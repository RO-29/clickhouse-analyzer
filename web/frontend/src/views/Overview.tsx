import { useEffect, useState, useCallback, useRef, type FC } from 'react'
import { RefreshCw, Sparkles, Zap, AlertTriangle, Settings2, ChevronUp, ChevronDown } from 'lucide-react'
import { cn, fmtNum, fmtTime, scoreColor } from '../lib/utils'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { Card, Section } from '../components/Card'
import { Badge } from '../components/Badge'
import { NodeCard } from '../components/NodeCard'
import { DataTable } from '../components/DataTable'
import { AlertDetailPanel } from '../components/AlertDetailPanel'
import { MetricChart } from '../components/MetricChart'
import { flashToast } from '../lib/notify'
import type { Instance, Alert, AlertStats, HealthResponse, QueryPatternV2, SLOReport } from '../types/api'

/* ── Dashboard widget types ─────────────────────────────────────────────── */

type WidgetType =
  | 'active_alerts'
  | 'health_scores'
  | 'query_throughput'
  | 'disk_usage'
  | 'insert_rate'
  | 'error_rate'
  | 'slow_queries'
  | 'slo_overview'
  | 'uptime'
  | 'live_queries'

interface DashboardWidget {
  id: string
  type: WidgetType
  enabled: boolean
  order: number
}

const WIDGET_LABELS: Record<WidgetType, string> = {
  active_alerts: 'Active Alerts',
  health_scores: 'Health Scores',
  query_throughput: 'Query Throughput',
  disk_usage: 'Disk Usage',
  insert_rate: 'Insert Rate',
  error_rate: 'Error Rate',
  slow_queries: 'Slow Queries',
  slo_overview: 'SLO Overview',
  uptime: 'Uptime',
  live_queries: 'Live Queries',
}

const DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: 'w1', type: 'health_scores',     enabled: true, order: 0 },
  { id: 'w2', type: 'active_alerts',     enabled: true, order: 1 },
  { id: 'w3', type: 'query_throughput',  enabled: true, order: 2 },
  { id: 'w4', type: 'disk_usage',        enabled: true, order: 3 },
  { id: 'w5', type: 'error_rate',        enabled: true, order: 4 },
  { id: 'w6', type: 'slow_queries',      enabled: true, order: 5 },
  { id: 'w7', type: 'slo_overview',      enabled: true, order: 6 },
  { id: 'w8', type: 'insert_rate',       enabled: true, order: 7 },
  { id: 'w9', type: 'uptime',            enabled: true, order: 8 },
  { id: 'w10', type: 'live_queries',    enabled: true, order: 9 },
]

function loadWidgetLayout(): DashboardWidget[] {
  try {
    const saved = JSON.parse(localStorage.getItem('ch-dashboard-layout') ?? 'null')
    if (Array.isArray(saved) && saved.length > 0) {
      const savedTypes = new Set(saved.map((w: DashboardWidget) => w.type))
      const maxOrder = saved.reduce((m: number, w: DashboardWidget) => Math.max(m, w.order), -1)
      const newWidgets = DEFAULT_WIDGETS
        .filter(w => !savedTypes.has(w.type))
        .map((w, i) => ({ ...w, order: maxOrder + 1 + i }))
      return [...saved, ...newWidgets]
    }
  } catch {}
  return DEFAULT_WIDGETS
}

function saveWidgetLayout(widgets: DashboardWidget[]) {
  localStorage.setItem('ch-dashboard-layout', JSON.stringify(widgets))
}

/* ── WidgetCard shell ───────────────────────────────────────────────────── */

interface WidgetCardProps {
  title: string
  scope?: string
  children: React.ReactNode
  onRefresh?: () => void
  loading?: boolean
  noInnerPad?: boolean
}

function WidgetCard({ title, scope, children, onRefresh, loading, noInnerPad }: WidgetCardProps) {
  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--dim)] flex-1">
          {title}
        </span>
        {scope && (
          <span className="text-[9px] text-[var(--dim)] bg-[var(--surface)] px-1.5 py-0.5 rounded-full border border-[var(--border)] shrink-0">
            {scope}
          </span>
        )}
        {onRefresh && (
          <button
            onClick={onRefresh}
            className="text-[var(--dim)] hover:text-[var(--text)] transition-colors p-0.5 rounded"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        )}
      </div>
      {loading && !noInnerPad ? (
        <div className="px-3 py-3 space-y-2">
          {[80, 60, 40].map(w => (
            <div key={w} className="h-3 rounded bg-[var(--surface)] animate-pulse" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : (
        <div className={noInnerPad ? '' : 'px-3 py-3'}>
          {children}
        </div>
      )}
    </div>
  )
}

/* ── Widget: Active Alerts ──────────────────────────────────────────────── */

function ActiveAlertsWidget({ setView }: { setView: (v: any) => void }) {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    setLoading(true)
    api.alerts.active()
      .then(setAlerts)
      .catch(() => setAlerts([]))
      .finally(() => setLoading(false))
  }, [tick])

  const sevDot = (sev: string) => {
    const colors: Record<string, string> = {
      critical: '#ef4444',
      warn: '#eab308',
      warning: '#eab308',
      info: '#60a5fa',
    }
    return (
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0 inline-block"
        style={{ backgroundColor: colors[sev] ?? '#94a3b8' }}
      />
    )
  }

  const top5 = alerts.slice(0, 5)

  return (
    <WidgetCard title="Active Alerts" scope="All instances" onRefresh={() => setTick(t => t + 1)} loading={loading}>
      {alerts.length === 0 ? (
        <div className="text-[var(--dim)] text-xs py-4 text-center">No active alerts</div>
      ) : (
        <div className="space-y-1">
          <div className="text-2xl font-bold tabular-nums" style={{ color: alerts.length > 0 ? '#ef4444' : undefined }}>
            {alerts.length}
          </div>
          <div className="space-y-1 mt-2">
            {top5.map(a => (
              <div key={a.id} className="flex items-center gap-2 text-xs">
                {sevDot(a.severity)}
                <span className="truncate flex-1 text-[var(--text)]">{a.title}</span>
                <span className="text-[var(--dim)] shrink-0">{a.instance}</span>
              </div>
            ))}
          </div>
          {alerts.length > 5 && (
            <div className="text-[10px] text-[var(--dim)] mt-1">+{alerts.length - 5} more</div>
          )}
          <button
            onClick={() => setView('alerts')}
            className="text-[11px] text-[var(--accent)] hover:underline mt-2 block"
          >
            View all →
          </button>
        </div>
      )}
    </WidgetCard>
  )
}

/* ── Widget: Health Scores ──────────────────────────────────────────────── */

function HealthScoresWidget({ setView: _setView }: { setView: (v: any) => void }) {
  const { navToDetail } = useStore()
  const [instanceList, setInstanceList] = useState<Instance[]>([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    setLoading(true)
    api.overview()
      .then(setInstanceList)
      .catch(() => setInstanceList([]))
      .finally(() => setLoading(false))
  }, [tick])

  return (
    <WidgetCard title="Health Scores" scope="Per instance" onRefresh={() => setTick(t => t + 1)} loading={loading}>
      {instanceList.length === 0 ? (
        <div className="text-[var(--dim)] text-xs py-4 text-center">No instances</div>
      ) : (
        <div className="space-y-1.5">
          {instanceList.map(inst => {
            const color = scoreColor(inst.health_score)
            const score = Math.round(inst.health_score)
            const crit = inst.alert_counts?.crit ?? 0
            const warn = inst.alert_counts?.warn ?? 0
            return (
              <div key={inst.name} className="flex items-center gap-2 text-xs">
                <span className="flex-1 truncate text-[var(--text)]">{inst.name}</span>
                <span
                  className="font-mono font-semibold text-[11px] px-1.5 py-0.5 rounded"
                  style={{ color, backgroundColor: color + '1a' }}
                >
                  {score}
                </span>
                {crit > 0 && <span className="text-[10px] text-red-400">{crit}C</span>}
                {warn > 0 && <span className="text-[10px] text-yellow-400">{warn}W</span>}
                <button
                  onClick={() => navToDetail(inst.name)}
                  className="text-[var(--accent)] text-[10px] hover:underline shrink-0"
                >
                  Open →
                </button>
              </div>
            )
          })}
        </div>
      )}
    </WidgetCard>
  )
}

/* ── Widget: Query Throughput ───────────────────────────────────────────── */

function QueryThroughputWidget({ instances }: { instances: string[] }) {
  return (
    <WidgetCard title="Query Throughput" scope="All instances" noInnerPad>
      <MetricChart
        instances={instances}
        metrics={['system.metrics.Query']}
        title="Active Queries"
        height={120}
      />
    </WidgetCard>
  )
}

/* ── Widget: Disk Usage ─────────────────────────────────────────────────── */

function DiskUsageWidget({ instances }: { instances: string[] }) {
  return (
    <WidgetCard title="Disk Usage" scope="All instances" noInnerPad>
      <MetricChart
        instances={instances}
        metrics={['storage.disk.used_percent']}
        title="Disk Used %"
        height={120}
        yFormat="percent"
      />
    </WidgetCard>
  )
}

/* ── Widget: Insert Rate ────────────────────────────────────────────────── */

function InsertRateWidget({ instances }: { instances: string[] }) {
  return (
    <WidgetCard title="Insert Rate" scope="All instances" noInnerPad>
      <MetricChart
        instances={instances}
        metrics={['inserts.total.rows']}
        title="Inserted Rows"
        height={120}
      />
    </WidgetCard>
  )
}

/* ── Widget: Error Rate ─────────────────────────────────────────────────── */

function StatMini({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="text-center">
      <div className="text-xl font-bold tabular-nums" style={{ color }}>{fmtNum(value)}</div>
      <div className="text-[10px] text-[var(--dim)] uppercase tracking-wider mt-0.5">{label}</div>
    </div>
  )
}

function ErrorRateWidget() {
  const [stats, setStats] = useState<AlertStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    setLoading(true)
    api.alerts.stats(24)
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setLoading(false))
  }, [tick])

  return (
    <WidgetCard title="Error Rate (24h)" scope="All instances · cumulative" onRefresh={() => setTick(t => t + 1)} loading={loading}>
      {!stats ? (
        <div className="text-[var(--dim)] text-xs py-4 text-center">No data</div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <StatMini label="Fired" value={stats.total_fired} />
          <StatMini label="Critical" value={stats.critical} color="#ef4444" />
          <StatMini label="Resolved" value={stats.resolved} color="#22c55e" />
        </div>
      )}
    </WidgetCard>
  )
}

/* ── Widget: Slow Queries ───────────────────────────────────────────────── */

function SlowQueriesWidget({ inst, from, to, setView }: { inst: string; from: number; to: number; setView: (v: any) => void }) {
  const { navToExploreWithRange } = useStore()
  const [patterns, setPatterns] = useState<QueryPatternV2[]>([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    setLoading(true)
    api.history.queryPatternsV2(inst, from, to, 5, 'avg_ms')
      .then(setPatterns)
      .catch(() => setPatterns([]))
      .finally(() => setLoading(false))
  }, [inst, from, to, tick])

  return (
    <WidgetCard title="Slow Queries" scope={`${inst} · top 5`} onRefresh={() => setTick(t => t + 1)} loading={loading}>
      {patterns.length === 0 ? (
        <div className="text-[var(--dim)] text-xs py-4 text-center">No query data</div>
      ) : (
        <div className="space-y-0.5">
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-2 pb-1 border-b border-[var(--border)]">
            <span className="text-[10px] text-[var(--dim)] uppercase tracking-wider">Query</span>
            <span className="text-[10px] text-[var(--dim)] uppercase tracking-wider text-right">Avg ms</span>
            <span className="text-[10px] text-[var(--dim)] uppercase tracking-wider text-right">Count</span>
          </div>
          {patterns.map(p => (
            <div
              key={p.normalized_query_hash}
              className="grid grid-cols-[1fr_auto_auto] gap-x-2 py-0.5 text-xs cursor-pointer hover:bg-[var(--hover)] rounded px-1 -mx-1"
              onClick={() => {
                const url = new URL(window.location.href)
                url.searchParams.set('view', 'explore')
                url.searchParams.set('tab', 'patterns')
                url.searchParams.set('hash', p.normalized_query_hash)
                window.history.pushState(null, '', url.toString())
                setView('explore')
              }}
            >
              <span className="truncate text-[var(--text)] font-mono text-[10px]" title={p.sample_query}>
                {p.normalized_query_hash.slice(0, 8)}
              </span>
              <span className="text-right tabular-nums text-[var(--dim)]">{p.avg_ms.toFixed(0)}</span>
              <span className="text-right tabular-nums text-[var(--dim)]">{fmtNum(p.cnt)}</span>
            </div>
          ))}
          <button
            onClick={() => navToExploreWithRange(inst, from, to)}
            className="text-[11px] text-[var(--accent)] hover:underline mt-1 block"
          >
            Open Explore →
          </button>
        </div>
      )}
    </WidgetCard>
  )
}

/* ── Widget: SLO Overview ───────────────────────────────────────────────── */

function SLOOverviewWidget({ instances }: { instances: string[] }) {
  const [rows, setRows] = useState<{ name: string; report: SLOReport | null }[]>([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (instances.length === 0) { setLoading(false); return }
    setLoading(true)
    Promise.all(
      instances.map(name => api.slo(name, 7).then(r => ({ name, report: r })).catch(() => ({ name, report: null })))
    ).then(setRows).finally(() => setLoading(false))
  }, [instances, tick])  // eslint-disable-line react-hooks/exhaustive-deps

  const pctColor = (v: number) => {
    if (v >= 99) return '#22c55e'
    if (v >= 95) return '#eab308'
    return '#ef4444'
  }

  return (
    <WidgetCard title="SLO Overview (7d)" scope="Per instance" onRefresh={() => setTick(t => t + 1)} loading={loading}>
      {rows.length === 0 ? (
        <div className="text-[var(--dim)] text-xs py-4 text-center">No instances</div>
      ) : (
        <div className="space-y-0.5">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 pb-1 border-b border-[var(--border)]">
            <span className="text-[10px] text-[var(--dim)] uppercase tracking-wider">Instance</span>
            <span className="text-[10px] text-[var(--dim)] uppercase tracking-wider text-right">Uptime</span>
            <span className="text-[10px] text-[var(--dim)] uppercase tracking-wider text-right">Healthy</span>
            <span className="text-[10px] text-[var(--dim)] uppercase tracking-wider text-right">Score</span>
          </div>
          {rows.map(({ name, report }) => (
            <div key={name} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 py-0.5 text-xs items-center">
              <span className="truncate text-[var(--text)]">{name}</span>
              {report ? (
                report.total_polls === 0 ? (
                  <span className="col-span-3 text-right text-[var(--dim)] text-[10px]">No data yet</span>
                ) : (
                  <>
                    <span className="text-right tabular-nums font-mono text-[11px]" style={{ color: pctColor(report.uptime_pct) }}>
                      {report.uptime_pct.toFixed(1)}%
                    </span>
                    <span className="text-right tabular-nums font-mono text-[11px]" style={{ color: pctColor(report.healthy_pct) }}>
                      {report.healthy_pct.toFixed(1)}%
                    </span>
                    <span className="text-right tabular-nums font-mono text-[11px]" style={{ color: scoreColor(report.p50_score) }}>
                      {Math.round(report.p50_score)}
                    </span>
                  </>
                )
              ) : (
                <span className="col-span-3 text-right text-[var(--dim)] text-[10px]">No data</span>
              )}
            </div>
          ))}
        </div>
      )}
    </WidgetCard>
  )
}

/* ── Widget: Uptime ─────────────────────────────────────────────────────── */

function UptimeWidget({ instances }: { instances: string[] }) {
  const now = Math.floor(Date.now() / 1000)
  const from = now - 300
  const [uptimes, setUptimes] = useState<{ name: string; secs: number | null }[]>([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (instances.length === 0) { setLoading(false); return }
    setLoading(true)
    Promise.all(
      instances.map(name =>
        api.metrics(name, 'system.uptime_seconds', from, now)
          .then(r => {
            const pts = r.points
            const val = pts.length > 0 ? pts[pts.length - 1].value : null
            return { name, secs: val }
          })
          .catch(() => ({ name, secs: null }))
      )
    ).then(setUptimes).finally(() => setLoading(false))
  }, [instances.join(','), tick]) // eslint-disable-line react-hooks/exhaustive-deps

  const formatUptime = (secs: number) => {
    const d = Math.floor(secs / 86400)
    const h = Math.floor((secs % 86400) / 3600)
    const m = Math.floor((secs % 3600) / 60)
    if (d > 0) return `${d}d ${h}h`
    if (h > 0) return `${h}h ${m}m`
    return `${m}m`
  }

  return (
    <WidgetCard title="Uptime" scope="Per instance" onRefresh={() => setTick(t => t + 1)} loading={loading}>
      {uptimes.length === 0 ? (
        <div className="text-[var(--dim)] text-xs py-4 text-center">No data</div>
      ) : (
        <div className="space-y-1.5">
          {uptimes.map(({ name, secs }) => (
            <div key={name} className="flex items-center gap-2 text-xs">
              <span className="flex-1 truncate text-[var(--text)]">{name}</span>
              {secs !== null ? (
                <span className="font-mono text-[11px] text-[var(--text)]">{formatUptime(secs)}</span>
              ) : (
                <span className="text-[var(--dim)] text-[10px]">—</span>
              )}
            </div>
          ))}
        </div>
      )}
    </WidgetCard>
  )
}

/* ── Widget: Live Queries ───────────────────────────────────────────────── */

interface LiveQuery {
  instance: string
  query_id: string
  query_short: string
  user: string
  elapsed: number
  memory: string
  read_size: string
  query_kind: string
}

function LiveQueriesWidget({ instances }: { instances: string[] }) {
  const { setView, setSelectedInstance } = useStore()
  const [rows, setRows] = useState<LiveQuery[]>([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (instances.length === 0) { setLoading(false); return }
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const results = await Promise.all(
          instances.map(inst =>
            api.queries(inst)
              .then((qs: any[]) => qs.map(q => ({ ...q, instance: inst })))
              .catch(() => [] as LiveQuery[])
          )
        )
        if (!cancelled) {
          const all = (results.flat() as LiveQuery[])
            .sort((a, b) => b.elapsed - a.elapsed)
          setRows(all)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    timerRef.current = setInterval(load, 15_000)
    return () => {
      cancelled = true
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [instances.join(','), tick]) // eslint-disable-line react-hooks/exhaustive-deps

  const fmtElapsed = (s: number) => {
    if (s < 60) return `${s.toFixed(0)}s`
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}m ${sec}s`
  }

  const navToLive = (instance: string) => {
    setSelectedInstance(instance)
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'explore')
    url.searchParams.set('instance', instance)
    url.searchParams.set('tab', 'live')
    window.history.pushState(null, '', url.toString())
    setView('explore')
  }

  return (
    <WidgetCard
      title="Live Queries"
      scope="All instances · live"
      onRefresh={() => setTick(t => t + 1)}
      loading={loading}
    >
      {rows.length === 0 ? (
        <div className="text-[var(--dim)] text-xs py-4 text-center">No running queries</div>
      ) : (
        <div className="space-y-0.5">
          <div className="grid grid-cols-[auto_auto_1fr_auto] gap-x-2 pb-1 border-b border-[var(--border)] text-[10px] text-[var(--dim)] uppercase tracking-wider">
            <span>Instance</span>
            <span className="text-right">Elapsed</span>
            <span>Query</span>
            <span className="text-right">Mem</span>
          </div>
          {rows.slice(0, 15).map((q, i) => {
            const isCrit = q.elapsed >= 60
            const isWarn = !isCrit && q.elapsed >= 30
            return (
              <div
                key={`${q.instance}-${q.query_id}-${i}`}
                className="grid grid-cols-[auto_auto_1fr_auto] gap-x-2 py-0.5 text-[11px] items-center cursor-pointer hover:bg-[var(--hover)] rounded px-1 -mx-1 group"
                onClick={() => navToLive(q.instance)}
                title={`Open Live Queries for ${q.instance}`}
              >
                <span className="text-[var(--accent)] text-[10px] font-mono shrink-0 group-hover:underline">
                  {q.instance.replace('single-node-', '')}
                </span>
                <span
                  className="tabular-nums font-mono text-right shrink-0"
                  style={{ color: isCrit ? '#ef4444' : isWarn ? '#eab308' : 'var(--text)' }}
                >
                  {fmtElapsed(q.elapsed)}
                </span>
                <span className="font-mono text-[10px] text-[var(--dim)] truncate" title={q.query_short}>
                  {q.query_kind ? `[${q.query_kind}] ` : ''}{q.query_short}
                </span>
                <span className="text-[var(--dim)] text-[10px] text-right shrink-0">{q.memory}</span>
              </div>
            )
          })}
          {rows.length > 15 && (
            <div className="text-[10px] text-[var(--dim)] pt-1">+{rows.length - 15} more</div>
          )}
          <div className="flex gap-3 pt-1 flex-wrap">
            {instances.map(inst => (
              <button
                key={inst}
                onClick={() => navToLive(inst)}
                className="text-[11px] text-[var(--accent)] hover:underline"
              >
                {inst.replace('single-node-', '')} live →
              </button>
            ))}
          </div>
        </div>
      )}
    </WidgetCard>
  )
}

/* ── WidgetWrapper ──────────────────────────────────────────────────────── */

interface WidgetWrapperProps {
  widget: DashboardWidget
  inst: string
  from: number
  to: number
  instances: string[]
  setView: (v: any) => void
}

function WidgetWrapper({ widget, inst, from, to, instances, setView }: WidgetWrapperProps) {
  switch (widget.type) {
    case 'active_alerts':
      return <ActiveAlertsWidget setView={setView} />
    case 'health_scores':
      return <HealthScoresWidget setView={setView} />
    case 'query_throughput':
      return <QueryThroughputWidget instances={instances} />
    case 'disk_usage':
      return <DiskUsageWidget instances={instances} />
    case 'insert_rate':
      return <InsertRateWidget instances={instances} />
    case 'error_rate':
      return <ErrorRateWidget />
    case 'slow_queries':
      return <SlowQueriesWidget inst={inst} from={from} to={to} setView={setView} />
    case 'slo_overview':
      return <SLOOverviewWidget instances={instances} />
    case 'uptime':
      return <UptimeWidget instances={instances} />
    case 'live_queries':
      return <LiveQueriesWidget instances={instances} />
    default:
      return null
  }
}

/* ── Loading skeleton ──────────────────────────────────────────────────── */
function Skeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
        {[...Array(7)].map((_, i) => (
          <div key={i} className="h-14 bg-[var(--card)] rounded-lg border border-[var(--border)]" />
        ))}
      </div>
      <div className="h-32 bg-[var(--card)] rounded-lg border border-[var(--border)]" />
    </div>
  )
}

/* ── Alert Activity Strip ──────────────────────────────────────────────── */
function AlertActivityStrip({ onViewHistory }: { onViewHistory: () => void }) {
  const [stats, setStats] = useState<AlertStats | null>(null)
  useEffect(() => {
    api.alerts.stats(24).then(setStats).catch(() => {})
  }, [])

  if (!stats || stats.total_fired === 0) return null

  const fmtDur = (s: number) => {
    if (s <= 0) return null
    if (s < 3600) return `${Math.round(s / 60)}m avg`
    return `${Math.round(s / 3600)}h avg`
  }
  const dur = fmtDur(stats.avg_duration_secs)

  return (
    <button
      onClick={onViewHistory}
      className="w-full text-left rounded-lg border border-[var(--border)] bg-[var(--card)] hover:border-[var(--accent)]/40 transition-colors px-4 py-2.5 flex items-center gap-4 flex-wrap"
    >
      <span className="text-[10px] font-semibold text-[var(--dim)] uppercase tracking-widest">24h alert activity</span>
      <span className="flex items-center gap-1.5 text-[12px]">
        <span className="font-semibold">{stats.total_fired}</span>
        <span className="text-[var(--dim)]">fired</span>
      </span>
      {stats.currently_firing > 0 && (
        <span className="flex items-center gap-1.5 text-[12px] text-[#ef4444]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#ef4444] animate-pulse" />
          <span className="font-semibold">{stats.currently_firing}</span>
          <span className="opacity-70">firing now</span>
        </span>
      )}
      <span className="flex items-center gap-1.5 text-[12px] text-[#22c55e]">
        <span className="font-semibold">{stats.resolved}</span>
        <span className="text-[var(--dim)]">resolved</span>
      </span>
      {dur && <span className="text-[12px] text-[var(--dim)]">{dur}</span>}
      {stats.top_categories[0] && (
        <span className="text-[12px] text-[var(--dim)]">
          top: <span className="text-[var(--text)]">{stats.top_categories[0].category}</span>
        </span>
      )}
      <span className="ml-auto text-[11px] text-[var(--accent)]">View history →</span>
    </button>
  )
}

/* ── Metric chip ─────────────────────────────────────────────────────── */
function MetricChip({
  label, value, valueColor, onClick, active,
}: {
  label: string
  value: string | number
  valueColor?: string
  onClick?: () => void
  active?: boolean
}) {
  return (
    <div
      className={`bg-[var(--card)] border rounded-lg px-4 py-3 flex flex-col justify-between ${
        onClick ? 'cursor-pointer hover:border-[var(--accent)]/40 transition-colors' : ''
      } ${active ? 'border-[var(--accent)]/40' : 'border-[var(--border)]'}`}
      onClick={onClick}
    >
      <div
        className="text-xl font-bold tabular-nums leading-tight"
        style={{ color: valueColor }}
      >
        {value}
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-widest text-[var(--dim)] mt-1">
        {label}
      </div>
    </div>
  )
}

/* ── Setup Wizard ────────────────────────────────────────────────────── */
const YAML_SNIPPET = `instances:
  - name: my-cluster
    host: localhost
    port: 9000
    user: default
    password: ""
    database: default`

const RESTART_SNIPPET = `sudo systemctl restart ch-analyzer
# or if running locally:
./ch-analyzer --config path/to/config.yaml`

function CopyBlock({ snippet }: { snippet: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  return (
    <div className="relative">
      <pre className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3 text-xs font-mono overflow-x-auto text-[var(--text)]">
        {snippet}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--card)] border border-[var(--border)] text-[var(--dim)] hover:text-[var(--text)] hover:border-[var(--accent)]/40 transition-colors"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  )
}

const SetupWizard: FC<{ onExplore: () => void }> = ({ onExplore }) => (
  <div className="max-w-lg mx-auto py-16 px-4">
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-8 space-y-8">
      {/* Header */}
      <div className="text-center space-y-1">
        <h2 className="text-lg font-semibold text-[var(--text)]">Get started with CH Analyzer</h2>
        <p className="text-sm text-[var(--dim)]">Monitor your ClickHouse instances in minutes</p>
      </div>

      {/* Step 1 */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--accent)]/15 border border-[var(--accent)]/30 flex items-center justify-center text-[11px] font-bold text-[var(--accent)]">1</span>
          <span className="text-sm font-medium text-[var(--text)]">Connect your first ClickHouse instance</span>
        </div>
        <p className="text-xs text-[var(--dim)] pl-9">
          Add an <code className="font-mono bg-[var(--surface)] px-1 py-0.5 rounded border border-[var(--border)]">instances</code> block to your config file:
        </p>
        <div className="pl-9">
          <CopyBlock snippet={YAML_SNIPPET} />
        </div>
      </div>

      {/* Step 2 */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--accent)]/15 border border-[var(--accent)]/30 flex items-center justify-center text-[11px] font-bold text-[var(--accent)]">2</span>
          <span className="text-sm font-medium text-[var(--text)]">Restart to connect</span>
        </div>
        <p className="text-xs text-[var(--dim)] pl-9">After saving your config file, restart ch-analyzer:</p>
        <div className="pl-9">
          <CopyBlock snippet={RESTART_SNIPPET} />
        </div>
      </div>

      {/* Footer link */}
      <div className="text-center pt-2">
        <button onClick={onExplore} className="text-[var(--accent)] hover:underline text-sm">
          Explore features →
        </button>
      </div>
    </div>
  </div>
)

/* ── Overview ────────────────────────────────────────────────────────── */
export default function Overview({ refreshKey }: { refreshKey?: number }) {
  const { setView, setInstance, setInstances, navToAlerts, navToDetail, denseMode, from, to } = useStore()
  const [analyzeInstance, setAnalyzeInstance] = useState('')
  const { analyze } = useAIAnalysis(analyzeInstance)
  const handleAnalyze = useCallback((data: Record<string, any>) => {
    analyze('Overview', data, { contextType: 'tab', tab: 'overview' })
  }, [analyze])

  const [instances, setLocalInstances] = useState<Instance[]>([])
  const [sortBy, setSortBy] = useState<'score' | 'name'>('score')
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [manualRefreshTick, setManualRefreshTick] = useState(0)
  const [forcingPoll, setForcingPoll] = useState(false)
  const [forcePollMsg, setForcePollMsg] = useState('')
  const [healthData, setHealthData] = useState<HealthResponse | null>(null)
  const isFirstLoad = useRef(true)

  // Widget panel state
  const [widgets, setWidgets] = useState<DashboardWidget[]>(loadWidgetLayout)
  const [widgetEditMode, setWidgetEditMode] = useState(false)
  const [widgetPanelOpen, setWidgetPanelOpen] = useState(false)

  const enabledWidgets = widgets.filter(w => w.enabled).sort((a, b) => a.order - b.order)

  const toggleWidget = useCallback((id: string) => {
    const next = widgets.map(w => w.id === id ? { ...w, enabled: !w.enabled } : w)
    setWidgets(next)
    saveWidgetLayout(next)
    flashToast('Layout saved', 'done')
  }, [widgets])

  const moveWidget = useCallback((id: string, dir: 'up' | 'down') => {
    const sorted = [...widgets].sort((a, b) => a.order - b.order)
    const idx = sorted.findIndex(w => w.id === id)
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= sorted.length) return
    const next = sorted.map((w, i) => {
      if (i === idx)     return { ...w, order: sorted[swapIdx].order }
      if (i === swapIdx) return { ...w, order: sorted[idx].order }
      return w
    })
    setWidgets(next)
    saveWidgetLayout(next)
    flashToast('Layout saved', 'done')
  }, [widgets])

  const handleForcePoll = useCallback(async () => {
    setForcingPoll(true)
    setForcePollMsg('')
    try {
      await api.forcePoll()
      setForcePollMsg('Polling now…')
      setTimeout(() => setManualRefreshTick(t => t + 1), 3000)
      setTimeout(() => setForcePollMsg(''), 5000)
    } catch {
      setForcePollMsg('Failed')
      setTimeout(() => setForcePollMsg(''), 3000)
    } finally {
      setForcingPoll(false)
    }
  }, [])

  const doLoad = useCallback(async () => {
    let cancelled = false
    if (isFirstLoad.current) setLoading(true)
    else setRefreshing(true)
    try {
      const [inst, alrt] = await Promise.all([
        api.overview(),
        api.alerts.active(),
      ])
      api.health().then(h => { if (!cancelled) setHealthData(h) }).catch(() => {})
      if (!cancelled) {
        setLocalInstances(inst ?? [])
        setAlerts(alrt ?? [])
        setInstances((inst ?? []).map(i => i.name))
        setLastRefreshed(new Date())
        if (inst.length > 0) {
          const worst = [...inst].sort((a, b) => a.health_score - b.health_score)[0]
          setAnalyzeInstance(worst.name)
        }
      }
    } catch (e: any) {
      if (!cancelled) setLoadError(e?.message ?? 'Failed to load data')
    } finally {
      if (!cancelled) {
        setLoading(false)
        setRefreshing(false)
        isFirstLoad.current = false
      }
    }
    return () => { cancelled = true }
  }, [setInstances])

  useEffect(() => {
    let cleanup: (() => void) | undefined
    doLoad().then(c => { cleanup = c })
    return () => { cleanup?.() }
  }, [doLoad, refreshKey, manualRefreshTick])

  if (loading) return <Skeleton />

  if (loadError && (instances?.length ?? 0) === 0) return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <AlertTriangle size={32} className="text-red-400 opacity-70" />
      <div>
        <div className="text-sm font-medium text-[var(--fg)]">Failed to load instances</div>
        <div className="text-xs text-[var(--dim)] mt-1">{loadError}</div>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={() => setManualRefreshTick(t => t + 1)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-sm hover:opacity-90 transition-opacity"
        >
          <RefreshCw size={14} /> Retry
        </button>
        <button
          onClick={() => setView('overview')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-sm text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)] transition-colors"
        >
          Overview
        </button>
      </div>
    </div>
  )

  /* ---- derived stats ---- */
  const totalInstances = instances.length
  const staleHours = (() => { try { return parseInt(localStorage.getItem('ch-stale-hours') ?? '24', 10) || 24 } catch { return 24 } })()
  const now = Date.now() / 1000
  // Use updated_at preferring positive values — negative means the backend returned a
  // zero time.Time (year 0001 = unix -62135596800), which would make every alert look
  // ancient and hide it from the Overview. Fall back to now so those alerts stay visible.
  const alertAge = (a: Alert) => {
    const ts = (a.updated_at ?? a.created_at)
    return ts > 0 ? now - ts : 0
  }
  const isFresh = (a: Alert) => !a.resolved && alertAge(a) <= staleHours * 3600
  const freshAlerts = alerts.filter(isFresh)
  const staleCount = alerts.filter(a => !a.resolved && alertAge(a) > staleHours * 3600).length

  const critFiring = freshAlerts.filter(a => a.severity === 'critical').length
  const warnFiring = freshAlerts.filter(a => a.severity === 'warn').length
  const infoFiring = freshAlerts.filter(a => a.severity !== 'critical' && a.severity !== 'warn').length

  const staleByInstance = new Map<string, number>()
  for (const a of alerts) {
    if (!a.resolved && (now - (a.updated_at ?? a.created_at)) > staleHours * 3600) {
      staleByInstance.set(a.instance, (staleByInstance.get(a.instance) ?? 0) + 1)
    }
  }

  const avgHealth = totalInstances > 0
    ? Math.round(instances.reduce((s, i) => s + i.health_score, 0) / totalInstances)
    : 0
  const runningQueries = instances.reduce((s, i) => s + (i.key_metrics?.['running_queries'] ?? 0), 0)
  const activeMerges = instances.reduce((s, i) => s + (i.key_metrics?.['active_merges'] ?? 0), 0)

  const sortedInstances = [...instances].sort((a, b) => {
    if (sortBy === 'score') return b.health_score - a.health_score
    return a.name.localeCompare(b.name)
  })

  const goToInstance = (name: string) => {
    setInstance(name)
    setView('detail')
  }

  const alertCols = [
    { key: 'severity', label: 'Sev', format: (v: any) => <Badge severity={v} dot /> },
    { key: 'instance', label: 'Instance' },
    { key: 'category', label: 'Category' },
    { key: 'title', label: 'Title' },
    { key: 'created_at', label: 'Time', format: (v: any) => <span className="text-[var(--dim)]">{fmtTime(v)}</span> },
  ]

  const instNames = instances.map(i => i.name)
  const inst = instNames[0] || ''

  return (
    <div className="space-y-0">
      {/* ── Header row ── */}
      <div className="flex items-center gap-3 pb-4">
        <div className="flex items-center gap-2">
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--dim)] border border-[var(--border)]">current state</span>
          {lastRefreshed && (
            <span className="text-[11px] text-[var(--dim)]">as of {lastRefreshed.toLocaleTimeString()}</span>
          )}
        </div>
        <div className="flex-1" />
        {refreshing && (
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--dim)]">
            <RefreshCw size={10} className="animate-spin" /> Refreshing…
          </div>
        )}
        <button
          onClick={() => setManualRefreshTick(t => t + 1)}
          disabled={refreshing}
          title="Fetch the latest collected data from storage"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-[var(--dim)] hover:bg-[var(--hover)] border border-[var(--border)] transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
        <button
          onClick={handleForcePoll}
          disabled={forcingPoll}
          title="Run all collectors now to gather fresh ClickHouse metrics"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-green-400 hover:bg-green-500/10 border border-green-500/30 transition-colors disabled:opacity-50"
        >
          <Zap size={10} className={forcingPoll ? 'animate-pulse' : ''} />
          {forcingPoll ? 'Collecting…' : forcePollMsg || 'Collect Now'}
        </button>
        <button
          onClick={() => handleAnalyze({ instances, alerts, avgHealth, critFiring, warnFiring, infoFiring, staleCount, runningQueries, activeMerges })}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent-subtle)] border border-[var(--accent)]/20 transition-colors"
        >
          <Sparkles size={10} />
          Analyze
        </button>
        <button
          onClick={() => setWidgetPanelOpen(o => !o)}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium border transition-colors',
            widgetPanelOpen
              ? 'bg-[var(--accent)] text-white border-transparent'
              : 'text-[var(--dim)] hover:text-[var(--text)] border-[var(--border)] hover:bg-[var(--hover)]',
          )}
          title="Toggle metrics widgets"
        >
          <Settings2 size={10} />
          Widgets
        </button>
      </div>

      {/* ── Dashboard widget panel ── */}
      {widgetPanelOpen && (
        <div className="pb-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--dim)]">Metrics Overview</span>
            <button
              onClick={() => setWidgetEditMode(e => !e)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] transition-colors',
                widgetEditMode
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--hover)] text-[var(--text-muted)] hover:text-[var(--text)]',
              )}
            >
              <Settings2 size={11} />
              {widgetEditMode ? 'Done' : 'Edit Layout'}
            </button>
          </div>

          {widgetEditMode && (
            <Card className="p-4">
              <div className="text-xs font-semibold text-[var(--text-muted)] mb-3">Widget Visibility &amp; Order</div>
              <div className="space-y-1">
                {[...widgets].sort((a, b) => a.order - b.order).map(w => (
                  <div key={w.id} className="flex items-center gap-3 py-1">
                    <input
                      type="checkbox"
                      checked={w.enabled}
                      onChange={() => toggleWidget(w.id)}
                      className="rounded"
                    />
                    <span className="text-sm flex-1">{WIDGET_LABELS[w.type]}</span>
                    <button onClick={() => moveWidget(w.id, 'up')} className="text-[var(--dim)] hover:text-[var(--text)] p-0.5">
                      <ChevronUp size={14} />
                    </button>
                    <button onClick={() => moveWidget(w.id, 'down')} className="text-[var(--dim)] hover:text-[var(--text)] p-0.5">
                      <ChevronDown size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={() => {
                  setWidgets(DEFAULT_WIDGETS)
                  saveWidgetLayout(DEFAULT_WIDGETS)
                  flashToast('Layout reset to defaults', 'done')
                }}
                className="mt-3 text-xs text-[var(--dim)] hover:text-red-400 transition-colors"
              >
                Reset to defaults
              </button>
            </Card>
          )}

          {inst === '' ? (
            <div className="text-xs text-[var(--dim)] text-center py-4">No instances configured</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {enabledWidgets.map(w => (
                <WidgetWrapper
                  key={w.id}
                  widget={w}
                  inst={inst}
                  from={from}
                  to={to}
                  instances={instNames}
                  setView={setView}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Metric strip ── */}
      <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
        <MetricChip label="Instances" value={totalInstances} />
        <MetricChip label="Avg Health" value={avgHealth} valueColor={scoreColor(avgHealth)} />
        <MetricChip label="Running Queries" value={fmtNum(runningQueries)} />
        <MetricChip label="Active Merges" value={fmtNum(activeMerges)} />
        <MetricChip
          label="Critical"
          value={critFiring}
          valueColor={critFiring > 0 ? '#ef4444' : undefined}
          onClick={() => critFiring > 0 ? navToAlerts({ severity: 'critical' }) : undefined}
          active={critFiring > 0}
        />
        <MetricChip
          label="Warning"
          value={warnFiring}
          valueColor={warnFiring > 0 ? '#eab308' : undefined}
          onClick={() => warnFiring > 0 ? navToAlerts({ severity: 'warn' }) : undefined}
          active={warnFiring > 0}
        />
        <MetricChip
          label={staleCount > 0 ? `Info (+${staleCount} stale)` : 'Info'}
          value={infoFiring}
          valueColor={infoFiring > 0 ? '#60a5fa' : undefined}
          onClick={() => infoFiring > 0 ? navToAlerts({ severity: 'info' }) : undefined}
          active={infoFiring > 0}
        />
      </div>

      {/* ── 24h Alert Activity ── */}
      <div className="pt-3">
        <AlertActivityStrip onViewHistory={() => setView('history')} />
      </div>

      {/* ── Instances section (or setup wizard when empty) ── */}
      {instances.length === 0 ? (
        <SetupWizard onExplore={() => setView('explore')} />
      ) : (
        <Section
          title={`Instances · ${totalInstances}`}
          defaultOpen
          actions={
            <div className="flex items-center gap-2">
              {healthData && (
                <span className={`inline-flex items-center gap-1 text-[10px] ${healthData.status === 'ok' ? 'text-green-400' : 'text-yellow-400'}`}>
                  <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: healthData.status === 'ok' ? '#22c55e' : '#eab308' }} />
                  v{healthData.version} · up {healthData.uptime}
                  {healthData.last_poll_at && (
                    <span className="text-[var(--dim)]" title={`Last poll: ${new Date(healthData.last_poll_at).toLocaleString()}`}>
                      {' '}· polled {new Date(healthData.last_poll_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </span>
              )}
              <div className="flex items-center gap-1 ml-auto">
                {(['score', 'name'] as const).map(s => (
                  <button key={s} onClick={() => setSortBy(s)} className={cn('text-[10px] px-1.5 py-0.5 rounded', sortBy === s ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'text-[var(--dim)] hover:text-[var(--fg)]')}>
                    {s === 'score' ? 'By score' : 'A–Z'}
                  </button>
                ))}
              </div>
            </div>
          }
        >
          <div className="rounded-lg border border-[var(--border)] overflow-hidden">
            {/* Table header */}
            <div className="grid bg-[var(--surface)] border-b border-[var(--border)] px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--dim)]"
              style={{ gridTemplateColumns: '16px 1fr 48px 280px 80px 100px 24px' }}
            >
              <span />
              <span>Instance</span>
              <span className="text-right">Health</span>
              <span className="hidden sm:block text-right pr-8">CPU / MEM / Queries / Merges</span>
              <span className="hidden md:block">Areas</span>
              <span className="text-right">Alerts</span>
              <span />
            </div>
            {sortedInstances.map(inst => (
              <NodeCard
                key={inst.name}
                instance={inst}
                onClick={() => goToInstance(inst.name)}
                staleAlerts={staleByInstance.get(inst.name) ?? 0}
                onResolved={() => setManualRefreshTick(t => t + 1)}
                onSelectAlert={setSelectedAlert}
              />
            ))}
          </div>
        </Section>
      )}

      {/* ── Active alerts ── */}
      {freshAlerts.length > 0 && (
        <Section
          title={`Active Alerts · ${freshAlerts.length}${staleCount > 0 ? ` (${staleCount} stale hidden)` : ''}`}
          defaultOpen={freshAlerts.length <= 20}
        >
          <Card noPad>
            <DataTable columns={alertCols} data={freshAlerts} pageSize={50} onRowClick={row => setSelectedAlert(row as Alert)} dense={denseMode} showColumnToggle={true} storageKey="overview-alerts" />
          </Card>
        </Section>
      )}

      {selectedAlert && (
        <AlertDetailPanel
          alert={selectedAlert}
          onClose={() => setSelectedAlert(null)}
          onAnalyze={a => {
            analyze(`Alert: ${a.title}`, { row: a }, { contextType: 'row', tab: 'alerts', elementId: String(a.id) })
            setSelectedAlert(null)
          }}
          onNavToInstance={name => { navToDetail(name); setSelectedAlert(null) }}
        />
      )}
    </div>
  )
}
