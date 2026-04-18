import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Play, History, X, Loader2, Download, BarChart2, ScatterChart, PieChart, LineChart, LayoutGrid, Plus, Columns2, ChevronDown, Bookmark, BookmarkPlus, StopCircle } from 'lucide-react'
import { Line, Bar, Doughnut, Scatter } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  DoughnutController,
  ScatterController,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import { useStore } from '../hooks/useStore'
import { api } from '../lib/api'
import { fmtDuration, fmtNum, fmtBytes, fmtCompact, cn } from '../lib/utils'
import { Card } from '../components/Card'
import { DataTable } from '../components/DataTable'
import { SqlEditor, type SqlEditorHandle, type SchemaItem } from '../components/SqlEditor'
import type { QueryResult, StatementResult, QueryHistoryEntry } from '../types/api'

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement, BarElement,
  ArcElement, DoughnutController, ScatterController,
  Tooltip, Legend, Filler,
)

const MAX_ROWS_OPTIONS = [100, 500, 1000, 5000]

const STARTER_QUERIES = [
  {
    label: 'Top slow queries (last 1h)',
    sql: `SELECT normalized_query_hash, count() as cnt, avg(query_duration_ms) as avg_ms, max(query_duration_ms) as max_ms, any(query) as sample\nFROM system.query_log\nWHERE event_time >= now() - INTERVAL 1 HOUR AND type = 'QueryFinish'\nGROUP BY normalized_query_hash\nORDER BY avg_ms DESC\nLIMIT 20`,
  },
  {
    label: 'Active queries right now',
    sql: `SELECT query_id, user, elapsed, memory_usage, query\nFROM system.processes\nORDER BY elapsed DESC`,
  },
  {
    label: 'Table disk usage',
    sql: `SELECT database, table, formatReadableSize(sum(bytes_on_disk)) as size, sum(rows) as rows, count() as parts\nFROM system.parts\nWHERE active\nGROUP BY database, table\nORDER BY sum(bytes_on_disk) DESC\nLIMIT 20`,
  },
  {
    label: 'Recent errors (last 1h)',
    sql: `SELECT event_time, user, exception_code, exception, query\nFROM system.query_log\nWHERE event_time >= now() - INTERVAL 1 HOUR AND type = 'ExceptionWhileProcessing'\nORDER BY event_time DESC\nLIMIT 50`,
  },
  {
    label: 'Merge queue',
    sql: `SELECT database, table, count() as merges, sum(rows_read) as rows_read\nFROM system.merges\nGROUP BY database, table\nORDER BY merges DESC`,
  },
  {
    label: 'Replication lag',
    sql: `SELECT database, table, is_leader, queue_size, absolute_delay\nFROM system.replicas\nORDER BY absolute_delay DESC`,
  },
]

const CHART_COLORS = [
  '#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7',
  '#06b6d4', '#f97316', '#ec4899',
]

type ChartMode = 'auto' | 'line' | 'area' | 'bar' | 'stacked' | 'scatter' | 'donut'

// ── column semantics detection ──────────────────────────────────────────────

function isTimestamp(name: string | undefined, values: any[]): boolean {
  if (!name) return false
  const lc = name.toLowerCase()
  if (lc.includes('time') || lc.includes('date') || lc.includes('ts') || lc === 'day' || lc === 'hour') return true
  if (values.length > 0) return /^\d{4}-\d{2}-\d{2}/.test(String(values[0]))
  return false
}

function isNumeric(values: any[]): boolean {
  return values.length > 0 && values.every(v => v !== null && v !== undefined && !isNaN(Number(v)))
}

/** Auto-format a cell value by column name heuristics */
function smartFmt(col: string, v: any): string {
  if (v === null || v === undefined) return 'NULL'
  const lc = col.toLowerCase()
  const n = Number(v)
  if (isFinite(n)) {
    if (/bytes|size|disk/.test(lc)) return fmtBytes(n)
    if (/_ms$|duration|elapsed|latency/.test(lc)) return fmtDuration(n)
    if (/count|cnt|^rows$|queries|requests/.test(lc)) return fmtCompact(n)
  }
  return String(v)
}

// ── chart builders ───────────────────────────────────────────────────────────

interface ColDef { name: string; type: string }

function buildChart(rows: Record<string, any>[], cols: ColDef[], mode: ChartMode) {
  if (rows.length === 0) return null
  const tsCol = cols.find(c => isTimestamp(c.name, rows.map(r => r[c.name])))
  const numCols = cols.filter(c => c !== tsCol && isNumeric(rows.map(r => r[c.name])))
  const strCols = cols.filter(c => c !== tsCol && !numCols.includes(c))
  if (numCols.length === 0) return null

  const eff: ChartMode = mode === 'auto'
    ? (tsCol ? (numCols.length === 1 ? 'area' : 'line')
      : numCols.length >= 2 ? 'stacked'
      : rows.length <= 12 ? 'donut'
      : 'bar')
    : mode

  // Scatter
  if (eff === 'scatter' && numCols.length >= 2) {
    return {
      type: eff,
      data: {
        datasets: [{
          label: `${numCols[0].name} vs ${numCols[1].name}`,
          data: rows.map(r => ({ x: Number(r[numCols[0].name]), y: Number(r[numCols[1].name]) })),
          backgroundColor: CHART_COLORS[0] + 'cc',
          pointRadius: 4, pointHoverRadius: 6,
        }],
      },
      suggest: undefined as ChartMode | undefined,
    }
  }

  // Donut
  if (eff === 'donut' && numCols.length >= 1) {
    const lbl = strCols[0] ?? tsCol ?? numCols[0]
    return {
      type: eff,
      data: {
        labels: rows.map(r => String(r[lbl.name])),
        datasets: [{
          data: rows.map(r => Number(r[numCols[0].name])),
          backgroundColor: CHART_COLORS.map(c => c + 'cc'),
          borderColor: CHART_COLORS,
          borderWidth: 1,
        }],
      },
      suggest: undefined as ChartMode | undefined,
    }
  }

  // Time series: line / area
  if (tsCol) {
    const fill = eff === 'area' || (eff === 'line' && numCols.length === 1)
    return {
      type: eff,
      data: {
        labels: rows.map(r => String(r[tsCol.name])),
        datasets: numCols.map((c, i) => ({
          label: c.name,
          data: rows.map(r => Number(r[c.name])),
          borderColor: CHART_COLORS[i % CHART_COLORS.length],
          backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + (fill ? '30' : '10'),
          borderWidth: 1.5,
          pointRadius: rows.length > 80 ? 0 : 2,
          tension: 0.3,
          fill,
          ...(eff === 'stacked' ? { stack: 'a' } : {}),
        })),
      },
      suggest: undefined as ChartMode | undefined,
    }
  }

  // Bar / stacked
  const barCol = numCols[0]
  const lbl = strCols[0] ?? cols.find(c => c !== barCol) ?? barCol
  if ((eff === 'stacked' || eff === 'bar') && numCols.length >= 2) {
    return {
      type: eff,
      data: {
        labels: rows.map(r => String(r[lbl.name])),
        datasets: numCols.map((c, i) => ({
          label: c.name,
          data: rows.map(r => Number(r[c.name])),
          backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + 'cc',
          borderRadius: 3,
          ...(eff === 'stacked' ? { stack: 'a' } : {}),
        })),
      },
      suggest: rows.length <= 12 ? 'donut' as ChartMode : undefined,
    }
  }
  return {
    type: 'bar' as ChartMode,
    data: {
      labels: rows.map(r => String(r[lbl.name])),
      datasets: [{
        label: barCol.name,
        data: rows.map(r => Number(r[barCol.name])),
        backgroundColor: CHART_COLORS.map(c => c + 'bb'),
        borderRadius: 4,
      }],
    },
    suggest: rows.length <= 12 ? 'donut' as ChartMode : undefined,
  }
}

function chartOptions(mode: ChartMode) {
  const tooltip = {
    backgroundColor: 'rgba(15,20,30,0.95)',
    borderColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    titleColor: '#f3f4f6',
    bodyColor: '#9ca3af',
    padding: 10,
    cornerRadius: 8,
  }
  if (mode === 'donut') {
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right' as const, labels: { color: '#9ca3af', font: { size: 11 }, padding: 12 } },
        tooltip,
      },
    }
  }
  const stacked = mode === 'stacked'
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { position: 'bottom' as const, labels: { color: '#9ca3af', font: { size: 11 }, boxWidth: 12, padding: 10 } },
      tooltip,
    },
    scales: {
      x: { ticks: { maxTicksLimit: 12, color: '#6b7280', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' }, stacked },
      y: { ticks: { color: '#6b7280', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' }, stacked },
    },
  }
}

// ── CSV export ───────────────────────────────────────────────────────────────

function exportCsv(columns: string[], rows: Record<string, any>[]) {
  const esc = (v: any) => { const s = String(v ?? ''); return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const csv = [columns.map(esc).join(','), ...rows.map(r => columns.map(c => esc(r[c])).join(','))].join('\r\n')
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: 'result.csv',
  })
  a.click()
  URL.revokeObjectURL(a.href)
}

// ── chart mode picker ────────────────────────────────────────────────────────

const MODES: { m: ChartMode; icon: React.ReactNode; label: string }[] = [
  { m: 'auto', icon: <LayoutGrid size={12} />, label: 'Auto' },
  { m: 'line', icon: <LineChart size={12} />, label: 'Line' },
  { m: 'area', icon: <LineChart size={12} />, label: 'Area' },
  { m: 'bar', icon: <BarChart2 size={12} />, label: 'Bar' },
  { m: 'stacked', icon: <BarChart2 size={12} />, label: 'Stack' },
  { m: 'scatter', icon: <ScatterChart size={12} />, label: 'XY' },
  { m: 'donut', icon: <PieChart size={12} />, label: 'Pie' },
]

// ── StatementPane: renders a single statement result ─────────────────────────

interface StatementPaneProps {
  stmt: StatementResult
  index: number
  total: number
}

function StatementPane({ stmt, index, total }: StatementPaneProps) {
  const [tab, setTab] = useState<'table' | 'chart'>('table')
  const [chartMode, setChartMode] = useState<ChartMode>('auto')

  const cols = useMemo<ColDef[]>(() =>
    stmt.columns.map((c, i) => ({ name: c, type: stmt.types?.[i] || 'String' })),
    [stmt],
  )
  const tableCols = useMemo(() => cols.map(c => ({
    key: c.name, label: c.name,
    format: (v: any) => v === null || v === undefined
      ? <span className="text-[var(--dim)]">NULL</span>
      : <span>{smartFmt(c.name, v)}</span>,
  })), [cols])

  const chartInfo = useMemo(() => buildChart(stmt.rows, cols, chartMode), [stmt, cols, chartMode])
  const opts = useMemo(() => chartOptions(chartInfo?.type ?? chartMode), [chartInfo, chartMode])

  return (
    <Card className="overflow-hidden !p-0">
      {/* Statement section header — only shown when multiple stmts */}
      {total > 1 && (
        <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <div className="flex items-center gap-2 shrink-0">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent)] text-[10px] font-bold text-white leading-none">
              {index + 1}
            </span>
            <span className="text-[11px] font-semibold text-[var(--dim)] uppercase tracking-wider">
              Statement {index + 1} / {total}
            </span>
          </div>
          <code className="flex-1 truncate text-[11px] font-mono text-[var(--fg)] opacity-70" title={stmt.sql}>
            {stmt.sql.length > 80 ? stmt.sql.slice(0, 80) + '…' : stmt.sql}
          </code>
        </div>
      )}

      {/* Pane controls */}
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        <div className="flex gap-1">
          {(['table', 'chart'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={cn('px-3 py-1 text-xs rounded-md capitalize transition-colors',
                tab === t ? 'bg-[var(--accent)] text-white' : 'text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)]')}>
              {t}
            </button>
          ))}
        </div>
        {tab === 'chart' && (
          <div className="flex gap-0.5 rounded-lg border border-[var(--border)] p-0.5">
            {MODES.map(({ m, icon, label }) => (
              <button key={m} onClick={() => setChartMode(m)} title={label}
                className={cn('flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
                  chartMode === m ? 'bg-[var(--accent)] text-white' : 'text-[var(--dim)] hover:text-[var(--fg)]')}>
                {icon}<span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-[var(--dim)]">
            {fmtCompact(stmt.row_count)} rows · {fmtDuration(stmt.elapsed_ms)}
          </span>
          <button
            onClick={() => exportCsv(cols.map(c => c.name), stmt.rows)}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-[var(--border)] text-[var(--dim)] hover:text-[var(--fg)] hover:border-[var(--accent)] transition-colors"
            title="Download CSV"
          >
            <Download size={11} /> CSV
          </button>
        </div>
      </div>

      {tab === 'table' ? (
        <div className="px-3 pb-3">
          <DataTable columns={tableCols} data={stmt.rows} maxHeight="340px" emptyText="No results" />
          {stmt.rows.length > 0 && stmt.rows.length < stmt.row_count && (
            <div className="mt-2 flex items-center gap-2 rounded-md bg-yellow-500/10 border border-yellow-500/20 px-3 py-2 text-xs text-yellow-400">
              <svg className="shrink-0 w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
              Showing first {stmt.rows.length.toLocaleString()} of {stmt.row_count.toLocaleString()} rows — results truncated at row limit
            </div>
          )}
        </div>
      ) : chartInfo ? (
        <div className="px-3 pb-3">
          <div className="h-64">
            {(chartInfo.type === 'line' || chartInfo.type === 'area') && <Line data={chartInfo.data} options={opts as any} />}
            {(chartInfo.type === 'bar' || chartInfo.type === 'stacked') && <Bar data={chartInfo.data} options={opts as any} />}
            {chartInfo.type === 'scatter' && <Scatter data={chartInfo.data as any} options={opts as any} />}
            {chartInfo.type === 'donut' && <Doughnut data={chartInfo.data} options={opts as any} />}
          </div>
          {chartInfo.suggest && (
            <p className="text-xs text-[var(--dim)] mt-2 text-center">
              Small dataset — try{' '}
              <button onClick={() => setChartMode(chartInfo.suggest!)} className="text-[var(--accent)] underline">
                {chartInfo.suggest}
              </button>{' '}view
            </p>
          )}
        </div>
      ) : (
        <div className="text-sm text-[var(--dim)] text-center py-8">
          No chartable data — needs at least one numeric column
        </div>
      )}
    </Card>
  )
}

// ── NodePane: results for one instance (may have multiple statements) ─────────

interface NodePaneProps {
  instance: string
  result: QueryResult | null
  error: string | null
  loading: boolean
  onRemove?: () => void
}

function NodePane({ instance, result, error, loading, onRemove }: NodePaneProps) {
  const stmts = result?.results ?? (result ? [{
    sql: '', columns: result.columns, types: result.types ?? [],
    rows: result.rows, row_count: result.row_count, elapsed_ms: result.elapsed_ms,
  }] : [])

  return (
    <div className="flex-1 min-w-0 space-y-3">
      {/* Node label */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-md bg-[var(--hover)] px-2.5 py-1 text-xs font-mono font-medium text-[var(--fg)]">
          <span className={cn('h-2 w-2 rounded-full shrink-0', loading ? 'bg-yellow-400 animate-pulse' : error ? 'bg-red-400' : result ? 'bg-green-400' : 'bg-[var(--dim)]')} />
          {instance}
        </div>
        {result && (
          <span className="text-xs text-[var(--dim)]">{fmtDuration(result.elapsed_ms)} total</span>
        )}
        {onRemove && (
          <button onClick={onRemove} className="ml-auto text-[var(--dim)] hover:text-[var(--fg)]" title="Remove node">
            <X size={14} />
          </button>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-[var(--dim)] py-4">
          <Loader2 size={16} className="animate-spin" /> Running…
        </div>
      )}

      {error && !loading && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-4 font-mono text-xs text-[var(--red)] whitespace-pre-wrap leading-relaxed">
          {error}
        </div>
      )}

      {!loading && !error && stmts.map((s, i) => (
        <StatementPane key={i} stmt={s} index={i} total={stmts.length} />
      ))}
    </div>
  )
}

// ── main component ───────────────────────────────────────────────────────────

type NodeResult = { result: QueryResult | null; error: string | null; loading: boolean }

interface BookmarkEntry {
  id: string
  name: string
  query: string
  savedAt: number
}

export default function Terminal() {
  const { instances, selectedInstance, setSelectedInstance, terminalQuery, terminalInstance } = useStore()
  const [inst, setInst] = useState(() => terminalInstance || selectedInstance || instances[0] || '')
  const [splitInstances, setSplitInstances] = useState<string[]>([])
  const [query, setQuery] = useState(() => terminalQuery || '')
  const [maxRows, setMaxRows] = useState(1000)
  const [nodeResults, setNodeResults] = useState<Record<string, NodeResult>>({})
  const [running, setRunning] = useState(false)
  const [execTime, setExecTime] = useState<Date | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState<QueryHistoryEntry[]>([])
  const [queryHistory, setQueryHistory] = useState<Array<{sql: string; ts: number; rowCount?: number}>>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [schema, setSchema] = useState<SchemaItem[]>([])
  const [showCompare, setShowCompare] = useState(false)
  const compareRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<SqlEditorHandle>(null)

  const abortControllerRef = useRef<AbortController | null>(null)

  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>(() => {
    try { return JSON.parse(localStorage.getItem('ch-terminal-bookmarks') ?? '[]') } catch { return [] }
  })
  const [showBookmarks, setShowBookmarks] = useState(false)
  const [bookmarkName, setBookmarkName] = useState('')

  function saveBookmark() {
    if (!query.trim()) return
    const name = bookmarkName.trim() || `Query ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    const b: BookmarkEntry = { id: Date.now().toString(), name, query, savedAt: Date.now() }
    const next = [b, ...bookmarks].slice(0, 30)
    setBookmarks(next)
    localStorage.setItem('ch-terminal-bookmarks', JSON.stringify(next))
    setBookmarkName('')
  }

  function deleteBookmark(id: string) {
    const next = bookmarks.filter(b => b.id !== id)
    setBookmarks(next)
    localStorage.setItem('ch-terminal-bookmarks', JSON.stringify(next))
  }

  function loadBookmark(b: BookmarkEntry) {
    setQuery(b.query)
    setShowBookmarks(false)
  }

  const allInstances = useMemo(() => [inst, ...splitInstances].filter(Boolean), [inst, splitInstances])

  useEffect(() => {
    if (terminalQuery) setQuery(terminalQuery)
    if (terminalInstance) setInst(terminalInstance)
  }, [terminalQuery, terminalInstance])

  useEffect(() => {
    if (selectedInstance && !terminalInstance) setInst(selectedInstance)
  }, [selectedInstance, terminalInstance])

  // Ensure inst is always populated once instances load
  useEffect(() => {
    if (instances.length > 0) {
      setInst(prev => prev || instances[0])
    }
  }, [instances])

  // Fetch tables + columns for autocomplete from primary instance
  useEffect(() => {
    if (!inst) return
    let cancelled = false

    Promise.all([
      api.terminal.execute(
        inst,
        `SELECT database, name AS table_name FROM system.tables
         WHERE database NOT IN ('information_schema','INFORMATION_SCHEMA')
           AND name NOT LIKE '.%'
         ORDER BY database, name LIMIT 5000`,
        5000,
      ).catch(() => null),
      api.terminal.execute(
        inst,
        `SELECT database, table, name, type FROM system.columns
         WHERE database NOT IN ('information_schema','INFORMATION_SCHEMA')
           AND table NOT LIKE '.%'
         ORDER BY database, table, name LIMIT 20000`,
        20000,
      ).catch(() => null),
    ]).then(([tblRes, colRes]) => {
      if (cancelled) return
      const items: SchemaItem[] = []
      const seen = new Set<string>()
      if (tblRes?.rows) {
        for (const t of tblRes.rows) {
          const db = String(t.database || ''); const tname = String(t.table_name || '')
          if (!db || !tname) continue
          const fq = `${db}.${tname}`
          if (!seen.has(fq)) { items.push({ label: fq, kind: 'table', detail: db }); seen.add(fq) }
          if (!seen.has(tname)) { items.push({ label: tname, kind: 'table', detail: db }); seen.add(tname) }
        }
      }
      if (colRes?.rows) {
        for (const r of colRes.rows) {
          const col = String(r.name || ''); const tbl = String(r.table || '')
          const db = String(r.database || ''); const typ = String(r.type || '')
          if (!col) continue
          const tqc = `${tbl}.${col}`
          if (!seen.has(tqc)) { items.push({ label: tqc, kind: 'column', detail: typ }); seen.add(tqc) }
          if (!seen.has(col)) { items.push({ label: col, kind: 'column', detail: `${db}.${tbl} · ${typ}` }); seen.add(col) }
        }
      }
      setSchema(items)
    })
    return () => { cancelled = true }
  }, [inst])

  const abortQuery = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setRunning(false)
    setNodeResults(prev => {
      const next = { ...prev }
      for (const key of Object.keys(next)) {
        if (next[key].loading) {
          next[key] = { result: null, error: 'Query cancelled', loading: false }
        }
      }
      return next
    })
  }, [])

  const execute = useCallback(async () => {
    if (!query.trim() || allInstances.length === 0) return

    // Abort any in-flight request
    if (abortControllerRef.current) abortControllerRef.current.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller

    setRunning(true)
    setExecTime(null)

    // Mark all instances as loading
    const initial: Record<string, NodeResult> = {}
    for (const i of allInstances) initial[i] = { result: null, error: null, loading: true }
    setNodeResults(initial)

    // Run against all instances in parallel
    const queryText = query.trim()
    const results = await Promise.all(allInstances.map(async (i) => {
      try {
        const res = await api.terminal.execute(i, queryText, maxRows, controller.signal)
        setNodeResults(prev => ({ ...prev, [i]: { result: res, error: null, loading: false } }))
        return res
      } catch (e: any) {
        if (e?.name === 'AbortError') return null
        setNodeResults(prev => ({ ...prev, [i]: { result: null, error: e.message ?? 'Request failed', loading: false } }))
        return null
      }
    }))

    if (controller.signal.aborted) return

    // Push to in-memory query history on any success
    const firstSuccess = results.find(r => r !== null)
    if (firstSuccess) {
      const rowCount = firstSuccess.results
        ? firstSuccess.results.reduce((s, r) => s + r.rows.length, 0)
        : firstSuccess.rows?.length
      setQueryHistory(prev => [{ sql: queryText, ts: Date.now(), rowCount }, ...prev].slice(0, 20))
    }

    setExecTime(new Date())
    setRunning(false)
    abortControllerRef.current = null
  }, [query, allInstances, maxRows])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') { e.preventDefault(); setNodeResults({}) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try { setHistory(await api.terminal.history()) } catch { setHistory([]) } finally { setHistoryLoading(false) }
  }, [])

  const toggleHistory = useCallback(() => {
    if (!showHistory) loadHistory()
    setShowHistory(v => !v)
  }, [showHistory, loadHistory])

  const addSplitNode = useCallback((node: string) => {
    if (!node || splitInstances.includes(node) || node === inst) return
    setSplitInstances(prev => [...prev, node])
  }, [splitInstances, inst])

  const removeSplitNode = useCallback((node: string) => {
    setSplitInstances(prev => prev.filter(n => n !== node))
    setNodeResults(prev => { const next = { ...prev }; delete next[node]; return next })
  }, [])

  // Close compare dropdown when clicking outside
  useEffect(() => {
    if (!showCompare) return
    const handler = (e: MouseEvent) => {
      if (compareRef.current && !compareRef.current.contains(e.target as Node)) {
        setShowCompare(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showCompare])

  const hasResults = Object.keys(nodeResults).length > 0
  const isSplit = allInstances.length > 1

  return (
    <div className="flex gap-4 h-full">
      {/* Left: in-memory session query history panel */}
      {historyOpen && (
        <div className="w-64 shrink-0 border-r border-[var(--border)] flex flex-col bg-[var(--card)] overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] shrink-0">
            <span className="text-xs font-semibold">Query History</span>
            <button onClick={() => setHistoryOpen(false)} className="text-[var(--dim)] hover:text-[var(--fg)]"><X size={13} /></button>
          </div>
          <div className="flex-1 overflow-auto">
            {queryHistory.length === 0 ? (
              <div className="text-[10px] text-[var(--dim)] text-center py-6">No queries yet</div>
            ) : queryHistory.map((h, i) => (
              <button
                key={i}
                onClick={() => { setQuery(h.sql); setHistoryOpen(false) }}
                className="w-full text-left px-3 py-2 border-b border-[var(--border)] hover:bg-[var(--hover)] transition-colors group"
              >
                <div className="text-[10px] font-mono text-[var(--fg)] truncate">{h.sql.replace(/\s+/g, ' ').trim()}</div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-[9px] text-[var(--dim)]">{new Date(h.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span>
                  {h.rowCount != null && <span className="text-[9px] text-[var(--dim)]">{h.rowCount} rows</span>}
                </div>
              </button>
            ))}
          </div>
          {queryHistory.length > 0 && (
            <button onClick={() => setQueryHistory([])} className="text-[10px] text-[var(--dim)] hover:text-red-400 transition-colors px-3 py-2 border-t border-[var(--border)] text-left">
              Clear history
            </button>
          )}
        </div>
      )}

      <div className="flex-1 flex flex-col gap-3 min-w-0 min-h-0 overflow-y-auto">
        {/* Instance row */}
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-sm text-[var(--dim)]">Instance</label>
          <select
            value={inst}
            onChange={e => { setInst(e.target.value); setSelectedInstance(e.target.value) }}
            className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
          >
            {instances.length === 0 && <option value="">No instances</option>}
            {instances.map(i => <option key={i} value={i}>{i}</option>)}
          </select>

          {/* Split node tags */}
          {splitInstances.map(n => (
            <span key={n} className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)]/10 border border-[var(--accent)]/30 px-2 py-1 text-xs font-mono text-[var(--accent)]">
              {n}
              <button onClick={() => removeSplitNode(n)} className="hover:text-[var(--fg)]"><X size={11} /></button>
            </span>
          ))}

          {/* Add another node */}
          {instances.length > 1 && (
            <div className="relative" ref={compareRef}>
              <button
                onClick={() => setShowCompare(v => !v)}
                className={cn('inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors border',
                  isSplit
                    ? 'border-[var(--accent)]/40 text-[var(--accent)] bg-[var(--accent)]/5'
                    : 'border-[var(--border)] text-[var(--dim)] hover:text-[var(--fg)] hover:border-[var(--accent)]')}
                title="Compare with another node"
              >
                {isSplit ? <Columns2 size={13} /> : <Plus size={13} />}
                <span className="hidden sm:inline">{isSplit ? 'Split' : 'Compare'}</span>
                <ChevronDown size={11} className={cn('transition-transform', showCompare ? 'rotate-180' : '')} />
              </button>
              {/* Click-based dropdown */}
              {showCompare && (
                <div className="absolute left-0 top-full mt-1 z-20 min-w-max rounded-md border border-[var(--border)] bg-[var(--card)] shadow-lg py-1">
                  {instances.filter(i => i !== inst && !splitInstances.includes(i)).map(i => (
                    <button key={i} onClick={() => { addSplitNode(i); setShowCompare(false) }}
                      className="block w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-[var(--hover)] text-[var(--fg)]">
                      {i}
                    </button>
                  ))}
                  {instances.filter(i => i !== inst && !splitInstances.includes(i)).length === 0 && (
                    <div className="px-3 py-1.5 text-xs text-[var(--dim)]">All nodes added</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* CodeMirror SQL editor */}
        <SqlEditor
          ref={editorRef}
          value={query}
          onChange={setQuery}
          onSubmit={execute}
          schemaCompletions={schema}
          height="240px"
        />

        {/* Controls */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={execute}
            disabled={running || !query.trim() || !inst}
            className={cn(
              'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
              running || !query.trim() || !inst
                ? 'bg-[var(--border)] text-[var(--dim)] cursor-not-allowed'
                : 'bg-[var(--accent)] text-white hover:opacity-90',
            )}
          >
            {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            {isSplit ? `Run on ${allInstances.length} nodes` : 'Run'}
          </button>
          {running && (
            <button
              onClick={abortQuery}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors"
              title="Cancel running query"
            >
              <StopCircle size={14} />
              Abort
            </button>
          )}
          <span className="text-xs text-[var(--dim)]">Ctrl+Enter to run · Ctrl+L to clear</span>
          <div className="ml-auto flex items-center gap-3">
            {query.trim() && (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={bookmarkName}
                  onChange={e => setBookmarkName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveBookmark()}
                  placeholder="Snippet name…"
                  className="text-xs bg-[var(--hover)] border border-[var(--border)] rounded px-2 py-1 outline-none focus:border-[var(--accent)] w-32"
                />
                <button
                  onClick={saveBookmark}
                  title="Save as snippet"
                  className="p-1.5 rounded-md text-[var(--dim)] hover:text-[var(--accent)] hover:bg-[var(--hover)] transition-colors"
                >
                  <BookmarkPlus size={14} />
                </button>
              </div>
            )}
            <div className="relative">
              <button
                onClick={() => setShowBookmarks(s => !s)}
                title="Saved snippets"
                className={cn('p-1.5 rounded-md transition-colors',
                  showBookmarks ? 'bg-[var(--accent)] text-white' : 'text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)]')}
              >
                <Bookmark size={16} />
                {bookmarks.length > 0 && (
                  <span className="absolute -top-1 -right-1 text-[9px] bg-[var(--accent)] text-white rounded-full w-3.5 h-3.5 flex items-center justify-center leading-none">
                    {bookmarks.length > 9 ? '9+' : bookmarks.length}
                  </span>
                )}
              </button>
            </div>
            <label className="text-xs text-[var(--dim)]">Max rows</label>
            <select
              value={maxRows}
              onChange={e => setMaxRows(Number(e.target.value))}
              className="rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs text-[var(--fg)] focus:outline-none"
            >
              {MAX_ROWS_OPTIONS.map(n => <option key={n} value={n}>{fmtNum(n)}</option>)}
            </select>
            <button
              onClick={() => setHistoryOpen(v => !v)}
              className={cn('flex items-center gap-1.5 px-2 py-1 rounded text-xs border transition-colors', historyOpen ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)]')}
              title="Query history"
            >
              <History size={11} />
              History
              {queryHistory.length > 0 && <span className="text-[9px] bg-[var(--accent)]/20 text-[var(--accent)] px-1 rounded-full">{queryHistory.length}</span>}
            </button>
            <button
              onClick={toggleHistory}
              className={cn('p-1.5 rounded-md transition-colors',
                showHistory ? 'bg-[var(--accent)] text-white' : 'text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)]')}
              title="Query History (server)"
            >
              <History size={16} />
            </button>
          </div>
        </div>

        {/* Bookmarks panel */}
        {showBookmarks && (
          <div className="border border-[var(--border)] rounded-lg bg-[var(--card)] p-3 space-y-1">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-[var(--text-muted)]">Saved Snippets</span>
              <button onClick={() => setShowBookmarks(false)} className="text-[var(--dim)] hover:text-[var(--fg)]">
                <X size={12} />
              </button>
            </div>
            {bookmarks.length === 0 ? (
              <div className="text-xs text-[var(--dim)] text-center py-4">No saved snippets yet</div>
            ) : (
              bookmarks.map(b => (
                <div key={b.id} className="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--hover)] cursor-pointer"
                  onClick={() => loadBookmark(b)}>
                  <Bookmark size={11} className="text-[var(--accent)] shrink-0" />
                  <span className="flex-1 text-xs truncate" title={b.query}>{b.name}</span>
                  <span className="text-[10px] text-[var(--dim)] shrink-0">
                    {new Date(b.savedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                  </span>
                  <button onClick={e => { e.stopPropagation(); deleteBookmark(b.id) }}
                    className="opacity-0 group-hover:opacity-100 text-[var(--dim)] hover:text-red-400 transition-opacity">
                    <X size={11} />
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* Starter queries — shown when editor is empty and no results yet */}
        {!query.trim() && !hasResults && (
          <div className="border border-[var(--border)] rounded-lg overflow-hidden flex flex-col max-h-[300px]">
            <div className="px-3 py-2 bg-[var(--surface)] border-b border-[var(--border)] shrink-0">
              <span className="text-[11px] font-semibold text-[var(--dim)] uppercase tracking-wider">Example Queries</span>
            </div>
            <div className="divide-y divide-[var(--border)] overflow-y-auto">
              {STARTER_QUERIES.map(q => (
                <button
                  key={q.label}
                  onClick={() => setQuery(q.sql)}
                  className="w-full text-left px-3 py-2.5 hover:bg-[var(--hover)] transition-colors"
                >
                  <div className="text-[12px] font-medium text-[var(--text)]">{q.label}</div>
                  <div className="text-[10px] text-[var(--dim)] font-mono mt-0.5 truncate">{q.sql.split('\\n')[0]}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Results — split view or single column */}
        {hasResults && (
          <>
          {execTime && !running && (
            <div className="flex items-center gap-2 text-[11px] text-[var(--dim)]">
              <span>Results from {execTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            </div>
          )}
          <div className={cn(isSplit ? 'overflow-x-auto' : '')}>
          <div className={cn('flex gap-4', isSplit ? 'flex-row items-start min-w-max' : 'flex-col')}>
            {allInstances.map((i, idx) => {
              const nr = nodeResults[i] ?? { result: null, error: null, loading: false }
              return (
                <NodePane
                  key={i}
                  instance={i}
                  result={nr.result}
                  error={nr.error}
                  loading={nr.loading}
                  onRemove={idx > 0 ? () => removeSplitNode(i) : undefined}
                />
              )
            })}
          </div>
          </div>
          </>
        )}
      </div>

      {/* History panel */}
      {showHistory && (
        <div className="w-80 shrink-0 border-l border-[var(--border)] pl-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium">Query History</h3>
            <button onClick={() => setShowHistory(false)} className="text-[var(--dim)] hover:text-[var(--fg)]"><X size={16} /></button>
          </div>
          {historyLoading
            ? <div className="text-sm text-[var(--dim)] text-center py-4">Loading…</div>
            : history.length === 0
            ? <div className="text-sm text-[var(--dim)] text-center py-4">No history yet</div>
            : (
              <div className="space-y-2">
                {history.map((entry, i) => (
                  <button key={i} onClick={() => { setQuery(entry.query); setInst(entry.instance); setShowHistory(false); editorRef.current?.focus() }}
                    className="w-full text-left rounded-md border border-[var(--border)] p-2.5 hover:border-[var(--accent)] transition-colors">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs text-[var(--dim)]">{entry.instance}</span>
                      <span className="text-xs text-[var(--dim)] ml-auto">{fmtDuration(entry.elapsed_ms)} · {fmtCompact(entry.row_count)} rows</span>
                    </div>
                    <div className="text-xs font-mono text-[var(--fg)] truncate" title={entry.query}>
                      {entry.query.length > 80 ? entry.query.slice(0, 80) + '…' : entry.query}
                    </div>
                    {entry.error && <div className="text-xs text-[var(--red)] mt-1 truncate" title={entry.error}>{entry.error}</div>}
                  </button>
                ))}
              </div>
            )
          }
        </div>
      )}
    </div>
  )
}
