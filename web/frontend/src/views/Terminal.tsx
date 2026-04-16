import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Play, History, X, Loader2, Download, BarChart2, ScatterChart, PieChart, LineChart, LayoutGrid } from 'lucide-react'
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
import type { QueryResult, QueryHistoryEntry } from '../types/api'

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement, BarElement,
  ArcElement, DoughnutController, ScatterController,
  Tooltip, Legend, Filler,
)

const MAX_ROWS_OPTIONS = [100, 500, 1000, 5000]

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

// ── main component ───────────────────────────────────────────────────────────

export default function Terminal() {
  const { instances, selectedInstance, setSelectedInstance, terminalQuery, terminalInstance } = useStore()
  const [inst, setInst] = useState(() => terminalInstance || selectedInstance || instances[0] || '')
  const [query, setQuery] = useState(() => terminalQuery || '')
  const [maxRows, setMaxRows] = useState(1000)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [resultTab, setResultTab] = useState<'table' | 'chart'>('table')
  const [chartMode, setChartMode] = useState<ChartMode>('auto')
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState<QueryHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [schema, setSchema] = useState<SchemaItem[]>([])
  const editorRef = useRef<SqlEditorHandle>(null)

  useEffect(() => {
    if (terminalQuery) setQuery(terminalQuery)
    if (terminalInstance) setInst(terminalInstance)
  }, [terminalQuery, terminalInstance])

  useEffect(() => {
    if (selectedInstance && !terminalInstance) setInst(selectedInstance)
  }, [selectedInstance, terminalInstance])

  // Fetch tables + columns for autocomplete
  useEffect(() => {
    if (!inst) return
    let cancelled = false

    Promise.all([
      api.tables(inst).catch(() => [] as any[]),
      api.terminal.execute(
        inst,
        `SELECT database, table, name, type FROM system.columns
         WHERE database NOT IN ('information_schema','INFORMATION_SCHEMA')
         ORDER BY database, table, name LIMIT 10000`,
        10000,
      ).catch(() => null),
    ]).then(([tables, colRes]) => {
      if (cancelled) return
      const items: SchemaItem[] = []
      const seen = new Set<string>()

      // Tables — API returns `table_name` field (not `name`)
      if (Array.isArray(tables)) {
        for (const t of tables) {
          const tname = t.table_name || t.name
          if (!t.database || !tname) continue
          const fq = `${t.database}.${tname}`
          if (!seen.has(fq)) { items.push({ label: fq, kind: 'table', detail: t.database }); seen.add(fq) }
          if (!seen.has(tname)) { items.push({ label: tname, kind: 'table', detail: t.database }); seen.add(tname) }
        }
      }

      // Columns
      if (colRes?.rows) {
        for (const r of colRes.rows) {
          const col = String(r.name || '')
          const tbl = String(r.table || '')
          const db  = String(r.database || '')
          const typ = String(r.type || '')
          if (!col) continue
          // table.column
          const tqc = `${tbl}.${col}`
          if (!seen.has(tqc)) { items.push({ label: tqc, kind: 'column', detail: typ }); seen.add(tqc) }
          // bare column (dedup)
          if (!seen.has(col)) { items.push({ label: col, kind: 'column', detail: `${db}.${tbl} · ${typ}` }); seen.add(col) }
        }
      }

      setSchema(items)
    })

    return () => { cancelled = true }
  }, [inst])

  const execute = useCallback(async () => {
    if (!query.trim() || !inst) return
    setRunning(true); setError(null); setResult(null)
    try {
      const res = await api.terminal.execute(inst, query.trim(), maxRows)
      if (res.error) setError(res.error)
      else { setResult(res); setResultTab('table'); setChartMode('auto') }
    } catch (e: any) {
      setError(e.message ?? 'Request failed')
    } finally { setRunning(false) }
  }, [query, inst, maxRows])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') { e.preventDefault(); setResult(null); setError(null) }
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

  const normalizedCols = useMemo<ColDef[]>(() => {
    if (!result) return []
    return result.columns.map((c: any, i: number) =>
      typeof c === 'string' ? { name: c, type: result.types?.[i] || 'String' } : c,
    )
  }, [result])

  const tableColumns = useMemo(() => normalizedCols.map(c => ({
    key: c.name,
    label: c.name,
    format: (v: any) => v === null || v === undefined
      ? <span className="text-[var(--dim)]">NULL</span>
      : <span>{smartFmt(c.name, v)}</span>,
  })), [normalizedCols])

  const chartInfo = useMemo(() => {
    if (!result) return null
    return buildChart(result.rows, normalizedCols, chartMode)
  }, [result, normalizedCols, chartMode])

  const opts = useMemo(() => chartOptions(chartInfo?.type ?? chartMode), [chartInfo, chartMode])

  return (
    <div className="flex gap-4 h-full">
      <div className="flex-1 space-y-3 min-w-0">
        {/* Instance */}
        <div className="flex items-center gap-3">
          <label className="text-sm text-[var(--dim)]">Instance</label>
          <select
            value={inst}
            onChange={e => { setInst(e.target.value); setSelectedInstance(e.target.value) }}
            className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
          >
            {instances.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
        </div>

        {/* CodeMirror SQL editor */}
        <SqlEditor
          ref={editorRef}
          value={query}
          onChange={setQuery}
          onSubmit={execute}
          schemaCompletions={schema}
          height="200px"
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
            Run
          </button>
          <span className="text-xs text-[var(--dim)]">Ctrl+Enter to run · Ctrl+L to clear</span>
          <div className="ml-auto flex items-center gap-3">
            <label className="text-xs text-[var(--dim)]">Max rows</label>
            <select
              value={maxRows}
              onChange={e => setMaxRows(Number(e.target.value))}
              className="rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs text-[var(--fg)] focus:outline-none"
            >
              {MAX_ROWS_OPTIONS.map(n => <option key={n} value={n}>{fmtNum(n)}</option>)}
            </select>
            <button
              onClick={toggleHistory}
              className={cn('p-1.5 rounded-md transition-colors',
                showHistory ? 'bg-[var(--accent)] text-white' : 'text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)]')}
              title="Query History"
            >
              <History size={16} />
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-4 font-mono text-xs text-[var(--red)] whitespace-pre-wrap leading-relaxed">
            {error}
          </div>
        )}

        {/* Results */}
        {result && (
          <Card>
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <div className="flex gap-1">
                {(['table', 'chart'] as const).map(t => (
                  <button key={t} onClick={() => setResultTab(t)}
                    className={cn('px-3 py-1 text-xs rounded-md capitalize transition-colors',
                      resultTab === t ? 'bg-[var(--accent)] text-white' : 'text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)]')}>
                    {t}
                  </button>
                ))}
              </div>

              {/* Chart mode picker (visible in chart tab) */}
              {resultTab === 'chart' && (
                <div className="flex gap-0.5 rounded-lg border border-[var(--border)] p-0.5">
                  {MODES.map(({ m, icon, label }) => (
                    <button key={m} onClick={() => setChartMode(m)} title={label}
                      className={cn('flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
                        chartMode === m ? 'bg-[var(--accent)] text-white' : 'text-[var(--dim)] hover:text-[var(--fg)]')}>
                      {icon}
                      <span className="hidden sm:inline">{label}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="ml-auto flex items-center gap-2">
                {result.statements_run && result.statements_run > 1 && (
                  <span className="text-xs text-[var(--dim)] italic">{result.statements_run} statements · last result shown</span>
                )}
                <span className="text-xs text-[var(--dim)]">
                  {fmtCompact(result.row_count)} rows · {fmtDuration(result.elapsed_ms)}
                </span>
                <button
                  onClick={() => exportCsv(normalizedCols.map(c => c.name), result.rows)}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-[var(--border)] text-[var(--dim)] hover:text-[var(--fg)] hover:border-[var(--accent)] transition-colors"
                  title="Download CSV"
                >
                  <Download size={11} /> CSV
                </button>
              </div>
            </div>

            {resultTab === 'table' ? (
              <DataTable columns={tableColumns} data={result.rows} maxHeight="420px" emptyText="No results" />
            ) : chartInfo ? (
              <div>
                <div className="h-72">
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
                    </button>
                    {' '}view
                  </p>
                )}
              </div>
            ) : (
              <div className="text-sm text-[var(--dim)] text-center py-8">
                No chartable data — needs at least one numeric column
              </div>
            )}
          </Card>
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
                    <div className="text-xs font-mono text-[var(--fg)] truncate">
                      {entry.query.length > 80 ? entry.query.slice(0, 80) + '…' : entry.query}
                    </div>
                    {entry.error && <div className="text-xs text-red-400 mt-1 truncate">{entry.error}</div>}
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
