import React, { useEffect, useMemo, useState } from 'react'
import { streamLogs, reloadPolicy, getLastErrors } from '../lib/api'
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend
} from 'recharts'

/* ----------------------------- API + utils ----------------------------- */

const API_BASE: string = (import.meta.env.VITE_API_BASE as string) ?? '/ui/api'
const n = (v: any) => (typeof v === 'number' && isFinite(v) ? v : 0)
const fmt = (v: any) => n(v).toLocaleString()

async function fetchSummary() {
  const r = await fetch(`${API_BASE}/metrics/summary`, { credentials: 'omit' })
  if (!r.ok) throw new Error('summary_failed')
  return r.json()
}

/** Backward-compatible windows picker. */
function pickWindows(metrics: any, key: 'delivered'|'deferred'|'bounced'|'received') {
  const w = metrics?.windows?.[key]
  if (w) return {
    lastHour: n(w.lastHour),
    topHour: n(w.topHour),
    lastMinute: n(w.lastMinute),
    topMinute: n(w.topMinute),
  }
  const s = metrics?.session
  if (!s) return undefined
  return {
    lastHour: n(s?.lastHour?.[key]),
    topHour: n(s?.topHour?.[key]),
    lastMinute: n(s?.lastMinute?.[key]),
    topMinute: n(s?.topMinute?.[key]),
  }
}

/** Compute OUT windows from session if traffic.* absent */
function computeOutWindowsFromSession(metrics: any) {
  const s = metrics?.session
  if (!s) return undefined
  const sum = (obj: any) => n(obj?.delivered) + n(obj?.deferred) + n(obj?.bounced)
  return {
    lastHour:  sum(s.lastHour),
    topHour:   sum(s.topHour),
    lastMinute:sum(s.lastMinute),
    topMinute: sum(s.topMinute),
  }
}

/* ----------------------------- UI Primitives ----------------------------- */

const Button = (p: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
  <button {...p} className={'px-3 py-2 rounded-xl border text-sm hover:bg-neutral-100 disabled:opacity-50 ' + (p.className ?? '')} />

const Badge: React.FC<{variant?: 'default'|'secondary'|'destructive', children: React.ReactNode}> = ({variant='default', children}) => {
  const cls = variant==='secondary' ? 'bg-neutral-100 text-neutral-800' :
             variant==='destructive' ? 'bg-red-100 text-red-700' : 'bg-black text-white';
  return <span className={'inline-flex items-center px-2 py-1 rounded-full text-xs ' + cls}>{children}</span>
}

const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) =>
  <input {...p} className={'px-3 py-2 rounded-xl border text-sm w-full ' + (p.className ?? '')} />

const Card: React.FC<{children: React.ReactNode, className?: string, title?: string, subtitle?: string}> = ({children, className, title, subtitle}) => (
  <div className={'rounded-2xl border bg-white ' + (className ?? '')}>
    {(title || subtitle) && (
      <div className="p-4 border-b">
        {title && <div className="text-sm font-semibold">{title}</div>}
        {subtitle && <div className="text-xs text-neutral-500">{subtitle}</div>}
      </div>
    )}
    <div className="p-4">{children}</div>
  </div>
)

/* --------------------------------- Layout -------------------------------- */

const Topbar: React.FC<{onToggleSidebar: ()=>void, busy?: boolean}> = ({onToggleSidebar, busy}) => (
  <div className="flex items-center justify-between p-4 border-b bg-white sticky top-0 z-10">
    <div className="flex items-center gap-3">
      <button onClick={onToggleSidebar} className="md:hidden px-3 py-2 rounded-xl border">≡</button>
      <div className="font-semibold">MagicSMTP — KumoMTA Control</div>
      <Badge variant="secondary">v2.5 preview</Badge>
      {busy && <Badge variant="secondary">auto-refresh</Badge>}
    </div>
    <div className="hidden md:flex items-center gap-2">
      <Input placeholder="Search logs, domains, IPs…" className="w-64" />
      <Button>Filter</Button>
      <Button>Policy OK</Button>
    </div>
  </div>
)

const Sidebar: React.FC<{sel:string, setSel:(v:string)=>void, open:boolean, setOpen:(v:boolean)=>void}> = ({sel,setSel,open,setOpen}) => {
  // Navigation updated per request:
  // - Removed: IP Pools, Shaping Rules, DKIM Keys
  // - Added (after Settings): About Omni → redirect to https://www.omniknoweth.com/
  const items = [
    ['dashboard','Dashboard'],
    ['queues','Queues'],
    ['logs','Logs'],
    ['api','API'],
    ['settings','Settings'],
    ['about','About Omni'],
  ] as const

  const onClick = (id: string, label: string) => {
if (id === 'about') {
  window.open('https://www.omniknoweth.com/', '_blank', 'noopener,noreferrer')
  return
}
    setSel(id)
    setOpen(false)
  }

  return (
    <aside className={(open?'fixed':'hidden') + ' md:flex md:static top-0 left-0 h-full w-64 shrink-0 border-r bg-white md:flex-col z-20'}>
      <div className="p-4">
        <div className="text-xs uppercase tracking-wider text-neutral-500 mb-2">Navigation</div>
        <nav className="space-y-1">
          {items.map(([id,label]) => (
            <button key={id} onClick={()=>onClick(id, label)}
              className={'w-full text-left px-3 py-2 rounded-xl transition ' + (sel===id?'bg-black text-white':'hover:bg-neutral-100')}>
              {label}
            </button>
          ))}
        </nav>
      </div>
      <div className="mt-auto p-4 border-t hidden md:block">
        <div className="text-xs text-neutral-500">Spool</div>
        <div className="text-sm font-medium">/var/spool/kumo</div>
        <div className="h-2 bg-neutral-100 rounded-full mt-2 overflow-hidden">
          <div className="h-full bg-neutral-800" style={{width:'28%'}} />
        </div>
        <div className="text-xs text-neutral-500 mt-1">28% used</div>
      </div>
    </aside>
  )
}

/* -------------------------------- Dashboard ------------------------------- */

const ThroughputChart: React.FC<{data:any[]}> = ({data}) => {
  const hasReceived = useMemo(() => data?.some((d:any) => typeof d?.received === 'number'), [data])
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data}>
        <defs>
          <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3"/>
        <XAxis dataKey="t" tick={{fontSize:12}}/>
        <YAxis tick={{fontSize:12}}/>
        <Tooltip/>
        <Legend />
        {hasReceived && (
          <Line type="monotone" dataKey="received" name="Received/min" stroke="var(--chart-4)" strokeWidth={2} dot={false}/>
        )}
        <Area type="monotone" dataKey="delivered" name="Delivered/min" stroke="var(--chart-1)" fill="url(#g1)"/>
        <Line type="monotone" dataKey="deferred"  name="Deferred/min"  stroke="var(--chart-3)" strokeWidth={2} dot={false}/>
        <Line type="monotone" dataKey="bounced"   name="Bounced/min"   stroke="var(--chart-2)" strokeWidth={2} dot={false}/>
      </AreaChart>
    </ResponsiveContainer>
  )
}

const QueueChart: React.FC<{data:any[]}> = ({data}) => (
  <ResponsiveContainer width="100%" height="100%">
    <LineChart data={data}>
      <CartesianGrid strokeDasharray="3 3"/>
      <XAxis dataKey="t" tick={{fontSize:12}}/>
      <YAxis tick={{fontSize:12}}/>
      <Tooltip/>
      <Legend />
      <Line type="monotone" dataKey="queued" name="Queue Depth" stroke="var(--chart-1)" strokeWidth={2} dot={false}/>
    </LineChart>
  </ResponsiveContainer>
)

const WindowGrid: React.FC<{w?: {lastHour?: number, topHour?: number, lastMinute?: number, topMinute?: number}}> = ({w}) => (
  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
    <div className="text-neutral-500">last hour</div>
    <div className="text-right">{w && isFinite(w.lastHour as number) ? fmt(w.lastHour) : '—'}</div>
    <div className="text-neutral-500">top / hour</div>
    <div className="text-right">{w && isFinite(w.topHour as number) ? fmt(w.topHour) : '—'}</div>
    <div className="text-neutral-500">last minute</div>
    <div className="text-right">{w && isFinite(w.lastMinute as number) ? fmt(w.lastMinute) : '—'}</div>
    <div className="text-neutral-500">top / minute</div>
    <div className="text-right">{w && isFinite(w.topMinute as number) ? fmt(w.topMinute) : '—'}</div>
  </div>
)

const Dashboard: React.FC<{
  metrics: any|null,
  hardRefresh: ()=>void,
  busy: boolean
}> = ({metrics /*, hardRefresh, busy*/}) => {
  // Series (works with both old and new server)
  const perMinute = metrics?.series?.perMinute ?? []
  const queue     = metrics?.series?.queue ?? []

  // Back-compat windows for cards
  const wDeferred = pickWindows(metrics, 'deferred')
  const wBounced  = pickWindows(metrics, 'bounced')

  // Traffic Totals
  const traffic = metrics?.traffic
  const totals = metrics?.totals ?? {}
  const outFromSession = computeOutWindowsFromSession(metrics)
  const trafficTotalIn  = traffic?.total?.in
  const trafficTotalOut = traffic?.total?.out ?? (n(totals.delivered) + n(totals.deferred) + n(totals.bounced))
  const trafficLHIn     = traffic?.lastHour?.in
  const trafficLHOut    = traffic?.lastHour?.out ?? outFromSession?.lastHour
  const trafficTHIn     = traffic?.topHour?.in
  const trafficTHOut    = traffic?.topHour?.out ?? outFromSession?.topHour
  const trafficLMIn     = traffic?.lastMinute?.in
  const trafficLMOut    = traffic?.lastMinute?.out ?? outFromSession?.lastMinute
  const trafficTMIn     = traffic?.topMinute?.in
  const trafficTMOut    = traffic?.topMinute?.out ?? outFromSession?.topMinute

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Overview</h2>
        {/* Buttons removed per request */}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* Traffic Totals (in/out) */}
        <Card>
          <div className="text-sm text-neutral-500 mb-1">Traffic Totals</div>
          <div className="text-xs text-neutral-500">in &nbsp;/&nbsp; out</div>
          <div className="text-2xl font-semibold mt-1">
            {(trafficTotalIn !== undefined ? fmt(trafficTotalIn) : '—')}&nbsp;/&nbsp;{fmt(trafficTotalOut)}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div className="text-neutral-500">last hour</div>
            <div className="text-right">
              {(trafficLHIn  !== undefined ? fmt(trafficLHIn)  : '—')} / {(trafficLHOut  !== undefined ? fmt(trafficLHOut)  : '—')}
            </div>
            <div className="text-neutral-500">top / hour</div>
            <div className="text-right">
              {(trafficTHIn  !== undefined ? fmt(trafficTHIn)  : '—')} / {(trafficTHOut  !== undefined ? fmt(trafficTHOut)  : '—')}
            </div>
            <div className="text-neutral-500">last minute</div>
            <div className="text-right">
              {(trafficLMIn  !== undefined ? fmt(trafficLMIn)  : '—')} / {(trafficLMOut  !== undefined ? fmt(trafficLMOut)  : '—')}
            </div>
            <div className="text-neutral-500">top / minute</div>
            <div className="text-right">
              {(trafficTMIn  !== undefined ? fmt(trafficTMIn)  : '—')} / {(trafficTMOut  !== undefined ? fmt(trafficTMOut)  : '—')}
            </div>
          </div>
        </Card>

        {/* Active connections + queue/disk */}
        <Card>
          <div className="text-sm text-neutral-500 mb-1">Active Conns</div>
          <div className="text-3xl font-semibold">{fmt(metrics?.connections?.active ?? 0)}</div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div className="text-neutral-500">queue depth</div><div className="text-right">{metrics?.queue?.depth ?? '—'}</div>
            <div className="text-neutral-500">ready</div><div className="text-right">{metrics?.queue?.ready ?? '—'}</div>
            <div className="text-neutral-500">scheduled</div><div className="text-right">{metrics?.queue?.scheduled ?? '—'}</div>
            <div className="text-neutral-500">disk free%</div><div className="text-right">{metrics?.disk?.freePercent ?? '—'}</div>
          </div>
        </Card>

        {/* Bounced */}
        <Card>
          <div className="text-sm text-neutral-500 mb-1">Bounced</div>
          <div className="text-3xl font-semibold">{fmt(metrics?.totals?.bounced)}</div>
          <WindowGrid w={pickWindows(metrics, 'bounced')}/>
        </Card>

        {/* Deferred */}
        <Card>
          <div className="text-sm text-neutral-500 mb-1">Deferred</div>
          <div className="text-3xl font-semibold">{fmt(metrics?.totals?.deferred)}</div>
          <WindowGrid w={pickWindows(metrics, 'deferred')}/>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2" title="Throughput (msgs/min)" subtitle="Per-minute rates computed from cumulative counters">
          <div className="h-72"><ThroughputChart data={perMinute}/></div>
        </Card>
        <Card title="Queue Depth">
          <div className="h-72"><QueueChart data={queue}/></div>
        </Card>
      </div>

      {/* Lists */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card title="Top Domains (Queued)">
          <div className="space-y-3">
            {(metrics?.lists?.topDomains ?? []).map((it:any) => (
              <div key={it.key} className="flex items-center justify-between p-3 rounded-xl border">
                <div className="font-medium">{it.key}</div>
                <div className="text-right font-semibold">{fmt(it.value)}</div>
              </div>
            ))}
            {(!metrics?.lists?.topDomains || metrics.lists.topDomains.length===0) && (
              <div className="text-sm text-neutral-500">No data yet.</div>
            )}
          </div>
        </Card>

        <Card title="Top Providers (Delivered)">
          <div className="space-y-3">
            {(metrics?.lists?.topProviders ?? []).map((it:any) => (
              <div key={it.key} className="flex items-center justify-between p-3 rounded-xl border">
                <div className="font-medium capitalize">{it.key}</div>
                <div className="text-right font-semibold">{fmt(it.value)}</div>
              </div>
            ))}
            {(!metrics?.lists?.topProviders || metrics.lists.topProviders.length===0) && (
              <div className="text-sm text-neutral-500">No data yet.</div>
            )}
          </div>
        </Card>

        <Card title="Top Deferrals by Domain">
          <div className="space-y-3">
            {(metrics?.lists?.topDeferralsHour ?? []).map((it: any) => (
              <div key={it.key} className="flex items-center justify-between p-3 rounded-xl border">
                <div>
                  <div className="font-medium">{it.key}</div>
                  <div className="text-xs text-neutral-500">last hour</div>
                </div>
                <div className="text-right font-semibold">{fmt(it.value)}</div>
              </div>
            ))}
            {(!metrics?.lists?.topDeferralsHour || metrics.lists.topDeferralsHour.length === 0) && (
              <div className="text-sm text-neutral-500">No deferrals in the last hour.</div>
            )}
            <hr className="my-2" />
            <div className="text-xs text-neutral-500 mb-1">Totals (retained window)</div>
            {(metrics?.lists?.topDeferralsTotal ?? []).map((it: any) => (
              <div key={it.key} className="flex items-center justify-between p-3 rounded-xl border">
                <div className="font-medium">{it.key}</div>
                <div className="text-right font-semibold">{fmt(it.value)}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Recent Events */}
      <div className="grid grid-cols-1">
        <Card title="Recent Events">
          <div className="space-y-2">
            {(metrics?.events ?? []).map((e:any, i:number) => (
              <div key={i} className="flex items-center justify-between p-3 rounded-xl border">
                <div className="flex items-center gap-3">
                  <span className={'text-xs px-2 py-1 rounded-full ' + (e.level==='WARN'?'bg-yellow-100 text-yellow-900': e.level==='ERROR'?'bg-red-100 text-red-800':'bg-green-100 text-green-800')}>
                    {e.level}
                  </span>
                  <span className="text-sm">{e.msg}</span>
                </div>
                <span className="text-xs text-neutral-500">
                  {new Date(e.t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'})}
                </span>
              </div>
            ))}
            {(!metrics?.events || metrics.events.length === 0) && (
              <div className="text-sm text-neutral-500">No events yet.</div>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

/* -------------------------- Queues: Last Error cell ----------------------- */

type LastErrorRow = { ts:number, domain:string, code?:number|string, enhanced?:string, text?:string }

const LastErrorCell: React.FC<{domain: string}> = ({ domain }) => {
  const [rows, setRows] = useState<LastErrorRow[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = await getLastErrors(domain, 5)
      // @ts-ignore
      const list: LastErrorRow[] = (data?.rows || [])
      setRows(list)
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let alive = true
    const tick = async () => { if (!alive) return; await load() }
    tick()
    const id = setInterval(tick, 30_000) // refresh every 30s
    return () => { alive = false; clearInterval(id) }
  }, [domain])

  const latest = rows[0]
  const summary = latest
    ? `${[latest.code, latest.enhanced].filter(Boolean).join(' ')} ${latest.text ?? ''}`.trim()
    : '—'

  return (
    <div className="flex items-center gap-2">
      <div className="max-w-[22rem] truncate text-xs" title={summary}>{summary || '—'}</div>
      <Button onClick={() => { setOpen(true); if (!rows.length) load() }} disabled={loading}>View</Button>

      {/* Lightweight modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/20" onClick={()=>setOpen(false)} />
          <div className="relative bg-white rounded-2xl border shadow-xl w-[min(42rem,92vw)] max-h-[80vh] overflow-auto">
            <div className="p-4 border-b flex items-center justify-between">
              <div className="text-sm font-semibold">Last Errors — {domain}</div>
              <div className="flex items-center gap-2">
                {loading && <span className="text-xs text-neutral-500">loading…</span>}
                <Button onClick={load}>Refresh</Button>
                <Button onClick={()=>setOpen(false)}>Close</Button>
              </div>
            </div>
            <div className="p-4 space-y-3">
              {rows.length === 0 && (
                <div className="text-sm text-neutral-500">No recent deferrals recorded.</div>
              )}
              {rows.map((r, i) => (
                <div key={i} className="p-3 rounded-xl border">
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-sm">
                      {[r.code, r.enhanced].filter(Boolean).join(' ') || '—'}
                    </div>
                    <div className="text-xs text-neutral-500">
                      {new Date(r.ts).toLocaleString()}
                    </div>
                  </div>
                  <div className="text-sm mt-1 whitespace-pre-wrap break-words">
                    {r.text || '—'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* --------------------------------- Queues -------------------------------- */

const Queues: React.FC<{metrics: any|null}> = ({ metrics }) => {
  // Use the backend-provided queued-by-domain list for #Rcpt
  const rows = (metrics?.lists?.topDomains ?? []) as Array<{key:string, value:number}>

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Queues</h2>
        <Button onClick={()=>window.location.reload()}>Refresh</Button>
      </div>
      <Card>
        <div className="overflow-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b bg-neutral-50">
                {['Name','#Rcpt','#KBytes','#Conn','Paused','Mode','Last Error','Actions'].map(h => (
                  <th key={h} className="text-left p-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const name = r.key
                const rcpt = r.value
                return (
                  <tr key={name || i} className="border-b hover:bg-neutral-50">
                    <td className="p-3 font-medium">{name}</td>
                    <td className="p-3">{fmt(rcpt)}</td>
                    <td className="p-3">—</td>
                    <td className="p-3">—</td>
                    <td className="p-3"><Badge variant="secondary">No</Badge></td>
                    <td className="p-3"><Badge variant="secondary">Normal</Badge></td>
                    <td className="p-3"><LastErrorCell domain={name} /></td>
                    <td className="p-3">
                      <div className="flex gap-2">
                        <Button title="(stub) Peek queue">Peek</Button>
                        <Button title="(stub) Pause domain">Pause</Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr><td className="p-3 text-neutral-500" colSpan={8}>No queued recipients detected.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

/* ---------------------------------- Logs --------------------------------- */

const LogsView: React.FC = () => {
  const [lines, setLines] = useState<string[]>([])
  useEffect(()=>{
    const es = streamLogs()
    es.onmessage = (e)=> setLines(prev => [...prev.slice(-2000), e.data])
    return ()=> es.close()
  },[])
  return (
    <div className="p-4 md:p-6 space-y-4">
      <h2 className="text-xl font-semibold">Logs</h2>
      <Card>
        <pre className="bg-black text-white p-4 rounded-xl text-xs h-96 overflow-auto">
{lines.join('\n')}
        </pre>
      </Card>
    </div>
  )
}

/* ----------------------------------- API --------------------------------- */

const ApiView: React.FC = () => (
  <div className="p-4 md:p-6 space-y-4">
    <h2 className="text-xl font-semibold">API</h2>
    <Card>
      <div className="text-sm text-neutral-500 mb-2">Endpoints</div>
      <ul className="list-disc pl-6 text-sm space-y-1">
        <li>GET <code>/ui/api/metrics</code> — raw metrics</li>
        <li>GET <code>/ui/api/metrics/summary</code> — dashboard summary</li>
        <li>POST <code>/ui/api/policy/reload</code> — reload policy</li>
        <li>POST <code>/ui/api/queue/flush</code> — flush queues</li>
        <li>GET <code>/ui/api/logs/stream</code> — live logs via SSE</li>
        <li>GET <code>/ui/api/metrics/last-errors?domain=&lt;d&gt;&amp;limit=5</code> — last error reasons (per domain)</li>
      </ul>
    </Card>
  </div>
)

/* -------------------------------- Settings -------------------------------- */

const SettingsView: React.FC = () => (
  <div className="p-4 md:p-6 space-y-4">
    <h2 className="text-xl font-semibold">Settings</h2>
    <Card>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <div className="text-xs text-neutral-500 mb-1">Spool Path</div>
          <Input defaultValue="/var/spool/kumo" />
        </div>
        <div>
          <div className="text-xs text-neutral-500 mb-1">Policy File</div>
          <Input defaultValue="/opt/kumomta/etc/policy/init.lua" />
        </div>
        <div>
          <div className="text-xs text-neutral-500 mb-1">Metrics Endpoint</div>
          <Input defaultValue="http://127.0.0.1:8000/metrics.json" />
        </div>
      </div>
      <div className="flex gap-2 mt-4">
        <Button>Test Connection</Button>
        <Button>Save</Button>
      </div>
    </Card>
  </div>
)

/* ---------------------------------- App ---------------------------------- */

const App: React.FC = () => {
  const [sel, setSel] = useState('dashboard')
  const [open, setOpen] = useState(false)
  const [metrics, setMetrics] = useState<any|null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      const m = await fetchSummary()
      setMetrics(m)
    } catch { /* keep UI up with last data */ }
  }

  useEffect(() => {
    let alive = true
    const tick = async () => { if (!alive) return; await load() }
    tick()
    const id = setInterval(tick, 3000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const hardRefresh = async () => {
    setBusy(true)
    try { await reloadPolicy() } catch {}
    await load()
    setBusy(false)
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-neutral-50 to-white text-neutral-900">
      <Topbar onToggleSidebar={()=>setOpen(!open)} busy />
      <div className="flex">
        <Sidebar sel={sel} setSel={setSel} open={open} setOpen={setOpen} />
        <main className="flex-1">
          {sel==='dashboard' && <Dashboard metrics={metrics} hardRefresh={hardRefresh} busy={busy} />}
          {sel==='queues' && <Queues metrics={metrics} />}
          {sel==='logs' && <LogsView/>}
          {sel==='api' && <ApiView/>}
          {sel==='settings' && <SettingsView/>}
        </main>
      </div>
      <footer className="p-4 text-xs text-center text-neutral-500 border-t">
        <a href="https://www.omniknoweth.com" className="hover:underline" target="_blank" rel="noopener noreferrer">
  © 2025 Intelligence Codes — MagicSMTP × KumoMTA — UI
</a>
      </footer>
    </div>
  )
}

export default App
