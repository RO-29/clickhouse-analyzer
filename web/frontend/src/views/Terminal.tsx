import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Play, History, X, Loader2 } from 'lucide-react'
import { Line, Bar } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import { useStore } from '../hooks/useStore'
import { api } from '../lib/api'
import { fmtDuration, fmtNum, cn } from '../lib/utils'
import { Card } from '../components/Card'
import { DataTable } from '../components/DataTable'
import type { QueryResult, QueryHistoryEntry } from '../types/api'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler)

const MAX_ROWS_OPTIONS = [100, 500, 1000, 5000]

const CHART_COLORS = [
  '#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7',
  '#06b6d4', '#f97316', '#ec4899',
]

function isTimestamp(name: string | undefined, values: any[]): boolean {
  if (!name) return false
  const lc = name.toLowerCase()
  if (lc.includes('time') || lc.includes('date') || lc.includes('ts') || lc === 'day' || lc === 'hour') return true
  if (values.length > 0) {
    const v = String(values[0])
    return /^\d{4}-\d{2}-\d{2}/.test(v)
  }
  return false
}

function isNumeric(values: any[]): boolean {
  return values.length > 0 && values.every((v) => v !== null && v !== undefined && !isNaN(Number(v)))
}

export default function Terminal() {
  const {
    instances, selectedInstance, setSelectedInstance,
    terminalQuery, terminalInstance,
  } = useStore()

  const [inst, setInst] = useState(() => terminalInstance || selectedInstance || instances[0] || '')
  const [query, setQuery] = useState(() => terminalQuery || '')
  const [maxRows, setMaxRows] = useState(1000)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [resultTab, setResultTab] = useState<'table' | 'chart'>('table')
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState<QueryHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Consume pre-fill values once
  useEffect(() => {
    if (terminalQuery) setQuery(terminalQuery)
    if (terminalInstance) setInst(terminalInstance)
  }, [terminalQuery, terminalInstance])

  // Update local inst when selectedInstance changes
  useEffect(() => {
    if (selectedInstance && !terminalInstance) setInst(selectedInstance)
  }, [selectedInstance, terminalInstance])

  const execute = useCallback(async () => {
    if (!query.trim() || !inst) return
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.terminal.execute(inst, query.trim(), maxRows)
      if (res.error) {
        setError(res.error)
      } else {
        setResult(res)
        setResultTab('table')
      }
    } catch (e: any) {
      setError(e.message ?? 'Request failed')
    } finally {
      setRunning(false)
    }
  }, [query, inst, maxRows])

  const clearResults = useCallback(() => {
    setResult(null)
    setError(null)
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        execute()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault()
        clearResults()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [execute, clearResults])

  // Load history
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const h = await api.terminal.history()
      setHistory(h)
    } catch {
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const toggleHistory = useCallback(() => {
    if (!showHistory) loadHistory()
    setShowHistory((v) => !v)
  }, [showHistory, loadHistory])

  const fillFromHistory = useCallback((entry: QueryHistoryEntry) => {
    setQuery(entry.query)
    setInst(entry.instance)
    setShowHistory(false)
    textareaRef.current?.focus()
  }, [])

  // Normalize columns: backend returns string[] not {name,type}[]
  const normalizedCols = useMemo(() => {
    if (!result) return []
    return result.columns.map((c: any, i: number) => {
      if (typeof c === 'string') return { name: c, type: result.types?.[i] || 'String' }
      return c as { name: string; type: string }
    })
  }, [result])

  // DataTable columns for results
  const tableColumns = useMemo(() => {
    return normalizedCols.map((c) => ({
      key: c.name,
      label: c.name,
      format: (v: any) =>
        v === null || v === undefined
          ? <span className="text-[var(--dim)]">NULL</span>
          : String(v),
    }))
  }, [normalizedCols])

  // Chart data
  const chartData = useMemo(() => {
    if (!result || result.rows.length === 0) return null
    const cols = normalizedCols
    const rows = result.rows

    const tsCol = cols.find((c) => isTimestamp(c.name, rows.map((r) => r[c.name])))
    const numCols = cols.filter((c) => c !== tsCol && isNumeric(rows.map((r) => r[c.name])))

    if (numCols.length === 0) return null

    if (tsCol) {
      const labels = rows.map((r) => String(r[tsCol.name]))
      return {
        type: 'line' as const,
        data: {
          labels,
          datasets: numCols.map((c, i) => ({
            label: c.name,
            data: rows.map((r) => Number(r[c.name])),
            borderColor: CHART_COLORS[i % CHART_COLORS.length],
            backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + '1a',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.3,
            fill: numCols.length === 1,
          })),
        },
      }
    }

    // Bar chart of first numeric column
    const barCol = numCols[0]
    const labelCol = cols.find((c) => c !== barCol) ?? barCol
    return {
      type: 'bar' as const,
      data: {
        labels: rows.map((r) => String(r[labelCol.name])),
        datasets: [{
          label: barCol.name,
          data: rows.map((r) => Number(r[barCol.name])),
          backgroundColor: '#3b82f6',
          borderRadius: 3,
        }],
      },
    }
  }, [result])

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: {
        position: 'bottom' as const,
        labels: { color: '#9ca3af', font: { size: 11 } },
      },
    },
    scales: {
      x: {
        ticks: { maxTicksLimit: 12, color: '#6b7280', font: { size: 10 } },
        grid: { color: 'rgba(255,255,255,0.04)' },
      },
      y: {
        ticks: { color: '#6b7280', font: { size: 10 } },
        grid: { color: 'rgba(255,255,255,0.04)' },
      },
    },
  }), [])

  return (
    <div className="flex gap-4 h-full">
      {/* Main panel */}
      <div className="flex-1 space-y-4 min-w-0">
        {/* Instance selector */}
        <div className="flex items-center gap-3">
          <label className="text-sm text-[var(--dim)]">Instance</label>
          <select
            value={inst}
            onChange={(e) => { setInst(e.target.value); setSelectedInstance(e.target.value) }}
            className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
          >
            {instances.map((i) => (
              <option key={i} value={i}>{i}</option>
            ))}
          </select>
        </div>

        {/* Editor */}
        <textarea
          ref={textareaRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Enter SQL query..."
          rows={8}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--code-bg)] p-4 font-mono text-sm text-[var(--fg)] resize-y focus:outline-none focus:border-[var(--accent)] placeholder:text-[var(--dim)]"
        />

        {/* Controls row */}
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
          <span className="text-xs text-[var(--dim)]">Ctrl+Enter to run</span>

          <div className="ml-auto flex items-center gap-3">
            <label className="text-xs text-[var(--dim)]">Max rows</label>
            <select
              value={maxRows}
              onChange={(e) => setMaxRows(Number(e.target.value))}
              className="rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs text-[var(--fg)] focus:outline-none"
            >
              {MAX_ROWS_OPTIONS.map((n) => (
                <option key={n} value={n}>{fmtNum(n)}</option>
              ))}
            </select>

            <button
              onClick={toggleHistory}
              className={cn(
                'p-1.5 rounded-md transition-colors',
                showHistory
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)]',
              )}
              title="Query History"
            >
              <History size={16} />
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-4 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Results */}
        {result && (
          <Card>
            {/* Result tabs + info */}
            <div className="flex items-center gap-4 mb-3">
              <div className="flex gap-1">
                <button
                  onClick={() => setResultTab('table')}
                  className={cn(
                    'px-3 py-1 text-xs rounded-md transition-colors',
                    resultTab === 'table'
                      ? 'bg-[var(--accent)] text-white'
                      : 'text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)]',
                  )}
                >
                  Table
                </button>
                <button
                  onClick={() => setResultTab('chart')}
                  className={cn(
                    'px-3 py-1 text-xs rounded-md transition-colors',
                    resultTab === 'chart'
                      ? 'bg-[var(--accent)] text-white'
                      : 'text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)]',
                  )}
                >
                  Chart
                </button>
              </div>
              <span className="text-xs text-[var(--dim)] ml-auto">
                {fmtNum(result.row_count)} rows in {fmtDuration(result.elapsed_ms)}
              </span>
            </div>

            {resultTab === 'table' ? (
              <DataTable
                columns={tableColumns}
                data={result.rows}
                maxHeight="400px"
                emptyText="No results"
              />
            ) : chartData ? (
              <div className="h-64">
                {chartData.type === 'line' ? (
                  <Line data={chartData.data} options={chartOptions} />
                ) : (
                  <Bar data={chartData.data} options={chartOptions} />
                )}
              </div>
            ) : (
              <div className="text-sm text-[var(--dim)] text-center py-8">
                No chartable data found
              </div>
            )}
          </Card>
        )}
      </div>

      {/* History panel */}
      {showHistory && (
        <div className="w-80 shrink-0 border-l border-[var(--border)] pl-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-[var(--fg)]">Query History</h3>
            <button
              onClick={() => setShowHistory(false)}
              className="text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
            >
              <X size={16} />
            </button>
          </div>
          {historyLoading ? (
            <div className="text-sm text-[var(--dim)] text-center py-4">Loading...</div>
          ) : history.length === 0 ? (
            <div className="text-sm text-[var(--dim)] text-center py-4">No history</div>
          ) : (
            <div className="space-y-2">
              {history.map((entry, i) => (
                <button
                  key={i}
                  onClick={() => fillFromHistory(entry)}
                  className="w-full text-left rounded-md border border-[var(--border)] p-2 hover:border-[var(--accent)] transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-[var(--dim)]">{entry.instance}</span>
                    <span className="text-xs text-[var(--dim)] ml-auto">
                      {fmtDuration(entry.elapsed_ms)} / {fmtNum(entry.row_count)} rows
                    </span>
                  </div>
                  <div className="text-xs font-mono text-[var(--fg)] truncate">
                    {entry.query.length > 80 ? entry.query.slice(0, 80) + '...' : entry.query}
                  </div>
                  {entry.error && (
                    <div className="text-xs text-red-400 mt-1 truncate">{entry.error}</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
