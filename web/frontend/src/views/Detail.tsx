import { useEffect, useState, useCallback, useRef } from 'react'
import { ArrowLeft, HelpCircle, RefreshCw, Sparkles, Wrench, AlertTriangle, CheckCircle2, Activity } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RechartTooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { fmtBytes, fmtNum, fmtTime, fmtDuration, cn } from '../lib/utils'
import { Card, Section } from '../components/Card'
import { Badge } from '../components/Badge'
import { MetricChart } from '../components/MetricChart'
import { HealthChecklist } from '../components/HealthChecklist'
import { DataTable } from '../components/DataTable'
import { AlertDetailPanel } from '../components/AlertDetailPanel'
import type { Alert, DiskInfo, ReplicaStatus, S3Stats, MaintenanceWindow, SLOReport } from '../types/api'

type DetailTab = 'summary' | 'queries' | 'storage' | 'replication' | 'history'

const TABS: { key: DetailTab; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'queries', label: 'Queries' },
  { key: 'storage', label: 'Storage' },
  { key: 'replication', label: 'Replication' },
  { key: 'history', label: 'History' },
]

/* ── Disk usage bar chart via Recharts ────────────────────────────────── */
function DiskChart({ disks }: { disks: DiskInfo[] }) {
  const data = disks.map(d => ({
    name: d.disk_name,
    used: d.total_space - d.free_space,
    free: d.free_space,
  }))

  const height = Math.max(60, disks.length * 44)

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 8, left: 8, bottom: 0 }} barSize={14}>
        <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
        <XAxis
          type="number"
          tickFormatter={v => fmtBytes(v)}
          tick={{ fontSize: 10, fill: '#64748b' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ fontSize: 11, fill: '#94a3b8' }}
          axisLine={false}
          tickLine={false}
          width={80}
        />
        <RechartTooltip
          formatter={(v: any, name: string) => [fmtBytes(v), name]}
          contentStyle={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            fontSize: 11,
          }}
        />
        <Bar dataKey="used" name="Used" stackId="a" fill="#7c3aed" radius={[0, 0, 0, 0]} />
        <Bar dataKey="free" name="Free" stackId="a" fill="#1e2d40" radius={[2, 2, 2, 2]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/* ── Loading skeleton ─────────────────────────────────────────────────── */
function Skeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 bg-[var(--card)] rounded-lg" />
        <div className="h-6 bg-[var(--card)] rounded w-48" />
      </div>
      <div className="h-10 bg-[var(--card)] rounded-lg border border-[var(--border)]" />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-[160px] bg-[var(--card)] rounded-lg border border-[var(--border)]" />
        ))}
      </div>
    </div>
  )
}

/* ── InfoTooltip ─────────────────────────────────────────────────────── */
function InfoTooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen(o => !o)}
        className="text-[var(--dim)] hover:text-[var(--accent)] transition-colors ml-1"
        aria-label="More info"
      >
        <HelpCircle size={12} />
      </button>
      {open && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 z-50 w-56 px-3 py-2 rounded-lg bg-[var(--card)] border border-[var(--border)] shadow-lg text-xs text-[var(--text)] leading-relaxed pointer-events-none">
          {text}
          <div className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-[var(--border)]" />
        </div>
      )}
    </span>
  )
}

/* ── Detail view ─────────────────────────────────────────────────────── */
export default function Detail({ refreshKey }: { refreshKey?: number }) {
  const { instance, setView, setInstance, customFrom, customTo } = useStore()
  const { analyze } = useAIAnalysis(instance ?? '')
  const handleAnalyze = useCallback((data: Record<string, any>) => {
    analyze('Instance Detail', data, { contextType: 'tab', tab: 'detail' })
  }, [analyze])

  const [activeTab, setActiveTab] = useState<DetailTab>('summary')
  const [activeWindow, setActiveWindow] = useState<MaintenanceWindow | null>(null)
  const [alertHistory, setAlertHistory] = useState<Alert[]>([])
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null)
  const [queries, setQueries] = useState<Record<string, any>[]>([])
  const [tables, setTables] = useState<Record<string, any>[]>([])
  const [disks, setDisks] = useState<DiskInfo[]>([])
  const [mvs, setMvs] = useState<Record<string, any>[]>([])
  const [s3Stats, setS3Stats] = useState<S3Stats | null>(null)
  const [cacheStats, setCacheStats] = useState<any>(null)
  const [tableMemory, setTableMemory] = useState<any[]>([])
  const [replicas, setReplicas] = useState<ReplicaStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  const [currentStateRefreshTick, setCurrentStateRefreshTick] = useState(0)
  const isFirstLoad = useRef(true)

  const [queryPatterns, setQueryPatterns] = useState<Record<string, any>[]>([])
  const [queryFailures, setQueryFailures] = useState<Record<string, any>[]>([])
  const [mergeHistory, setMergeHistory] = useState<Record<string, any>[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const [slo, setSlo] = useState<SLOReport | null>(null)
  const [sloWindow, setSloWindow] = useState(7)

  const [showActiveOnly, setShowActiveOnly] = useState(false)
  const [apLoaded, setApLoaded] = useState(false)
  const [apLoading, setApLoading] = useState(false)
  const [queryAP, setQueryAP] = useState<any[] | null>(null)
  const [tableAP, setTableAP] = useState<any[] | null>(null)

  useEffect(() => {
    if (!instance) return
    let cancelled = false

    async function load() {
      if (isFirstLoad.current) setLoading(true)
      else setRefreshing(true)
      try {
        // Active pulled from /api/alerts/active?instance=X so our count matches
        // Overview exactly (same dedup, same server-side path). History is a
        // separate fetch scoped to this instance — the old "history includes
        // appended active" trick was unreliable because the 500-row limit
        // applied globally and could starve alerts for a single instance.
        const [activeRaw, historyRaw, q, t, d, m, s3, cs, tm, repl, maint] = await Promise.all([
          api.alerts.active(instance!).catch(() => [] as Alert[]),
          api.alerts.history({ limit: 500, instance: instance! }).catch(() => [] as Alert[]),
          api.queries(instance!).catch(() => []),
          api.tables(instance!).catch(() => []),
          api.disks(instance!).catch(() => []),
          api.mvs(instance!).catch(() => []),
          api.s3Stats(instance!).catch(() => null),
          api.cacheStats(instance!).catch(() => null),
          api.tableMemory(instance!).catch(() => []),
          api.replication(instance!).catch(() => [] as ReplicaStatus[]),
          api.maintenance.list().catch(() => [] as MaintenanceWindow[]),
        ])
        if (!cancelled) {
          const now = new Date()
          const win = (maint as MaintenanceWindow[]).find(
            w => (w.instance === instance || w.instance === '*') && w.end_time * 1000 > now.getTime()
          ) ?? null
          setActiveWindow(win)
          // Merge active (authoritative for unresolved) with history (shows
          // resolved too). Dedup by id so history + active don't double-list.
          const byId = new Map<number, Alert>()
          for (const a of historyRaw as Alert[]) byId.set(a.id, a)
          for (const a of activeRaw as Alert[]) byId.set(a.id, a) // active wins on same id
          setAlertHistory(Array.from(byId.values()))
          setQueries(q)
          setTables(t)
          setDisks(d as DiskInfo[])
          setMvs(m)
          setS3Stats(s3 as any)
          setCacheStats(cs)
          setTableMemory(tm ?? [])
          setReplicas(repl as ReplicaStatus[])
          setLoadedAt(new Date())
        }
      } catch {
        // keep empty
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
          isFirstLoad.current = false
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [instance, refreshKey, currentStateRefreshTick])

  useEffect(() => {
    if (!instance) return
    let cancelled = false
    setHistoryLoading(true)
    Promise.all([
      api.history.queryPatterns(instance, customFrom, customTo, 20).catch(() => []),
      api.history.failures(instance, customFrom, customTo).then(r => r.timeline).catch(() => []),
      api.history.merges(instance, customFrom, customTo).catch(() => []),
    ]).then(([qp, qf, mg]) => {
      if (!cancelled) {
        setQueryPatterns(qp as Record<string, any>[])
        setQueryFailures(qf as Record<string, any>[])
        setMergeHistory(mg as Record<string, any>[])
      }
    }).finally(() => { if (!cancelled) setHistoryLoading(false) })
    return () => { cancelled = true }
  }, [instance, customFrom, customTo])

  useEffect(() => {
    if (!instance) return
    api.slo(instance, sloWindow).then(setSlo).catch(() => setSlo(null))
  }, [instance, sloWindow])

  if (!instance) return null

  const goBack = () => {
    setView('overview')
    setInstance(null)
  }

  const localDisks = disks.filter(d => !d.disk_name.toLowerCase().includes('s3'))
  const rangeAlerts = alertHistory.filter(a => a.created_at >= customFrom && a.created_at <= customTo)

  // Split unresolved alerts into fresh vs stale using the same 24h threshold
  // Overview uses (configurable via the ch-stale-hours localStorage key) so
  // the per-instance "Active Alerts" count agrees with NodeCard on Overview.
  // Stale alerts still show, just in a separate collapsed subsection.
  const detailStaleHours = (() => {
    try { return parseInt(localStorage.getItem('ch-stale-hours') ?? '24', 10) || 24 } catch { return 24 }
  })()
  const detailNow = Date.now() / 1000
  const detailAlertAge = (a: Alert) => {
    const ts = (a.updated_at ?? a.created_at)
    return ts > 0 ? detailNow - ts : 0
  }
  const unresolvedAlerts = alertHistory.filter(a => !a.resolved)
  const activeAlerts = unresolvedAlerts.filter(a => detailAlertAge(a) <= detailStaleHours * 3600)
  const staleAlerts = unresolvedAlerts.filter(a => detailAlertAge(a) > detailStaleHours * 3600)

  const handleResolveDetailAlert = useCallback(async (dedupKey: string) => {
    try {
      await api.alerts.resolve(dedupKey)
      // Re-fetch active + history scoped to this instance, matching the
      // initial load path. Using the unscoped /history with a global 500
      // limit could under-report on noisy clusters.
      const [active, history] = await Promise.all([
        api.alerts.active(instance!).catch(() => [] as Alert[]),
        api.alerts.history({ limit: 500, instance: instance! }).catch(() => [] as Alert[]),
      ])
      const byId = new Map<number, Alert>()
      for (const a of history as Alert[]) byId.set(a.id, a)
      for (const a of active as Alert[]) byId.set(a.id, a)
      setAlertHistory(Array.from(byId.values()))
    } catch {}
  }, [instance])

  const maintUntil = activeWindow
    ? new Date(activeWindow.end_time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null

  /* ── column defs ── */
  const alertCols = [
    { key: 'severity', label: 'Sev', format: (v: any) => <Badge severity={v} dot /> },
    { key: 'category', label: 'Category' },
    { key: 'title', label: 'Title' },
    { key: 'resolved', label: 'Status', format: (v: any) => v ? <span className="text-[11px] text-green-400">resolved</span> : <span className="text-[11px] text-yellow-400">active</span> },
    { key: 'created_at', label: 'Time', format: (v: any) => <span className="text-[var(--dim)]">{fmtTime(v)}</span> },
    { key: 'dedup_key', label: '', format: (_v: any, row: Record<string, any>) => !row.resolved ? (
      <button onClick={e => { e.stopPropagation(); handleResolveDetailAlert(row.dedup_key) }} className="text-[11px] text-green-400 hover:underline whitespace-nowrap">Resolve</button>
    ) : null },
  ]

  const queryCols = [
    { key: 'query_short', label: 'Query', format: (v: any) => <span className="font-mono truncate block max-w-md" title={String(v ?? '')}>{String(v ?? '')}</span> },
    { key: 'elapsed', label: 'Elapsed', format: (v: any) => fmtDuration((v ?? 0) * 1000) },
    { key: 'user', label: 'User' },
    { key: 'memory_usage', label: 'Memory', format: (v: any) => fmtBytes(v ?? 0) },
    { key: 'read_rows', label: 'Read Rows', format: (v: any) => fmtNum(v) },
  ]

  const tableCols = [
    { key: 'database', label: 'Database' },
    { key: 'table_name', label: 'Table' },
    { key: 'engine', label: 'Engine' },
    { key: 'part_count', label: 'Parts', format: (v: any) => {
      const pc = v ?? 0
      return <span className={pc > 300 ? 'text-red-400' : pc > 100 ? 'text-yellow-400' : 'text-green-400'}>{fmtNum(pc)}</span>
    }},
    { key: 'size_readable', label: 'Size' },
  ]

  const mvCols = [
    { key: 'database', label: 'Database' },
    { key: 'mv_name', label: 'Materialized View' },
  ]

  const s3VolCols = [
    { key: 'table', label: 'Table' },
    { key: 'parts', label: 'Parts', format: (v: any) => fmtNum(v) },
    { key: 'size', label: 'Size' },
  ]

  const s3LatCols = [
    { key: 'table', label: 'Table' },
    { key: 'avg_latency_ms', label: 'Avg Latency', format: (v: any) => (v ?? 0).toFixed(1) + 'ms' },
    { key: 'total_requests', label: 'Requests', format: (v: any) => fmtNum(v ?? 0) },
  ]

  if (loading) return <Skeleton />

  return (
    <div className="space-y-4">
      {/* ── Maintenance banner ── */}
      {activeWindow && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-orange-500/30 bg-orange-500/10 text-[12px] text-orange-400">
          <Wrench size={13} className="shrink-0" />
          <div className="flex-1">
            <span className="font-semibold">Maintenance window active</span>
            {activeWindow.reason && <span className="opacity-70 ml-2">— {activeWindow.reason}</span>}
          </div>
          {maintUntil && <span className="opacity-70 text-[11px] shrink-0">Alerts suppressed until {maintUntil}</span>}
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <button
            onClick={goBack}
            className="flex items-center gap-1 text-sm text-[var(--dim)] hover:text-[var(--text)] transition-colors shrink-0"
          >
            <ArrowLeft size={14} />
            Overview
          </button>
          <span className="text-[var(--dim)] opacity-40 text-sm">/</span>
          <h2 className="text-sm font-semibold truncate" title={instance}>{instance}</h2>
          <button title="What is the health score?" className="text-[var(--dim)] transition-colors shrink-0 cursor-default">
            <HelpCircle size={13} />
          </button>
        </div>
        {loadedAt && !refreshing && (
          <span className="text-[11px] text-[var(--dim)] hidden sm:block">
            Updated {loadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
        {refreshing && (
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--dim)]">
            <RefreshCw size={10} className="animate-spin" /> Refreshing…
          </div>
        )}
        <button
          onClick={() => setCurrentStateRefreshTick(t => t + 1)}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-[var(--dim)] hover:bg-[var(--hover)] border border-[var(--border)] transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
        <button
          onClick={() => handleAnalyze({ instance, activeAlerts, queries, tables, disks, s3Stats, cacheStats, tableMemory })}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent-subtle)] border border-[var(--accent)]/20 transition-colors"
        >
          <Sparkles size={10} />
          Analyze
        </button>
      </div>

      {/* ── Tabs ── */}
      <div className="flex items-center gap-0 border-b border-[var(--border)]">
        {TABS.map(tab => {
          const alertCount = activeAlerts.length
          const badge =
            tab.key === 'summary' && alertCount > 0 ? alertCount
            : tab.key === 'queries' && queries.length > 0 ? queries.length
            : tab.key === 'replication' && replicas.length > 0 ? replicas.length
            : tab.key === 'history' && (rangeAlerts.length > 0 || queryPatterns.length > 0) ? (rangeAlerts.length + queryPatterns.length)
            : null
          const isAlertBadge = tab.key === 'summary' && alertCount > 0
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-[12px] font-medium border-b-2 transition-colors -mb-px',
                activeTab === tab.key
                  ? 'border-[var(--accent)] text-[var(--accent)]'
                  : 'border-transparent text-[var(--dim)] hover:text-[var(--text)] hover:border-[var(--border)]',
              )}
            >
              {tab.label}
              {badge != null && (
                <span className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded font-semibold',
                  isAlertBadge
                    ? 'bg-red-500/20 text-red-400'
                    : activeTab === tab.key
                      ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                      : 'bg-[var(--surface)] text-[var(--dim)]',
                )}>
                  {badge}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* ═══ SUMMARY TAB ═══ */}
      {activeTab === 'summary' && (
        <div className="space-y-4">
          <div>
            <div className="flex items-center mb-2">
              <span className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-widest">Health Score</span>
              <InfoTooltip text="Health score (0–100) measures overall instance health. 100 = all checks passing. Drops when CPU, memory, query latency, parts count, or replication fall outside thresholds." />
            </div>
            <HealthChecklist instance={instance} refreshTrigger={currentStateRefreshTick} />
          </div>

          {slo && (
            <Card className="p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-[var(--text-muted)] flex items-center gap-1.5">
                  <Activity size={13} /> SLO / Uptime
                  <InfoTooltip text="Service Level Objective: percentage of polling cycles where the instance was reachable and healthy. Uptime = instance responded. Healthy = health score ≥ 70." />
                </span>
                <div className="flex gap-1">
                  {[1, 7, 30].map(d => (
                    <button key={d} onClick={() => setSloWindow(d)}
                      className={cn('px-2 py-0.5 rounded text-xs', sloWindow === d ? 'bg-[var(--accent)] text-white' : 'bg-[var(--hover)] text-[var(--text-muted)]')}>
                      {d === 1 ? '24h' : d === 7 ? '7d' : '30d'}
                    </button>
                  ))}
                </div>
              </div>
              {slo.total_polls === 0 ? (
                <div className="text-sm text-[var(--dim)] py-2 text-center">No data yet for this window</div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <div className={cn('text-xl font-bold', slo.uptime_pct >= 99.9 ? 'text-green-400' : slo.uptime_pct >= 99 ? 'text-amber-400' : 'text-red-400')}>
                      {slo.uptime_pct.toFixed(2)}%
                    </div>
                    <div className="text-xs text-[var(--text-muted)]">Uptime</div>
                  </div>
                  <div>
                    <div className={cn('text-xl font-bold', slo.healthy_pct >= 95 ? 'text-green-400' : slo.healthy_pct >= 80 ? 'text-amber-400' : 'text-red-400')}>
                      {slo.healthy_pct.toFixed(1)}%
                    </div>
                    <div className="text-xs text-[var(--text-muted)]">Healthy</div>
                  </div>
                  <div>
                    <div className="text-xl font-bold">{Math.round(slo.p50_score)}</div>
                    <div className="text-xs text-[var(--text-muted)]">Median score</div>
                  </div>
                </div>
              )}
              <div className="text-[10px] text-[var(--dim)] mt-1">{slo.total_polls} polls in last {slo.window_days}d</div>
            </Card>
          )}

          <Section title="Live Metrics" defaultOpen>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <MetricChart instance={instance} title="Memory %" metrics={['system.memory.rss_percent', 'system.memory.used_percent']} yFormat="percent" height={130} />
              <MetricChart
                instance={instance}
                title="Memory Bytes"
                subtitle="Host total vs OS available, ClickHouse process RSS, and CH's own memory accounting."
                metrics={[
                  { name: 'system.memory.total_bytes', label: 'Host Total', color: '#64748b' },
                  { name: 'system.memory.available_bytes', label: 'OS Available', color: '#22c55e' },
                  { name: 'system.memory.rss_bytes', label: 'CH RSS', color: '#7c3aed' },
                  { name: 'system.metrics.MemoryTracking', label: 'CH Tracked', color: '#eab308' },
                ]}
                seriesHelp={{
                  'Host Total': 'Total physical RAM on the host (or cgroup limit on cloud CH).',
                  'OS Available': 'Memory the OS reports as free for new allocations. Host Total minus OS Available = what the host is actually using.',
                  'CH RSS': 'Resident Set Size of the ClickHouse process — what the kernel sees it using, including caches. Tracks memory pressure owed to CH itself.',
                  'CH Tracked': 'MemoryTracking from system.metrics — ClickHouse\'s internal accounting (query memory, mark cache, uncompressed cache, dictionaries). Usually close to RSS; divergence = kernel-level overhead not accounted by CH.',
                }}
                yFormat="bytes"
                height={130}
              />
              <MetricChart instance={instance} title="CPU %" metrics={['system.cpu.busy_percent']} yFormat="percent" height={130} />
              <MetricChart instance={instance} title="Load Average" metrics={['system.async.LoadAverage1', 'system.async.LoadAverage5', 'system.async.LoadAverage15']} height={130} />
              <MetricChart instance={instance} title="Queries" metrics={['system.metrics.Query', 'queries.failed_5m']} height={130} />
              <MetricChart instance={instance} title="Parts & Merges" metrics={['tables.merges.active_count']} height={130} />
              <MetricChart instance={instance} title="Insert Throughput" metrics={['inserts.total.rows']} height={130} />
              <MetricChart instance={instance} title="S3 Latency" metrics={['storage.s3.avg_latency_ms', 'storage.s3.max_latency_ms']} yFormat="ms" height={130} />
            </div>
            {/* Alert event timeline — marks alert fires in the current time range */}
            {rangeAlerts.length > 0 && (
              <div className="mt-3 px-1">
                <div
                  className="text-[10px] text-[var(--dim)] mb-1 uppercase tracking-wider font-medium"
                  title="Every alert firing (resolved + active) whose created_at falls inside the selected time range. The Active Alerts section below only counts what's unresolved right now."
                >
                  Alert firings in range ({rangeAlerts.length}) · includes resolved
                </div>
                <div className="relative h-3 w-full">
                  {rangeAlerts.map((evt, idx) => {
                    const range = customTo - customFrom
                    const pct = range > 0 ? Math.min(100, Math.max(0, ((evt.created_at - customFrom) / range) * 100)) : 0
                    return (
                      <div
                        key={evt.id ?? idx}
                        className="absolute w-0.5 h-3 rounded-full"
                        style={{
                          left: `${pct}%`,
                          backgroundColor: evt.severity === 'critical' ? 'rgba(248,113,113,0.7)'
                            : evt.severity === 'warn' ? 'rgba(251,191,36,0.7)'
                            : 'rgba(148,163,184,0.5)',
                        }}
                        title={`${evt.title} — ${new Date(evt.created_at * 1000).toLocaleString()}`}
                      />
                    )
                  })}
                </div>
              </div>
            )}
          </Section>

          {activeAlerts.length > 0 && (
            <Section title={`Active Alerts · ${activeAlerts.length}`} defaultOpen>
              <Card noPad>
                <DataTable columns={alertCols} data={activeAlerts.sort((a, b) => b.created_at - a.created_at)} pageSize={20} onRowClick={row => setSelectedAlert(row as Alert)} showColumnToggle={true} storageKey="detail-active-alerts" />
              </Card>
            </Section>
          )}

          {staleAlerts.length > 0 && (
            <Section
              title={`Stale Alerts · ${staleAlerts.length} (no update in >${detailStaleHours}h)`}
              defaultOpen={false}
            >
              <Card noPad>
                <DataTable columns={alertCols} data={staleAlerts.sort((a, b) => b.created_at - a.created_at)} pageSize={20} onRowClick={row => setSelectedAlert(row as Alert)} showColumnToggle={true} storageKey="detail-stale-alerts" />
              </Card>
            </Section>
          )}
        </div>
      )}

      {/* ═══ QUERIES TAB ═══ */}
      {activeTab === 'queries' && (
        <div className="space-y-4">
          {queries.length > 0 ? (
            <Section title={`Running Queries · ${queries.length}`} defaultOpen badge={<span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/20">live</span>}>
              <Card noPad>
                <DataTable columns={queryCols} data={queries} maxHeight="280px" showColumnToggle={true} storageKey="detail-running-queries" />
              </Card>
            </Section>
          ) : (
            <div className="flex items-center gap-2 text-[12px] text-green-400 py-2">
              <CheckCircle2 size={14} /> No running queries
            </div>
          )}

          {/* Anti-pattern scan */}
          <Section
            title="Anti-pattern Scan"
            defaultOpen
            actions={
              !apLoaded ? (
                <button
                  onClick={e => {
                    e.stopPropagation()
                    setApLoaded(true)
                    setApLoading(true)
                    Promise.all([
                      api.advisor.queryAntiPatterns(instance).then(setQueryAP).catch(() => setQueryAP([])),
                      api.advisor.tableAntiPatterns(instance).then(setTableAP).catch(() => setTableAP([])),
                    ]).finally(() => setApLoading(false))
                  }}
                  className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
                >
                  <Wrench size={10} /> Run scan
                </button>
              ) : apLoading ? (
                <span className="text-[11px] text-[var(--dim)] animate-pulse">Scanning…</span>
              ) : null
            }
          >
            {!apLoaded ? (
              <div className="text-[12px] text-[var(--dim)] py-4 text-center">Click "Run scan" to detect anti-patterns</div>
            ) : apLoading ? (
              <div className="text-[12px] text-[var(--dim)] py-4 text-center animate-pulse">Scanning queries and tables…</div>
            ) : (
              <div className="space-y-3">
                {[...(queryAP ?? []), ...(tableAP ?? [])].filter(g => g.count > 0).length === 0 ? (
                  <div className="text-[12px] text-green-400 flex items-center gap-2 py-2">
                    <CheckCircle2 size={14} /> No anti-patterns detected
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {[...(queryAP ?? []), ...(tableAP ?? [])]
                      .filter(g => g.count > 0)
                      .sort((a, b) => {
                        const sev = { critical: 0, warn: 1, info: 2 }
                        return (sev[a.severity as keyof typeof sev] ?? 3) - (sev[b.severity as keyof typeof sev] ?? 3)
                      })
                      .map(group => (
                        <div key={group.type} className={cn(
                          'flex items-start gap-2 rounded-lg border px-3 py-2',
                          group.severity === 'critical' ? 'border-red-500/30 bg-red-500/5' : 'border-yellow-500/30 bg-yellow-500/5',
                        )}>
                          <AlertTriangle size={12} className={cn('mt-0.5 shrink-0', group.severity === 'critical' ? 'text-red-400' : 'text-yellow-400')} />
                          <div className="min-w-0">
                            <div className="text-[12px] font-medium truncate" title={group.title}>{group.title}</div>
                            <div className="text-[11px] text-[var(--dim)]">{group.count} {group.count === 1 ? 'table/query' : 'tables/queries'}</div>
                          </div>
                        </div>
                      ))
                    }
                  </div>
                )}
              </div>
            )}
          </Section>
        </div>
      )}

      {/* ═══ STORAGE TAB ═══ */}
      {activeTab === 'storage' && (
        <div className="space-y-4">
          {localDisks.length > 0 && (
            <Section title="Disk Usage" defaultOpen>
              <Card>
                <DiskChart disks={localDisks} />
              </Card>
            </Section>
          )}

          {cacheStats && (
            <Section title="Cache & Memory" defaultOpen>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Card>
                  <div className="text-lg font-bold">{fmtBytes(cacheStats.mark_cache_bytes ?? 0)}</div>
                  <div className="text-[10px] text-[var(--dim)] mt-1 uppercase tracking-widest">Mark Cache</div>
                  <div className="text-[11px] text-[var(--dim)]">{fmtNum(cacheStats.mark_cache_files ?? 0)} files</div>
                </Card>
                <Card>
                  <div className="text-lg font-bold">{fmtBytes(cacheStats.primary_key_bytes ?? 0)}</div>
                  <div className="text-[10px] text-[var(--dim)] mt-1 uppercase tracking-widest">Primary Key Mem</div>
                </Card>
                <Card>
                  <div className="text-lg font-bold">{fmtBytes(cacheStats.filesystem_cache_bytes ?? 0)}</div>
                  <div className="text-[10px] text-[var(--dim)] mt-1 uppercase tracking-widest">FS Cache</div>
                  <div className="text-[11px] text-[var(--dim)]">{fmtBytes(cacheStats.filesystem_cache_limit ?? 0)} limit</div>
                </Card>
                <Card>
                  <div className="text-lg font-bold">{fmtBytes(cacheStats.index_granularity_bytes ?? 0)}</div>
                  <div className="text-[10px] text-[var(--dim)] mt-1 uppercase tracking-widest">Index Granularity</div>
                </Card>
              </div>
            </Section>
          )}

          {s3Stats && s3Stats.volume_by_table && Array.isArray(s3Stats.volume_by_table) && s3Stats.volume_by_table.length > 0 && (() => {
            const volTable = s3Stats.volume_by_table as any[]
            const totalS3Bytes = volTable.reduce((sum: number, r: any) => sum + (r.bytes ?? 0), 0)
            const fsBytes = cacheStats?.filesystem_cache_bytes ?? 0
            const fsLimit = cacheStats?.filesystem_cache_limit ?? 0
            const fsPct = fsLimit > 0 ? Math.min(100, (fsBytes / fsLimit) * 100) : 0
            return (
              <Section title="S3 Storage" defaultOpen>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                  <Card>
                    <div className="text-lg font-bold">{fmtBytes(totalS3Bytes)}</div>
                    <div className="text-[10px] text-[var(--dim)] mt-1 uppercase tracking-widest">Total S3 Data</div>
                    <div className="text-[11px] text-[var(--dim)]">{volTable.length} tables</div>
                  </Card>
                  <Card>
                    <div className="text-lg font-bold">{fsLimit > 0 ? fsPct.toFixed(1) + '%' : '--'}</div>
                    <div className="text-[10px] text-[var(--dim)] mt-1 uppercase tracking-widest">S3 Local Cache</div>
                    <div className="text-[11px] text-[var(--dim)]">{fmtBytes(fsBytes)} / {fmtBytes(fsLimit)}</div>
                    {fsLimit > 0 && (
                      <div className="mt-2 h-1 rounded-full bg-[var(--hover)] overflow-hidden">
                        <div className={`h-full rounded-full ${fsPct > 90 ? 'bg-red-500' : fsPct > 70 ? 'bg-yellow-500' : 'bg-[var(--accent)]'}`} style={{ width: fsPct + '%' }} />
                      </div>
                    )}
                  </Card>
                  <Card>
                    <div className="text-lg font-bold">{fmtNum(cacheStats?.filesystem_cache_elements ?? 0)}</div>
                    <div className="text-[10px] text-[var(--dim)] mt-1 uppercase tracking-widest">Cached Elements</div>
                  </Card>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <Card title="S3 Volume by Table" noPad>
                    <DataTable columns={s3VolCols} data={volTable} maxHeight="250px" />
                  </Card>
                  {s3Stats.latency_by_table && Array.isArray(s3Stats.latency_by_table) && s3Stats.latency_by_table.length > 0 && (
                    <Card title="S3 Latency by Table" noPad>
                      <DataTable columns={s3LatCols} data={s3Stats.latency_by_table} maxHeight="250px" />
                    </Card>
                  )}
                </div>
              </Section>
            )
          })()}

          {tables.length > 0 && (
            <Section title={`Tables · ${tables.length}`} defaultOpen>
              <Card noPad>
                <DataTable columns={tableCols} data={tables} maxHeight="300px" showColumnToggle={true} storageKey="detail-tables" />
              </Card>
            </Section>
          )}

          {tableMemory.length > 0 && (
            <Section title="Table Memory & Parts" defaultOpen={false}>
              <Card noPad>
                <DataTable
                  columns={[
                    { key: 'database', label: 'DB' },
                    { key: 'table_name', label: 'Table' },
                    { key: 'pk_readable', label: 'PK Mem' },
                    { key: 'marks_readable', label: 'Marks Mem' },
                    { key: 'parts', label: 'Parts', format: (v: any) => fmtNum(v) },
                    { key: 'total_rows', label: 'Rows', format: (v: any) => fmtNum(v) },
                    { key: 'disk_size', label: 'Disk', format: (v: any) => fmtBytes(v ?? 0) },
                  ]}
                  data={[...tableMemory].sort((a, b) => (b.pk_bytes ?? 0) - (a.pk_bytes ?? 0))}
                  maxHeight="300px"
                />
              </Card>
            </Section>
          )}

          {mvs.length > 0 && (
            <Section title={`Materialized Views · ${mvs.length}`} defaultOpen={false}>
              <Card noPad>
                <DataTable columns={mvCols} data={mvs} maxHeight="250px" showColumnToggle={true} storageKey="detail-mvs" />
              </Card>
            </Section>
          )}
        </div>
      )}

      {/* ═══ REPLICATION TAB ═══ */}
      {activeTab === 'replication' && (
        <div className="space-y-4">
          {replicas.length === 0 ? (
            <div className="flex items-center gap-2 text-[12px] text-[var(--dim)] py-8 justify-center">
              No replicated tables found on this instance
            </div>
          ) : (
            <Section
              title={`Replicated Tables · ${replicas.length}`}
              defaultOpen
              badge={
                replicas.some(r => r.is_readonly || r.is_session_expired) ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20 font-semibold">readonly</span>
                ) : replicas.some(r => r.absolute_delay > 30) ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400 border border-yellow-500/20 font-semibold">lag</span>
                ) : null
              }
            >
              <Card noPad>
                <div className="overflow-auto">
                  <table className="w-full min-w-[700px]">
                    <thead className="sticky top-0 bg-[var(--card)]">
                      <tr className="border-b border-[var(--border)]">
                        {['Table', 'Replica', 'Leader', 'Delay', 'Queue', 'Parts to Check', 'Status'].map(h => (
                          <th key={h} className="text-left py-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-[var(--dim)]">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {replicas.map((r, i) => {
                        const hasIssue = r.is_readonly || r.is_session_expired || r.absolute_delay > 300
                        const hasWarn = r.absolute_delay > 30 || r.parts_to_check > 0 || r.queue_size > 100
                        return (
                          <tr key={i} className={cn(
                            'border-b border-[var(--border)] last:border-0 text-[11px]',
                            i % 2 === 1 && 'bg-[var(--surface)]/40',
                            hasIssue ? 'bg-red-500/5' : hasWarn ? 'bg-yellow-500/5' : '',
                          )}>
                            <td className="py-1.5 px-3 font-mono">{r.database}.{r.table}</td>
                            <td className="py-1.5 px-3 text-[var(--dim)]">{r.replica_name}</td>
                            <td className="py-1.5 px-3">{r.is_leader ? <span className="text-green-400">leader</span> : <span className="text-[var(--dim)]">replica</span>}</td>
                            <td className="py-1.5 px-3">
                              <span className={r.absolute_delay > 300 ? 'text-red-400 font-medium' : r.absolute_delay > 30 ? 'text-yellow-400' : 'text-[var(--dim)]'}>
                                {r.absolute_delay > 0 ? `${Math.round(r.absolute_delay)}s` : '—'}
                              </span>
                            </td>
                            <td className="py-1.5 px-3">
                              <span className={r.queue_size > 1000 ? 'text-red-400' : r.queue_size > 100 ? 'text-yellow-400' : 'text-[var(--dim)]'}>
                                {fmtNum(r.queue_size)}
                              </span>
                            </td>
                            <td className="py-1.5 px-3">
                              <span className={r.parts_to_check > 5 ? 'text-yellow-400' : 'text-[var(--dim)]'}>
                                {fmtNum(r.parts_to_check)}
                              </span>
                            </td>
                            <td className="py-1.5 px-3">
                              {r.is_readonly || r.is_session_expired
                                ? <span className="text-red-400 font-medium">readonly</span>
                                : r.replica_is_active
                                  ? <span className="text-green-400">active</span>
                                  : <span className="text-[var(--dim)]">inactive</span>
                              }
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {replicas.some(r => r.last_exception) && (
                    <div className="m-3 space-y-1">
                      {replicas.filter(r => r.last_exception).map((r, i) => (
                        <div key={i} className="text-[11px] text-red-400 bg-red-500/5 rounded px-3 py-2 font-mono">
                          <span className="font-semibold">{r.database}.{r.table}:</span> {r.last_exception}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            </Section>
          )}
        </div>
      )}

      {/* ═══ HISTORY TAB ═══ */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          <Section title={`Alert firings in range · ${rangeAlerts.length}${activeAlerts.length > 0 ? ` · ${activeAlerts.length} still active` : ''}`} defaultOpen>
            <div className="flex items-center gap-2 mb-3">
              <button
                onClick={() => setShowActiveOnly(!showActiveOnly)}
                className={cn(
                  'text-[11px] px-2.5 py-1 rounded-md border transition-colors',
                  showActiveOnly
                    ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'
                    : 'text-[var(--dim)] border-[var(--border)] hover:text-[var(--text)]',
                )}
              >
                {showActiveOnly ? 'Active only' : 'All (active + resolved)'}
              </button>
            </div>
            {rangeAlerts.length === 0 ? (
              <div className="text-[12px] text-[var(--dim)] py-4 text-center">No alerts fired in selected time range</div>
            ) : (
              <Card noPad>
                <DataTable
                  columns={alertCols}
                  data={(showActiveOnly ? rangeAlerts.filter(a => !a.resolved) : rangeAlerts).sort((a, b) => b.created_at - a.created_at)}
                  pageSize={50}
                  onRowClick={row => setSelectedAlert(row as Alert)}
                />
              </Card>
            )}
          </Section>

          {historyLoading && (
            <div className="text-[11px] text-[var(--dim)] animate-pulse py-2">Loading history data…</div>
          )}

          {queryPatterns.length > 0 && (
            <Section title={`Top Query Patterns · ${queryPatterns.length}`} defaultOpen>
              <Card noPad>
                <DataTable
                  columns={[
                    { key: 'sample_query', label: 'Query', format: (v: any) => <span className="font-mono truncate block max-w-sm" title={v}>{String(v ?? '')}</span> },
                    { key: 'cnt', label: 'Count', format: (v: any) => fmtNum(v) },
                    { key: 'avg_ms', label: 'Avg', format: (v: any) => fmtDuration(v) },
                    { key: 'p95_ms', label: 'p95', format: (v: any) => fmtDuration(v) },
                    { key: 'avg_memory', label: 'Avg Mem', format: (v: any) => fmtBytes(v ?? 0) },
                    { key: 'failures', label: 'Failures', format: (v: any) => v > 0 ? <span className="text-red-400">{fmtNum(v)}</span> : <span className="text-[var(--dim)]">0</span> },
                  ]}
                  data={queryPatterns}
                  maxHeight="240px"
                  showColumnToggle={true}
                  storageKey="detail-query-patterns"
                />
              </Card>
            </Section>
          )}

          {queryFailures.length > 0 && (
            <Section title={`Query Failures · ${queryFailures.length} buckets`} defaultOpen>
              <Card noPad>
                <DataTable
                  columns={[
                    { key: 'ts', label: 'Time', format: (v: any) => <span className="text-[var(--dim)]">{fmtTime(typeof v === 'string' ? new Date(v).getTime() / 1000 : v)}</span> },
                    { key: 'exception_code', label: 'Code' },
                    { key: 'cnt', label: 'Count', format: (v: any) => <span className="text-red-400">{fmtNum(v)}</span> },
                    { key: 'sample', label: 'Sample', format: (v: any) => <span className="text-[var(--dim)] font-mono truncate block max-w-sm" title={String(v ?? '')}>{String(v ?? '')}</span> },
                  ]}
                  data={queryFailures}
                  maxHeight="200px"
                  showColumnToggle={true}
                  storageKey="detail-query-failures"
                />
              </Card>
            </Section>
          )}

          {mergeHistory.length > 0 && (
            <Section title={`Merge Activity · ${mergeHistory.length} buckets`} defaultOpen={false}>
              <Card noPad>
                <DataTable
                  columns={[
                    { key: 'ts', label: 'Time', format: (v: any) => <span className="text-[var(--dim)]">{fmtTime(typeof v === 'string' ? new Date(v).getTime() / 1000 : v)}</span> },
                    { key: 'merge_count', label: 'Merges', format: (v: any) => fmtNum(v) },
                    { key: 'new_part_count', label: 'New Parts', format: (v: any) => fmtNum(v) },
                    { key: 'avg_merge_ms', label: 'Avg Merge', format: (v: any) => fmtDuration(v) },
                    { key: 'merged_rows', label: 'Rows Merged', format: (v: any) => fmtNum(v) },
                    { key: 'merged_bytes', label: 'Data Merged', format: (v: any) => fmtBytes(v ?? 0) },
                  ]}
                  data={mergeHistory}
                  maxHeight="200px"
                />
              </Card>
            </Section>
          )}

          {!historyLoading && queryPatterns.length === 0 && queryFailures.length === 0 && mergeHistory.length === 0 && (
            <div className="text-[12px] text-[var(--dim)] text-center py-4">No activity data for selected range</div>
          )}
        </div>
      )}

      {selectedAlert && (
        <AlertDetailPanel
          alert={selectedAlert}
          onClose={() => setSelectedAlert(null)}
          onResolve={!selectedAlert.resolved ? handleResolveDetailAlert : undefined}
          onAnalyze={a => {
            analyze(`Alert: ${a.title}`, { row: a }, { contextType: 'row', tab: 'alerts', elementId: String(a.id) })
            setSelectedAlert(null)
          }}
        />
      )}
    </div>
  )
}
