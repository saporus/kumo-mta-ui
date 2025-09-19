// server.js (ESM) — Kumo UI API proxy with session stats + persistence
// Requires: Node 18+, package.json with `"type":"module"`, and .env (API_KEY, optional KUMO_HTTP, STATE_PATH)

import express from 'express';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import 'dotenv/config'; // loads .env

// ---------- Config ----------
const KUMO = process.env.KUMO_HTTP || 'http://127.0.0.1:8000';
const SAMPLE_MS = 3000;                     // poll every 3s
const RETAIN_MS = 2 * 3600_000;             // keep ~2 hours of samples for session windows
const STATE_PATH = process.env.STATE_PATH || '/opt/kumo-ui-api/state.json';
const DEFERRAL_RETAIN_MS = Number(process.env.DEFERRAL_RETAIN_MS || (48 * 3600_000)); // 48h rolling window
const DEFERRAL_MAX_EVENTS = Number(process.env.DEFERRAL_MAX_EVENTS || 50000);
// ----------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// --- Auth (Nginx injects X-API-Key) ---
app.use((req, res, next) => {
  const want = process.env.API_KEY;
  if (want && req.get('x-api-key') !== want) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// --------- In-memory state (also persisted) ----------
let samples = [];   // [{t, delivered, deferred, bounced}] (cumulative counters)
let qSamples = [];  // [{t, depth, ready, scheduled}]
let peaks = { minute: { delivered:0, deferred:0, bounced:0 },
              hour:   { delivered:0, deferred:0, bounced:0 } };
let lastRaw = null;
let deferralEvents = []; // [{t, domain}]

// --------- Helpers ----------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const sumObjNums = (o) => o && typeof o === 'object'
  ? Object.values(o).reduce((a, v) => (isNum(v) ? a + v : a), 0)
  : 0;
const sumArrayAt = (arr) => Array.isArray(arr)
  ? arr.reduce((a, v) => a + (isNum(v?.['@']) ? v['@'] : 0), 0)
  : 0;

// Prefer rollup "smtp_client" if present; otherwise sum everything.
// Avoids double-count when service map contains parent + children.
const pickServiceTotal = (serviceObj) => {
  if (!serviceObj || typeof serviceObj !== 'object') return 0;
  if (Number.isFinite(serviceObj['smtp_client'])) return serviceObj['smtp_client'];
  return Object.values(serviceObj).reduce((a,v)=>a + (Number.isFinite(v)?v:0), 0);
};

// Turn objects into sorted arrays e.g. {gmail.com:123} -> [{key:'gmail.com', value:123}, ...]
const topEntries = (obj, limit = 10) =>
  Object.entries(obj || {})
    .map(([k, v]) => ({ key: k, value: Number(v) || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);

// Deferral capture
function extractDomain(str) {
  if (!str) return null;
  const m = String(str).match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return m ? m[1].toLowerCase() : null;
}
function looks4xx(code) {
  const n = Number(code);
  return Number.isFinite(n) && n >= 400 && n < 500;
}
function isDeferralJson(obj) {
  const outcome = (obj.outcome || obj.status || obj.result || '').toString().toLowerCase();
  const klass = (obj.status_class || obj.class || '').toString();
  const code  = obj.smtp_code || obj.smtp?.code || obj.code;
  // outcome mentions transient/deferr OR status class "4" OR SMTP code 4xx
  return /transient|defer/.test(outcome) || klass === '4' || looks4xx(code);
}
function rcptFromJson(obj) {
  return (
    obj.rcpt || obj.recipient || obj.to ||
    obj.envelope?.to || obj.message?.rcpt || obj.message?.recipient || null
  );
}
function recordDeferral(domain) {
  if (!domain) return;
  const now = Date.now();
  deferralEvents.push({ t: now, domain });
  // time prune
  const cutoff = now - DEFERRAL_RETAIN_MS;
  deferralEvents = deferralEvents.filter(e => e.t >= cutoff);
  // cap prune
  if (deferralEvents.length > DEFERRAL_MAX_EVENTS) {
    deferralEvents = deferralEvents.slice(-Math.floor(DEFERRAL_MAX_EVENTS * 0.9));
  }
}

function startDeferralWatcher() {
  // --------------- File tailer for JSON logs (preferred) ---------------
  // We tail common Kumo file logger targets. Adjust patterns if your path differs.
  const tailCmd = 'tail';
  const tailArgs = ['-n', '0', '-F',
    '/var/log/kumomta/*.jsonl',
    '/var/log/kumomta/*.log'
  ];
  const tail = spawn(tailCmd, tailArgs, { shell: false });

  let buf = '';
  const handleLine = (line) => {
    const s = line.toString().trim();
    if (!s) return;

    // Try JSON first
    if (s.startsWith('{') && s.endsWith('}')) {
      try {
        const obj = JSON.parse(s);
        if (isDeferralJson(obj)) {
          const rcpt = rcptFromJson(obj);
          const dom = extractDomain(rcpt || obj.domain || obj.provider_domain);
          if (dom) recordDeferral(dom);
          return;
        }
      } catch { /* fall through to text regex */ }
    }

    // Text fallback (e.g., if files are text)
    // Look for "defer" or "transient" and a recipient address
    if (/defer|transient|temporar/i.test(s)) {
      const m =
        s.match(/rcpt(?:=|:)\s*[^@\s<]+@([a-z0-9.-]+\.[a-z]{2,})/i) ||
        s.match(/to\s*[=:]\s*<?[^@\s<]+@([a-z0-9.-]+\.[a-z]{2,})>?/i) ||
        s.match(/<[^@\s<]+@([a-z0-9.-]+\.[a-z]{2,})>/i);
      const dom = m && m[1] ? m[1].toLowerCase() : null;
      if (dom) recordDeferral(dom);
    }
  };

  tail.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const ln of lines) handleLine(ln);
  });
  tail.stderr.on('data', (d) => {
    // treat stderr like stdout; some tail/locale messages end up here
    handleLine(d.toString());
  });
  tail.on('close', () => {
    // restart after a short delay
    setTimeout(startDeferralWatcher, 2000);
  });

  // --------------- Journald fallback (plain text) ---------------
  const jc = spawn('journalctl', ['-u', 'kumomta', '-f', '-o', 'cat']);
  let jbuf = '';
  jc.stdout.on('data', (d) => {
    jbuf += d.toString();
    const lines = jbuf.split('\n');
    jbuf = lines.pop() || '';
    for (const ln of lines) {
      // same text regex heuristic
      if (/defer|transient|temporar/i.test(ln)) {
        const m =
          ln.match(/rcpt(?:=|:)\s*[^@\s<]+@([a-z0-9.-]+\.[a-z]{2,})/i) ||
          ln.match(/to\s*[=:]\s*<?[^@\s<]+@([a-z0-9.-]+\.[a-z]{2,})>?/i) ||
          ln.match(/<[^@\s<]+@([a-z0-9.-]+\.[a-z]{2,})>/i);
        const dom = m && m[1] ? m[1].toLowerCase() : null;
        if (dom) recordDeferral(dom);
      }
    }
  });
  jc.stderr.on('data', () => {});
  jc.on('close', () => {
    setTimeout(startDeferralWatcher, 2000);
  });
}


function prune() {
  const cutoff = Date.now() - RETAIN_MS;
  samples = samples.filter(s => s.t >= cutoff);
  qSamples = qSamples.filter(s => s.t >= cutoff);
}

function windowSum(list, endTs, ms, key) {
  // Sum of INCREMENTS of cumulative counter in [endTs-ms, endTs]
  let sum = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    if (b.t <= endTs - ms) continue;
    const inc = Math.max(0, (b[key] - a[key]) || 0);
    sum += inc;
  }
  return sum;
}

function updatePeaks(lastMinute, lastHour) {
  const upd = (dst, src) => {
    dst.delivered = Math.max(dst.delivered, src.delivered);
    dst.deferred  = Math.max(dst.deferred,  src.deferred);
    dst.bounced   = Math.max(dst.bounced,   src.bounced);
  };
  upd(peaks.minute, lastMinute);
  upd(peaks.hour,   lastHour);
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

  // Persist peak windows
  updatePeaks(lastMinute, lastHour);

  // per-minute rate series (for charts)
  const perMinute = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const dt = Math.max(1, b.t - a.t);
    const f = 60_000 / dt;
    perMinute.push({
      t: new Date(b.t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}),
      delivered: Math.max(0, (b.delivered - a.delivered) * f),
      deferred:  Math.max(0, (b.deferred  - a.deferred ) * f),
      bounced:   Math.max(0, (b.bounced   - a.bounced  ) * f),
    });
  }
  const queue = qSamples.map(q => ({
    t: new Date(q.t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}),
    depth: q.depth, ready: q.ready, scheduled: q.scheduled
  }));

  return {
    lastMinute,
    lastHour,
    topMinute: { ...peaks.minute },
    topHour:   { ...peaks.hour },
    perMinute: perMinute.slice(-120),
    queue:     queue.slice(-120),
  };
}

function pushFromKumo(m) {
  const now = Date.now();

  // ----- totals (cumulative) -----
  const delivered =
    pickServiceTotal(m?.total_messages_delivered?.value?.service) ||
    sumObjNums(m?.total_messages_delivered_by_provider?.value?.provider || {}) ||
    sumArrayAt(m?.total_messages_delivered_by_provider_and_source?.value || []) || 0;

  const deferred =
    pickServiceTotal(m?.total_messages_transfail?.value?.service) ||
    sumObjNums(m?.total_messages_transfail_by_provider?.value?.provider || {}) ||
    sumArrayAt(m?.total_messages_transfail_by_provider_and_source?.value || []) || 0;

  const bounced =
    pickServiceTotal(m?.total_messages_fail?.value?.service) ||
    sumObjNums(m?.total_messages_fail_by_provider?.value?.provider || {}) ||
    sumArrayAt(m?.total_messages_fail_by_provider_and_source?.value || []) || 0;

  samples.push({ t: now, delivered, deferred, bounced });

  // ----- queue snapshot -----
  const ready = pickServiceTotal(m?.ready_count?.value?.service) || 0;
  const scheduled =
    (isNum(m?.scheduled_count_total?.value) ? m.scheduled_count_total.value : 0) ||
    (isNum(m?.scheduled_count?.value) ? m.scheduled_count.value : 0);

  // Depth from provider rollups first; else fall back to ready+scheduled.
  const depthProv = sumObjNums(m?.queued_count_by_provider?.value?.provider || {});
  const depthPool = sumArrayAt(m?.queued_count_by_provider_and_pool?.value || []);
  const depth = depthProv || depthPool || (ready + scheduled) || 0;

  qSamples.push({ t: now, depth, ready, scheduled });

  prune();
}

// --------- Persistence (peaks + ring buffers + deferrals) ----------
async function loadState() {
  try {
    const txt = await fs.readFile(STATE_PATH, 'utf8');
    const state = JSON.parse(txt);
    const cutoff = Date.now() - RETAIN_MS;
    samples  = Array.isArray(state.samples)  ? state.samples.filter(s => s.t >= cutoff) : [];
    qSamples = Array.isArray(state.qSamples) ? state.qSamples.filter(s => s.t >= cutoff) : [];
    if (state.peaks?.minute && state.peaks?.hour) peaks = state.peaks;

    const dCut = Date.now() - DEFERRAL_RETAIN_MS;
    deferralEvents = Array.isArray(state.deferralEvents)
      ? state.deferralEvents.filter(e => e.t >= dCut)
      : [];
  } catch {
    // first boot, ignore
  }
}

async function saveState() {
  const state = { samples, qSamples, peaks, deferralEvents, savedAt: Date.now() };
  const dir = path.dirname(STATE_PATH);
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
  await fs.writeFile(STATE_PATH, JSON.stringify(state));
}
setInterval(() => { saveState().catch(()=>{}) }, 10_000);
for (const sig of ['SIGINT','SIGTERM']) {
  process.on(sig, async () => {
    try { await saveState(); } finally { process.exit(0); }
  });
}

// --------- Poller ----------
async function pollOnce() {
  try {
    const r = await fetch(`${KUMO}/metrics.json`);
    if (!r.ok) return;
    const m = await r.json();
    lastRaw = m;
    pushFromKumo(m);
  } catch {
    // ignore one-off errors; next tick will retry
  }
}

await loadState();
startDeferralWatcher();
setInterval(pollOnce, SAMPLE_MS);
pollOnce();

// --------- Routes ----------
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
    const m = lastRaw || {}; // still respond even if first poll hasn't landed

    // Disk (nullable)
    const diskFreePct = m?.disk_free_percent?.value?.name?.['data spool'];
    const diskFreeInodesPct = m?.disk_free_inodes_percent?.value?.name?.['data spool'];

    // Connections / Ready using rollup to avoid double-count
    const activeConns = pickServiceTotal(m?.connection_count?.value?.service) || 0;
    const ready = pickServiceTotal(m?.ready_count?.value?.service) || 0;

    // Scheduled + depth
    const scheduled =
      (isNum(m?.scheduled_count_total?.value) ? m.scheduled_count_total.value : 0) ||
      (isNum(m?.scheduled_count?.value) ? m.scheduled_count.value : 0);
    const depthProv = sumObjNums(m?.queued_count_by_provider?.value?.provider || {});
    const depthPool = sumArrayAt(m?.queued_count_by_provider_and_pool?.value || []);
    const depth = depthProv || depthPool || (ready + scheduled) || 0;

    // Totals (cumulative)
    const delivered =
      pickServiceTotal(m?.total_messages_delivered?.value?.service) ||
      sumObjNums(m?.total_messages_delivered_by_provider?.value?.provider || {}) ||
      sumArrayAt(m?.total_messages_delivered_by_provider_and_source?.value || []) || 0;

    const deferred =
      pickServiceTotal(m?.total_messages_transfail?.value?.service) ||
      sumObjNums(m?.total_messages_transfail_by_provider?.value?.provider || {}) ||
      sumArrayAt(m?.total_messages_transfail_by_provider_and_source?.value || []) || 0;

    const bounced =
      pickServiceTotal(m?.total_messages_fail?.value?.service) ||
      sumObjNums(m?.total_messages_fail_by_provider?.value?.provider || {}) ||
      sumArrayAt(m?.total_messages_fail_by_provider_and_source?.value || []) || 0;

    // Build session stats (returns zeros if no samples yet) + update peaks
    const sess = buildSession();

    // --- Top domains (scheduled backlog) ---
    const topDomainsArr = topEntries(m?.scheduled_by_domain?.value?.domain, 10);

    // --- Top providers (cumulative delivered) ---
    const topProvidersArr = topEntries(m?.total_messages_delivered_by_provider?.value?.provider, 10);

    // --- Top deferrals by domain (last hour + totals in retention window) ---
    const now = Date.now();
    const hourCutoff = now - 3_600_000;

    const hourCount = {};
    const totalCount = {};
    for (const e of deferralEvents) {
      totalCount[e.domain] = (totalCount[e.domain] || 0) + 1;
      if (e.t >= hourCutoff) hourCount[e.domain] = (hourCount[e.domain] || 0) + 1;
    }
    const topDeferralsHour  = topEntries(hourCount, 10);
    const topDeferralsTotal = topEntries(totalCount, 10);

    res.json({
      disk: {
        freePercent: isNum(diskFreePct) ? diskFreePct : null,
        inodeFreePercent: isNum(diskFreeInodesPct) ? diskFreeInodesPct : null,
      },
      connections: { active: activeConns },
      queue: { depth, ready, scheduled },
      totals: { delivered, deferred, bounced },
      session: {
        lastMinute: sess.lastMinute,  // shows 0 if no activity in window
        lastHour:   sess.lastHour,    // shows 0 if no activity in window
        topMinute:  sess.topMinute,   // persists across refresh/restart
        topHour:    sess.topHour      // persists across refresh/restart
      },
      series: {
        perMinute: sess.perMinute,
        queue:     sess.queue
      },
      lists: {
        topDomains: topDomainsArr,       // [{key:"gmail.com", value:123}, …]
        topProviders: topProvidersArr,   // [{key:"google", value:456}, …]
        topDeferralsHour,
        topDeferralsTotal
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

// Logs via SSE (used elsewhere in UI)
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
