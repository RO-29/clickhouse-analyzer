import { useEffect, useState, useMemo, useCallback } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip as ChartTooltip,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { Check, AlertTriangle, XCircle, Sparkles, Search, Loader2 } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { fmtBytes, fmtNum, cn } from '../lib/utils'
import { Card } from '../components/Card'
import { DataTable } from '../components/DataTable'

ChartJS.register(CategoryScale, LinearScale, BarElement, ChartTooltip)

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */
interface DiskSlice { disk: string; type: string; bytes: number; parts: number }
interface PartsDetail {
  oldest_h: number
  avg_bytes: number
  wide_parts: number
  compact_parts: number
}

interface QueryStats {
  select_count: number
  avg_ms: number
  max_ms: number
  p95_ms: number
}

interface NodeData {
  rows: number
  bytes: number
  size: string
  parts: number
  pk_bytes?: number
  marks_bytes?: number
  disk_dist?: DiskSlice[]
  parts_detail?: PartsDetail
  s3_pct?: number
  query_stats?: QueryStats
  // DDL fields — per node, so frontend can diff only selected nodes
  partition_key?: string
  sorting_key?: string
  col_hash?: string
}

type DDLCriticality = 'high' | 'critical'

interface TableRow {
  database: string
  table: string
  engine: string
  nodes: Record<string, NodeData>
  missing_on?: string[]
  max_row_diff_pct?: number
  total_bytes?: number
  ddl_criticality?: DDLCriticality
  ddl_changes?: string[]
  disk_discrepancy?: boolean
  disk_disc_details?: string
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
/*  computeStatus — for node pill status badges (non-Tables tabs)     */
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
/*  Node Pill — click to set as baseline (Settings / Metrics / Memory)*/
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
/*  Node Selector — multi-select checkboxes for Tables tab            */
/* ------------------------------------------------------------------ */
function NodeSelector({
  instances,
  selected,
  onChange,
}: {
  instances: string[]
  selected: string[]
  onChange: (nodes: string[]) => void
}) {
  const toggle = (inst: string) => {
    if (selected.includes(inst)) {
      if (selected.length > 1) onChange(selected.filter((i) => i !== inst))
    } else {
      onChange([...selected, inst])
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-[var(--dim)] uppercase tracking-wider font-medium shrink-0 mr-1">
        Nodes
      </span>
      {instances.map((inst) => {
        const active = selected.includes(inst)
        return (
          <button
            key={inst}
            onClick={() => toggle(inst)}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all select-none',
              active
                ? 'border-[var(--accent)]/60 bg-[var(--accent)]/10 text-[var(--text)]'
                : 'border-[var(--border)] text-[var(--dim)] hover:border-[var(--accent)]/30 hover:text-[var(--text)]',
            )}
          >
            <span
              className={cn(
                'w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 transition-colors',
                active ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-current opacity-40',
              )}
            >
              {active && <Check size={9} className="text-white" strokeWidth={3} />}
            </span>
            {inst}
          </button>
        )
      })}
      <div className="flex items-center gap-3 ml-auto text-xs">
        <button
          onClick={() => onChange([...instances])}
          className="text-[var(--dim)] hover:text-[var(--text)] transition-colors"
        >
          All
        </button>
        <span className="text-[var(--dim)]">·</span>
        <button
          onClick={() => onChange(instances.slice(0, 1))}
          className="text-[var(--dim)] hover:text-[var(--text)] transition-colors disabled:opacity-30"
          disabled={instances.length <= 1}
        >
          Reset
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  DDL diff helper — scoped to active nodes only                     */
/* ------------------------------------------------------------------ */
function computeNodeDDL(t: TableRow, activeNodes: string[]): { criticality: DDLCriticality | ''; changes: string[] } {
  const present = activeNodes.filter(n => !t.missing_on?.includes(n) && t.nodes?.[n])
  if (present.length < 2) return { criticality: '', changes: [] }

  const ref = t.nodes[present[0]]
  const changes: string[] = []
  let crit: DDLCriticality | '' = ''

  for (const inst of present.slice(1)) {
    const node = t.nodes[inst]
    if ((ref.partition_key ?? '') !== (node.partition_key ?? '')) {
      changes.push(`PARTITION BY: ${ref.partition_key || '(none)'} vs ${node.partition_key || '(none)'}`)
      crit = 'critical'
    }
    if ((ref.sorting_key ?? '') !== (node.sorting_key ?? '')) {
      changes.push(`ORDER BY: ${ref.sorting_key || '(none)'} vs ${node.sorting_key || '(none)'}`)
      if (!crit) crit = 'critical'
    }
    if (ref.col_hash && node.col_hash && ref.col_hash !== node.col_hash) {
      changes.push('Column schema differs')
      if (crit !== 'critical') crit = 'high'
    }
  }

  return { criticality: crit, changes }
}

/* ------------------------------------------------------------------ */
/*  Tables view — flat sortable grid + node selector + live search    */
/* ------------------------------------------------------------------ */
type SortKey = 'name' | 'rows' | 'bytes' | 'drift' | 'total'
type RowFilter = 'all' | 'missing' | 'divergent' | 'ddl' | 'disk'

const NODES_KEY = 'compare-selected-nodes'

function TablesView({ data, instances, onAnalyze }: { data: TablesData; instances: string[]; onAnalyze: (data: Record<string, any>) => void }) {
  const [selectedNodes, setSelectedNodes] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(NODES_KEY) ?? '[]') as string[]
      const valid = stored.filter((n) => instances.includes(n))
      return valid.length > 0 ? valid : [...instances]
    } catch {
      return [...instances]
    }
  })
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [rowFilter, setRowFilter] = useState<RowFilter>('all')
  // On-demand query stats: instance → "db.table" → stats
  const [queryStatsData, setQueryStatsData] = useState<Record<string, Record<string, QueryStats>> | null>(null)
  const [queryStatsLoading, setQueryStatsLoading] = useState(false)

  const loadQueryStats = useCallback(async () => {
    setQueryStatsLoading(true)
    try {
      const resp = await api.compare.queryStats()
      setQueryStatsData(resp.stats ?? null)
    } catch (e: any) {
      console.error('Failed to load query stats:', e.message)
    } finally {
      setQueryStatsLoading(false)
    }
  }, [])

  // Persist selected nodes whenever they change
  const handleSetNodes = useCallback((nodes: string[]) => {
    setSelectedNodes(nodes)
    try { localStorage.setItem(NODES_KEY, JSON.stringify(nodes)) } catch {}
  }, [])

  // Active nodes: intersection of stored selection + current instances
  const activeNodes = useMemo(() => {
    const valid = selectedNodes.filter((n) => instances.includes(n))
    return valid.length > 0 ? valid : instances
  }, [selectedNodes, instances])

  // Per-row derived helpers
  const rowDrift = useCallback((t: TableRow, nodes: string[]): number => {
    const present = nodes.filter((n) => !t.missing_on?.includes(n))
    if (present.length < 2) return 0
    const vals = present.map((n) => t.nodes?.[n]?.rows ?? 0)
    const max = Math.max(...vals)
    const min = Math.min(...vals)
    return max > 0 ? (max - min) / max : 0
  }, [])

  const isRowMissing = useCallback((t: TableRow, nodes: string[]) =>
    nodes.some((n) => t.missing_on?.includes(n)),
  [])

  // Base rows: nodes-filtered + search only (no rowFilter) — used for counts
  const baseRows = useMemo(() => {
    let rows = data.tables.filter((t) =>
      activeNodes.some((n) => !(t.missing_on ?? []).includes(n)),
    )
    if (search.trim()) {
      const q = search.toLowerCase()
      rows = rows.filter((t) => t.table.toLowerCase().includes(q) || t.database.toLowerCase().includes(q))
    }
    return rows
  }, [data.tables, search, activeNodes])

  const filtered = useMemo(() => {
    let rows = baseRows

    if (rowFilter === 'missing') {
      rows = rows.filter((t) => isRowMissing(t, activeNodes))
    } else if (rowFilter === 'divergent') {
      rows = rows.filter((t) => !isRowMissing(t, activeNodes) && rowDrift(t, activeNodes) > 0.01)
    } else if (rowFilter === 'ddl') {
      rows = rows.filter((t) => !!computeNodeDDL(t, activeNodes).criticality)
    } else if (rowFilter === 'disk') {
      rows = rows.filter((t) => !!t.disk_discrepancy)
    }

    return [...rows].sort((a, b) => {
      let cmp = 0
      if (sortKey === 'name') {
        cmp = `${a.database}.${a.table}`.localeCompare(`${b.database}.${b.table}`)
      } else if (sortKey === 'rows') {
        const aMax = Math.max(0, ...activeNodes.map((n) => a.nodes?.[n]?.rows ?? 0))
        const bMax = Math.max(0, ...activeNodes.map((n) => b.nodes?.[n]?.rows ?? 0))
        cmp = aMax - bMax
      } else if (sortKey === 'bytes') {
        const aMax = Math.max(0, ...activeNodes.map((n) => a.nodes?.[n]?.bytes ?? 0))
        const bMax = Math.max(0, ...activeNodes.map((n) => b.nodes?.[n]?.bytes ?? 0))
        cmp = aMax - bMax
      } else if (sortKey === 'drift') {
        cmp = rowDrift(a, activeNodes) - rowDrift(b, activeNodes)
      } else if (sortKey === 'total') {
        cmp = (a.total_bytes ?? 0) - (b.total_bytes ?? 0)
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [baseRows, rowFilter, sortKey, sortDir, activeNodes, rowDrift, isRowMissing])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'name' ? 'asc' : 'desc')
    }
  }

  function SortIndicator({ k }: { k: SortKey }) {
    if (sortKey !== k)
      return <span className="opacity-25 text-[var(--dim)] ml-0.5">↕</span>
    return (
      <span className="text-[var(--accent)] ml-0.5">
        {sortDir === 'asc' ? '↑' : '↓'}
      </span>
    )
  }

  // Counts from baseRows so they stay stable regardless of rowFilter selection
  const missingCount = useMemo(
    () => baseRows.filter((t) => isRowMissing(t, activeNodes)).length,
    [baseRows, activeNodes, isRowMissing],
  )
  const diffCount = useMemo(
    () => baseRows.filter((t) => !isRowMissing(t, activeNodes) && rowDrift(t, activeNodes) > 0.01).length,
    [baseRows, activeNodes, isRowMissing, rowDrift],
  )
  const ddlCount = useMemo(
    () => baseRows.filter((t) => !!computeNodeDDL(t, activeNodes).criticality).length,
    [baseRows, activeNodes],
  )
  const diskCount = useMemo(
    () => baseRows.filter((t) => !!t.disk_discrepancy).length,
    [baseRows],
  )
  const totalBytes = useMemo(
    () => baseRows.reduce((acc, t) => acc + (t.total_bytes ?? 0), 0),
    [baseRows],
  )

  return (
    <div className="space-y-4">
      {/* Node selector */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl px-4 py-3">
        <NodeSelector instances={instances} selected={activeNodes} onChange={handleSetNodes} />
      </div>

      {/* Search + filter + summary row */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative max-w-sm flex-1 min-w-[180px]">
          <Search
            size={13}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--dim)] pointer-events-none"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter tables…"
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] placeholder-[var(--dim)] outline-none focus:border-[var(--accent)]/50 transition-colors"
          />
        </div>

        {/* Row filter */}
        <div className="flex items-center gap-0.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-0.5">
          {([
            { key: 'all',       label: 'All',        count: null },
            { key: 'missing',   label: 'Missing',    count: missingCount, color: 'text-red-400' },
            { key: 'divergent', label: 'Divergent',  count: diffCount,    color: 'text-yellow-400' },
            { key: 'ddl',       label: 'DDL diff',   count: ddlCount,     color: 'text-orange-400' },
            { key: 'disk',      label: 'Disk disc.', count: diskCount,    color: 'text-blue-400' },
          ] as { key: RowFilter; label: string; count: number | null; color?: string }[]).map(({ key, label, count, color }) => (
            <button
              key={key}
              onClick={() => setRowFilter(key)}
              className={cn(
                'px-2.5 py-1 rounded text-xs font-medium transition-colors',
                rowFilter === key
                  ? 'bg-[var(--hover)] text-[var(--fg)]'
                  : 'text-[var(--dim)] hover:text-[var(--fg)]',
              )}
            >
              {label}
              {count != null && count > 0 && (
                <span className={cn('ml-1', color ?? '')}>{count}</span>
              )}
            </button>
          ))}
        </div>

        {/* Load Query Stats on demand */}
        <button
          onClick={loadQueryStats}
          disabled={queryStatsLoading}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium border transition-colors',
            queryStatsData
              ? 'text-green-400 border-green-500/30 hover:bg-green-500/10'
              : 'text-[var(--dim)] border-[var(--border)] hover:text-[var(--text)] hover:bg-[var(--surface)]',
            queryStatsLoading && 'opacity-60 cursor-not-allowed',
          )}
          title="Load SELECT latency stats from query_log (expensive — runs on demand)"
        >
          {queryStatsLoading && <Loader2 size={11} className="animate-spin" />}
          {queryStatsLoading ? 'Loading stats…' : queryStatsData ? '✓ Query stats' : 'Load query stats'}
        </button>

        <div className="flex items-center gap-4 text-xs ml-auto">
          {totalBytes > 0 && (
            <span className="text-[var(--dim)]">cumulative {fmtBytes(totalBytes)}</span>
          )}
          {missingCount > 0 && rowFilter === 'all' && (
            <button onClick={() => setRowFilter('missing')} className="flex items-center gap-1 text-red-400 hover:underline">
              <XCircle size={11} />
              {missingCount} missing
            </button>
          )}
          {diffCount > 0 && rowFilter === 'all' && (
            <button onClick={() => setRowFilter('divergent')} className="flex items-center gap-1 text-yellow-400 hover:underline">
              <AlertTriangle size={11} />
              {diffCount} diverging
            </button>
          )}
          <span className="text-[var(--dim)]">{filtered.length} tables</span>
        </div>
      </div>

      {/* Table grid */}
      <div className="border border-[var(--border)] rounded-xl overflow-hidden">
        <div className="max-h-[65vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--surface)] z-10 border-b border-[var(--border)]">
              <tr>
                <th className="text-left py-2.5 px-4 w-[260px]">
                  <button
                    onClick={() => handleSort('name')}
                    className="flex items-center text-xs font-medium uppercase tracking-wider text-[var(--dim)] hover:text-[var(--text)] transition-colors"
                  >
                    Table
                    <SortIndicator k="name" />
                  </button>
                </th>
                {activeNodes.map((inst) => (
                  <th key={inst} className="text-left py-2 px-4 min-w-[140px]">
                    <div className="text-xs font-medium text-[var(--text)] mb-0.5 break-all leading-tight" title={inst}>
                      {inst}
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => handleSort('bytes')}
                        className="text-[10px] text-[var(--dim)] hover:text-[var(--accent)] transition-colors flex items-center"
                      >
                        size
                        {sortKey === 'bytes' && <SortIndicator k="bytes" />}
                      </button>
                      <button
                        onClick={() => handleSort('rows')}
                        className="text-[10px] text-[var(--dim)] hover:text-[var(--accent)] transition-colors flex items-center"
                      >
                        rows
                        {sortKey === 'rows' && <SortIndicator k="rows" />}
                      </button>
                    </div>
                  </th>
                ))}
                {activeNodes.length > 1 && (
                  <th className="text-right py-2.5 px-4 w-28">
                    <div className="flex flex-col items-end gap-0.5">
                      <button
                        onClick={() => handleSort('drift')}
                        className="flex items-center text-xs font-medium uppercase tracking-wider text-[var(--dim)] hover:text-[var(--text)] transition-colors"
                      >
                        Drift
                        <SortIndicator k="drift" />
                      </button>
                      <button
                        onClick={() => handleSort('total')}
                        className="flex items-center text-[10px] text-[var(--dim)] hover:text-[var(--text)] transition-colors"
                      >
                        Total
                        <SortIndicator k="total" />
                      </button>
                    </div>
                  </th>
                )}
                <th className="w-8 px-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={activeNodes.length + 2}
                    className="py-12 text-center text-[var(--dim)] text-sm"
                  >
                    {search ? `No tables matching "${search}"` : 'No tables'}
                  </td>
                </tr>
              ) : (
                filtered.map((t, idx) => {
                  const missing = isRowMissing(t, activeNodes)
                  const drift = rowDrift(t, activeNodes)
                  const diverging = !missing && drift > 0.01
                  const ddl = computeNodeDDL(t, activeNodes)

                  return (
                    <tr
                      key={idx}
                      className={cn(
                        'border-b border-[var(--border)] last:border-0 transition-colors group',
                        missing
                          ? 'bg-red-500/5 hover:bg-red-500/[0.08]'
                          : diverging
                            ? 'bg-yellow-500/5 hover:bg-yellow-500/[0.08]'
                            : t.disk_discrepancy
                              ? 'bg-blue-500/5 hover:bg-blue-500/[0.08]'
                              : ddl.criticality
                                ? 'bg-orange-500/5 hover:bg-orange-500/[0.08]'
                                : 'hover:bg-[var(--hover)]/50',
                      )}
                    >
                      {/* Table name + engine + badges */}
                      <td className="py-2.5 px-4">
                        <div className="font-mono text-xs leading-snug">
                          <span className="text-[var(--dim)]">{t.database}.</span>
                          <span className="font-medium">{t.table}</span>
                        </div>
                        <div className="text-[10px] text-[var(--dim)] font-mono mt-0.5">
                          {t.engine}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {ddl.criticality && (
                            <span
                              title={ddl.changes.join('\n')}
                              className={cn(
                                'inline-flex items-center text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border cursor-help',
                                ddl.criticality === 'critical'
                                  ? 'bg-red-500/15 text-red-400 border-red-500/30'
                                  : 'bg-orange-500/15 text-orange-400 border-orange-500/30',
                              )}
                            >
                              DDL {ddl.criticality}
                            </span>
                          )}
                          {t.disk_discrepancy && (
                            <span
                              title={t.disk_disc_details}
                              className="inline-flex items-center text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border bg-blue-500/15 text-blue-400 border-blue-500/30 cursor-help"
                            >
                              ☁ Disk disc.
                            </span>
                          )}
                        </div>
                        {ddl.criticality && ddl.changes.length > 0 && (
                          <div className="text-[9px] text-[var(--dim)] mt-0.5 leading-tight">
                            {ddl.changes[0]}
                            {ddl.changes.length > 1 && <> +{ddl.changes.length - 1} more</>}
                          </div>
                        )}
                      </td>

                      {/* Per-node: size, rows, parts detail, disk distribution, on-demand query stats */}
                      {activeNodes.map((inst) => {
                        const nodeMissing = t.missing_on?.includes(inst)
                        const node = t.nodes?.[inst]
                        const tableKey = `${t.database}.${t.table}`
                        const qs = queryStatsData?.[inst]?.[tableKey]
                        return (
                          <td key={inst} className="py-2.5 px-4">
                            {nodeMissing ? (
                              <span className="inline-flex text-xs font-medium text-red-400 bg-red-500/10 border border-red-500/20 px-1.5 py-0.5 rounded">
                                missing
                              </span>
                            ) : node ? (
                              <div className="text-xs space-y-0.5">
                                <div className="text-[var(--text)] font-medium tabular-nums">
                                  {node.size}
                                </div>
                                <div className="text-[var(--dim)] tabular-nums">
                                  {fmtNum(node.rows)} rows · {node.parts} parts
                                </div>
                                {/* Parts detail: age + format breakdown */}
                                {node.parts_detail && node.parts_detail.oldest_h > 0 && (
                                  <div className="text-[9px] text-[var(--dim)] tabular-nums leading-tight">
                                    oldest {node.parts_detail.oldest_h.toFixed(0)}h
                                    {node.parts_detail.avg_bytes > 0 && (
                                      <> · avg {fmtBytes(node.parts_detail.avg_bytes)}/part</>
                                    )}
                                    {node.parts_detail.compact_parts > 0 && (
                                      <> · {node.parts_detail.compact_parts} compact</>
                                    )}
                                  </div>
                                )}
                                {/* S3 % label when non-zero */}
                                {node.s3_pct != null && node.s3_pct > 0 && (
                                  <div className="text-[9px] text-blue-400 tabular-nums leading-tight">
                                    {node.s3_pct.toFixed(0)}% S3
                                  </div>
                                )}
                                {/* Disk distribution pills */}
                                {node.disk_dist && node.disk_dist.length > 0 && (
                                  <div className="flex flex-wrap gap-0.5 mt-0.5">
                                    {node.disk_dist.map((d) => {
                                      const isRemote = d.type === 's3' || d.type === 's3_plain' || d.type === 'object_storage' || d.type === 'hdfs'
                                      return (
                                        <span
                                          key={d.disk}
                                          title={`${d.disk} (${d.type || 'local'}): ${d.parts} parts`}
                                          className={cn(
                                            'inline-flex items-center text-[9px] px-1 py-0.5 rounded font-mono',
                                            isRemote
                                              ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                                              : 'bg-[var(--hover)] text-[var(--dim)] border border-[var(--border)]',
                                          )}
                                        >
                                          {isRemote ? '☁ ' : '💾 '}
                                          {d.disk.length > 7 ? d.disk.slice(0, 7) + '…' : d.disk}: {fmtBytes(d.bytes)}
                                        </span>
                                      )
                                    })}
                                  </div>
                                )}
                                {/* On-demand query stats */}
                                {qs && qs.select_count > 0 && (
                                  <div className="text-[9px] text-[var(--dim)] tabular-nums mt-0.5 leading-tight">
                                    <span className="text-blue-400">{qs.select_count.toLocaleString()} SELs</span>
                                    {' · avg '}
                                    <span className={cn(
                                      qs.avg_ms >= 5000 ? 'text-red-400' :
                                      qs.avg_ms >= 1000 ? 'text-orange-400' : '',
                                    )}>
                                      {qs.avg_ms >= 1000
                                        ? `${(qs.avg_ms / 1000).toFixed(1)}s`
                                        : `${qs.avg_ms.toFixed(0)}ms`}
                                    </span>
                                    {' · p95 '}
                                    <span className={cn(
                                      qs.p95_ms >= 5000 ? 'text-red-400' :
                                      qs.p95_ms >= 1000 ? 'text-orange-400' : '',
                                    )}>
                                      {qs.p95_ms >= 1000
                                        ? `${(qs.p95_ms / 1000).toFixed(1)}s`
                                        : `${qs.p95_ms.toFixed(0)}ms`}
                                    </span>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-[var(--dim)]">—</span>
                            )}
                          </td>
                        )
                      })}
                      {activeNodes.length > 1 && (
                        <td className="py-2.5 px-4 text-right">
                          <div className="flex flex-col items-end gap-0.5">
                            {missing ? (
                              <XCircle size={13} className="text-red-400" />
                            ) : drift > 0.001 ? (
                              <span
                                className={cn(
                                  'text-xs font-medium tabular-nums',
                                  drift > 0.1
                                    ? 'text-red-400'
                                    : drift > 0.01
                                      ? 'text-yellow-400'
                                      : 'text-[var(--dim)]',
                                )}
                              >
                                {(drift * 100).toFixed(1)}%
                              </span>
                            ) : (
                              <Check size={13} className="text-green-400" />
                            )}
                            {t.disk_discrepancy && (
                              <span
                                className="text-[9px] text-blue-400 tabular-nums leading-tight"
                                title={t.disk_disc_details}
                              >
                                {activeNodes
                                  .filter(n => !t.missing_on?.includes(n) && t.nodes?.[n]?.s3_pct != null)
                                  .map(n => `${t.nodes[n].s3_pct!.toFixed(0)}%S3`)
                                  .join(' vs ')}
                              </span>
                            )}
                            {t.total_bytes != null && t.total_bytes > 0 && (
                              <span className="text-[9px] text-[var(--dim)] tabular-nums">
                                {fmtBytes(t.total_bytes)}
                              </span>
                            )}
                          </div>
                        </td>
                      )}
                      <td className="px-2 w-8">
                        <button
                          onClick={() => onAnalyze({ table: `${t.database}.${t.table}`, engine: t.engine, nodes: t.nodes, missing_on: t.missing_on, drift: (drift * 100).toFixed(1) + '%' })}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-purple-400 hover:bg-purple-500/15"
                          title="Analyze with AI"
                        >
                          <Sparkles size={11} />
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Settings view — baseline column + delta for others               */
/* ------------------------------------------------------------------ */
function SettingsView({
  data, baseline, instances, onAnalyze,
}: {
  data: SettingsData
  baseline: string
  instances: string[]
  onAnalyze: (data: Record<string, any>) => void
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
                <th className="w-8 px-2" />
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
                  className={cn('border-b border-[var(--border)] last:border-0 group', s.important && 'border-l-2 border-l-blue-500')}
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
                  <td className="px-2 w-8">
                    <button
                      onClick={() => onAnalyze({ setting: s.name, baseline_value: s.values?.[baseline], values: s.values, important: s.important })}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-purple-400 hover:bg-purple-500/15"
                      title="Analyze with AI"
                    >
                      <Sparkles size={11} />
                    </button>
                  </td>
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

function MetricsView({ baseline, instances, onAnalyze }: { baseline: string; instances: string[]; onAnalyze: (data: Record<string, any>) => void }) {
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
                <th className="w-8 px-2" />
              </tr>
            </thead>
            <tbody>
              {data.metrics.map((m, i) => {
                const bVal = m.values?.[baseline] ?? 0
                return (
                  <tr key={i} className="border-b border-[var(--border)] last:border-0 group">
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
                    <td className="px-2 w-8">
                      <button
                        onClick={() => onAnalyze({ metric: m.name, unit: m.unit, baseline_value: bVal, values: m.values })}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-purple-400 hover:bg-purple-500/15"
                        title="Analyze with AI"
                      >
                        <Sparkles size={11} />
                      </button>
                    </td>
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
  const { instances: storeInstances, selectedInstance } = useStore()
  const { analyze } = useAIAnalysis(selectedInstance)
  const handleAnalyze = useCallback((data: Record<string, any>) => {
    analyze('Instance Comparison', data, { contextType: 'tab', tab: 'compare' })
  }, [analyze])
  const makeElementAnalyzer = useCallback((labelFn: (d: Record<string, any>) => string) =>
    (data: Record<string, any>) => analyze(labelFn(data), data, { contextType: 'row', tab: 'compare' }),
  [analyze])

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

  // Use compare API instances as authoritative (they have actual data).
  // Fall back to store instances if compare hasn't loaded yet.
  const instances = tablesData?.instances?.length
    ? tablesData.instances
    : storeInstances

  // Effective baseline for Settings / Metrics / Memory tabs
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
      {/* ---- Tab bar + Analyze ---- */}
      <div className="flex items-center gap-3">
        <div className="flex gap-1 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-1 w-fit">
          <TabButton active={tab === 'tables'} label="Tables" onClick={() => setTab('tables')} />
          <TabButton active={tab === 'settings'} label="Settings" onClick={() => setTab('settings')} />
          <TabButton active={tab === 'metrics'} label="Metrics" onClick={() => setTab('metrics')} />
          <TabButton active={tab === 'memory'} label="Memory" onClick={() => setTab('memory')} />
        </div>
        <button
          onClick={() => handleAnalyze({ baseline: effectiveBaseline, instances, tab, tablesData, settingsData })}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-purple-400 hover:bg-purple-500/15 border border-purple-500/20 transition-colors"
        >
          <Sparkles size={11} />
          Analyze
        </button>
      </div>

      {/* ---- Node pills (baseline selector) — only for non-Tables tabs ---- */}
      {tab !== 'tables' && (
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
      )}

      {/* ---- Tab content ---- */}
      {tab === 'tables' && (
        tablesLoading
          ? <LoadingSkeleton />
          : tablesData
            ? <TablesView data={tablesData} instances={instances} onAnalyze={makeElementAnalyzer(d => `Compare table: ${d.table}`)} />
            : <EmptyMsg msg="Failed to load table data" />
      )}
      {tab === 'settings' && (
        settingsLoading
          ? <LoadingSkeleton />
          : settingsData
            ? <SettingsView data={settingsData} baseline={effectiveBaseline} instances={instances} onAnalyze={makeElementAnalyzer(d => `Setting: ${d.setting}`)} />
            : <EmptyMsg msg="Failed to load settings data" />
      )}
      {tab === 'metrics' && (
        <MetricsView baseline={effectiveBaseline} instances={instances} onAnalyze={makeElementAnalyzer(d => `Metric: ${d.metric}`)} />
      )}
      {tab === 'memory' && (
        <MemoryView baseline={effectiveBaseline} instances={instances} />
      )}
    </div>
  )
}
