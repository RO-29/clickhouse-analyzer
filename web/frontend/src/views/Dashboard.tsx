import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  LayoutDashboard, Settings2, ChevronUp, ChevronDown, RefreshCw,
} from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { api } from '../lib/api'
import { Card } from '../components/Card'
import { MetricChart } from '../components/MetricChart'
import { cn, fmtNum, scoreColor } from '../lib/utils'
import type { Alert, AlertStats, Instance, QueryPatternV2, SLOReport } from '../types/api'

/* ── Types ──────────────────────────────────────────────────────────────── */

type WidgetType =
  | 'active_alerts'
  | 'health_scores'
  | 'query_throughput'
  | 'disk_usage'
  | 'insert_rate'
  | 'error_rate'
  | 'slow_queries'
  | 'slo_overview'

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
]

function loadLayout(): DashboardWidget[] {
  try {
    const saved = JSON.parse(localStorage.getItem('ch-dashboard-layout') ?? 'null')
    if (Array.isArray(saved) && saved.length > 0) {
      // Merge: keep saved order/enabled state, append any new widget types at the end.
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

function saveLayout(widgets: DashboardWidget[]) {
  localStorage.setItem('ch-dashboard-layout', JSON.stringify(widgets))
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
    <WidgetCard title="Active Alerts" onRefresh={() => setTick(t => t + 1)} loading={loading}>
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

function HealthScoresWidget({ setView }: { setView: (v: any) => void }) {
  const { navToDetail } = useStore()
  const [instances, setInstances] = useState<Instance[]>([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    setLoading(true)
    api.overview()
      .then(setInstances)
      .catch(() => setInstances([]))
      .finally(() => setLoading(false))
  }, [tick])

  return (
    <WidgetCard title="Health Scores" onRefresh={() => setTick(t => t + 1)} loading={loading}>
      {instances.length === 0 ? (
        <div className="text-[var(--dim)] text-xs py-4 text-center">No instances</div>
      ) : (
        <div className="space-y-1.5">
          {instances.map(inst => {
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

function QueryThroughputWidget({ inst }: { inst: string }) {
  return (
    <WidgetCard title="Query Throughput" noInnerPad>
      <MetricChart
        instance={inst}
        metrics={['Query']}
        title="Queries/sec"
        height={120}
      />
    </WidgetCard>
  )
}

/* ── Widget: Disk Usage ─────────────────────────────────────────────────── */

function DiskUsageWidget({ inst }: { inst: string }) {
  return (
    <WidgetCard title="Disk Usage" noInnerPad>
      <MetricChart
        instance={inst}
        metrics={['FilesystemMainPathAvailableBytes']}
        title="Disk Available"
        height={120}
        yFormat="bytes"
      />
    </WidgetCard>
  )
}

/* ── Widget: Insert Rate ────────────────────────────────────────────────── */

function InsertRateWidget({ inst }: { inst: string }) {
  return (
    <WidgetCard title="Insert Rate" noInnerPad>
      <MetricChart
        instance={inst}
        metrics={['InsertedRows']}
        title="Insert Rate"
        height={120}
      />
    </WidgetCard>
  )
}

/* ── Widget: Error Rate ─────────────────────────────────────────────────── */

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
    <WidgetCard title="Error Rate (24h)" onRefresh={() => setTick(t => t + 1)} loading={loading}>
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

function StatMini({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="text-center">
      <div className="text-xl font-bold tabular-nums" style={{ color }}>{fmtNum(value)}</div>
      <div className="text-[10px] text-[var(--dim)] uppercase tracking-wider mt-0.5">{label}</div>
    </div>
  )
}

/* ── Widget: Slow Queries ───────────────────────────────────────────────── */

function SlowQueriesWidget({ inst, from, to, setView }: { inst: string; from: number; to: number; setView: (v: any) => void }) {
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
    <WidgetCard title="Slow Queries" onRefresh={() => setTick(t => t + 1)} loading={loading}>
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
            <div key={p.normalized_query_hash} className="grid grid-cols-[1fr_auto_auto] gap-x-2 py-0.5 text-xs">
              <span className="truncate text-[var(--text)] font-mono text-[10px]" title={p.sample_query}>
                {p.normalized_query_hash.slice(0, 8)}
              </span>
              <span className="text-right tabular-nums text-[var(--dim)]">{p.avg_ms.toFixed(0)}</span>
              <span className="text-right tabular-nums text-[var(--dim)]">{fmtNum(p.cnt)}</span>
            </div>
          ))}
          <button
            onClick={() => setView('explore')}
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
    <WidgetCard title="SLO Overview (7d)" onRefresh={() => setTick(t => t + 1)} loading={loading}>
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

/* ── WidgetCard shell ───────────────────────────────────────────────────── */

interface WidgetCardProps {
  title: string
  children: React.ReactNode
  onRefresh?: () => void
  loading?: boolean
  noInnerPad?: boolean
}

function WidgetCard({ title, children, onRefresh, loading, noInnerPad }: WidgetCardProps) {
  return (
    <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--dim)] flex-1">
          {title}
        </span>
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
      {/* Body */}
      {loading && !noInnerPad ? (
        <div className="px-3 py-4 flex items-center justify-center text-[var(--dim)] text-xs">
          Loading…
        </div>
      ) : (
        <div className={noInnerPad ? '' : 'px-3 py-3'}>
          {children}
        </div>
      )}
    </div>
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
      return <QueryThroughputWidget inst={inst} />
    case 'disk_usage':
      return <DiskUsageWidget inst={inst} />
    case 'insert_rate':
      return <InsertRateWidget inst={inst} />
    case 'error_rate':
      return <ErrorRateWidget />
    case 'slow_queries':
      return <SlowQueriesWidget inst={inst} from={from} to={to} setView={setView} />
    case 'slo_overview':
      return <SLOOverviewWidget instances={instances} />
    default:
      return null
  }
}

/* ── Dashboard ──────────────────────────────────────────────────────────── */

export default function Dashboard() {
  const { instances, selectedInstance, from, to, setView } = useStore()
  const inst = selectedInstance || instances[0] || ''
  const [widgets, setWidgets] = useState<DashboardWidget[]>(loadLayout)
  const [editMode, setEditMode] = useState(false)

  const enabledWidgets = useMemo(
    () => [...widgets].sort((a, b) => a.order - b.order).filter(w => w.enabled),
    [widgets],
  )

  const toggleWidget = useCallback((id: string) => {
    const next = widgets.map(w => w.id === id ? { ...w, enabled: !w.enabled } : w)
    setWidgets(next)
    saveLayout(next)
  }, [widgets])

  const moveWidget = useCallback((id: string, dir: 'up' | 'down') => {
    const sorted = [...widgets].sort((a, b) => a.order - b.order)
    const idx = sorted.findIndex(w => w.id === id)
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= sorted.length) return
    const next = sorted.map((w, i) => {
      if (i === idx)   return { ...w, order: sorted[swapIdx].order }
      if (i === swapIdx) return { ...w, order: sorted[idx].order }
      return w
    })
    setWidgets(next)
    saveLayout(next)
  }, [widgets])

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <LayoutDashboard size={18} /> Dashboard
        </h2>
        <button
          onClick={() => setEditMode(e => !e)}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors',
            editMode
              ? 'bg-[var(--accent)] text-white'
              : 'bg-[var(--hover)] text-[var(--text-muted)] hover:text-[var(--text)]',
          )}
        >
          <Settings2 size={14} />
          {editMode ? 'Done' : 'Edit Layout'}
        </button>
      </div>

      {/* Edit mode: widget checklist */}
      {editMode && (
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
                <button
                  onClick={() => moveWidget(w.id, 'up')}
                  className="text-[var(--dim)] hover:text-[var(--text)] p-0.5"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  onClick={() => moveWidget(w.id, 'down')}
                  className="text-[var(--dim)] hover:text-[var(--text)] p-0.5"
                >
                  <ChevronDown size={14} />
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Widget grid */}
      {inst === '' ? (
        <Card className="p-10 text-center text-[var(--text-muted)]">
          <LayoutDashboard size={32} className="mx-auto mb-3 opacity-20" />
          <div className="text-sm">No instances configured</div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {enabledWidgets.map(w => (
            <WidgetWrapper
              key={w.id}
              widget={w}
              inst={inst}
              from={from}
              to={to}
              instances={instances}
              setView={setView}
            />
          ))}
        </div>
      )}
    </div>
  )
}
