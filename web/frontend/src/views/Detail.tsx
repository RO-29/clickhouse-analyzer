import { useEffect, useState, useCallback, useRef } from 'react'
import { ArrowLeft, ChevronRight, RefreshCw, Sparkles } from 'lucide-react'
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
import type { Alert, DiskInfo, S3Stats } from '../types/api'

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

  const [alertHistory, setAlertHistory] = useState<Alert[]>([])
  const [queries, setQueries] = useState<Record<string, any>[]>([])
  const [tables, setTables] = useState<Record<string, any>[]>([])
  const [disks, setDisks] = useState<DiskInfo[]>([])
  const [mvs, setMvs] = useState<Record<string, any>[]>([])
  const [s3Stats, setS3Stats] = useState<S3Stats | null>(null)
  const [cacheStats, setCacheStats] = useState<any>(null)
  const [tableMemory, setTableMemory] = useState<any[]>([])
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
        const [ah, q, t, d, m, s3, cs, tm] = await Promise.all([
          api.alerts.history(500).catch(() => [] as Alert[]),
          api.queries(instance!).catch(() => []),
          api.tables(instance!).catch(() => []),
          api.disks(instance!).catch(() => []),
          api.mvs(instance!).catch(() => []),
          api.s3Stats(instance!).catch(() => null),
          api.cacheStats(instance!).catch(() => null),
          api.tableMemory(instance!).catch(() => []),
        ])
        if (!cancelled) {
          setAlertHistory((ah as Alert[]).filter((a) => a.instance === instance))
          setQueries(q)
          setTables(t)
          setDisks(d as DiskInfo[])
          setMvs(m)
          setS3Stats(s3 as any)
          setCacheStats(cs)
          setTableMemory(tm ?? [])
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
      const ah = await api.alerts.history(500).catch(() => [] as Alert[])
      setAlertHistory((ah as Alert[]).filter((a) => a.instance === instance))
    } catch (e: any) {
      console.error('resolve alert failed:', e)
    }
  }, [instance])

  const [showActiveOnly, setShowActiveOnly] = useState(false)

  const alertCols = [
    { key: 'severity', label: 'Sev', format: (v: any) => <Badge severity={v} /> },
    { key: 'category', label: 'Category' },
    { key: 'title', label: 'Title' },
    {
      key: 'resolved',
      label: 'Status',
      format: (v: any) => v
        ? <span className="text-xs text-green-400">resolved</span>
        : <span className="text-xs text-yellow-400">active</span>,
    },
    { key: 'created_at', label: 'Time', format: (v: any) => <span className="text-[var(--dim)]">{fmtTime(v)}</span> },
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
      format: (v: any) => (
        <span className="font-mono text-xs truncate block max-w-md" title={String(v ?? '')}>
          {String(v ?? '').slice(0, 100)}
        </span>
      ),
    },
    {
      key: 'elapsed',
      label: 'Elapsed',
      format: (v: any) => fmtDuration((v ?? 0) * 1000),
    },
    { key: 'user', label: 'User' },
    {
      key: 'memory_usage',
      label: 'Memory',
      format: (v: any) => fmtBytes(v ?? 0),
    },
    {
      key: 'read_rows',
      label: 'Read Rows',
      format: (v: any) => fmtNum(v),
    },
  ]

  const tableCols = [
    { key: 'database', label: 'Database' },
    { key: 'table_name', label: 'Table' },
    { key: 'engine', label: 'Engine' },
    {
      key: 'part_count',
      label: 'Parts',
      format: (v: any) => {
        const pc = v ?? 0
        const cls = pc > 300 ? 'text-red-400' : pc > 100 ? 'text-yellow-400' : 'text-green-400'
        return <span className={cls}>{fmtNum(pc)}</span>
      },
    },
    {
      key: 'size_readable',
      label: 'Size',
    },
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
    {
      key: 'avg_latency_ms',
      label: 'Avg Latency',
      format: (v: any) => (v ?? 0).toFixed(1) + 'ms',
    },
    {
      key: 'total_requests',
      label: 'Requests',
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
        <div className="grid grid-cols-4 gap-4">
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

  return (
    <div className="space-y-6">
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
      <div className="grid grid-cols-3 gap-3">
        <MetricChart instance={instance} title="Memory %" metrics={['system.memory.rss_percent', 'system.memory.used_percent']} yFormat="percent" height={130} />
        <MetricChart instance={instance} title="Memory Bytes" metrics={['system.memory.rss_bytes', 'system.memory.available_bytes', 'system.metrics.MemoryTracking']} yFormat="bytes" height={130} />
        <MetricChart instance={instance} title="CPU %" metrics={['system.cpu.busy_percent']} yFormat="percent" height={130} />
        <MetricChart instance={instance} title="Load Average" metrics={['system.async.LoadAverage1', 'system.async.LoadAverage5', 'system.async.LoadAverage15']} height={130} />
        <MetricChart instance={instance} title="Queries" metrics={['system.metrics.Query', 'queries.failed_5m']} height={130} />
        <MetricChart instance={instance} title="Parts & Merges" metrics={['tables.merges.active_count']} height={130} />
        <MetricChart instance={instance} title="Insert Throughput" metrics={['inserts.total.rows']} height={130} />
        <MetricChart instance={instance} title="S3 Latency" metrics={['storage.s3.avg_latency_ms', 'storage.s3.max_latency_ms']} yFormat="ms" height={130} />
      </div>

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
                    { key: 'sample_query', label: 'Query', format: (v: any) => <span className="font-mono text-xs truncate block max-w-sm" title={v}>{String(v ?? '').slice(0, 80)}</span> },
                    { key: 'cnt', label: 'Count', format: (v: any) => fmtNum(v) },
                    { key: 'avg_ms', label: 'Avg', format: (v: any) => fmtDuration(v) },
                    { key: 'p95_ms', label: 'p95', format: (v: any) => fmtDuration(v) },
                    { key: 'avg_memory', label: 'Avg Mem', format: (v: any) => fmtBytes(v ?? 0) },
                    { key: 'failures', label: 'Failures', format: (v: any) => v > 0 ? <span className="text-red-400">{fmtNum(v)}</span> : <span className="text-[var(--dim)]">0</span> },
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
                    { key: 'ts', label: 'Time', format: (v: any) => <span className="text-[var(--dim)]">{fmtTime(typeof v === 'string' ? new Date(v).getTime() / 1000 : v)}</span> },
                    { key: 'exception_code', label: 'Code' },
                    { key: 'cnt', label: 'Count', format: (v: any) => <span className="text-red-400">{fmtNum(v)}</span> },
                    { key: 'sample', label: 'Sample', format: (v: any) => <span className="text-xs text-[var(--dim)]">{String(v ?? '').slice(0, 80)}</span> },
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
      )}

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
                <div className="grid grid-cols-4 gap-3">
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
                    <div className="grid grid-cols-3 gap-3">
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
    </div>
  )
}
