import express from 'express';
import fetch from 'node-fetch';
import { spawn } from 'node:child_process';
import 'dotenv/config';

const app = express();
app.disable('x-powered-by');
app.use(express.json());

/** auth: require X-API-Key to match .env API_KEY (Nginx injects it) */
app.use((req, res, next) => {
  const want = process.env.API_KEY;
  if (want && req.get('x-api-key') !== want) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

const KUMO = process.env.KUMO_HTTP || 'http://127.0.0.1:8000';

/** raw passthrough for debugging */
app.get('/metrics', async (_req, res) => {
  try {
    const r = await fetch(`${KUMO}/metrics.json`);
    if (!r.ok) return res.status(r.status).json({ error: 'upstream_error' });
    const j = await r.json();
    res.json(j);
  } catch (e) {
    res.status(500).json({ error: 'fetch_failed', detail: String(e) });
  }
});

/** summary suitable for the UI cards */
app.get('/metrics/summary', async (_req, res) => {
  try {
    const r = await fetch(`${KUMO}/metrics.json`);
    if (!r.ok) return res.status(r.status).json({ error: 'upstream_error' });
    const m = await r.json();

    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    const sumObjectNumbers = (obj) =>
      obj && typeof obj === 'object'
        ? Object.values(obj).reduce((a, v) => (isNum(v) ? a + v : a), 0)
        : 0;
    const sumArrayAt = (arr) =>
      Array.isArray(arr)
        ? arr.reduce((a, v) => a + (isNum(v?.['@']) ? v['@'] : 0), 0)
        : 0;

    // Active SMTP connections (sum across services if present)
    const activeConns = sumObjectNumbers(m?.connection_count?.value?.service || {});

    // Queue: compute ready & scheduled separately; fall back to provider/pool aggregates for depth
    const ready = sumObjectNumbers(m?.ready_count?.value?.service || {}) || 0;
    const scheduled =
      (isNum(m?.scheduled_count_total?.value) ? m.scheduled_count_total.value : 0) ||
      (isNum(m?.scheduled_count?.value) ? m.scheduled_count.value : 0);

    const queuedProv = sumObjectNumbers(m?.queued_count_by_provider?.value?.provider || {});
    const queuedPool = sumArrayAt(m?.queued_count_by_provider_and_pool?.value || []);

    const depth =
      queuedProv || queuedPool || (ready + scheduled) || null;

    // Totals: delivered / deferred / bounced
    // delivered -> total_messages_delivered
    // deferred  -> total_messages_transfail (transient)
    // bounced   -> total_messages_fail (permanent)
    const delivered =
      sumObjectNumbers(m?.total_messages_delivered?.value?.service || {}) ||
      sumObjectNumbers(m?.total_messages_delivered_by_provider?.value?.provider || {}) ||
      sumArrayAt(m?.total_messages_delivered_by_provider_and_source?.value || []) ||
      null;

    const deferred =
      sumObjectNumbers(m?.total_messages_transfail?.value?.service || {}) ||
      sumObjectNumbers(m?.total_messages_transfail_by_provider?.value?.provider || {}) ||
      sumArrayAt(m?.total_messages_transfail_by_provider_and_source?.value || []) ||
      null;

    const bounced =
      sumObjectNumbers(m?.total_messages_fail?.value?.service || {}) ||
      sumObjectNumbers(m?.total_messages_fail_by_provider?.value?.provider || {}) ||
      sumArrayAt(m?.total_messages_fail_by_provider_and_source?.value || []) ||
      null;

    // Disk
    const diskFreePct = m?.disk_free_percent?.value?.name?.['data spool'];
    const diskFreeInodesPct = m?.disk_free_inodes_percent?.value?.name?.['data spool'];

    res.json({
      disk: {
        freePercent: isNum(diskFreePct) ? diskFreePct : null,
        inodeFreePercent: isNum(diskFreeInodesPct) ? diskFreeInodesPct : null,
      },
      connections: { active: activeConns },
      queue: { depth, ready, scheduled },
      totals: { delivered, deferred, bounced },
    });
  } catch (e) {
    res.status(500).json({ error: 'summarize_failed', detail: String(e) });
  }
});

/** policy reload via systemd (adjust if you expose a Kumo endpoint) */
app.post('/policy/reload', async (_req, res) => {
  const child = spawn('/bin/systemctl', ['reload', 'kumomta']);
  child.on('close', (code) => res.json({ ok: code === 0, code }));
});

/** flush queue placeholder */
app.post('/queue/flush', async (_req, res) => {
  res.json({ ok: true });
});

/** logs via SSE (journalctl follow) */
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
