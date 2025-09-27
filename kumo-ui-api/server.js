// server.js — Kumo UI API Proxy (ESM)
// Node 18+, package.json { "type": "module" }
import express from 'express';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import 'dotenv/config';

// ---------- Config ----------
const KUMO = process.env.KUMO_HTTP || 'http://127.0.0.1:8000';
const SAMPLE_MS = 3000;
const RETAIN_MS = 2 * 3600_000; // ~2h of samples for windows/charts
const STATE_PATH = process.env.STATE_PATH || '/opt/kumo-ui-api/state.json';
const DEFERRAL_RETAIN_MS = Number(process.env.DEFERRAL_RETAIN_MS || (48 * 3600_000));
const DEFERRAL_MAX_EVENTS = Number(process.env.DEFERRAL_MAX_EVENTS || 50000);
const EVENTS_MAX = Number(process.env.EVENTS_MAX || 500); // recent events ring buffer
const API_KEY = process.env.API_KEY || '';

const app = express();
app.disable('x-powered-by');
app.use(express.json());

// ---------- Simple header auth ----------
app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.get('x-api-key') !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// ---------- Helpers ----------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const n = (v) => (isNum(v) ? v : 0);

const sumObjNums = (o) =>
  (o && typeof o === 'object')
    ? Object.values(o).reduce((a, v) => (isNum(v) ? a + v : a), 0)
    : 0;

// Some Kumo arrays store a numeric value at '@'
const sumArrayAt = (arr) =>
  Array.isArray(arr) ? arr.reduce((a, v) => a + (isNum(v?.['@']) ? v['@'] : 0), 0) : 0;

// Prefer a specific service rollup to avoid double-counting (parent + child)
const pickServiceTotal = (serviceObj) => {
  if (!serviceObj || typeof serviceObj !== 'object') return 0;
  for (const k of ['smtp_client', 'smtp', 'http', 'submission', 'esmtp_listener']) {
    if (isNum(serviceObj[k])) return serviceObj[k];
  }
  // Fallback: sum everything (may double count on some setups)
  return Object.values(serviceObj).reduce((a, v) => (isNum(v) ? a + v : a), 0);
};

const topEntries = (obj, limit = 10) =>
  Object.entries(obj || {})
    .map(([k, v]) => ({ key: String(k), value: Number(v) || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);

// ---------- State ----------
let samples = [];   // [{t, received, delivered, deferred, bounced}]  (cumulatives)
let qSamples = [];  // [{t, depth, ready, scheduled}]
let peaks = {       // window peaks for lastMinute/hour
  minute: { received:0, delivered:0, deferred:0, bounced:0 },
  hour:   { received:0, delivered:0, deferred:0, bounced:0 }
};
let lastRaw = null;

// deferral counters from logs
let deferralEvents = []; // [{t, domain}]

// Keep recent log events for "Recent Events" card
let recentEvents = [];   // [{t, level, msg}]

// Cache last non-empty lists to avoid flicker during quiet periods
let cachedLists = {
  topDomains: [],
  topProviders: [],
  topDeferralsHour: [],
  topDeferralsTotal: [],
};

// ---------- LAST-ERRORS helpers/state ----------
function toEnhancedCode(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const a = v.major ?? v.m ?? v[0];
    const b = v.minor ?? v.n ?? v[1];
    const c = v.detail ?? v.d ?? v[2];
    if (a != null && b != null && c != null) return `${a}.${b}.${c}`;
  }
  return null;
}
function trimText(s, max = 400) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
const LAST_ERRORS_PER_DOMAIN = 20;              // keep up to 20 recent reasons per domain
const LAST_ERRORS_RETENTION  = 48 * 3600_000;   // 48h
// Map<string, Array<{ts:number, domain:string, provider?:string, code?:string|number, enhanced?:string, text:string}>>
const lastErrors = new Map();
function pushLastError(entry) {
  const now = Date.now();
  const list = lastErrors.get(entry.domain) || [];
  list.push({ ...entry, ts: now });
  while (list.length > LAST_ERRORS_PER_DOMAIN) list.shift();
  lastErrors.set(entry.domain, list);
  // GC across all domains
  const cutoff = now - LAST_ERRORS_RETENTION;
  for (const [dom, arr] of lastErrors) {
    lastErrors.set(dom, arr.filter(e => e.ts >= cutoff));
  }
}

// Convert journald MESSAGE (may be a byte array) into a UTF-8 string, then strip ANSI.
function normalizeMsg(v) {
  if (Array.isArray(v)) {
    try { return Buffer.from(v).toString('utf8'); } catch { return String(v); }
  }
  if (v && typeof v === 'object' && 'data' in v) { // rare structured form
    try { return Buffer.from(v.data).toString('utf8'); } catch { return String(v); }
  }
  return typeof v === 'string' ? v : String(v ?? '');
}

function stripAnsi(s = '') { return String(s).replace(/\x1B\[[0-9;]*m/g, ''); }

function isDeferralLine(line) {
  return /\b4\d\d\b/.test(line) || /\b4\.\d\.\d\b/.test(line)
      || /\btemporary failure\b/i.test(line) || /\btransient\b/i.test(line)
      || /\bdefer(?:red|ral)?\b/i.test(line) || /\brate ?limit(?:ed|ing)?\b/i.test(line)
      || /\bgreylist(?:ed|ing)?\b/i.test(line) || /\btry(?:ing)? again later\b/i.test(line);
}

// ---------- Deferral + Events capture ----------
function extractDomain(s) {
  if (!s) return null;
  const txt = String(s);
  const m =
    txt.match(/@([a-z0-9.-]+\.[a-z]{2,})/i) ||
    txt.match(/\bdomain[=:]\s*([a-z0-9.-]+\.[a-z]{2,})\b/i) ||
    txt.match(/\bprovider[_ ]domain[=:]\s*([a-z0-9.-]+\.[a-z]{2,})\b/i) ||
    txt.match(/\bmx\s+(?:host|domain)[=:]\s*([a-z0-9.-]+\.[a-z]{2,})\b/i) ||
    txt.match(/<[^@\s<>]+@([a-z0-9.-]+\.[a-z]{2,})>/i) ||
    txt.match(/\bto[=:]\s*(?:<?[^@\s<]+@)?([a-z0-9.-]+\.[a-z]{2,})>?/i) ||
    txt.match(/\brcpt[=:]\s*(?:<?[^@\s<]+@)?([a-z0-9.-]+\.[a-z]{2,})>?/i);
  return m ? m[1].toLowerCase() : null;
}
function looks4xx(code) { const x = Number(code); return Number.isFinite(x) && x >= 400 && x < 500; }
function isDeferralJson(obj) {
  const outcome = (obj.outcome || obj.status || obj.result || '').toString().toLowerCase();
  const klass   = (obj.status_class || obj.class || '').toString();
  const code    = obj.smtp_code || obj.smtp?.code || obj.code;
  return /transient|defer/.test(outcome) || klass === '4' || looks4xx(code);
}
function rcptFromJson(obj) {
  return obj.rcpt || obj.recipient || obj.to ||
         obj.envelope?.to || obj.message?.rcpt || obj.message?.recipient || null;
}
function recordDeferral(domain) {
  if (!domain) return;
  const now = Date.now();
  deferralEvents.push({ t: now, domain });
  const cutoff = now - DEFERRAL_RETAIN_MS;
  deferralEvents = deferralEvents.filter(e => e.t >= cutoff);
  if (deferralEvents.length > DEFERRAL_MAX_EVENTS) {
    deferralEvents = deferralEvents.slice(-Math.floor(DEFERRAL_MAX_EVENTS * 0.9));
  }
}
function recordEvent(line) {
  const s = stripAnsi(String(line)).trim();
  if (!s) return;
  const level = (s.match(/\b(INFO|WARN|ERROR)\b/i)?.[1] || 'INFO').toUpperCase();
  const msg = s.slice(0, 500);
  recentEvents.push({ t: Date.now(), level, msg });
  if (recentEvents.length > EVENTS_MAX) recentEvents = recentEvents.slice(-EVENTS_MAX);
}
function startDeferralWatcher() {
  const TAILER = process.env.KUMO_TAILER || '/opt/kumomta/sbin/tailer';
  const LOGDIR = process.env.KUMO_LOGDIR || '/var/log/kumomta';
  const proc = spawn(TAILER, ['--tail', LOGDIR], { env: process.env });

  let buf = '';
  const handleLine = (line) => {
    const s = String(line).trim();
    if (!s) return;
    let obj;
    try { obj = JSON.parse(s); } catch { recordEvent(s); return; }
    recordEvent(obj.message || obj.event || obj.type || s);

    const type = (obj.event || obj.type || '').toString();
    if (!/TransientFailure/i.test(type)) return;

    const dom =
      (obj.domain || obj.provider_domain || obj.rcpt_domain) ||
      extractDomain(obj.rcpt || obj.recipient || obj.envelope_to || obj.to || obj.message?.recipient || obj.message?.rcpt || '') ||
      extractDomain(obj.message || '');
    if (dom) recordDeferral(String(dom).toLowerCase());

    const code  = obj.response?.code || obj.smtp?.code || obj.smtp_code;
    const enhl  = obj.response?.enhanced_code || obj.enhanced_code;
    const text  = obj.response?.content || obj.response?.text || obj.smtp?.text || obj.reason || obj.message || '';
    if (dom && (code || text)) {
      recordEvent(`DEFERRAL ${dom} ${code || ''} ${toEnhancedCode(enhl) || ''} ${trimText(text, 240)}`.trim());
      pushLastError({
        domain: String(dom).toLowerCase(),
        provider: (obj.provider || obj.provider_domain || null) ?? undefined,
        code: code ?? undefined,
        enhanced: toEnhancedCode(enhl) ?? undefined,
        text: trimText(text, 400)
      });
    }
  };

  proc.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const ln of lines) handleLine(ln);
  });
  proc.stderr.on('data', (d) => { recordEvent(`tailer: ${String(d).trim()}`); });
  proc.on('close', (code) => {
    recordEvent(`tailer exited with code ${code}, retrying…`);
    setTimeout(startDeferralWatcher, 2000);
  });
}

// ---------- Sampling + windows ----------
function prune() {
  const cutoff = Date.now() - RETAIN_MS;
  samples = samples.filter(s => s.t >= cutoff);
  qSamples = qSamples.filter(s => s.t >= cutoff);
}
function windowSum(list, endTs, ms, key) {
  // sum of increments of cumulative counters over the window
  let sum = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    if (b.t <= endTs - ms) continue;
    const inc = Math.max(0, (n(b[key]) - n(a[key])));
    sum += inc;
  }
  return sum;
}
function updatePeaks(lastMinute, lastHour) {
  const upd = (dst, src) => {
    dst.received  = Math.max(n(dst.received ), n(src.received ));
    dst.delivered = Math.max(n(dst.delivered), n(src.delivered));
    dst.deferred  = Math.max(n(dst.deferred ), n(src.deferred ));
    dst.bounced   = Math.max(n(dst.bounced  ), n(src.bounced  ));
  };
  upd(peaks.minute, lastMinute);
  upd(peaks.hour,   lastHour);
}
function buildSession() {
  const now = Date.now();
  const MIN = 60_000, HOUR = 3_600_000;

  const lastMinute = {
    received:  windowSum(samples, now, MIN, 'received'),
    delivered: windowSum(samples, now, MIN, 'delivered'),
    deferred:  windowSum(samples, now, MIN, 'deferred'),
    bounced:   windowSum(samples, now, MIN, 'bounced'),
  };
  const lastHour = {
    received:  windowSum(samples, now, HOUR, 'received'),
    delivered: windowSum(samples, now, HOUR, 'delivered'),
    deferred:  windowSum(samples, now, HOUR, 'deferred'),
    bounced:   windowSum(samples, now, HOUR, 'bounced'),
  };

  updatePeaks(lastMinute, lastHour);

  const perMinute = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const dt = Math.max(1, b.t - a.t);
    const f = 60_000 / dt;
    perMinute.push({
      t: new Date(b.t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}),
      received:  Math.max(0, (n(b.received)  - n(a.received))  * f),
      delivered: Math.max(0, (n(b.delivered) - n(a.delivered)) * f),
      deferred:  Math.max(0, (n(b.deferred ) - n(a.deferred )) * f),
      bounced:   Math.max(0, (n(b.bounced  ) - n(a.bounced  )) * f),
    });
  }

  const queue = qSamples.map(q => ({
    t: new Date(q.t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}),
    queued: q.depth
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

// ---------- Poller: use true cumulatives from Kumo ----------
function pushFromKumo(m) {
  const now = Date.now();

  // OUT cumulatives
  const delivered =
    (isNum(m?.total_messages_delivered?.value) ? m.total_messages_delivered.value : 0) ||
    pickServiceTotal(m?.total_messages_delivered?.value?.service) ||
    sumObjNums(m?.total_messages_delivered_by_provider?.value?.provider || {}) ||
    sumArrayAt(m?.total_messages_delivered_by_provider_and_source?.value || []) || 0;

  const deferred =
    (isNum(m?.total_messages_transfail?.value) ? m.total_messages_transfail.value : 0) ||
    pickServiceTotal(m?.total_messages_transfail?.value?.service) ||
    sumObjNums(m?.total_messages_transfail_by_provider?.value?.provider || {}) ||
    sumArrayAt(m?.total_messages_transfail_by_provider_and_source?.value || []) || 0;

  const bounced =
    (isNum(m?.total_messages_fail?.value) ? m.total_messages_fail.value : 0) ||
    pickServiceTotal(m?.total_messages_fail?.value?.service) ||
    sumObjNums(m?.total_messages_fail_by_provider?.value?.provider || {}) ||
    sumArrayAt(m?.total_messages_fail_by_provider_and_source?.value || []) || 0;

  // Out that actually left the box
  const outSent = n(delivered) + n(bounced);

  // QUEUE snapshot (recipients/messages pending).
  const ready = pickServiceTotal(m?.ready_count?.value?.service) || 0;
  const scheduled =
    (isNum(m?.scheduled_count_total?.value) ? m.scheduled_count_total.value : 0) ||
    (isNum(m?.scheduled_count?.value) ? m.scheduled_count.value : 0);

  const depthProv = sumObjNums(m?.queued_count_by_provider?.value?.provider || {});
  const depthPool = sumArrayAt(m?.queued_count_by_provider_and_pool?.value || []);
  const depth = depthProv || depthPool || (ready + scheduled) || 0;

  // IN cumulative: true inbound/accepted (no derivation)
  const received =
    (isNum(m?.total_messages_received?.value) ? m.total_messages_received.value : 0) ||
    pickServiceTotal(m?.total_messages_received?.value?.service) || 0;

  samples.push({ t: now, received, delivered, deferred, bounced });
  qSamples.push({ t: now, depth, ready, scheduled });

  prune();
}

// ---------- Persistence ----------
async function loadState() {
  try {
    const txt = await fs.readFile(STATE_PATH, 'utf8');
    const state = JSON.parse(txt);
    const cutoff = Date.now() - RETAIN_MS;
    samples  = Array.isArray(state.samples)  ? state.samples.filter(s => s.t >= cutoff) : [];
    qSamples = Array.isArray(state.qSamples) ? state.qSamples.filter(s => s.t >= cutoff) : [];
    if (state.peaks?.minute && state.peaks?.hour) peaks = state.peaks;
    for (const k of ['minute','hour']) {
      peaks[k].received  = peaks[k].received  ?? 0;
      peaks[k].delivered = peaks[k].delivered ?? 0;
      peaks[k].deferred  = peaks[k].deferred  ?? 0;
      peaks[k].bounced   = peaks[k].bounced   ?? 0;
    }
    const dCut = Date.now() - DEFERRAL_RETAIN_MS;
    deferralEvents = Array.isArray(state.deferralEvents)
      ? state.deferralEvents.filter(e => e.t >= dCut)
      : [];
  } catch {}
}
async function saveState() {
  const state = { samples, qSamples, peaks, deferralEvents, savedAt: Date.now() };
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state));
}
setInterval(() => { saveState().catch(()=>{}) }, 10_000);
for (const sig of ['SIGINT','SIGTERM']) {
  process.on(sig, async () => { try { await saveState(); } finally { process.exit(0); } });
}

// ---------- Boot ----------
await loadState();
startDeferralWatcher();
setInterval(pollOnce, SAMPLE_MS);
pollOnce();

async function pollOnce() {
  try {
    const r = await fetch(`${KUMO}/metrics.json`);
    if (!r.ok) return;
    const m = await r.json();
    lastRaw = m;
    pushFromKumo(m);
  } catch {}
}

// ---------- Routes ----------
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
    const m = lastRaw || {};

    // Disk / connections / queue
    const diskFreePct = m?.disk_free_percent?.value?.name?.['data spool'];
    const diskFreeInodesPct = m?.disk_free_inodes_percent?.value?.name?.['data spool'];
    const activeConns = pickServiceTotal(m?.connection_count?.value?.service) || 0;

    const ready = pickServiceTotal(m?.ready_count?.value?.service) || 0;
    const scheduled =
      (isNum(m?.scheduled_count_total?.value) ? m.scheduled_count_total.value : 0) ||
      (isNum(m?.scheduled_count?.value) ? m.scheduled_count.value : 0);
    const depthProv = sumObjNums(m?.queued_count_by_provider?.value?.provider || {});
    const depthPool = sumArrayAt(m?.queued_count_by_provider_and_pool?.value || []);
    const depth = depthProv || depthPool || (ready + scheduled) || 0;

    // OUT cumulatives
    const delivered =
      (isNum(m?.total_messages_delivered?.value) ? m.total_messages_delivered.value : 0) ||
      pickServiceTotal(m?.total_messages_delivered?.value?.service) ||
      sumObjNums(m?.total_messages_delivered_by_provider?.value?.provider || {}) ||
      sumArrayAt(m?.total_messages_delivered_by_provider_and_source?.value || []) || 0;

    const deferred =
      (isNum(m?.total_messages_transfail?.value) ? m.total_messages_transfail.value : 0) ||
      pickServiceTotal(m?.total_messages_transfail?.value?.service) ||
      sumObjNums(m?.total_messages_transfail_by_provider?.value?.provider || {}) ||
      sumArrayAt(m?.total_messages_transfail_by_provider_and_source?.value || []) || 0;

    const bounced =
      (isNum(m?.total_messages_fail?.value) ? m.total_messages_fail.value : 0) ||
      pickServiceTotal(m?.total_messages_fail?.value?.service) ||
      sumObjNums(m?.total_messages_fail_by_provider?.value?.provider || {}) ||
      sumArrayAt(m?.total_messages_fail_by_provider_and_source?.value || []) || 0;

    // "Out" = delivered + bounced (actually sent)
    const outSent = n(delivered) + n(bounced);

    // "In" = true inbound cumulative captured in samples
    const received = samples.length ? samples[samples.length - 1].received : (
      (isNum(m?.total_messages_received?.value) ? m.total_messages_received.value : 0) ||
      pickServiceTotal(m?.total_messages_received?.value?.service) || 0
    );

    // Windows + series
    const sess = buildSession();

    // Lists from metrics (may be empty on quiet or older schemas)
    const topDomainsArr   = topEntries(m?.scheduled_by_domain?.value?.domain, 10);
    const topProvidersArr = topEntries(m?.total_messages_delivered_by_provider?.value?.provider, 10);

    // Top deferrals from watcher (hour + total)
    const now = Date.now();
    const hourCutoff = now - 3_600_000;
    const hourCount = {}, totalCount = {};
    for (const e of deferralEvents) {
      totalCount[e.domain] = (totalCount[e.domain] || 0) + 1;
      if (e.t >= hourCutoff) hourCount[e.domain] = (hourCount[e.domain] || 0) + 1;
    }
    const topDeferralsHour  = topEntries(hourCount, 10);
    const topDeferralsTotal = topEntries(totalCount, 10);

    // Preserve last non-empty lists so cards don't vanish on quiet periods
    const lists = {
      topDomains:         topDomainsArr.length    ? topDomainsArr    : cachedLists.topDomains,
      topProviders:       topProvidersArr.length  ? topProvidersArr  : cachedLists.topProviders,
      topDeferralsHour:   topDeferralsHour.length ? topDeferralsHour : cachedLists.topDeferralsHour,
      topDeferralsTotal:  topDeferralsTotal.length? topDeferralsTotal: cachedLists.topDeferralsTotal,
    };
    cachedLists = lists;

    // Traffic windows (OUT from sent: delivered + bounced)
    const sumWinSent = (o) => n(o.delivered) + n(o.bounced);
    const traffic = {
      total:      { in: received, out: outSent },
      lastMinute: { in: n(sess.lastMinute?.received) || 0, out: sumWinSent(sess.lastMinute) },
      lastHour:   { in: n(sess.lastHour?.received)   || 0, out: sumWinSent(sess.lastHour) },
      topMinute:  { in: n(sess.topMinute?.received)  || 0, out: sumWinSent(sess.topMinute) },
      topHour:    { in: n(sess.topHour?.received)    || 0, out: sumWinSent(sess.topHour) },
    };

    res.json({
      disk: {
        freePercent: isNum(diskFreePct) ? diskFreePct : null,
        inodeFreePercent: isNum(diskFreeInodesPct) ? diskFreeInodesPct : null,
      },
      connections: { active: activeConns },
      queue: { depth, ready, scheduled },

      // raw cumulatives for transparency
      totals: { received, delivered, deferred, bounced },

      // windows + series (back-compat with the UI)
      session: {
        lastMinute: sess.lastMinute,
        lastHour:   sess.lastHour,
        topMinute:  sess.topMinute,
        topHour:    sess.topHour
      },
      series: {
        perMinute: sess.perMinute,
        queue:     sess.queue
      },

      // stable lists
      lists,

      // recent events for the Dashboard card
      events: recentEvents.slice(-100),

      // traffic rollups used by "Traffic Totals"
      traffic,
    });
  } catch (e) {
    res.status(500).json({ error: 'summarize_failed', detail: String(e) });
  }
});

// LAST-ERRORS read-only endpoint
app.get('/metrics/last-errors', (req, res) => {
  const qDomain = (req.query.domain || '').toString().toLowerCase().trim();
  const limit = Math.min( Number(req.query.limit ?? 10) || 10, 50 );
  if (qDomain) {
    const rows = (lastErrors.get(qDomain) || []).slice(-limit).reverse();
    return res.json({ domain: qDomain, rows });
  }
  const out = {};
  for (const [dom, rows] of lastErrors.entries()) {
    out[dom] = rows.slice(-limit).reverse();
  }
  res.json(out);
});

// Admin
app.post('/policy/reload', (_req, res) => {
  const child = spawn('/bin/systemctl', ['reload', 'kumomta']);
  child.on('close', (code) => res.json({ ok: code === 0, code }));
});
app.post('/queue/flush', (_req, res) => { res.json({ ok: true }); });

// Logs SSE (tail journald)
app.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const jc = spawn('journalctl', ['-u','kumomta','-f','-o','cat']);
  const send = (chunk) => {
    const s = chunk.toString();
    res.write(`data: ${s.replace(/\n/g, '\ndata: ')}\n\n`);
  };
  jc.stdout.on('data', send);
  jc.stderr.on('data', (d) => send(`[ERR] ${d}`));
  jc.on('close', (code) => { res.write(`event: end\ndata: ${code}\n\n`); res.end(); });
  req.on('close', () => jc.kill('SIGTERM'));
});

// ---------- Optional debug endpoints ----------
app.get('/debug/logprobe', async (_req, res) => {
  try {
    const p = spawn('journalctl', ['-u','kumomta','-n','50','-o','json']);
    let out = '';
    p.stdout.on('data', d => out += d.toString());
    p.on('close', () => {
      const lines = out.split('\n').filter(Boolean);
      const parsed = [];
      for (const ln of lines) {
        try {
          const o = JSON.parse(ln);
          const text = stripAnsi(normalizeMsg(o.MESSAGE)).slice(0, 300);
          parsed.push({ text, isDeferral: isDeferralLine(text), domain: extractDomain(text) });
        } catch {}
      }
      res.json(parsed);
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 5055;
app.listen(port, () => console.log(`kumo-ui-api listening on ${port}`));
