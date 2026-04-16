import { useEffect, useState, useCallback, useRef } from 'react'
import { ArrowLeft, ChevronRight, RefreshCw, Sparkles, Wrench, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Bar } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip as ChartTooltip,
} from 'chart.js'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { fmtBytes, fmtNum, fmtTime, fmtDuration, cn } from '../lib/utils'
import { Card } from '../components/Card'
import { Badge } from '../components/Badge'
import { MetricChart } from '../components/MetricChart'
import { HealthChecklist } from '../components/HealthChecklist'
import { DataTable } from '../components/DataTable'
import type { Alert, DiskInfo, ReplicaStatus, S3Stats, MaintenanceWindow } from '../types/api'

ChartJS.register(CategoryScale, LinearScale, BarElement, ChartTooltip)

/* ------------------------------------------------------------------ */
/*  Detail view                                                       */
/* ------------------------------------------------------------------ */
export default function Detail({ refreshKey }: { refreshKey?: number }) {
  const { instance, setView, setInstance, customFrom, customTo } = useStore()
  const { analyze } = useAIAnalysis(instance ?? '')
  const handleAnalyze = useCallback((data: Record<string, any>) => {
    analyze('Instance Detail', data, { contextType: 'tab', tab: 'detail' })
  }, [analyze])

  const [activeWindow, setActiveWindow] = useState<MaintenanceWindow | null>(null)
  const [alertHistory, setAlertHistory] = useState<Alert[]>([])
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
  const [currentStateRefreshTick, setCurrentStateRefreshTick] = useState(0)
  const isFirstLoad = useRef(true)
  // Time-range-aware historical data (re-fetches when from/to changes)
  const [queryPatterns, setQueryPatterns] = useState<Record<string, any>[]>([])
  const [queryFailures, setQueryFailures] = useState<Record<string, any>[]>([])
  const [mergeHistory, setMergeHistory] = useState<Record<string, any>[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // Collapsible sections
  const [showRunning, setShowRunning] = useState(false)
  const [showMVs, setShowMVs] = useState(false)
  const [showStorage, setShowStorage] = useState(false)
  const [showHistory, setShowHistory] = useState(true)
  const [showReplication, setShowReplication] = useState(false)

  // Anti-patterns quick scan
  const [showAP, setShowAP] = useState(false)
  const [queryAP, setQueryAP] = useState<any[] | null>(null)
  const [tableAP, setTableAP] = useState<any[] | null>(null)
  const [apLoading, setApLoading] = useState(false)
  const [apLoaded, setApLoaded] = useState(false)

  useEffect(() => {
    if (!instance) return
    let cancelled = false

    async function load() {
      if (isFirstLoad.current) {
        setLoading(true)
      } else {
        setRefreshing(true)
      }
      try {
        const [ah, q, t, d, m, s3, cs, tm, repl, maint] = await Promise.all([
          api.alerts.history({ limit: 500 }).catch(() => [] as Alert[]),
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
          // Find active maintenance window for this instance or wildcard "*"
          const now = new Date()
          const win = (maint as MaintenanceWindow[]).find(
            w => (w.instance === instance || w.instance === '*') && new Date(w.ends_at) > now
          ) ?? null
          setActiveWindow(win)
          setAlertHistory((ah as Alert[]).filter((a) => a.instance === instance))
          setQueries(q)
          setTables(t)
          setDisks(d as DiskInfo[])
          setMvs(m)
          setS3Stats(s3 as any)
          setCacheStats(cs)
          setTableMemory(tm ?? [])
          setReplicas(repl as ReplicaStatus[])
        }
      } catch {
        // keep empty state
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

  // Separate effect: re-runs whenever the time range changes
  useEffect(() => {
    if (!instance) return
    let cancelled = false
    setHistoryLoading(true)
    Promise.all([
      api.history.queryPatterns(instance, customFrom, customTo, 20).catch(() => []),
      api.history.failures(instance, customFrom, customTo).catch(() => []),
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

  if (!instance) return null

  const goBack = () => {
    setView('overview')
    setInstance(null)
  }

  /* ---- Local disks only (exclude s3) for bar chart ---- */
  const localDisks = disks.filter((d) => !d.disk_name.toLowerCase().includes('s3'))

  const diskChartData = {
    labels: localDisks.map((d) => d.disk_name),
    datasets: [
      {
        label: 'Used',
        data: localDisks.map((d) => d.total_space - d.free_space),
        backgroundColor: '#3b82f6',
      },
      {
        label: 'Free',
        data: localDisks.map((d) => d.free_space),
        backgroundColor: '#1e3a5f',
      },
    ],
  }

  const diskChartOpts = {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: 'y' as const,
    plugins: {
      tooltip: {
        callbacks: {
          label: (ctx: any) => `${ctx.dataset.label}: ${fmtBytes(ctx.parsed.x)}`,
        },
      },
    },
    scales: {
      x: {
        stacked: true,
        ticks: { callback: (v: any) => fmtBytes(Number(v)), color: '#6b7280', font: { size: 10 } },
        grid: { color: 'rgba(255,255,255,0.04)' },
      },
      y: {
        stacked: true,
        ticks: { color: '#6b7280', font: { size: 11 } },
        grid: { display: false },
      },
    },
  }

  /* ---- Time-range filtered alerts ---- */
  const rangeAlerts = alertHistory.filter(
    (a) => a.created_at >= customFrom && a.created_at <= customTo
  )
  const activeAlerts = alertHistory.filter((a) => !a.resolved)

  /* ---- Table columns (DataTable format API: format receives cell value) ---- */
  const handleResolveDetailAlert = useCallback(async (dedupKey: string) => {
    try {
      await api.alerts.resolve(dedupKey)
      // Refresh alert history
      const ah = await api.alerts.history({ limit: 500 }).catch(() => [] as Alert[])
      setAlertHistory((ah as Alert[]).filter((a) => a.instance === instance))
    } catch (e: any) {
      console.error('resolve alert failed:', e)
    }
  }, [instance])

  const [showActiveOnly, setShowActiveOnly] = useState(false)

  const alertCols = [
    { key: 'severity', label: 'Sev', tooltip: 'Alert severity: info (blue), warning (amber), critical (red)', format: (v: any) => <Badge severity={v} /> },
    { key: 'category', label: 'Category', tooltip: 'Type of system check that triggered this alert (e.g. parts, memory, replication)' },
    { key: 'title', label: 'Title', tooltip: 'Brief description of the alert condition' },
    {
      key: 'resolved',
      label: 'Status',
      tooltip: 'Active alerts need attention; resolved alerts have been acknowledged',
      format: (v: any) => v
        ? <span className="text-xs text-green-400">resolved</span>
        : <span className="text-xs text-yellow-400">active</span>,
    },
    { key: 'created_at', label: 'Time', tooltip: 'Timestamp when the alert was first triggered', format: (v: any) => <span className="text-[var(--dim)]">{fmtTime(v)}</span> },
    {
      key: 'dedup_key',
      label: '',
      format: (_v: any, row: Record<string, any>) => !row.resolved ? (
        <button
          onClick={(e) => { e.stopPropagation(); handleResolveDetailAlert(row.dedup_key) }}
          className="text-xs text-green-400 hover:underline whitespace-nowrap"
        >
          Resolve
        </button>
      ) : null,
    },
  ]

  const queryCols = [
    {
      key: 'query_short',
      label: 'Query',
      tooltip: 'Truncated SQL query from system.processes (currently running)',
      format: (v: any) => (
        <span className="font-mono text-xs truncate block max-w-md" title={String(v ?? '')}>
          {String(v ?? '').slice(0, 100)}
        </span>
      ),
    },
    {
      key: 'elapsed',
      label: 'Elapsed',
      tooltip: 'How long the query has been running so far',
      format: (v: any) => fmtDuration((v ?? 0) * 1000),
    },
    { key: 'user', label: 'User', tooltip: 'Database user who submitted the query' },
    {
      key: 'memory_usage',
      label: 'Memory',
      tooltip: 'Current peak memory consumed by this query',
      format: (v: any) => fmtBytes(v ?? 0),
    },
    {
      key: 'read_rows',
      label: 'Read Rows',
      tooltip: 'Rows scanned from disk or cache so far',
      format: (v: any) => fmtNum(v),
    },
  ]

  const tableCols = [
    { key: 'database', label: 'Database', tooltip: 'ClickHouse database name' },
    { key: 'table_name', label: 'Table', tooltip: 'Table name' },
    { key: 'engine', label: 'Engine', tooltip: 'Table engine (e.g. MergeTree, ReplicatedMergeTree, Distributed)' },
    {
      key: 'part_count',
      label: 'Parts',
      tooltip: 'Number of active data parts — high part counts slow queries and increase memory use. Target < 100 per table',
      format: (v: any) => {
        const pc = v ?? 0
        const cls = pc > 300 ? 'text-red-400' : pc > 100 ? 'text-yellow-400' : 'text-green-400'
        return <span className={cls}>{fmtNum(pc)}</span>
      },
    },
    {
      key: 'size_readable',
      label: 'Size',
      tooltip: 'Total compressed disk size of all parts for this table',
    },
  ]

  const mvCols = [
    { key: 'database', label: 'Database', tooltip: 'Database containing the materialized view' },
    { key: 'mv_name', label: 'Materialized View', tooltip: 'Materialized view name — these execute automatically on each INSERT to the source table' },
  ]

  const s3VolCols = [
    { key: 'table', label: 'Table', tooltip: 'Table with data stored in S3 (tiered or S3-backed storage)' },
    { key: 'parts', label: 'Parts', tooltip: 'Number of data parts stored in S3', format: (v: any) => fmtNum(v) },
    { key: 'size', label: 'Size', tooltip: 'Total data volume in S3 for this table' },
  ]

  const s3LatCols = [
    { key: 'table', label: 'Table', tooltip: 'Table whose queries generated the most S3 requests' },
    {
      key: 'avg_latency_ms',
      label: 'Avg Latency',
      tooltip: 'Average S3 request latency — high values indicate slow S3 or large object reads',
      format: (v: any) => (v ?? 0).toFixed(1) + 'ms',
    },
    {
      key: 'total_requests',
      label: 'Requests',
      tooltip: 'Total number of S3 API calls from this table in the time range',
      format: (v: any) => fmtNum(v ?? 0),
    },
  ]

  /* ---- Loading skeleton ---- */
  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 bg-[var(--hover)] rounded" />
          <div className="h-6 bg-[var(--hover)] rounded w-48" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => (
            <Card key={i}>
              <div className="h-3 bg-[var(--hover)] rounded w-1/2 mb-2" />
              <div className="h-40 bg-[var(--hover)] rounded" />
            </Card>
          ))}
        </div>
      </div>
    )
  }

  const maintUntil = activeWindow
    ? new Date(activeWindow.ends_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div className="space-y-6">
      {/* ---- Maintenance banner ---- */}
      {activeWindow && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-orange-500/30 bg-orange-500/10 text-sm text-orange-400">
          <Wrench size={15} className="shrink-0" />
          <div className="flex-1">
            <span className="font-semibold">Maintenance window active</span>
            {activeWindow.reason && (
              <span className="text-orange-400/70 ml-2">— {activeWindow.reason}</span>
            )}
          </div>
          {maintUntil && <span className="text-orange-400/70 text-xs shrink-0">Alerts suppressed until {maintUntil}</span>}
        </div>
      )}
      {/* ---- Header ---- */}
      <div className="flex items-center gap-3">
        <button
          onClick={goBack}
          className="p-1.5 rounded-md hover:bg-[var(--hover)] text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-xl font-bold flex-1">{instance}</h1>
        {refreshing && (
          <div className="flex items-center gap-1.5 text-xs text-[var(--dim)]">
            <RefreshCw size={11} className="animate-spin" />
            Refreshing…
          </div>
        )}
        <button
          onClick={() => setCurrentStateRefreshTick(t => t + 1)}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-[var(--dim)] hover:bg-[var(--hover)] border border-[var(--border)] transition-colors shrink-0 disabled:opacity-50"
          title="Refresh current-state data (health checks, running queries, disk)"
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          Refresh now
        </button>
        <button
          onClick={() => handleAnalyze({ instance, activeAlerts, queries, tables, disks, s3Stats, cacheStats, tableMemory })}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-purple-400 hover:bg-purple-500/15 border border-purple-500/20 transition-colors"
        >
          <Sparkles size={11} />
          Analyze
        </button>
      </div>

      {/* ---- Health checklist (current state — use Refresh now to re-fetch) ---- */}
      <HealthChecklist instance={instance} refreshTrigger={currentStateRefreshTick} />

      {/* ---- Metric charts: 3-col compact grid (time-range aware) ---- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <MetricChart instance={instance} title="Memory %" metrics={['system.memory.rss_percent', 'system.memory.used_percent']} yFormat="percent" height={130} />
        <MetricChart instance={instance} title="Memory Bytes" metrics={['system.memory.rss_bytes', 'system.memory.available_bytes', 'system.metrics.MemoryTracking']} yFormat="bytes" height={130} />
        <MetricChart instance={instance} title="CPU %" metrics={['system.cpu.busy_percent']} yFormat="percent" height={130} />
        <MetricChart instance={instance} title="Load Average" metrics={['system.async.LoadAverage1', 'system.async.LoadAverage5', 'system.async.LoadAverage15']} height={130} />
        <MetricChart instance={instance} title="Queries" metrics={['system.metrics.Query', 'queries.failed_5m']} height={130} />
        <MetricChart instance={instance} title="Parts & Merges" metrics={['tables.merges.active_count']} height={130} />
        <MetricChart instance={instance} title="Insert Throughput" metrics={['inserts.total.rows']} height={130} />
        <MetricChart instance={instance} title="S3 Latency" metrics={['storage.s3.avg_latency_ms', 'storage.s3.max_latency_ms']} yFormat="ms" height={130} />
      </div>

      {/* ---- Storage section (collapsible) ---- */}
      {(localDisks.length > 0 || s3Stats || cacheStats) && (
        <div>
          <button
            onClick={() => setShowStorage(!showStorage)}
            className="w-full flex items-center gap-2 py-2 text-sm font-medium text-[var(--dim)] hover:text-[var(--text)] transition-colors"
          >
            <ChevronRight size={14} className={cn('transition-transform', showStorage && 'rotate-90')} />
            Storage, S3 & Cache
            <span className="text-xs font-normal px-1.5 py-0.5 rounded bg-[var(--hover)] text-[var(--dim)] border border-[var(--border)]">now</span>
          </button>
          {showStorage && (
            <div className="space-y-4 mt-2">
              {localDisks.length > 0 && (
                <Card title="Disk Usage">
                  <div style={{ height: Math.max(60, localDisks.length * 40) }}>
                    <Bar data={diskChartData} options={diskChartOpts} />
                  </div>
                </Card>
              )}
              {cacheStats && (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <Card>
                    <div className="text-lg font-bold">{fmtBytes(cacheStats.mark_cache_bytes ?? 0)}</div>
                    <div className="text-xs text-[var(--dim)] mt-1">Mark Cache</div>
                    <div className="text-xs text-[var(--dim)]">{fmtNum(cacheStats.mark_cache_files ?? 0)} files</div>
                  </Card>
                  <Card>
                    <div className="text-lg font-bold">{fmtBytes(cacheStats.primary_key_bytes ?? 0)}</div>
                    <div className="text-xs text-[var(--dim)] mt-1">Primary Key Mem</div>
                  </Card>
                  <Card>
                    <div className="text-lg font-bold">{fmtBytes(cacheStats.filesystem_cache_bytes ?? 0)}</div>
                    <div className="text-xs text-[var(--dim)] mt-1">FS Cache</div>
                    <div className="text-xs text-[var(--dim)]">{fmtBytes(cacheStats.filesystem_cache_limit ?? 0)} limit</div>
                  </Card>
                  <Card>
                    <div className="text-lg font-bold">{fmtBytes(cacheStats.index_granularity_bytes ?? 0)}</div>
                    <div className="text-xs text-[var(--dim)] mt-1">Index Granularity</div>
                  </Card>
                </div>
              )}
              {s3Stats && s3Stats.volume_by_table && Array.isArray(s3Stats.volume_by_table) && s3Stats.volume_by_table.length > 0 && (() => {
                const volTable = s3Stats.volume_by_table as any[]
                const totalS3Bytes = volTable.reduce((sum: number, r: any) => sum + (r.bytes ?? 0), 0)
                const fsBytes = cacheStats?.filesystem_cache_bytes ?? 0
                const fsLimit = cacheStats?.filesystem_cache_limit ?? 0
                const fsPct = fsLimit > 0 ? Math.min(100, (fsBytes / fsLimit) * 100) : 0
                return (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <Card>
                        <div className="text-lg font-bold">{fmtBytes(totalS3Bytes)}</div>
                        <div className="text-xs text-[var(--dim)] mt-1">Total S3 Data</div>
                        <div className="text-xs text-[var(--dim)]">{volTable.length} tables</div>
                      </Card>
                      <Card>
                        <div className="text-lg font-bold">{fsLimit > 0 ? fsPct.toFixed(1) + '%' : '--'}</div>
                        <div className="text-xs text-[var(--dim)] mt-1">S3 Local Cache</div>
                        <div className="text-xs text-[var(--dim)]">{fmtBytes(fsBytes)} / {fmtBytes(fsLimit)}</div>
                        {fsLimit > 0 && (
                          <div className="mt-1.5 h-1 rounded-full bg-[var(--hover)] overflow-hidden">
                            <div className={`h-full rounded-full ${fsPct > 90 ? 'bg-red-500' : fsPct > 70 ? 'bg-yellow-500' : 'bg-green-500'}`} style={{ width: fsPct + '%' }} />
                          </div>
                        )}
                      </Card>
                      <Card>
                        <div className="text-lg font-bold">{fmtNum(cacheStats?.filesystem_cache_elements ?? 0)}</div>
                        <div className="text-xs text-[var(--dim)] mt-1">Cached Elements</div>
                      </Card>
                    </div>
                    <Card title="S3 Volume by Table">
                      <DataTable columns={s3VolCols} data={volTable} maxHeight="250px" />
                    </Card>
                    {s3Stats.latency_by_table && Array.isArray(s3Stats.latency_by_table) && s3Stats.latency_by_table.length > 0 && (
                      <Card title="S3 Latency by Table">
                        <DataTable columns={s3LatCols} data={s3Stats.latency_by_table} maxHeight="250px" />
                      </Card>
                    )}
                  </div>
                )
              })()}
            </div>
          )}
        </div>
      )}

      {/* ---- Running Queries (collapsible, current state) ---- */}
      {queries.length > 0 && (
        <div>
          <button
            onClick={() => setShowRunning(!showRunning)}
            className="w-full flex items-center gap-2 py-2 text-sm font-medium text-[var(--dim)] hover:text-[var(--text)] transition-colors"
          >
            <ChevronRight size={14} className={cn('transition-transform', showRunning && 'rotate-90')} />
            Running Queries ({queries.length})
            <span className="text-xs font-normal px-1.5 py-0.5 rounded bg-[var(--hover)] text-[var(--dim)] border border-[var(--border)]">now</span>
          </button>
          {showRunning && (
            <Card className="mt-2">
              <DataTable columns={queryCols} data={queries} maxHeight="280px" />
            </Card>
          )}
        </div>
      )}

      {/* ---- Replication health (collapsible, current state) ---- */}
      {replicas.length > 0 && (
        <div>
          <button
            onClick={() => setShowReplication(!showReplication)}
            className="w-full flex items-center gap-2 py-2 text-sm font-medium text-[var(--dim)] hover:text-[var(--text)] transition-colors"
          >
            <ChevronRight size={14} className={cn('transition-transform', showReplication && 'rotate-90')} />
            Replication ({replicas.length} table{replicas.length !== 1 ? 's' : ''})
            {replicas.some(r => r.is_readonly || r.is_session_expired) && (
              <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20">readonly</span>
            )}
            {replicas.some(r => r.absolute_delay > 30) && !replicas.some(r => r.is_readonly) && (
              <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400 border border-yellow-500/20">lag</span>
            )}
            <span className="text-xs font-normal px-1.5 py-0.5 rounded bg-[var(--hover)] text-[var(--dim)] border border-[var(--border)]">now</span>
          </button>
          {showReplication && (
            <Card className="mt-2">
              <div className="overflow-auto">
                <table className="w-full min-w-[700px] text-xs">
                  <thead>
                    <tr className="border-b border-[var(--border)]">
                      {['Table', 'Replica', 'Leader', 'Delay', 'Queue', 'Parts to Check', 'Status'].map(h => (
                        <th key={h} className="text-left py-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {replicas.map((r, i) => {
                      const hasIssue = r.is_readonly || r.is_session_expired || r.absolute_delay > 300
                      const hasWarn = r.absolute_delay > 30 || r.parts_to_check > 0 || r.queue_size > 100
                      return (
                        <tr key={i} className={cn(
                          'border-b border-[var(--border)] last:border-0',
                          hasIssue ? 'bg-red-500/5' : hasWarn ? 'bg-yellow-500/5' : '',
                        )}>
                          <td className="py-2 px-3 font-mono">{r.database}.{r.table}</td>
                          <td className="py-2 px-3 text-[var(--dim)]">{r.replica_name}</td>
                          <td className="py-2 px-3">{r.is_leader ? <span className="text-green-400">leader</span> : <span className="text-[var(--dim)]">replica</span>}</td>
                          <td className="py-2 px-3">
                            <span className={r.absolute_delay > 300 ? 'text-red-400 font-medium' : r.absolute_delay > 30 ? 'text-yellow-400' : 'text-[var(--dim)]'}>
                              {r.absolute_delay > 0 ? `${Math.round(r.absolute_delay)}s` : '—'}
                            </span>
                          </td>
                          <td className="py-2 px-3">
                            <span className={r.queue_size > 1000 ? 'text-red-400' : r.queue_size > 100 ? 'text-yellow-400' : 'text-[var(--dim)]'}>
                              {fmtNum(r.queue_size)}
                            </span>
                          </td>
                          <td className="py-2 px-3">
                            <span className={r.parts_to_check > 5 ? 'text-yellow-400' : 'text-[var(--dim)]'}>
                              {fmtNum(r.parts_to_check)}
                            </span>
                          </td>
                          <td className="py-2 px-3">
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
                  <div className="mt-3 space-y-1">
                    {replicas.filter(r => r.last_exception).map((r, i) => (
                      <div key={i} className="text-xs text-red-400 bg-red-500/5 rounded px-3 py-2 font-mono">
                        <span className="font-semibold">{r.database}.{r.table}:</span> {r.last_exception}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ---- Alerts (time-range aware) ---- */}
      <Card title={`Alerts in Range${rangeAlerts.length > 0 ? ` (${rangeAlerts.length})` : ''}${activeAlerts.length > 0 ? ` · ${activeAlerts.length} active` : ''}`}>
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => setShowActiveOnly(!showActiveOnly)}
            className={cn(
              'text-xs px-2.5 py-1 rounded border transition-colors',
              showActiveOnly
                ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'
                : 'text-[var(--dim)] border-[var(--border)] hover:text-[var(--text)]'
            )}
          >
            {showActiveOnly ? 'Active only' : 'All (active + resolved)'}
          </button>
        </div>
        {rangeAlerts.length === 0 ? (
          <div className="text-sm text-[var(--dim)] py-4 text-center">No alerts fired in selected time range</div>
        ) : (
          <DataTable
            columns={alertCols}
            data={(showActiveOnly ? rangeAlerts.filter(a => !a.resolved) : rangeAlerts).sort((a, b) => b.created_at - a.created_at)}
            pageSize={50}
          />
        )}
      </Card>

      {/* ---- Historical activity (time-range aware) ---- */}
      <div>
        <button
          onClick={() => setShowHistory(!showHistory)}
          className="w-full flex items-center gap-2 py-2 text-sm font-medium text-[var(--dim)] hover:text-[var(--text)] transition-colors"
        >
          <ChevronRight size={14} className={cn('transition-transform', showHistory && 'rotate-90')} />
          Activity in Range
          {historyLoading && <span className="text-xs font-normal animate-pulse">loading…</span>}
        </button>
        {showHistory && (
          <div className="space-y-3 mt-2">
            {queryPatterns.length > 0 && (
              <Card title={`Top Query Patterns (${queryPatterns.length})`}>
                <DataTable
                  columns={[
                    { key: 'sample_query', label: 'Query', tooltip: 'Example SQL for this query pattern', format: (v: any) => <span className="font-mono text-xs truncate block max-w-sm" title={v}>{String(v ?? '').slice(0, 80)}</span> },
                    { key: 'cnt', label: 'Count', tooltip: 'Number of executions in the time range', format: (v: any) => fmtNum(v) },
                    { key: 'avg_ms', label: 'Avg', tooltip: 'Average query duration', format: (v: any) => fmtDuration(v) },
                    { key: 'p95_ms', label: 'p95', tooltip: '95th percentile latency — 95% of runs were faster', format: (v: any) => fmtDuration(v) },
                    { key: 'avg_memory', label: 'Avg Mem', tooltip: 'Average peak memory per execution', format: (v: any) => fmtBytes(v ?? 0) },
                    { key: 'failures', label: 'Failures', tooltip: 'Executions that raised an exception', format: (v: any) => v > 0 ? <span className="text-red-400">{fmtNum(v)}</span> : <span className="text-[var(--dim)]">0</span> },
                  ]}
                  data={queryPatterns}
                  maxHeight="240px"
                />
              </Card>
            )}
            {queryFailures.length > 0 && (
              <Card title={`Query Failures (${queryFailures.length} buckets)`}>
                <DataTable
                  columns={[
                    { key: 'ts', label: 'Time', tooltip: 'Time bucket for this failure count', format: (v: any) => <span className="text-[var(--dim)]">{fmtTime(typeof v === 'string' ? new Date(v).getTime() / 1000 : v)}</span> },
                    { key: 'exception_code', label: 'Code', tooltip: 'ClickHouse exception code — e.g. 241=memory limit, 159=timeout, 60=table not found' },
                    { key: 'cnt', label: 'Count', tooltip: 'Number of query failures in this time bucket', format: (v: any) => <span className="text-red-400">{fmtNum(v)}</span> },
                    { key: 'sample', label: 'Sample', tooltip: 'Example error message for this exception code', format: (v: any) => <span className="text-xs text-[var(--dim)]">{String(v ?? '').slice(0, 80)}</span> },
                  ]}
                  data={queryFailures}
                  maxHeight="200px"
                />
              </Card>
            )}
            {mergeHistory.length > 0 && (
              <Card title={`Merge Activity (${mergeHistory.length} time buckets)`}>
                <DataTable
                  columns={[
                    { key: 'ts', label: 'Time', tooltip: 'Time bucket for this merge activity', format: (v: any) => <span className="text-[var(--dim)]">{fmtTime(typeof v === 'string' ? new Date(v).getTime() / 1000 : v)}</span> },
                    { key: 'merge_count', label: 'Merges', tooltip: 'Number of background merge operations completed', format: (v: any) => fmtNum(v) },
                    { key: 'new_part_count', label: 'New Parts', tooltip: 'New parts created (from INSERTs) — high counts may indicate too-small inserts', format: (v: any) => fmtNum(v) },
                    { key: 'avg_merge_ms', label: 'Avg Merge', tooltip: 'Average time per merge operation — slow merges may cause part accumulation', format: (v: any) => fmtDuration(v) },
                    { key: 'merged_rows', label: 'Rows Merged', tooltip: 'Total rows consolidated by merges in this bucket', format: (v: any) => fmtNum(v) },
                    { key: 'merged_bytes', label: 'Data Merged', tooltip: 'Total data bytes processed by merges in this bucket', format: (v: any) => fmtBytes(v ?? 0) },
                  ]}
                  data={mergeHistory}
                  maxHeight="200px"
                />
              </Card>
            )}
            {!historyLoading && queryPatterns.length === 0 && queryFailures.length === 0 && mergeHistory.length === 0 && (
              <div className="text-sm text-[var(--dim)] text-center py-4">No activity data for selected range</div>
            )}
          </div>
        )}
      </div>

      {/* ---- Tables (current state) ---- */}
      {tables.length > 0 && (
        <Card title={`Tables · ${tables.length} total`}>
          <DataTable
            columns={tableCols}
            data={tables}
            maxHeight="300px"
          />
        </Card>
      )}

      {/* ---- Per-Table Memory (current state) ---- */}
      {tableMemory.length > 0 && (
        <Card title="Table Memory & Parts">
          <DataTable
            columns={[
              { key: 'database', label: 'DB', tooltip: 'Database name' },
              { key: 'table_name', label: 'Table', tooltip: 'Table name' },
              { key: 'pk_readable', label: 'PK Mem', tooltip: 'Memory used by the primary key index (loaded on server start, stays in RAM)' },
              { key: 'marks_readable', label: 'Marks Mem', tooltip: 'Memory used by granule marks — used to locate data ranges during queries' },
              { key: 'parts', label: 'Parts', tooltip: 'Number of active data parts — aim to keep under 100 per table', format: (v: any) => fmtNum(v) },
              { key: 'total_rows', label: 'Rows', tooltip: 'Total row count across all parts', format: (v: any) => fmtNum(v) },
              { key: 'disk_size', label: 'Disk', tooltip: 'Compressed disk size of all local parts', format: (v: any) => fmtBytes(v ?? 0) },
            ]}
            data={[...tableMemory].sort((a, b) => (b.pk_bytes ?? 0) - (a.pk_bytes ?? 0))}
            maxHeight="300px"
          />
        </Card>
      )}

      {/* ---- Materialized Views (collapsible, current state) ---- */}
      {mvs.length > 0 && (
        <div>
          <button
            onClick={() => setShowMVs(!showMVs)}
            className="w-full flex items-center gap-2 py-2 text-sm font-medium text-[var(--dim)] hover:text-[var(--text)] transition-colors"
          >
            <ChevronRight size={14} className={cn('transition-transform', showMVs && 'rotate-90')} />
            Materialized Views ({mvs.length})
            <span className="text-xs font-normal px-1.5 py-0.5 rounded bg-[var(--hover)] text-[var(--dim)] border border-[var(--border)]">now</span>
          </button>
          {showMVs && (
            <Card className="mt-2">
              <DataTable columns={mvCols} data={mvs} maxHeight="250px" />
            </Card>
          )}
        </div>
      )}

      {/* ---- Anti-pattern Quick Scan (on-demand) ---- */}
      <div>
        <button
          onClick={() => {
            const next = !showAP
            setShowAP(next)
            if (next && !apLoaded && instance) {
              setApLoading(true)
              setApLoaded(true)
              Promise.all([
                api.advisor.queryAntiPatterns(instance).then(d => setQueryAP(d)).catch(() => setQueryAP([])),
                api.advisor.tableAntiPatterns(instance).then(d => setTableAP(d)).catch(() => setTableAP([])),
              ]).finally(() => setApLoading(false))
            }
          }}
          className="w-full flex items-center gap-2 py-2 text-sm font-medium text-[var(--dim)] hover:text-[var(--text)] transition-colors"
        >
          <ChevronRight size={14} className={cn('transition-transform', showAP && 'rotate-90')} />
          <Wrench size={14} />
          Anti-pattern Scan
          {!apLoaded && <span className="text-xs font-normal text-[var(--dim)]">— click to run</span>}
          {apLoading && <span className="text-xs font-normal text-[var(--dim)]">Loading…</span>}
          {(queryAP || tableAP) && !apLoading && (() => {
            const issues = [
              ...(queryAP?.filter(g => g.count > 0) ?? []),
              ...(tableAP?.filter(g => g.count > 0) ?? []),
            ]
            const crits = issues.filter(g => g.severity === 'critical').length
            return crits > 0
              ? <span className="text-xs font-semibold text-red-400 ml-auto">{crits} critical</span>
              : issues.length > 0
              ? <span className="text-xs font-semibold text-yellow-400 ml-auto">{issues.length} warnings</span>
              : <span className="text-xs font-semibold text-green-400 ml-auto flex items-center gap-1"><CheckCircle2 size={11} /> Clean</span>
          })()}
        </button>
        {showAP && !apLoading && (queryAP || tableAP) && (
          <Card className="mt-2">
            <div className="space-y-3">
              {/* Summary row */}
              {[...(queryAP ?? []), ...(tableAP ?? [])].filter(g => g.count > 0).length === 0
                ? <div className="text-sm text-green-400 flex items-center gap-2"><CheckCircle2 size={14} /> No anti-patterns detected</div>
                : (
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
                          <AlertTriangle size={13} className={group.severity === 'critical' ? 'text-red-400 mt-0.5 shrink-0' : 'text-yellow-400 mt-0.5 shrink-0'} />
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-[var(--fg)] truncate">{group.title}</div>
                            <div className="text-[11px] text-[var(--dim)]">{group.count} {group.count === 1 ? 'table/query' : 'tables/queries'}</div>
                          </div>
                        </div>
                      ))
                    }
                  </div>
                )
              }
              <button
                onClick={() => { setView('explore'); setTimeout(() => {
                  const url = new URL(window.location.href)
                  url.searchParams.set('tab', 'antipatterns')
                  window.history.pushState({}, '', url)
                }, 50) }}
                className="text-xs text-[var(--accent)] hover:underline"
              >
                Open full Anti-patterns tab in Explore →
              </button>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
