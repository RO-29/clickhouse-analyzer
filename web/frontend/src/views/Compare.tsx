import { useEffect, useState, useMemo } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip as ChartTooltip,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { Check, AlertTriangle, XCircle, ChevronDown, ChevronRight } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { api } from '../lib/api'
import { fmtBytes, fmtNum, cn } from '../lib/utils'
import { Card } from '../components/Card'
import { DataTable } from '../components/DataTable'

ChartJS.register(CategoryScale, LinearScale, BarElement, ChartTooltip)

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */
interface NodeData { rows: number; size: string; parts: number }

interface TableRow {
  database: string
  table: string
  engine: string
  nodes: Record<string, NodeData>
  missing_on?: string[]
  max_row_diff_pct?: number
}

interface TablesData { instances: string[]; tables: TableRow[] }
interface SettingsData {
  instances: string[]
  settings: { name: string; differs: boolean; important?: boolean; values: Record<string, string> }[]
}
interface MetricsData {
  instances: string[]
  metrics: { name: string; unit: string; values: Record<string, number> }[]
}

/* ------------------------------------------------------------------ */
/*  Node status vs baseline                                           */
/* ------------------------------------------------------------------ */
function computeStatus(
  inst: string,
  baseline: string,
  tables: TablesData | null,
  settings: SettingsData | null,
): { missing: number; diverging: number; settingsDiff: number } {
  let missing = 0, diverging = 0, settingsDiff = 0

  if (tables) {
    for (const t of tables.tables) {
      const bPresent = !t.missing_on?.includes(baseline)
      const iPresent = !t.missing_on?.includes(inst)
      if (bPresent !== iPresent) {
        missing++
      } else if (bPresent && iPresent) {
        const bRows = t.nodes?.[baseline]?.rows ?? 0
        const iRows = t.nodes?.[inst]?.rows ?? 0
        if (bRows > 0 && Math.abs(iRows - bRows) / bRows > 0.01) diverging++
      }
    }
  }

  if (settings) {
    for (const s of settings.settings) {
      if (s.differs && s.values[baseline] !== undefined && s.values[inst] !== undefined) {
        if (s.values[baseline] !== s.values[inst]) settingsDiff++
      }
    }
  }

  return { missing, diverging, settingsDiff }
}

/* ------------------------------------------------------------------ */
/*  Node Pill — click to set as baseline                             */
/* ------------------------------------------------------------------ */
function NodePill({
  inst, isBaseline, status, onClick,
}: {
  inst: string
  isBaseline: boolean
  status: { missing: number; diverging: number; settingsDiff: number }
  onClick: () => void
}) {
  const hasIssues = status.missing > 0 || status.diverging > 0 || status.settingsDiff > 0

  return (
    <button
      onClick={onClick}
      title={isBaseline ? 'Current baseline' : 'Click to set as baseline'}
      className={cn(
        'flex flex-col gap-1.5 px-4 py-3 rounded-xl border text-left transition-all select-none',
        'min-w-[130px]',
        isBaseline
          ? 'border-[var(--accent)] bg-[var(--accent)]/10 cursor-default'
          : hasIssues
            ? 'border-[var(--border)] bg-[var(--surface)] hover:border-yellow-500/50 cursor-pointer'
            : 'border-[var(--border)] bg-[var(--surface)] hover:border-green-500/40 cursor-pointer',
      )}
    >
      <div className={cn('font-medium text-sm truncate', isBaseline && 'text-[var(--accent)]')}>
        {inst}
      </div>
      {isBaseline ? (
        <div className="text-xs text-[var(--accent)] opacity-70">baseline</div>
      ) : status.missing > 0 ? (
        <div className="text-xs text-red-400 flex items-center gap-1">
          <XCircle size={10} />
          {status.missing} missing
        </div>
      ) : status.diverging > 0 || status.settingsDiff > 0 ? (
        <div className="text-xs text-yellow-400 flex items-center gap-1">
          <AlertTriangle size={10} />
          {status.diverging + status.settingsDiff} diffs
        </div>
      ) : (
        <div className="text-xs text-green-400 flex items-center gap-1">
          <Check size={10} />
          in sync
        </div>
      )}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/*  Tables view — diff-first, baseline-relative                      */
/* ------------------------------------------------------------------ */
type ClassifiedTable = TableRow & {
  missingNodes: string[]
  isDiverging: boolean
  maxDivPct: number
  isMissing: boolean
}

function TableDetailRow({
  t, baseline, others,
}: {
  t: ClassifiedTable
  baseline: string
  others: string[]
}) {
  const [expanded, setExpanded] = useState(false)
  const key = `${t.database}.${t.table}`
  const baseNode = t.nodes?.[baseline]

  return (
    <div className="border-b border-[var(--border)] last:border-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-[var(--hover)] transition-colors"
      >
        {expanded
          ? <ChevronDown size={13} className="shrink-0 text-[var(--dim)]" />
          : <ChevronRight size={13} className="shrink-0 text-[var(--dim)]" />
        }
        <span className="font-mono text-xs font-medium flex-1">{key}</span>
        <span className="text-xs text-[var(--dim)]">{t.engine}</span>
        {t.isDiverging && (
          <span className={cn(
            'text-xs font-medium tabular-nums',
            Math.abs(t.maxDivPct) > 0.1 ? 'text-red-400' : 'text-yellow-400',
          )}>
            {t.maxDivPct > 0 ? '+' : ''}{(t.maxDivPct * 100).toFixed(1)}% max drift
          </span>
        )}
        {t.missingNodes.length > 0 && (
          <span className="text-xs text-red-400">
            missing on {t.missingNodes.join(', ')}
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-8 pb-3 space-y-1 bg-[var(--hover)]/30">
          {/* Baseline */}
          <div className="flex items-center gap-4 text-xs py-1.5">
            <span className="w-36 truncate font-semibold text-[var(--accent)] shrink-0">
              {baseline} (baseline)
            </span>
            {baseNode
              ? <>
                  <span className="tabular-nums">{fmtNum(baseNode.rows)} rows</span>
                  <span className="text-[var(--dim)]">{baseNode.size}</span>
                  <span className="text-[var(--dim)]">{fmtNum(baseNode.parts)} parts</span>
                </>
              : <span className="text-red-400">MISSING on baseline</span>
            }
          </div>
          {/* Other nodes */}
          {others.map((inst) => {
            const isMissing = t.missing_on?.includes(inst)
            const node = t.nodes?.[inst]
            const bRows = baseNode?.rows ?? 0
            const iRows = node?.rows ?? 0
            const pct = bRows > 0 && !isMissing ? (iRows - bRows) / bRows : null

            return (
              <div key={inst} className="flex items-center gap-4 text-xs py-1.5">
                <span className="w-36 truncate text-[var(--dim)] shrink-0">{inst}</span>
                {isMissing ? (
                  <span className="text-red-400 font-semibold">MISSING</span>
                ) : node ? (
                  <>
                    <span className="tabular-nums">{fmtNum(node.rows)} rows</span>
                    <span className="text-[var(--dim)]">{node.size}</span>
                    <span className="text-[var(--dim)]">{fmtNum(node.parts)} parts</span>
                    {pct !== null && (
                      Math.abs(pct) < 0.001
                        ? <span className="text-green-400">✓</span>
                        : <span className={cn(
                            'font-medium tabular-nums',
                            Math.abs(pct) > 0.1 ? 'text-red-400' : 'text-yellow-400',
                          )}>
                            {pct > 0 ? '+' : ''}{(pct * 100).toFixed(2)}%
                          </span>
                    )}
                  </>
                ) : (
                  <span className="text-[var(--dim)]">no data</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SyncedSection({ tables, baseline, others }: { tables: ClassifiedTable[]; baseline: string; others: string[] }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <Card className="!p-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--hover)] transition-colors"
      >
        {expanded ? <ChevronDown size={14} className="text-[var(--dim)]" /> : <ChevronRight size={14} className="text-[var(--dim)]" />}
        <Check size={13} className="text-green-400 shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-wider text-green-400">
          {tables.length} tables in sync
        </span>
      </button>
      {expanded && (
        <div className="border-t border-[var(--border)]">
          {tables.map((t) => <TableDetailRow key={`${t.database}.${t.table}`} t={t} baseline={baseline} others={others} />)}
        </div>
      )}
    </Card>
  )
}

function TablesView({
  data, baseline, instances,
}: {
  data: TablesData
  baseline: string
  instances: string[]
}) {
  const [diffsOnly, setDiffsOnly] = useState(true)
  const others = instances.filter((i) => i !== baseline)

  const classified = useMemo<ClassifiedTable[]>(() => {
    return data.tables.map((t) => {
      const bPresent = !t.missing_on?.includes(baseline)
      const missingNodes = others.filter((i) => t.missing_on?.includes(i))
      const isMissing = !bPresent || missingNodes.length > 0

      let maxDivPct = 0
      let isDiverging = false
      if (bPresent && t.nodes?.[baseline]) {
        const bRows = t.nodes[baseline]?.rows ?? 0
        for (const inst of others) {
          if (!t.missing_on?.includes(inst) && t.nodes?.[inst]) {
            const pct = bRows > 0 ? (t.nodes[inst].rows - bRows) / bRows : 0
            if (Math.abs(pct) > 0.01) isDiverging = true
            if (Math.abs(pct) > Math.abs(maxDivPct)) maxDivPct = pct
          }
        }
      }

      return { ...t, missingNodes, isDiverging, maxDivPct, isMissing }
    })
  }, [data, baseline, others])

  const missing = classified.filter((t) => t.isMissing)
  const diverging = classified.filter((t) => !t.isMissing && t.isDiverging)
    .sort((a, b) => Math.abs(b.maxDivPct) - Math.abs(a.maxDivPct))
  const synced = classified.filter((t) => !t.isMissing && !t.isDiverging)

  const allGood = missing.length === 0 && diverging.length === 0

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex items-center gap-4 text-sm">
        {missing.length > 0 && (
          <span className="flex items-center gap-1.5 text-red-400">
            <XCircle size={13} /> {missing.length} missing
          </span>
        )}
        {diverging.length > 0 && (
          <span className="flex items-center gap-1.5 text-yellow-400">
            <AlertTriangle size={13} /> {diverging.length} diverging
          </span>
        )}
        {synced.length > 0 && (
          <span className="flex items-center gap-1.5 text-green-400">
            <Check size={13} /> {synced.length} in sync
          </span>
        )}
        <label className="ml-auto flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={diffsOnly}
            onChange={(e) => setDiffsOnly(e.target.checked)}
            className="rounded border-[var(--border)] bg-[var(--surface)] accent-[var(--accent)]"
          />
          <span className="text-[var(--dim)]">Diffs only</span>
        </label>
      </div>

      {allGood && (
        <div className="flex items-center justify-center gap-2 text-green-400 py-12">
          <Check size={20} />
          <span className="text-base font-medium">All tables in sync with baseline</span>
        </div>
      )}

      {/* Missing tables */}
      {missing.length > 0 && (
        <Card className="!p-0">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border)] bg-red-500/5">
            <XCircle size={13} className="text-red-400 shrink-0" />
            <span className="text-xs font-semibold uppercase tracking-wider text-red-400">
              Missing on some nodes
            </span>
          </div>
          {missing.map((t) => (
            <TableDetailRow key={`${t.database}.${t.table}`} t={t} baseline={baseline} others={others} />
          ))}
        </Card>
      )}

      {/* Diverging tables */}
      {diverging.length > 0 && (
        <Card className="!p-0">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border)] bg-yellow-500/5">
            <AlertTriangle size={13} className="text-yellow-400 shrink-0" />
            <span className="text-xs font-semibold uppercase tracking-wider text-yellow-400">
              Row count divergence — sorted by worst drift
            </span>
          </div>
          {diverging.map((t) => (
            <TableDetailRow key={`${t.database}.${t.table}`} t={t} baseline={baseline} others={others} />
          ))}
        </Card>
      )}

      {/* In-sync tables */}
      {!diffsOnly && synced.length > 0 && (
        <SyncedSection tables={synced} baseline={baseline} others={others} />
      )}

      {diffsOnly && !allGood && synced.length > 0 && (
        <div className="text-xs text-[var(--dim)] text-center py-2">
          {synced.length} matching tables hidden — uncheck "Diffs only" to show all
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Settings view — baseline column + delta for others               */
/* ------------------------------------------------------------------ */
function SettingsView({
  data, baseline, instances,
}: {
  data: SettingsData
  baseline: string
  instances: string[]
}) {
  const [diffsOnly, setDiffsOnly] = useState(true)
  const others = instances.filter((i) => i !== baseline)

  const diffCount = data.settings.filter(
    (s) => s.differs && others.some((i) => s.values[i] !== s.values[baseline]),
  ).length

  const settings = diffsOnly
    ? data.settings.filter((s) => s.differs && others.some((i) => s.values[i] !== s.values[baseline]))
    : data.settings

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <span className="text-sm">
          {diffCount > 0
            ? <span className="text-yellow-400">{diffCount} settings differ from baseline</span>
            : <span className="text-green-400">All settings match baseline</span>
          }
        </span>
        <label className="ml-auto flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={diffsOnly}
            onChange={(e) => setDiffsOnly(e.target.checked)}
            className="rounded border-[var(--border)] bg-[var(--surface)] accent-[var(--accent)]"
          />
          <span className="text-[var(--dim)]">Diffs only</span>
        </label>
      </div>

      <Card>
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--surface)] z-10">
              <tr className="border-b border-[var(--border)]">
                <th className="text-left py-2 px-3 text-xs font-medium uppercase tracking-wider text-[var(--dim)]">Setting</th>
                <th className="text-left py-2 px-3 text-xs font-medium uppercase tracking-wider text-[var(--accent)]">
                  {baseline} (baseline)
                </th>
                {others.map((inst) => (
                  <th key={inst} className="text-left py-2 px-3 text-xs font-medium uppercase tracking-wider text-[var(--dim)]">
                    {inst}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {settings.length === 0 ? (
                <tr>
                  <td colSpan={2 + others.length} className="py-10 text-center text-[var(--dim)] text-sm">
                    All settings match baseline
                  </td>
                </tr>
              ) : settings.map((s, i) => (
                <tr
                  key={i}
                  className={cn('border-b border-[var(--border)] last:border-0', s.important && 'border-l-2 border-l-blue-500')}
                >
                  <td className="py-2 px-3 font-mono text-xs font-medium">{s.name}</td>
                  <td className="py-2 px-3 font-mono text-xs">{String(s.values?.[baseline] ?? '—')}</td>
                  {others.map((inst) => {
                    const val = s.values?.[inst]
                    const differs = val !== s.values?.[baseline]
                    return (
                      <td key={inst} className={cn('py-2 px-3 font-mono text-xs', differs ? 'bg-yellow-500/10 text-yellow-300' : '')}>
                        {differs ? String(val ?? '—') : <span className="text-[var(--dim)]">—</span>}
                      </td>
                    )
                  })}
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
/*  Metrics view — % deviation from baseline                         */
/* ------------------------------------------------------------------ */
const BAR_COLORS = [
  '#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7', '#14b8a6', '#f97316', '#ec4899',
]

function MetricsView({ baseline, instances }: { baseline: string; instances: string[] }) {
  const [data, setData] = useState<MetricsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const others = instances.filter((i) => i !== baseline)
  const orderedInsts = [baseline, ...others]

  useEffect(() => {
    setLoading(true)
    api.compare.metrics()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorMsg msg={error} />
  if (!data?.metrics?.length) return <EmptyMsg msg="No metrics" />

  return (
    <div className="space-y-6">
      <Card>
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--surface)] z-10">
              <tr className="border-b border-[var(--border)]">
                <th className="text-left py-2 px-3 text-xs font-medium uppercase tracking-wider text-[var(--dim)]">Metric</th>
                <th className="text-left py-2 px-3 text-xs font-medium uppercase tracking-wider text-[var(--accent)]">
                  {baseline} (baseline)
                </th>
                {others.map((inst) => (
                  <th key={inst} className="text-left py-2 px-3 text-xs font-medium uppercase tracking-wider text-[var(--dim)]">{inst}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.metrics.map((m, i) => {
                const bVal = m.values?.[baseline] ?? 0
                return (
                  <tr key={i} className="border-b border-[var(--border)] last:border-0">
                    <td className="py-2 px-3 font-mono text-xs">{m.name}</td>
                    <td className="py-2 px-3 font-mono text-xs">
                      {m.unit === 'bytes' ? fmtBytes(bVal) : fmtNum(bVal)}
                    </td>
                    {others.map((inst) => {
                      const val = m.values?.[inst] ?? 0
                      const pct = bVal > 0 ? (val - bVal) / bVal : 0
                      return (
                        <td key={inst} className={cn(
                          'py-2 px-3 font-mono text-xs',
                          Math.abs(pct) > 0.2 ? 'bg-red-500/10' : Math.abs(pct) > 0.01 ? 'bg-yellow-500/10' : '',
                        )}>
                          {m.unit === 'bytes' ? fmtBytes(val) : fmtNum(val)}
                          {Math.abs(pct) > 0.01 && bVal > 0 && (
                            <span className={cn('ml-1 text-xs', pct > 0 ? 'text-yellow-400' : 'text-red-400')}>
                              {pct > 0 ? '+' : ''}{(pct * 100).toFixed(0)}%
                            </span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data.metrics.map((m, idx) => {
          const vals = orderedInsts.map((i) => m.values?.[i] ?? 0)
          const isBytesUnit = m.unit === 'bytes'
          const chartData = {
            labels: orderedInsts,
            datasets: [{ label: m.name, data: vals, backgroundColor: orderedInsts.map((_, i) => BAR_COLORS[i % BAR_COLORS.length]) }],
          }
          const chartOpts = {
            responsive: true, maintainAspectRatio: false, indexAxis: 'y' as const,
            plugins: { tooltip: { callbacks: { label: (ctx: any) => isBytesUnit ? fmtBytes(ctx.parsed.x) : fmtNum(ctx.parsed.x) } } },
            scales: {
              x: { ticks: { callback: (v: any) => isBytesUnit ? fmtBytes(Number(v)) : fmtNum(Number(v)), color: '#6b7280', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
              y: { ticks: { color: '#6b7280', font: { size: 11 } }, grid: { display: false } },
            },
          }
          return (
            <Card key={idx} title={m.name}>
              <div style={{ height: Math.max(60, orderedInsts.length * 32) }}>
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
/*  Memory view                                                       */
/* ------------------------------------------------------------------ */
function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">{label}</div>
      {sub && <div className="text-xs text-[var(--dim)] mt-0.5">{sub}</div>}
    </Card>
  )
}

function MemoryView({ baseline, instances }: { baseline: string; instances: string[] }) {
  const orderedInsts = [baseline, ...instances.filter((i) => i !== baseline)]
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [memoryData, setMemoryData] = useState<Record<string, { cache: any; tableMemory: any[] }>>({})

  useEffect(() => {
    if (!orderedInsts.length) { setLoading(false); return }
    setLoading(true)
    Promise.all(orderedInsts.map(async (inst) => {
      const [tableMemory, cache] = await Promise.all([
        api.tableMemory(inst).catch(() => []),
        api.cacheStats(inst).catch(() => null),
      ])
      return { inst, tableMemory: tableMemory ?? [], cache }
    }))
      .then((results) => {
        const map: Record<string, { cache: any; tableMemory: any[] }> = {}
        for (const r of results) map[r.inst] = { cache: r.cache, tableMemory: r.tableMemory }
        setMemoryData(map)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [orderedInsts.join(',')])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorMsg msg={error} />

  const tableCols = [
    { key: 'database', label: 'Database' },
    { key: 'table', label: 'Table' },
    { key: 'pk_readable', label: 'PK Memory', format: (v: any) => String(v ?? '') },
    { key: 'marks_readable', label: 'Marks Memory', format: (v: any) => String(v ?? '') },
    { key: 'mark_count', label: 'Marks', format: (v: any) => fmtNum(v) },
    { key: 'parts', label: 'Parts', format: (v: any) => fmtNum(v) },
    { key: 'total_rows', label: 'Rows', format: (v: any) => fmtNum(v) },
  ]

  return (
    <div className="space-y-8">
      {orderedInsts.map((inst) => {
        const d = memoryData[inst]
        if (!d) return null
        const sorted = [...d.tableMemory].sort((a, b) => (b.pk_bytes ?? 0) - (a.pk_bytes ?? 0))
        return (
          <div key={inst} className="space-y-4">
            <h3 className={cn('text-base font-semibold', inst === baseline && 'text-[var(--accent)]')}>
              {inst}{inst === baseline && ' (baseline)'}
            </h3>
            {d.cache && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="Mark Cache" value={fmtBytes(d.cache.mark_cache_bytes ?? 0)} sub={`${fmtNum(d.cache.mark_cache_files ?? 0)} files`} />
                <StatCard label="Filesystem Cache" value={fmtBytes(d.cache.filesystem_cache_bytes ?? 0)} sub={`${fmtBytes(d.cache.filesystem_cache_limit ?? 0)} limit`} />
                <StatCard label="Primary Key Memory" value={fmtBytes(d.cache.primary_key_bytes ?? 0)} />
                <StatCard label="Index Granularity" value={fmtBytes(d.cache.index_granularity_bytes ?? 0)} />
              </div>
            )}
            {sorted.length > 0 && (
              <Card title="Per-Table Memory">
                <DataTable columns={tableCols} data={sorted} maxHeight="400px" />
              </Card>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
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
  return <div className="text-sm text-[var(--dim)] text-center py-12">{msg}</div>
}

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

/* ------------------------------------------------------------------ */
/*  Main Compare                                                      */
/* ------------------------------------------------------------------ */
export default function Compare() {
  const { instances: storeInstances } = useStore()

  const [tablesData, setTablesData] = useState<TablesData | null>(null)
  const [settingsData, setSettingsData] = useState<SettingsData | null>(null)
  const [tablesLoading, setTablesLoading] = useState(true)
  const [settingsLoading, setSettingsLoading] = useState(true)

  const [tab, setTab] = useState<'tables' | 'settings' | 'metrics' | 'memory'>('tables')

  const [baseline, setBaseline] = useState<string>(() => {
    try { return localStorage.getItem('compare-baseline') ?? '' } catch { return '' }
  })

  // Load tables + settings eagerly — needed for node pill status
  useEffect(() => {
    setTablesLoading(true)
    api.compare.tables()
      .then(setTablesData)
      .catch(() => {})
      .finally(() => setTablesLoading(false))

    setSettingsLoading(true)
    api.compare.settings()
      .then(setSettingsData)
      .catch(() => {})
      .finally(() => setSettingsLoading(false))
  }, [])

  // Prefer store instances (populated by overview); fall back to API response
  const instances = storeInstances.length > 0
    ? storeInstances
    : tablesData?.instances ?? []

  // Effective baseline: use stored, or first available instance
  const effectiveBaseline = (baseline && instances.includes(baseline))
    ? baseline
    : instances[0] ?? ''

  const handleSetBaseline = (inst: string) => {
    setBaseline(inst)
    try { localStorage.setItem('compare-baseline', inst) } catch {}
  }

  const nodeStatuses = useMemo(() => {
    const map: Record<string, ReturnType<typeof computeStatus>> = {}
    for (const inst of instances) {
      if (inst !== effectiveBaseline) {
        map[inst] = computeStatus(inst, effectiveBaseline, tablesData, settingsData)
      }
    }
    return map
  }, [instances, effectiveBaseline, tablesData, settingsData])

  if (!instances.length && (tablesLoading || settingsLoading)) {
    return <LoadingSkeleton />
  }

  if (!instances.length) {
    return <EmptyMsg msg="No instances available" />
  }

  return (
    <div className="space-y-6">
      {/* ---- Node pills — click to pivot baseline ---- */}
      <div>
        <div className="text-xs text-[var(--dim)] mb-2">Click any node to set as comparison baseline</div>
        <div className="flex flex-wrap gap-3">
          {instances.map((inst) => (
            <NodePill
              key={inst}
              inst={inst}
              isBaseline={inst === effectiveBaseline}
              status={nodeStatuses[inst] ?? { missing: 0, diverging: 0, settingsDiff: 0 }}
              onClick={() => handleSetBaseline(inst)}
            />
          ))}
        </div>
      </div>

      {/* ---- Tab bar ---- */}
      <div className="flex gap-1 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-1 w-fit">
        <TabButton active={tab === 'tables'} label="Tables" onClick={() => setTab('tables')} />
        <TabButton active={tab === 'settings'} label="Settings" onClick={() => setTab('settings')} />
        <TabButton active={tab === 'metrics'} label="Metrics" onClick={() => setTab('metrics')} />
        <TabButton active={tab === 'memory'} label="Memory" onClick={() => setTab('memory')} />
      </div>

      {/* ---- Tab content ---- */}
      {tab === 'tables' && (
        tablesLoading
          ? <LoadingSkeleton />
          : tablesData
            ? <TablesView data={tablesData} baseline={effectiveBaseline} instances={instances} />
            : <EmptyMsg msg="Failed to load table data" />
      )}
      {tab === 'settings' && (
        settingsLoading
          ? <LoadingSkeleton />
          : settingsData
            ? <SettingsView data={settingsData} baseline={effectiveBaseline} instances={instances} />
            : <EmptyMsg msg="Failed to load settings data" />
      )}
      {tab === 'metrics' && (
        <MetricsView baseline={effectiveBaseline} instances={instances} />
      )}
      {tab === 'memory' && (
        <MemoryView baseline={effectiveBaseline} instances={instances} />
      )}
    </div>
  )
}
