import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Bar } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip as ChartTooltip,
} from 'chart.js'
import { useStore } from '../hooks/useStore'
import { api } from '../lib/api'
import { fmtBytes, fmtNum, fmtTime, fmtDuration } from '../lib/utils'
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
export default function Detail() {
  const { instance, setView, setInstance } = useStore()

  const [alerts, setAlerts] = useState<Alert[]>([])
  const [queries, setQueries] = useState<Record<string, any>[]>([])
  const [tables, setTables] = useState<Record<string, any>[]>([])
  const [disks, setDisks] = useState<DiskInfo[]>([])
  const [mvs, setMvs] = useState<Record<string, any>[]>([])
  const [s3Stats, setS3Stats] = useState<S3Stats | null>(null)
  const [cacheStats, setCacheStats] = useState<any>(null)
  const [tableMemory, setTableMemory] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!instance) return
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const [al, q, t, d, m, s3, cs, tm] = await Promise.all([
          api.alerts.active(),
          api.queries(instance!),
          api.tables(instance!),
          api.disks(instance!),
          api.mvs(instance!),
          api.s3Stats(instance!),
          api.cacheStats(instance!).catch(() => null),
          api.tableMemory(instance!).catch(() => []),
        ])
        if (!cancelled) {
          setAlerts(al.filter((a) => a.instance === instance))
          setQueries(q)
          setTables(t)
          setDisks(d)
          setMvs(m)
          setS3Stats(s3)
          setCacheStats(cs)
          setTableMemory(tm ?? [])
        }
      } catch {
        // keep empty state
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [instance])

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

  /* ---- Table columns (DataTable format API: format receives cell value) ---- */
  const alertCols = [
    {
      key: 'severity',
      label: 'Severity',
      format: (v: any) => <Badge severity={v} />,
    },
    { key: 'category', label: 'Category' },
    { key: 'title', label: 'Title' },
    {
      key: 'created_at',
      label: 'Time',
      format: (v: any) => <span className="text-[var(--dim)]">{fmtTime(v)}</span>,
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
        <h1 className="text-xl font-bold">{instance}</h1>
      </div>

      {/* ---- Health checklist ---- */}
      <HealthChecklist instance={instance} />

      {/* ---- 8 Metric charts in 2-col x 4-row grid ---- */}
      <div className="grid grid-cols-2 gap-4">
        <MetricChart
          instance={instance}
          title="Memory %"
          metrics={['system.memory.rss_percent', 'system.memory.used_percent']}
          yFormat="percent"
        />
        <MetricChart
          instance={instance}
          title="Memory Bytes"
          metrics={[
            'system.memory.rss_bytes',
            'system.memory.available_bytes',
            'system.metrics.MemoryTracking',
          ]}
          yFormat="bytes"
        />
        <MetricChart
          instance={instance}
          title="CPU %"
          metrics={['system.cpu.busy_percent']}
          yFormat="percent"
        />
        <MetricChart
          instance={instance}
          title="Load Average"
          metrics={[
            'system.async.LoadAverage1',
            'system.async.LoadAverage5',
            'system.async.LoadAverage15',
          ]}
        />
        <MetricChart
          instance={instance}
          title="Queries"
          metrics={['system.metrics.Query', 'queries.failed_5m']}
        />
        <MetricChart
          instance={instance}
          title="Parts & Merges"
          metrics={['tables.merges.active_count']}
        />
        <MetricChart
          instance={instance}
          title="Insert Throughput"
          metrics={['inserts.total.rows']}
        />
        <MetricChart
          instance={instance}
          title="S3 Latency"
          metrics={['storage.s3.avg_latency_ms', 'storage.s3.max_latency_ms']}
          yFormat="ms"
        />
      </div>

      {/* ---- Disk Usage (local only) ---- */}
      {localDisks.length > 0 && (
        <Card title="Disk Usage">
          <div style={{ height: Math.max(80, localDisks.length * 40) }}>
            <Bar data={diskChartData} options={diskChartOpts} />
          </div>
        </Card>
      )}

      {/* ---- S3 Storage ---- */}
      {s3Stats && s3Stats.volume_by_table && Array.isArray(s3Stats.volume_by_table) && s3Stats.volume_by_table.length > 0 && (() => {
        const volTable = s3Stats.volume_by_table as any[]
        const totalS3Bytes = volTable.reduce((sum: number, r: any) => sum + (r.bytes ?? 0), 0)
        const fsBytes = cacheStats?.filesystem_cache_bytes ?? 0
        const fsLimit = cacheStats?.filesystem_cache_limit ?? 0
        const fsElements = cacheStats?.filesystem_cache_elements ?? 0
        const fsPct = fsLimit > 0 ? Math.min(100, (fsBytes / fsLimit) * 100) : 0
        return (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--dim)]">S3 Storage</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <div className="text-2xl font-bold">{fmtBytes(totalS3Bytes)}</div>
                <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Total S3 Data</div>
                <div className="text-xs text-[var(--dim)]">{fmtNum(volTable.length)} tables</div>
              </Card>
              <Card>
                <div className="text-2xl font-bold">{fsLimit > 0 ? fsPct.toFixed(1) + '%' : '--'}</div>
                <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Local S3 Cache</div>
                <div className="text-xs text-[var(--dim)]">{fmtBytes(fsBytes)} / {fmtBytes(fsLimit)}</div>
                {fsLimit > 0 && (
                  <div className="mt-2 h-1.5 rounded-full bg-[var(--hover)] overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${fsPct > 90 ? 'bg-red-500' : fsPct > 70 ? 'bg-yellow-500' : 'bg-green-500'}`}
                      style={{ width: fsPct + '%' }}
                    />
                  </div>
                )}
              </Card>
              <Card>
                <div className="text-2xl font-bold">{fmtNum(fsElements)}</div>
                <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Cached Elements</div>
                <div className="text-xs text-[var(--dim)]">files in local cache</div>
              </Card>
              <Card>
                <div className="text-2xl font-bold">{fmtBytes(cacheStats?.mark_cache_bytes ?? 0)}</div>
                <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Mark Cache</div>
                <div className="text-xs text-[var(--dim)]">{fmtNum(cacheStats?.mark_cache_files ?? 0)} files</div>
              </Card>
            </div>
            <Card title="S3 Data Volume">
              <DataTable columns={s3VolCols} data={volTable} />
            </Card>
          </div>
        )
      })()}

      {/* ---- S3 Latency by Table ---- */}
      {s3Stats && s3Stats.latency_by_table && Array.isArray(s3Stats.latency_by_table) && s3Stats.latency_by_table.length > 0 && (
        <Card title="S3 Latency by Table">
          <DataTable columns={s3LatCols} data={s3Stats.latency_by_table} />
        </Card>
      )}

      {/* ---- Cache & Index Memory ---- */}
      {(cacheStats || tableMemory.length > 0) && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--dim)]">Cache & Index Memory</h2>
          {cacheStats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <div className="text-2xl font-bold">{fmtBytes(cacheStats.mark_cache_bytes ?? 0)}</div>
                <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Mark Cache</div>
                <div className="text-xs text-[var(--dim)]">{fmtNum(cacheStats.mark_cache_files ?? 0)} files</div>
              </Card>
              <Card>
                <div className="text-2xl font-bold">{fmtBytes(cacheStats.primary_key_bytes ?? 0)}</div>
                <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Primary Key Memory</div>
              </Card>
              <Card>
                <div className="text-2xl font-bold">{fmtBytes(cacheStats.index_granularity_bytes ?? 0)}</div>
                <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Index Granularity</div>
              </Card>
              <Card>
                <div className="text-2xl font-bold">{fmtBytes(cacheStats.filesystem_cache_bytes ?? 0)}</div>
                <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Filesystem Cache</div>
                <div className="text-xs text-[var(--dim)]">{fmtBytes(cacheStats.filesystem_cache_limit ?? 0)} limit</div>
              </Card>
            </div>
          )}
          {tableMemory.length > 0 && (
            <Card title="Per-Table Memory">
              <DataTable
                columns={[
                  { key: 'database', label: 'Database' },
                  { key: 'table_name', label: 'Table' },
                  { key: 'pk_readable', label: 'PK Memory' },
                  { key: 'marks_readable', label: 'Marks Memory' },
                  { key: 'mark_count', label: 'Mark Count', format: (v: any) => fmtNum(v) },
                  { key: 'parts', label: 'Parts', format: (v: any) => fmtNum(v) },
                  { key: 'total_rows', label: 'Rows', format: (v: any) => fmtNum(v) },
                  { key: 'disk_size', label: 'Disk Size', format: (v: any) => fmtBytes(v ?? 0) },
                ]}
                data={[...tableMemory].sort((a, b) => (b.pk_bytes ?? 0) - (a.pk_bytes ?? 0))}
                maxHeight="400px"
              />
            </Card>
          )}
        </div>
      )}

      {/* ---- Active Alerts ---- */}
      {alerts.length > 0 && (
        <Card title="Active Alerts">
          <DataTable columns={alertCols} data={alerts} />
        </Card>
      )}

      {/* ---- Running Queries ---- */}
      {queries.length > 0 && (
        <Card title="Running Queries">
          <DataTable columns={queryCols} data={queries} />
        </Card>
      )}

      {/* ---- Tables ---- */}
      {tables.length > 0 && (
        <Card title="Tables">
          <DataTable columns={tableCols} data={tables} />
        </Card>
      )}

      {/* ---- Materialized Views ---- */}
      {mvs.length > 0 && (
        <Card title="Materialized Views">
          <DataTable columns={mvCols} data={mvs} />
        </Card>
      )}
    </div>
  )
}
