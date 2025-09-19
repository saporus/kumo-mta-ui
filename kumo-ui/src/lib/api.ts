const base: string = (import.meta.env.VITE_API_BASE as string) ?? '/ui/api';

export const getMetrics = async () => {
  const r = await fetch(`${base}/metrics/summary`);
  if (!r.ok) throw new Error('metrics_failed');
  return r.json();
};

export const reloadPolicy = async () => {
  const r = await fetch(`${base}/policy/reload`, { method: 'POST' });
  if (!r.ok) throw new Error('reload_failed');
  return r.json();
};

export const flushQueue = async () => {
  const r = await fetch(`${base}/queue/flush`, { method: 'POST' });
  if (!r.ok) throw new Error('flush_failed');
  return r.json();
};

export const streamLogs = () => new EventSource(`${base}/logs/stream`);

export async function getLastErrors(domain: string, limit = 1) {
  const url = `${base}/metrics/last-errors?domain=${encodeURIComponent(domain)}&limit=${limit}`;
  const r = await fetch(url); // creds omitted like others
  if (!r.ok) throw new Error(`last-errors ${domain} ${r.status}`);
  return r.json() as Promise<{
    domain: string;
    rows: Array<{ ts:number; domain:string; code?:number|string; enhanced?:string; text?:string }>;
  }>;
}
