'use strict';

const express = require('express');
const { spawn } = require('node:child_process');
require('dotenv').config();

// Node 18+ has global fetch
const app = express();
app.disable('x-powered-by');
app.use(express.json());

// auth (Nginx injects X-API-Key)
app.use((req, res, next) => {
  const want = process.env.API_KEY;
  if (want && req.get('x-api-key') !== want) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

const KUMO = process.env.KUMO_HTTP || 'http://127.0.0.1:8000';
const SAMPLE_MS = 3000;          // poll every 3s
const RETAIN_MS = 2 * 3600_000;  // keep ~2h

let samples = [];   // {t, delivered, deferred, bounced}
let qSamples = [];  // {t, depth, ready, scheduled}
let lastRaw = null;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const sumObjNums = (o) => o && typeof o === 'object'
  ? Object.values(o).reduce((a, v) => (isNum(v) ? a + v : a), 0)
  : 0;
const sumArrayAt = (arr) => Array.isArray(arr)
  ? arr.reduce((a, v) => a + (isNum(v?.['@']) ? v['@'] : 0), 0)
  : 0;

function prune() {
  const cutoff = Date.now() - RETAIN_MS;
  samples = samples.filter(s => s.t >= cutoff);
  qSamples = qSamples.filter(s => s.t >= cutoff);
}

function pushFromKumo(m) {
  const now = Date.now();

  const delivered =
    sumObjNums(m?.total_messages_delivered?.value?.service || {}) ||
    sumObjNums(m?.total_messages_delivered_by_provider?.value?.provider || {}) ||
    sumArrayAt(m?.total_messages_delivered_by_provider_and_source?.value || []) || 0;

  const deferred =
    sumObjNums(m?.total_messages_transfail?.value?.service || {}) ||
    sumObjNums(m?.total_messages_transfail_by_provider?.value?.provider || {}) ||
    sumArrayAt(m?.total_messages_transfail_by_provider_and_source?.value || []) || 0;

  const bounced =
    sumObjNums(m?.total_messages_fail?.value?.service || {}) ||
    sumObjNums(m?.total_messages_fail_by_provider?.value?.provider || {}) ||
    sumArrayAt(m?.total_messages_fail_by_provider_and_source?.value || []) || 0;

  samples.push({ t: now, delivered, deferred, bounced });

  const ready = sumObjNums(m?.ready_count?.value?.service || {}) || 0;
  const scheduled =
    (isNum(m?.scheduled_count_total?.value) ? m.scheduled_count_total.value : 0) ||
    (isNum(m?.scheduled_count?.value) ? m.scheduled_count.value : 0);

  const depthProv = sumObjNums(m?.queued_count_by_provider?.value?.provider || {});
  const depthPool = sumArrayAt(m?.queued_count_by_provider_and_pool?.value || []);
  const depth = depthProv || depthPool || (ready + scheduled) || 0;

  qSamples.push({ t: now, depth, ready, scheduled });

  prune();
}

function windowSum(list, now, ms, key) {
  let sum = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    if (b.t <= now - ms) continue;
    const inc = Math.max(0, b[key] - a[key]);
    sum += inc;
  }
  return sum;
}
function windowPeak(list, ms, key) {
  let peak = 0;
  for (let i = 1; i < list.length; i++) {
    const end = list[i].t;
    let sum = 0;
    for (let j = 1; j <= i; j++) {
      const a = list[j - 1], b = list[j];
      if (b.t <= end - ms) continue;
      const inc = Math.max(0, b[key] - a[key]);
      sum += inc;
    }
    if (sum > peak) peak = sum;
  }
  return peak;
}
function buildSession() {
  const now = Date.now();
  const MIN = 60_000, HOUR = 3_600_000;

  const lastMinute = {
    delivered: windowSum(samples, now, MIN, 'delivered'),
    deferred:  windowSum(samples, now, MIN, 'deferred'),
    bounced:   windowSum(samples, now, MIN, 'bounced'),
  };
  const lastHour = {
    delivered: windowSum(samples, now, HOUR, 'delivered'),
    deferred:  windowSum(samples, now, HOUR, 'deferred'),
    bounced:   windowSum(samples, now, HOUR, 'bounced'),
  };
  const topMinute = {
    delivered: windowPeak(samples, MIN, 'delivered'),
    deferred:  windowPeak(samples, MIN, 'deferred'),
    bounced:   windowPeak(samples, MIN, 'bounced'),
  };
  const topHour = {
    delivered: windowPeak(samples, HOUR, 'delivered'),
    deferred:  windowPeak(samples, HOUR, 'deferred'),
    bounced:   windowPeak(samples, HOUR, 'bounced'),
  };

  const perMinute = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const dt = Math.max(1, b.t - a.t);
    const f = 60_000 / dt;
    perMinute.push({
      t: b.t,
      delivered: Math.max(0, (b.delivered - a.delivered) * f),
      deferred:  Math.max(0, (b.deferred  - a.deferred ) * f),
      bounced:   Math.max(0, (b.bounced   - a.bounced  ) * f),
    });
  }
  const perMinuteOut = perMinute.slice(-120).map(x => ({
    t: new Date(x.t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}),
    delivered: x.delivered, deferred: x.deferred, bounced: x.bounced
  }));
  const queueOut = qSamples.slice(-120).map(q => ({
    t: new Date(q.t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}),
    depth: q.depth, ready: q.ready, scheduled: q.scheduled
  }));

  return { lastMinute, lastHour, topMinute, topHour, perMinute: perMinuteOut, queue: queueOut };
}

// background poller
async function pollOnce() {
  try {
    const r = await fetch(`${KUMO}/metrics.json`);
    if (!r.ok) return;
    const m = await r.json();
    lastRaw = m;
    pushFromKumo(m);
  } catch {}
}
setInterval(pollOnce, SAMPLE_MS);
pollOnce();

// routes
app.get('/metrics', async (_req, res) => {
  try {
    const r = await fetch(`${KUMO}/metrics.json`);
    if (!r.ok) return res.status(r.status).json({ error: 'upstream_error' });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: 'fetch_failed', detail: String(e) });
  }
});

app.get('/metrics/summary', (_req, res) => {
  try {
    const m = lastRaw;
    if (!m) return res.status(503).json({ error: 'warming_up' });

    const diskFreePct = m?.disk_free_percent?.value?.name?.['data spool'];
    const diskFreeInodesPct = m?.disk_free_inodes_percent?.value?.name?.['data spool'];
    const activeConns = sumObjNums(m?.connection_count?.value?.service || {});

    const ready = sumObjNums(m?.ready_count?.value?.service || {}) || 0;
    const scheduled =
      (isNum(m?.scheduled_count_total?.value) ? m.scheduled_count_total.value : 0) ||
      (isNum(m?.scheduled_count?.value) ? m.scheduled_count.value : 0);
    const depthProv = sumObjNums(m?.queued_count_by_provider?.value?.provider || {});
    const depthPool = sumArrayAt(m?.queued_count_by_provider_and_pool?.value || []);
    const depth = depthProv || depthPool || (ready + scheduled) || 0;

    const delivered =
      sumObjNums(m?.total_messages_delivered?.value?.service || {}) ||
      sumObjNums(m?.total_messages_delivered_by_provider?.value?.provider || {}) ||
      sumArrayAt(m?.total_messages_delivered_by_provider_and_source?.value || []) || 0;

    const deferred =
      sumObjNums(m?.total_messages_transfail?.value?.service || {}) ||
      sumObjNums(m?.total_messages_transfail_by_provider?.value?.provider || {}) ||
      sumArrayAt(m?.total_messages_transfail_by_provider_and_source?.value || []) || 0;

    const bounced =
      sumObjNums(m?.total_messages_fail?.value?.service || {}) ||
      sumObjNums(m?.total_messages_fail_by_provider?.value?.provider || {}) ||
      sumArrayAt(m?.total_messages_fail_by_provider_and_source?.value || []) || 0;

    const session = buildSession();

    res.json({
      disk: {
        freePercent: isNum(diskFreePct) ? diskFreePct : null,
        inodeFreePercent: isNum(diskFreeInodesPct) ? diskFreeInodesPct : null,
      },
      connections: { active: activeConns },
      queue: { depth, ready, scheduled },
      totals: { delivered, deferred, bounced },
      session: {
        lastMinute: session.lastMinute,
        lastHour:   session.lastHour,
        topMinute:  session.topMinute,
        topHour:    session.topHour,
      },
      series: {
        perMinute: session.perMinute,
        queue:     session.queue,
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'summarize_failed', detail: String(e) });
  }
});

app.post('/policy/reload', (_req, res) => {
  const child = spawn('/bin/systemctl', ['reload', 'kumomta']);
  child.on('close', (code) => res.json({ ok: code === 0, code }));
});

app.post('/queue/flush', (_req, res) => {
  res.json({ ok: true });
});

app.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const jc = spawn('journalctl', ['-u', 'kumomta', '-f', '-o', 'cat']);
  const send = (chunk) =>
    res.write(`data: ${chunk.toString().replace(/\n/g, '\ndata: ')}\n\n`);
  jc.stdout.on('data', send);
  jc.stderr.on('data', (d) => send(`[ERR] ${d}`));
  jc.on('close', (code) => {
    res.write(`event: end\ndata: ${code}\n\n`);
    res.end();
  });
  req.on('close', () => jc.kill('SIGTERM'));
});

const port = process.env.PORT || 5055;
app.listen(port, () => console.log(`kumo-ui-api listening on ${port}`));
