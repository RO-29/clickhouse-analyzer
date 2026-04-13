import { useEffect, useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip as ChartTooltip,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { useStore } from '../hooks/useStore'
import { api } from '../lib/api'
import { fmtBytes, fmtNum, cn } from '../lib/utils'
import { Card } from '../components/Card'
import { DataTable } from '../components/DataTable'

ChartJS.register(CategoryScale, LinearScale, BarElement, ChartTooltip)

/* ------------------------------------------------------------------ */
/*  Shared                                                            */
/* ------------------------------------------------------------------ */
type Tab = 'tables' | 'settings' | 'metrics' | 'memory'

function TabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-4 py-2 text-sm font-medium rounded-lg transition-colors',
        active
          ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
          : 'text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)]',
      )}
    >
      {label}
    </button>
  )
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">{label}</div>
      {sub && <div className="text-xs text-[var(--dim)] mt-0.5">{sub}</div>}
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Tables Tab                                                        */
/* ------------------------------------------------------------------ */
function TablesTab() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    api.compare.tables()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorMsg msg={error} />
  if (!data?.tables?.length) return <EmptyMsg msg="No tables to compare" />

  const instances: string[] = data.instances ?? []
  const tables: any[] = data.tables

  const columns: { key: string; label: string; format?: (v: any) => any }[] = [
    { key: 'database', label: 'Database' },
    { key: 'table', label: 'Table' },
    { key: 'engine', label: 'Engine' },
    ...instances.flatMap((inst) => [
      {
        key: `${inst}_rows`,
        label: `${inst} Rows`,
        format: (v: any) => v === 'MISSING' ? <span className="text-red-400 font-semibold">MISSING</span> : fmtNum(v),
      },
      {
        key: `${inst}_size`,
        label: `${inst} Size`,
        format: (v: any) => v === 'MISSING' ? <span className="text-red-400 font-semibold">MISSING</span> : String(v ?? ''),
      },
      {
        key: `${inst}_parts`,
        label: `${inst} Parts`,
        format: (v: any) => v === 'MISSING' ? <span className="text-red-400 font-semibold">MISSING</span> : fmtNum(v),
      },
    ]),
  ]

  const rows = tables.map((t) => {
    const row: Record<string, any> = {
      database: t.database,
      table: t.table,
      engine: t.engine,
      _highlight: t.max_row_diff_pct > 20,
    }
    for (const inst of instances) {
      const node = t.nodes?.[inst]
      const isMissing = t.missing_on?.includes(inst)
      if (isMissing || !node) {
        row[`${inst}_rows`] = 'MISSING'
        row[`${inst}_size`] = 'MISSING'
        row[`${inst}_parts`] = 'MISSING'
      } else {
        row[`${inst}_rows`] = node.rows
        row[`${inst}_size`] = node.size
        row[`${inst}_parts`] = node.parts
      }
    }
    return row
  })

  return (
    <Card>
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-[var(--surface)]">
            <tr className="border-b border-[var(--border)]">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="text-left py-2 px-3 text-xs font-medium uppercase tracking-wider text-[var(--dim)] whitespace-nowrap"
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={i}
                className={cn(
                  'border-b border-[var(--border)] last:border-0',
                  row._highlight && 'bg-red-500/5',
                )}
              >
                {columns.map((col) => (
                  <td key={col.key} className="py-2 px-3 font-mono text-xs whitespace-nowrap">
                    {col.format ? col.format(row[col.key]) : String(row[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Settings Tab                                                      */
/* ------------------------------------------------------------------ */
function SettingsTab() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [diffOnly, setDiffOnly] = useState(false)

  useEffect(() => {
    setLoading(true)
    api.compare.settings()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorMsg msg={error} />
  if (!data?.settings?.length) return <EmptyMsg msg="No settings to compare" />

  const instances: string[] = data.instances ?? []
  const settings: any[] = diffOnly ? data.settings.filter((s: any) => s.differs) : data.settings

  return (
    <div className="space-y-4">
      <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none">
        <input
          type="checkbox"
          checked={diffOnly}
          onChange={(e) => setDiffOnly(e.target.checked)}
          className="rounded border-[var(--border)] bg-[var(--surface)] accent-[var(--accent)]"
        />
        <span>Show only differences</span>
      </label>

      <Card>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--surface)]">
              <tr className="border-b border-[var(--border)]">
                <th className="text-left py-2 px-3 text-xs font-medium uppercase tracking-wider text-[var(--dim)]">
                  Setting
                </th>
                {instances.map((inst) => (
                  <th
                    key={inst}
                    className="text-left py-2 px-3 text-xs font-medium uppercase tracking-wider text-[var(--dim)]"
                  >
                    {inst}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {settings.map((s: any, i: number) => (
                <tr
                  key={i}
                  className={cn(
                    'border-b border-[var(--border)] last:border-0',
                    s.differs && 'bg-yellow-500/5',
                    s.important && 'border-l-2 border-l-blue-500',
                  )}
                >
                  <td className="py-2 px-3 font-mono text-xs font-medium">{s.name}</td>
                  {instances.map((inst) => (
                    <td key={inst} className="py-2 px-3 font-mono text-xs">
                      {String(s.values?.[inst] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Metrics Tab                                                       */
/* ------------------------------------------------------------------ */
const BAR_COLORS = [
  '#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7', '#14b8a6', '#f97316', '#ec4899',
]

function MetricsTab() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    api.compare.metrics()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorMsg msg={error} />
  if (!data?.metrics?.length) return <EmptyMsg msg="No metrics to compare" />

  const instances: string[] = data.instances ?? []
  const metrics: any[] = data.metrics

  const columns: { key: string; label: string; format?: (v: any, row?: any) => string }[] = [
    { key: 'name', label: 'Metric' },
    ...instances.map((inst) => ({
      key: inst,
      label: inst,
      format: (v: any, row?: any) => {
        const unit = row?.unit
        if (unit === 'bytes') return fmtBytes(v ?? 0)
        return fmtNum(v)
      },
    })),
  ]

  const rows = metrics.map((m) => {
    const row: Record<string, any> = { name: m.name, unit: m.unit }
    for (const inst of instances) {
      row[inst] = m.values?.[inst] ?? 0
    }
    return row
  })

  return (
    <div className="space-y-6">
      <Card>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--surface)]">
              <tr className="border-b border-[var(--border)]">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className="text-left py-2 px-3 text-xs font-medium uppercase tracking-wider text-[var(--dim)]"
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  {columns.map((col) => (
                    <td key={col.key} className="py-2 px-3 font-mono text-xs">
                      {col.format ? col.format(row[col.key], row) : String(row[col.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Bar charts per metric */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {metrics.map((m, idx) => {
          const vals = instances.map((inst) => m.values?.[inst] ?? 0)
          const isBytesUnit = m.unit === 'bytes'
          const chartData = {
            labels: instances,
            datasets: [
              {
                label: m.name,
                data: vals,
                backgroundColor: instances.map((_, i) => BAR_COLORS[i % BAR_COLORS.length]),
              },
            ],
          }
          const chartOpts = {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y' as const,
            plugins: {
              tooltip: {
                callbacks: {
                  label: (ctx: any) => isBytesUnit ? fmtBytes(ctx.parsed.x) : fmtNum(ctx.parsed.x),
                },
              },
            },
            scales: {
              x: {
                ticks: {
                  callback: (v: any) => isBytesUnit ? fmtBytes(Number(v)) : fmtNum(Number(v)),
                  color: '#6b7280',
                  font: { size: 10 },
                },
                grid: { color: 'rgba(255,255,255,0.04)' },
              },
              y: {
                ticks: { color: '#6b7280', font: { size: 11 } },
                grid: { display: false },
              },
            },
          }
          return (
            <Card key={idx} title={m.name}>
              <div style={{ height: Math.max(60, instances.length * 32) }}>
                <Bar data={chartData} options={chartOpts} />
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Memory Tab                                                        */
/* ------------------------------------------------------------------ */
function MemoryTab() {
  const { instances: storeInstances } = useStore()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [memoryData, setMemoryData] = useState<Record<string, { cache: any; tableMemory: any[] }>>({})

  useEffect(() => {
    if (!storeInstances.length) {
      setLoading(false)
      return
    }

    setLoading(true)
    const promises = storeInstances.map(async (inst) => {
      const [tableMemory, cache] = await Promise.all([
        api.tableMemory(inst).catch(() => []),
        api.cacheStats(inst).catch(() => null),
      ])
      return { inst, tableMemory: tableMemory ?? [], cache }
    })

    Promise.all(promises)
      .then((results) => {
        const map: Record<string, { cache: any; tableMemory: any[] }> = {}
        for (const r of results) {
          map[r.inst] = { cache: r.cache, tableMemory: r.tableMemory }
        }
        setMemoryData(map)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [storeInstances])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorMsg msg={error} />
  if (!storeInstances.length) return <EmptyMsg msg="No instances available" />

  const tableCols = [
    { key: 'database', label: 'Database' },
    { key: 'table', label: 'Table' },
    { key: 'pk_readable', label: 'PK Memory', format: (v: any) => String(v ?? '') },
    { key: 'marks_readable', label: 'Marks Memory', format: (v: any) => String(v ?? '') },
    { key: 'mark_count', label: 'Mark Count', format: (v: any) => fmtNum(v) },
    { key: 'parts', label: 'Parts', format: (v: any) => fmtNum(v) },
    { key: 'total_rows', label: 'Rows', format: (v: any) => fmtNum(v) },
  ]

  return (
    <div className="space-y-8">
      {storeInstances.map((inst) => {
        const d = memoryData[inst]
        if (!d) return null
        const cache = d.cache
        const sortedTables = [...d.tableMemory].sort((a, b) => (b.pk_bytes ?? 0) - (a.pk_bytes ?? 0))

        return (
          <div key={inst} className="space-y-4">
            <h3 className="text-lg font-semibold">{inst}</h3>

            {/* Cache stat cards */}
            {cache && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard
                  label="Mark Cache"
                  value={fmtBytes(cache.mark_cache_bytes ?? 0)}
                  sub={`${fmtNum(cache.mark_cache_files ?? 0)} files`}
                />
                <StatCard
                  label="Filesystem Cache"
                  value={fmtBytes(cache.filesystem_cache_bytes ?? 0)}
                  sub={`${fmtBytes(cache.filesystem_cache_limit ?? 0)} limit`}
                />
                <StatCard
                  label="Primary Key Memory"
                  value={fmtBytes(cache.primary_key_bytes ?? 0)}
                />
                <StatCard
                  label="Index Granularity"
                  value={fmtBytes(cache.index_granularity_bytes ?? 0)}
                />
              </div>
            )}

            {/* Table memory */}
            {sortedTables.length > 0 && (
              <Card title="Per-Table Memory">
                <DataTable columns={tableCols} data={sortedTables} maxHeight="400px" />
              </Card>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Shared small components                                           */
/* ------------------------------------------------------------------ */
function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {[...Array(3)].map((_, i) => (
        <Card key={i}>
          <div className="h-4 bg-[var(--hover)] rounded w-1/3 mb-3" />
          <div className="h-32 bg-[var(--hover)] rounded" />
        </Card>
      ))}
    </div>
  )
}

function ErrorMsg({ msg }: { msg: string }) {
  return (
    <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
      Failed to load: {msg}
    </div>
  )
}

function EmptyMsg({ msg }: { msg: string }) {
  return (
    <div className="text-sm text-[var(--dim)] text-center py-12">{msg}</div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main Compare view                                                 */
/* ------------------------------------------------------------------ */
export default function Compare() {
  const [tab, setTab] = useState<Tab>('tables')

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Compare Instances</h1>

      {/* Tab bar */}
      <div className="flex gap-1 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-1 w-fit">
        <TabButton active={tab === 'tables'} label="Tables" onClick={() => setTab('tables')} />
        <TabButton active={tab === 'settings'} label="Settings" onClick={() => setTab('settings')} />
        <TabButton active={tab === 'metrics'} label="Metrics" onClick={() => setTab('metrics')} />
        <TabButton active={tab === 'memory'} label="Memory" onClick={() => setTab('memory')} />
      </div>

      {/* Tab content */}
      {tab === 'tables' && <TablesTab />}
      {tab === 'settings' && <SettingsTab />}
      {tab === 'metrics' && <MetricsTab />}
      {tab === 'memory' && <MemoryTab />}
    </div>
  )
}
