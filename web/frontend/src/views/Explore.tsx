import { useState, useEffect, useMemo, useCallback, useRef, type ChangeEvent } from 'react'
import { Sparkles, X, Copy, Play, Maximize2, Skull, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { fmtBytes, fmtNum, fmtDuration, cn } from '../lib/utils'
import { Card } from '../components/Card'
import { HistoryChart } from '../components/HistoryChart'
import { DataTable } from '../components/DataTable'
import type {
  QueryPattern,
  QueryPatternV2,
  QuerySample,
  QueryUser,
  PatternOverviewResponse,
  HistoryFailure,
  HistoryMerge,
  HistoryInsert,
  HistoryS3,
  HistoryAsyncMetric,
  S3Stats,
  PartsAgeEntry,
} from '../types/api'
import type { AnalyzeOptions } from '../hooks/useAIAnalysis'

type Tab =
  | 'patterns'
  | 'samples'
  | 'live'
  | 'users'
  | 'failures'
  | 'merges'
  | 'mvs'
  | 's3'
  | 'inserts'
  | 'metrics'
  | 'diskio'
  | 'partsage'

const TABS: { key: Tab; label: string }[] = [
  { key: 'patterns', label: 'Query Patterns' },
  { key: 'samples', label: 'Samples' },
  { key: 'live', label: 'Live Queries' },
  { key: 'users', label: 'Users' },
  { key: 'failures', label: 'Failures' },
  { key: 'merges', label: 'Merges & Parts' },
  { key: 'partsage', label: 'Parts Age' },
  { key: 'mvs', label: 'MV Performance' },
  { key: 's3', label: 'S3 Latency' },
  { key: 'inserts', label: 'Insert Throughput' },
  { key: 'metrics', label: 'System Metrics' },
  { key: 'diskio', label: 'Disk I/O' },
]

const C = {
  blue: '#3b82f6',
  green: '#22c55e',
  yellow: '#eab308',
  red: '#ef4444',
  purple: '#a855f7',
  cyan: '#06b6d4',
  orange: '#f97316',
  pink: '#ec4899',
}

/* ── shared props every tab receives ─────────────────────────────────────── */

interface TabProps {
  instance: string
  from: number
  to: number
  refreshKey?: number
  onAnalyze: (label: string, data: Record<string, any>, options: AnalyzeOptions) => void
  onShowQuery: (query: string) => void
}

/* ── QueryModal ──────────────────────────────────────────────────────────── */

function QueryModal({
  query,
  instance,
  onClose,
}: {
  query: string
  instance: string
  onClose: () => void
}) {
  const { navToTerminal } = useStore()

  const handleCopy = () => navigator.clipboard.writeText(query).catch(() => {})
  const handleRun = () => { navToTerminal(query, instance); onClose() }

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-3xl bg-[var(--card)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0">
          <span className="text-sm font-semibold">Full Query</span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs text-[var(--dim)] hover:text-[var(--fg)] hover:border-[var(--accent)] transition-colors"
            >
              <Copy size={12} />
              Copy
            </button>
            <button
              onClick={handleRun}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs font-medium hover:opacity-90 transition-opacity"
            >
              <Play size={12} />
              Run in Terminal
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--surface)] transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        {/* Query body */}
        <div className="flex-1 overflow-auto p-4">
          <pre className="font-mono text-sm text-[var(--fg)] whitespace-pre-wrap break-all leading-relaxed">
            {query}
          </pre>
        </div>
      </div>
    </div>
  )
}

/* ── small helper: "Analyze Tab" button ─────────────────────────────────── */

function AnalyzeTabBtn({
  label,
  data,
  tab,
  onAnalyze,
  disabled,
}: {
  label: string
  data: Record<string, any>
  tab: Tab
  onAnalyze: TabProps['onAnalyze']
  disabled?: boolean
}) {
  return (
    <button
      onClick={() =>
        onAnalyze(label, data, { contextType: 'tab', tab })
      }
      disabled={disabled}
      className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium text-purple-400 hover:bg-purple-500/15 border border-transparent hover:border-purple-500/20 transition-colors disabled:opacity-30"
      title={`Analyze ${label} with AI`}
    >
      <Sparkles size={11} />
      Analyze tab
    </button>
  )
}

/* ------------------------------------------------------------------ */
/*  Query Patterns Tab                                                 */
/* ------------------------------------------------------------------ */

const SORT_OPTIONS = [
  { value: 'total_ms', label: 'Total Time' },
  { value: 'cnt', label: 'Executions' },
  { value: 'avg_ms', label: 'Avg Duration' },
  { value: 'max_ms', label: 'Max Duration' },
  { value: 'p95_ms', label: 'P95' },
  { value: 'failures', label: 'Failures' },
]

interface QueryPatternsTabProps extends TabProps {
  onDrillHash?: (hash: string, user?: string) => void
}

function QueryPatternsTab({ instance, from, to, refreshKey, onAnalyze, onShowQuery, onDrillHash }: QueryPatternsTabProps) {
  const [patterns, setPatterns] = useState<QueryPatternV2[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<Record<string, any>[]>([])
  const [tlLoading, setTlLoading] = useState(false)
  const [sortBy, setSortBy] = useState<string>('total_ms')
  const [overview, setOverview] = useState<PatternOverviewResponse | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    setSelectedHash(null)
    Promise.all([
      api.history.queryPatternsV2(instance, from, to, 50, sortBy),
      api.history.queryPatternOverview(instance, from, to, 8).catch(() => null),
    ])
      .then(([d, ov]) => {
        if (!c) {
          setPatterns(d)
          setOverview(ov)
        }
      })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to, refreshKey, sortBy])

  useEffect(() => {
    if (!selectedHash) return
    let c = false
    setTlLoading(true)
    api.history.queryPatternTimeline(instance, selectedHash, from, to)
      .then(d => { if (!c) setTimeline(Array.isArray(d) ? d : []) })
      .catch(() => { if (!c) setTimeline([]) })
      .finally(() => { if (!c) setTlLoading(false) })
    return () => { c = true }
  }, [instance, selectedHash, from, to])

  // Stacked bar overview — must be before any early returns (Rules of Hooks).
  const overviewChart = useMemo(() => {
    if (!overview || !overview.timeline?.length) return null
    const COLORS = ['#3b82f6','#22c55e','#f59e0b','#ef4444','#a855f7','#06b6d4','#f97316','#ec4899']
    const hashColors: Record<string, string> = {}
    overview.patterns.forEach((p, i) => {
      hashColors[p.normalized_query_hash] = COLORS[i % COLORS.length]
    })
    const allTs = [...new Set(overview.timeline.map(r => r.ts))].sort()
    const bars = allTs.map(ts => {
      const slices = overview.timeline.filter(r => r.ts === ts)
      const total = slices.reduce((s, r) => s + (Number(r.total_ms) || 0), 0)
      return { ts, slices, total }
    })
    const maxTotal = Math.max(...bars.map(b => b.total), 1)
    return { bars, maxTotal, hashColors }
  }, [overview])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  // Compute max total_ms for bar widths.
  const maxTotalMs = patterns.reduce((m, p) => Math.max(m, p.total_ms || 0), 1)

  const columns: any[] = [
    {
      key: 'normalized_query_hash',
      label: 'Hash',
      format: (v: any) => (
        <span className="font-mono text-xs text-[var(--accent)]">{String(v).slice(0, 12)}</span>
      ),
    },
    { key: 'cnt', label: 'Execs', format: (v: any) => fmtNum(v) },
    { key: 'kind', label: 'Kind' },
    {
      key: 'total_ms',
      label: 'Total Time',
      format: (v: any, row: any) => (
        <span className="flex items-center gap-2 min-w-[100px]">
          <span className="tabular-nums">{fmtDuration(v)}</span>
          <span
            className="h-1.5 rounded-full bg-[var(--accent)] opacity-70 shrink-0"
            style={{ width: `${Math.max(4, ((row.total_ms || 0) / maxTotalMs) * 64)}px` }}
          />
        </span>
      ),
    },
    { key: 'avg_ms', label: 'Avg ms', format: (v: any) => fmtDuration(v) },
    { key: 'p95_ms', label: 'P95 ms', format: (v: any) => fmtDuration(v) },
    { key: 'avg_memory', label: 'Avg Mem', format: (v: any) => fmtBytes(v) },
    { key: 'failures', label: 'Fails', format: (v: any) => (
      <span className={Number(v) > 0 ? 'text-red-400 font-semibold' : ''}>{fmtNum(v)}</span>
    )},
    {
      key: 'sample_query',
      label: 'Sample Query',
      format: (v: any) => {
        const q = String(v ?? '')
        return (
          <span className="flex items-center gap-1.5 group/q min-w-0">
            <span className="text-[var(--dim)] text-xs font-mono truncate">
              {q.length > 60 ? q.slice(0, 60) + '…' : q}
            </span>
            {q && (
              <button
                onClick={(e) => { e.stopPropagation(); onShowQuery(q) }}
                className="shrink-0 p-0.5 rounded text-[var(--dim)] hover:text-[var(--accent)] hover:bg-[var(--hover)] opacity-60 group-hover/q:opacity-100 transition-all"
                title="View full query"
              >
                <Maximize2 size={11} />
              </button>
            )}
          </span>
        )
      },
    },
    ...(onDrillHash ? [{
      key: '_drill',
      label: '',
      format: (_v: any, row: any) => (
        <button
          onClick={(e: any) => { e.stopPropagation(); onDrillHash(String(row.normalized_query_hash)) }}
          className="text-xs text-[var(--accent)] hover:underline whitespace-nowrap"
        >
          Samples →
        </button>
      ),
    }] : []),
  ]

  return (
    <div className="space-y-4">
      {/* Stacked bar overview */}
      {overviewChart && overviewChart.bars.length > 0 && (
        <Card>
          <div className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider mb-3">
            Query Load by Pattern (Total CPU ms)
          </div>
          <div className="flex items-end gap-px h-20 overflow-hidden">
            {overviewChart.bars.map((bar, i) => (
              <div key={i} className="flex-1 flex flex-col justify-end" title={bar.ts}>
                {bar.slices.map((s, j) => {
                  const pct = (Number(s.total_ms) / overviewChart.maxTotal) * 100
                  const color = overviewChart.hashColors[String(s.normalized_query_hash)] ?? '#6b7280'
                  return <div key={j} style={{ height: `${pct}%`, background: color }} className="min-h-[1px]" />
                })}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
            {overview!.patterns.map((p, i) => {
              const color = overviewChart.hashColors[p.normalized_query_hash] ?? '#6b7280'
              return (
                <span key={i} className="flex items-center gap-1 text-xs text-[var(--dim)]">
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: color }} />
                  <span className="font-mono">{String(p.normalized_query_hash).slice(0, 10)}</span>
                  <span className="opacity-60 truncate max-w-[120px]">{String(p.label).slice(0, 30)}</span>
                </span>
              )
            })}
          </div>
        </Card>
      )}

      <Card>
        <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
          <span className="text-xs text-[var(--dim)] uppercase tracking-wider font-medium">
            {patterns.length} patterns
          </span>
          <div className="flex items-center gap-2">
            <label className="text-xs text-[var(--dim)]">Sort by</label>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value)}
              className="rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs text-[var(--fg)] focus:outline-none"
            >
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <AnalyzeTabBtn
              label="Query Patterns"
              data={{ patterns }}
              tab="patterns"
              onAnalyze={onAnalyze}
              disabled={patterns.length === 0}
            />
          </div>
        </div>
        <DataTable
          columns={columns}
          data={patterns}
          onRowClick={r => setSelectedHash(String(r.normalized_query_hash))}
          onRowAnalyze={row =>
            onAnalyze(
              `Query: ${String(row.normalized_query_hash).slice(0, 12)}`,
              { row, allPatterns: patterns },
              { contextType: 'row', tab: 'patterns', elementId: String(row.normalized_query_hash) },
            )
          }
          emptyText="No query patterns found"
        />
      </Card>
      {selectedHash && (
        <div className="mt-4">
          {tlLoading
            ? <div className="text-sm text-[var(--dim)] p-4">Loading timeline for {selectedHash.slice(0, 12)}…</div>
            : timeline.length === 0
              ? <div className="text-sm text-[var(--dim)] p-4 bg-[var(--surface)] border border-[var(--border)] rounded-xl">No timeline data for hash {selectedHash.slice(0, 12)} in selected time range.</div>
              : <HistoryChart
                  title={`Timeline: ${selectedHash.slice(0, 12)}`}
                  data={timeline}
                  series={[
                    { key: 'cnt', label: 'Count', color: C.blue },
                    { key: 'avg_ms', label: 'Avg ms', color: C.yellow },
                  ]}
                  onAnalyze={(data, series, title) =>
                    onAnalyze(title, { data, series }, { contextType: 'chart', tab: 'patterns' })
                  }
                />
          }
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Samples Tab                                                        */
/* ------------------------------------------------------------------ */

interface SamplesTabProps extends TabProps {
  initialHash?: string
  initialUser?: string
  onClearDrill?: () => void
}

function SamplesTab({ instance, from, to, refreshKey, onShowQuery, initialHash, initialUser, onClearDrill }: SamplesTabProps) {
  const [samples, setSamples] = useState<QuerySample[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hashFilter, setHashFilter] = useState(initialHash ?? '')
  const [userFilter, setUserFilter] = useState(initialUser ?? '')
  const [kindFilter, setKindFilter] = useState('')
  const [minMs, setMinMs] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  // When initial drill context changes, update filters.
  useEffect(() => { setHashFilter(initialHash ?? '') }, [initialHash])
  useEffect(() => { setUserFilter(initialUser ?? '') }, [initialUser])

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.querySamples(instance, from, to, {
      hash: hashFilter || undefined,
      user: userFilter || undefined,
      kind: kindFilter || undefined,
      minMs: minMs || undefined,
      limit: 200,
    })
      .then(d => { if (!c) setSamples(d) })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to, refreshKey, hashFilter, userFilter, kindFilter, minMs])

  const toggleExpand = (i: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  const durationColor = (ms: number) => {
    if (ms > 30000) return 'text-red-400'
    if (ms > 5000) return 'text-orange-400'
    if (ms > 1000) return 'text-yellow-400'
    return 'text-[var(--fg)]'
  }

  return (
    <div className="space-y-3">
      {/* Filters */}
      <Card>
        <div className="flex flex-wrap gap-2 items-end">
          {(hashFilter || userFilter) && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-[var(--accent)]/15 border border-[var(--accent)]/30 text-xs text-[var(--accent)]">
              {hashFilter && <span>hash: {hashFilter.slice(0, 12)}</span>}
              {userFilter && <span>user: {userFilter}</span>}
              <button
                onClick={() => { setHashFilter(''); setUserFilter(''); onClearDrill?.() }}
                className="ml-1 hover:text-[var(--fg)]"
              >
                <X size={10} />
              </button>
            </div>
          )}
          <div className="flex items-center gap-1">
            <label className="text-xs text-[var(--dim)]">User</label>
            <input
              value={userFilter}
              onChange={e => setUserFilter(e.target.value)}
              className="rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs w-28 focus:outline-none"
              placeholder="filter user…"
            />
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs text-[var(--dim)]">Kind</label>
            <select
              value={kindFilter}
              onChange={e => setKindFilter(e.target.value)}
              className="rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs focus:outline-none"
            >
              <option value="">All</option>
              <option value="Select">Select</option>
              <option value="Insert">Insert</option>
            </select>
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs text-[var(--dim)]">Min ms</label>
            <input
              value={minMs}
              onChange={e => setMinMs(e.target.value.replace(/\D/g, ''))}
              className="rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs w-20 focus:outline-none"
              placeholder="0"
            />
          </div>
          <span className="ml-auto text-xs text-[var(--dim)]">{samples.length} rows</span>
        </div>
      </Card>

      {loading && <LoadingSkeleton />}
      {!loading && error && <ErrorBox message={error} />}
      {!loading && !error && (
        <div className="space-y-1">
          {samples.length === 0 && (
            <div className="text-sm text-[var(--dim)] text-center py-10">No samples found</div>
          )}
          {samples.map((s, i) => {
            const isOpen = expanded.has(i)
            return (
              <div key={i} className="rounded-lg border border-[var(--border)] bg-[var(--card)] overflow-hidden">
                <button
                  onClick={() => toggleExpand(i)}
                  className="w-full flex items-center gap-3 px-3 py-2 hover:bg-[var(--hover)] transition-colors text-left"
                >
                  {isOpen ? <ChevronDown size={13} className="shrink-0 text-[var(--dim)]" /> : <ChevronRight size={13} className="shrink-0 text-[var(--dim)]" />}
                  <span className="text-xs text-[var(--dim)] tabular-nums w-36 shrink-0">
                    {String(s.event_time).slice(0, 19)}
                  </span>
                  <span className={cn('text-xs font-semibold tabular-nums w-20 shrink-0', durationColor(s.query_duration_ms))}>
                    {fmtDuration(s.query_duration_ms)}
                  </span>
                  <span className="text-xs text-[var(--dim)] w-20 shrink-0">{s.user}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--dim)] w-16 text-center shrink-0">
                    {s.query_kind || '—'}
                  </span>
                  {s.is_exception === 1 && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20 shrink-0">
                      error
                    </span>
                  )}
                  <span className="text-xs text-[var(--dim)] font-mono truncate">
                    {String(s.query_text ?? '').slice(0, 80)}
                  </span>
                </button>
                {isOpen && (
                  <div className="border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3 space-y-3">
                    {/* Stats row */}
                    <div className="flex flex-wrap gap-4 text-xs">
                      <span><span className="text-[var(--dim)]">Read rows:</span> {fmtNum(s.read_rows)}</span>
                      <span><span className="text-[var(--dim)]">Read bytes:</span> {fmtBytes(s.read_bytes)}</span>
                      <span><span className="text-[var(--dim)]">Memory:</span> {fmtBytes(s.memory_usage)}</span>
                      <span><span className="text-[var(--dim)]">Result rows:</span> {fmtNum(s.result_rows)}</span>
                      <span><span className="text-[var(--dim)]">Client:</span> {s.client_name || '—'}</span>
                      <span><span className="text-[var(--dim)]">Hash:</span>
                        <span className="font-mono ml-1">{String(s.normalized_query_hash).slice(0, 16)}</span>
                      </span>
                    </div>
                    {/* Query text */}
                    <div className="relative">
                      <pre className="text-xs font-mono text-[var(--fg)] whitespace-pre-wrap break-all leading-relaxed max-h-48 overflow-y-auto bg-[var(--card)] border border-[var(--border)] rounded p-2">
                        {s.query_text}
                      </pre>
                      <button
                        onClick={() => onShowQuery(s.query_text)}
                        className="absolute top-1.5 right-1.5 p-1 rounded text-[var(--dim)] hover:text-[var(--accent)] bg-[var(--card)]"
                        title="Full query"
                      >
                        <Maximize2 size={11} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Live Queries Tab                                                   */
/* ------------------------------------------------------------------ */

function LiveTab({ instance, onShowQuery }: { instance: string; onShowQuery: (q: string) => void }) {
  const [rows, setRows] = useState<Record<string, any>[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [killTarget, setKillTarget] = useState<string | null>(null)
  const [killing, setKilling] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(() => {
    api.queries(instance)
      .then(d => { setRows(Array.isArray(d) ? d : []); setError(null) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [instance])

  useEffect(() => {
    setLoading(true)
    load()
    intervalRef.current = setInterval(load, 5000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [load])

  const handleKill = async () => {
    if (!killTarget) return
    setKilling(true)
    try {
      await api.killQuery(instance, killTarget)
      setKillTarget(null)
      load()
    } catch (e: any) {
      alert(`Kill failed: ${e.message}`)
    } finally {
      setKilling(false)
    }
  }

  const elapsed = (v: any) => {
    const s = Number(v) || 0
    if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
    if (s >= 60) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
    return `${s.toFixed(1)}s`
  }

  const elapsedColor = (v: any) => {
    const s = Number(v) || 0
    if (s > 300) return 'text-red-400 font-semibold'
    if (s > 60) return 'text-orange-400'
    if (s > 10) return 'text-yellow-400'
    return 'text-[var(--fg)]'
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--dim)]">Auto-refreshes every 5s • {rows.length} running</span>
        <button onClick={load} className="flex items-center gap-1 text-xs text-[var(--dim)] hover:text-[var(--fg)] transition-colors">
          <RefreshCw size={12} />
          Refresh
        </button>
      </div>

      {loading && <LoadingSkeleton />}
      {!loading && error && <ErrorBox message={error} />}
      {!loading && !error && rows.length === 0 && (
        <Card>
          <div className="text-sm text-[var(--dim)] text-center py-8">No running queries</div>
        </Card>
      )}
      {!loading && !error && rows.length > 0 && (
        <div className="space-y-1">
          {rows.map((r, i) => {
            const qid = String(r.query_id ?? '')
            const q = String(r.query_short ?? r.query ?? '')
            return (
              <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--card)] hover:bg-[var(--hover)] transition-colors group">
                <span className={cn('text-xs tabular-nums w-14 shrink-0', elapsedColor(r.elapsed))}>
                  {elapsed(r.elapsed)}
                </span>
                <span className="text-xs text-[var(--dim)] w-24 shrink-0 truncate">{r.user}</span>
                <span className="text-xs font-mono text-[var(--fg)] truncate flex-1">{q.slice(0, 100)}</span>
                <span className="text-xs text-[var(--dim)] w-20 text-right shrink-0">{r.memory ?? r.memory_usage ?? ''}</span>
                <button
                  onClick={() => onShowQuery(q)}
                  className="shrink-0 p-1 rounded text-[var(--dim)] hover:text-[var(--accent)] opacity-0 group-hover:opacity-100 transition-all"
                  title="View query"
                >
                  <Maximize2 size={12} />
                </button>
                <button
                  onClick={() => setKillTarget(qid)}
                  className="shrink-0 p-1 rounded text-[var(--dim)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                  title="Kill query"
                >
                  <Skull size={12} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Kill confirm dialog */}
      {killTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-[var(--card)] border border-[var(--border)] rounded-xl shadow-2xl p-5 space-y-4">
            <div className="text-sm font-semibold text-[var(--fg)]">Kill Query?</div>
            <p className="text-sm text-[var(--dim)]">
              Send KILL QUERY for <span className="font-mono text-xs text-[var(--fg)]">{killTarget.slice(0, 24)}…</span>
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setKillTarget(null)}
                className="px-3 py-1.5 text-sm rounded-lg border border-[var(--border)] text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleKill}
                disabled={killing}
                className="px-3 py-1.5 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
              >
                {killing ? 'Killing…' : 'Kill Query'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Users Tab                                                          */
/* ------------------------------------------------------------------ */

interface UsersTabProps extends TabProps {
  onDrillUser?: (user: string) => void
}

function UsersTab({ instance, from, to, refreshKey, onDrillUser }: UsersTabProps) {
  const [users, setUsers] = useState<QueryUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.queryUsers(instance, from, to)
      .then(d => { if (!c) setUsers(d) })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to, refreshKey])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  const maxTotalMs = users.reduce((m, u) => Math.max(m, u.total_ms || 0), 1)

  return (
    <div className="space-y-3">
      <Card>
        <div className="text-xs text-[var(--dim)] uppercase tracking-wider font-medium mb-3">
          {users.length} users — sorted by total CPU time
        </div>
        {users.length === 0 && (
          <div className="text-sm text-[var(--dim)] text-center py-8">No data in range</div>
        )}
        <div className="space-y-1.5">
          {users.map((u, i) => {
            const barW = Math.max(4, (u.total_ms / maxTotalMs) * 180)
            return (
              <div
                key={i}
                onClick={() => onDrillUser?.(u.user)}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg border border-[var(--border)] hover:bg-[var(--hover)] transition-colors',
                  onDrillUser && 'cursor-pointer',
                )}
              >
                <span className="text-sm font-medium w-32 shrink-0 truncate">{u.user || '(unknown)'}</span>
                <div className="flex-1 flex items-center gap-2">
                  <div
                    className="h-2 rounded-full bg-[var(--accent)] opacity-80"
                    style={{ width: `${barW}px` }}
                  />
                  <span className="text-xs tabular-nums text-[var(--dim)]">{fmtDuration(u.total_ms)}</span>
                </div>
                <div className="flex gap-4 text-xs text-[var(--dim)] shrink-0">
                  <span><span className="text-[var(--fg)]">{fmtNum(u.cnt)}</span> execs</span>
                  <span>avg <span className="text-[var(--fg)]">{fmtDuration(u.avg_ms)}</span></span>
                  <span>p95 <span className="text-[var(--fg)]">{fmtDuration(u.p95_ms)}</span></span>
                  {u.failures > 0 && (
                    <span className="text-red-400">{fmtNum(u.failures)} fails</span>
                  )}
                </div>
                {onDrillUser && (
                  <span className="text-xs text-[var(--accent)] opacity-0 group-hover:opacity-100 shrink-0">
                    →
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Failures Tab                                                       */
/* ------------------------------------------------------------------ */

function FailuresTab({ instance, from, to, refreshKey, onAnalyze }: TabProps) {
  const [data, setData] = useState<HistoryFailure[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.failures(instance, from, to)
      .then(d => { if (!c) setData(d) })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to, refreshKey])

  const byTs = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of data) map.set(r.ts, (map.get(r.ts) ?? 0) + r.cnt)
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([ts, cnt]) => ({ ts, cnt }))
  }, [data])

  const byCode = useMemo(() => {
    const map = new Map<number, { count: number; sample: string }>()
    for (const r of data) {
      const prev = map.get(r.exception_code)
      if (prev) { prev.count += r.cnt } else { map.set(r.exception_code, { count: r.cnt, sample: r.sample }) }
    }
    return [...map.entries()].map(([code, v]) => ({ exception_code: code, count: v.count, sample: v.sample })).sort((a, b) => b.count - a.count)
  }, [data])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  return (
    <div className="space-y-4">
      <HistoryChart
        title="Failures Over Time"
        data={byTs}
        series={[{ key: 'cnt', label: 'Count', color: C.red }]}
        onAnalyze={(d, s, title) =>
          onAnalyze(title, { data: d, series: s }, { contextType: 'chart', tab: 'failures' })
        }
      />
      <Card>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider">By Exception Code</div>
          <AnalyzeTabBtn
            label="Failures"
            data={{ byCode, byTs }}
            tab="failures"
            onAnalyze={onAnalyze}
            disabled={byCode.length === 0}
          />
        </div>
        <DataTable
          columns={[
            { key: 'exception_code', label: 'Code' },
            { key: 'count', label: 'Count', format: (v: any) => fmtNum(v) },
            {
              key: 'sample',
              label: 'Sample',
              format: (v: any) => (
                <span className="text-[var(--dim)]">
                  {String(v ?? '').length > 120 ? String(v).slice(0, 120) + '…' : String(v ?? '')}
                </span>
              ),
            },
          ]}
          data={byCode}
          onRowAnalyze={row =>
            onAnalyze(
              `Error code ${row.exception_code}`,
              { row, allErrors: byCode },
              { contextType: 'row', tab: 'failures', elementId: String(row.exception_code) },
            )
          }
          emptyText="No failures"
        />
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Merges & Parts Tab                                                 */
/* ------------------------------------------------------------------ */

function MergesTab({ instance, from, to, refreshKey, onAnalyze }: TabProps) {
  const [data, setData] = useState<HistoryMerge[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.merges(instance, from, to)
      .then(d => { if (!c) setData(d) })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to, refreshKey])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <AnalyzeTabBtn
          label="Merges & Parts"
          data={{ data }}
          tab="merges"
          onAnalyze={onAnalyze}
          disabled={data.length === 0}
        />
      </div>
      <HistoryChart
        title="Merges & Parts"
        data={data}
        series={[
          { key: 'merge_count', label: 'Merge Count', color: C.blue },
          { key: 'new_part_count', label: 'New Parts', color: C.green },
          { key: 'remove_count', label: 'Removed', color: C.red },
        ]}
        onAnalyze={(d, s, title) =>
          onAnalyze(title, { data: d, series: s }, { contextType: 'chart', tab: 'merges' })
        }
      />
      <HistoryChart
        title="Average Merge Duration"
        data={data}
        series={[{ key: 'avg_merge_ms', label: 'Avg Merge ms', color: C.orange }]}
        yFormat="ms"
        onAnalyze={(d, s, title) =>
          onAnalyze(title, { data: d, series: s }, { contextType: 'chart', tab: 'merges' })
        }
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  MV Performance Tab                                                 */
/* ------------------------------------------------------------------ */

function MVTab({ instance, from, to, refreshKey, onAnalyze }: TabProps) {
  const [data, setData] = useState<Record<string, any>[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedView, setSelectedView] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    setSelectedView(null)
    api.history.mvs(instance, from, to)
      .then(d => { if (!c) setData(d) })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to, refreshKey])

  const aggregated = useMemo(() => {
    const map = new Map<string, { cnt: number; sumAvg: number; maxMax: number; failures: number; n: number }>()
    for (const r of data) {
      const name = r.view_name ?? r.target_name ?? 'unknown'
      const prev = map.get(name) ?? { cnt: 0, sumAvg: 0, maxMax: 0, failures: 0, n: 0 }
      prev.cnt += Number(r.cnt ?? 0)
      prev.sumAvg += Number(r.avg_ms ?? 0)
      prev.maxMax = Math.max(prev.maxMax, Number(r.max_ms ?? 0))
      prev.failures += Number(r.failures ?? 0)
      prev.n += 1
      map.set(name, prev)
    }
    return [...map.entries()].map(([name, v]) => ({
      view_name: name, cnt: v.cnt, avg_ms: v.n > 0 ? v.sumAvg / v.n : 0, max_ms: v.maxMax, failures: v.failures,
    })).sort((a, b) => b.cnt - a.cnt)
  }, [data])

  const selectedData = useMemo(() => {
    if (!selectedView) return []
    return data.filter(r => (r.view_name ?? r.target_name) === selectedView).sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  }, [data, selectedView])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[var(--dim)] uppercase tracking-wider font-medium">
            {aggregated.length} views
          </span>
          <AnalyzeTabBtn
            label="MV Performance"
            data={{ views: aggregated }}
            tab="mvs"
            onAnalyze={onAnalyze}
            disabled={aggregated.length === 0}
          />
        </div>
        <DataTable
          columns={[
            { key: 'view_name', label: 'View Name' },
            { key: 'cnt', label: 'Count', format: (v: any) => fmtNum(v) },
            { key: 'avg_ms', label: 'Avg ms', format: (v: any) => fmtDuration(v) },
            { key: 'max_ms', label: 'Max ms', format: (v: any) => fmtDuration(v) },
            { key: 'failures', label: 'Failures', format: (v: any) => fmtNum(v) },
          ]}
          data={aggregated}
          onRowClick={r => setSelectedView(r.view_name)}
          onRowAnalyze={row =>
            onAnalyze(
              `MV: ${row.view_name}`,
              { row, allViews: aggregated },
              { contextType: 'row', tab: 'mvs', elementId: String(row.view_name) },
            )
          }
          emptyText="No materialized view data"
        />
      </Card>
      {selectedView && selectedData.length > 0 && (
        <HistoryChart
          title={`MV: ${selectedView}`}
          data={selectedData}
          series={[{ key: 'avg_ms', label: 'Avg ms', color: C.purple }]}
          yFormat="ms"
          onAnalyze={(d, s, title) =>
            onAnalyze(title, { data: d, series: s }, { contextType: 'chart', tab: 'mvs' })
          }
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  S3 Latency Tab                                                     */
/* ------------------------------------------------------------------ */

function S3Tab({ instance, from, to, refreshKey, onAnalyze, onShowQuery }: TabProps) {
  const [history, setHistory] = useState<HistoryS3[]>([])
  const [stats, setStats] = useState<S3Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    Promise.all([api.history.s3(instance, from, to), api.s3Stats(instance)])
      .then(([h, s]) => { if (!c) { setHistory(h); setStats(s) } })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to, refreshKey])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <AnalyzeTabBtn
          label="S3 Latency"
          data={{ history, latencyByQuery: stats?.latency_by_query, latencyByTable: stats?.latency_by_table }}
          tab="s3"
          onAnalyze={onAnalyze}
          disabled={history.length === 0}
        />
      </div>
      <HistoryChart
        title="S3 Latency & Requests"
        data={history}
        series={[
          { key: 'avg_latency_ms', label: 'Avg Latency ms', color: C.blue },
          { key: 'total_s3_requests', label: 'Total Requests', color: C.green },
        ]}
        onAnalyze={(d, s, title) =>
          onAnalyze(title, { data: d, series: s }, { contextType: 'chart', tab: 's3' })
        }
      />
      {stats?.latency_by_query && stats.latency_by_query.length > 0 && (
        <Card>
          <div className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider mb-2">S3 Latency by Query</div>
          <DataTable
            columns={[
              { key: 'normalized_query_hash', label: 'Hash', format: (v: any) => String(v ?? '').slice(0, 12) },
              { key: 'cnt', label: 'Count', format: (v: any) => fmtNum(v) },
              { key: 'avg_latency_ms', label: 'Avg ms', format: (v: any) => fmtDuration(Number(v ?? 0)) },
              { key: 'max_latency_ms', label: 'Max ms', format: (v: any) => fmtDuration(Number(v ?? 0)) },
              {
                key: 'sample_query', label: 'Sample',
                format: (v: any) => {
                  const q = String(v ?? '')
                  return (
                    <span className="flex items-center gap-1.5 group/q min-w-0">
                      <span className="text-[var(--dim)] text-xs font-mono truncate">
                        {q.length > 60 ? q.slice(0, 60) + '…' : q}
                      </span>
                      {q && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onShowQuery(q) }}
                          className="shrink-0 p-0.5 rounded text-[var(--dim)] hover:text-[var(--accent)] hover:bg-[var(--hover)] opacity-60 group-hover/q:opacity-100 transition-all"
                          title="View full query"
                        >
                          <Maximize2 size={11} />
                        </button>
                      )}
                    </span>
                  )
                },
              },
            ]}
            data={stats.latency_by_query}
            onRowAnalyze={row =>
              onAnalyze(
                `S3 query ${String(row.normalized_query_hash).slice(0, 12)}`,
                { row, allQueries: stats.latency_by_query },
                { contextType: 'row', tab: 's3', elementId: String(row.normalized_query_hash) },
              )
            }
            emptyText="No query data"
          />
        </Card>
      )}
      {stats?.latency_by_table && stats.latency_by_table.length > 0 && (
        <Card>
          <div className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider mb-2">S3 Latency by Table</div>
          <DataTable
            columns={[
              { key: 'table_name', label: 'Table' },
              { key: 'queries', label: 'Queries', format: (v: any) => fmtNum(v) },
              { key: 'avg_latency_ms', label: 'Avg ms', format: (v: any) => fmtDuration(Number(v ?? 0)) },
              { key: 'total_requests', label: 'Total Requests', format: (v: any) => fmtNum(v) },
            ]}
            data={stats.latency_by_table}
            emptyText="No table data"
          />
        </Card>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Insert Throughput Tab                                              */
/* ------------------------------------------------------------------ */

function InsertsTab({ instance, from, to, refreshKey, onAnalyze }: TabProps) {
  const [data, setData] = useState<HistoryInsert[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.inserts(instance, from, to)
      .then(d => { if (!c) setData(d) })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to, refreshKey])

  const byTs = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of data) map.set(r.ts, (map.get(r.ts) ?? 0) + r.total_rows)
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([ts, total_rows]) => ({ ts, total_rows }))
  }, [data])

  const byTable = useMemo(() => {
    const map = new Map<string, { insert_count: number; total_rows: number; total_bytes: number; small_insert_count: number }>()
    for (const r of data) {
      const key = `${r.database}.${r.table}`
      const prev = map.get(key) ?? { insert_count: 0, total_rows: 0, total_bytes: 0, small_insert_count: 0 }
      prev.insert_count += r.insert_count
      prev.total_rows += r.total_rows
      prev.total_bytes += r.total_bytes
      prev.small_insert_count += r.small_insert_count
      map.set(key, prev)
    }
    return [...map.entries()].map(([table, v]) => ({ table, ...v })).sort((a, b) => b.total_rows - a.total_rows)
  }, [data])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  return (
    <div className="space-y-4">
      <HistoryChart
        title="Insert Throughput (Rows)"
        data={byTs}
        series={[{ key: 'total_rows', label: 'Total Rows', color: C.blue }]}
        onAnalyze={(d, s, title) =>
          onAnalyze(title, { data: d, series: s }, { contextType: 'chart', tab: 'inserts' })
        }
      />
      <Card>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider">By Table</div>
          <AnalyzeTabBtn
            label="Insert Throughput"
            data={{ byTable, byTs }}
            tab="inserts"
            onAnalyze={onAnalyze}
            disabled={byTable.length === 0}
          />
        </div>
        <DataTable
          columns={[
            { key: 'table', label: 'Table' },
            { key: 'insert_count', label: 'Inserts', format: (v: any) => fmtNum(v) },
            { key: 'total_rows', label: 'Total Rows', format: (v: any) => fmtNum(v) },
            { key: 'total_bytes', label: 'Total Bytes', format: (v: any) => fmtBytes(v) },
            { key: 'small_insert_count', label: 'Small Inserts', format: (v: any) => fmtNum(v) },
          ]}
          data={byTable}
          onRowAnalyze={row =>
            onAnalyze(
              `Inserts: ${row.table}`,
              { row, allTables: byTable },
              { contextType: 'row', tab: 'inserts', elementId: String(row.table) },
            )
          }
          emptyText="No insert data"
        />
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  System Metrics Tab                                                 */
/* ------------------------------------------------------------------ */

function SystemMetricsTab({ instance, from, to, refreshKey, onAnalyze }: TabProps) {
  const [data, setData] = useState<HistoryAsyncMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.asyncMetrics(instance, from, to, 'MemoryResident,CGroupMemoryUsed,LoadAverage1,LoadAverage5,LoadAverage15')
      .then(d => { if (!c) setData(d) })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to, refreshKey])

  const { memoryData, loadData } = useMemo(() => {
    const allTs = [...new Set(data.map(r => r.ts))].sort()
    const grouped = new Map<string, Map<string, number>>()
    for (const r of data) {
      if (!grouped.has(r.metric)) grouped.set(r.metric, new Map())
      grouped.get(r.metric)!.set(r.ts, r.avg_value)
    }
    const memoryMetrics = ['MemoryResident', 'CGroupMemoryUsed']
    const loadMetrics = ['LoadAverage1', 'LoadAverage5', 'LoadAverage15']
    const memoryData = allTs.map(ts => {
      const row: Record<string, any> = { ts }
      for (const m of memoryMetrics) row[m] = grouped.get(m)?.get(ts) ?? 0
      return row
    })
    const loadData = allTs.map(ts => {
      const row: Record<string, any> = { ts }
      for (const m of loadMetrics) row[m] = grouped.get(m)?.get(ts) ?? 0
      return row
    })
    return { memoryData, loadData }
  }, [data])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <AnalyzeTabBtn
          label="System Metrics"
          data={{ memoryData, loadData }}
          tab="metrics"
          onAnalyze={onAnalyze}
          disabled={data.length === 0}
        />
      </div>
      <HistoryChart
        title="Memory"
        data={memoryData}
        series={[
          { key: 'MemoryResident', label: 'MemoryResident', color: C.blue },
          { key: 'CGroupMemoryUsed', label: 'CGroupMemoryUsed', color: C.green },
        ]}
        yFormat="bytes"
        onAnalyze={(d, s, title) =>
          onAnalyze(title, { data: d, series: s }, { contextType: 'chart', tab: 'metrics' })
        }
      />
      <HistoryChart
        title="Load Average"
        data={loadData}
        series={[
          { key: 'LoadAverage1', label: 'LoadAverage1', color: C.blue },
          { key: 'LoadAverage5', label: 'LoadAverage5', color: C.yellow },
          { key: 'LoadAverage15', label: 'LoadAverage15', color: C.red },
        ]}
        onAnalyze={(d, s, title) =>
          onAnalyze(title, { data: d, series: s }, { contextType: 'chart', tab: 'metrics' })
        }
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Disk I/O Tab                                                       */
/* ------------------------------------------------------------------ */

function DiskIOTab({ instance, from, to, refreshKey, onAnalyze }: TabProps) {
  const [data, setData] = useState<HistoryAsyncMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.diskIO(instance, from, to)
      .then(d => { if (!c) setData(d) })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to, refreshKey])

  const pivoted = useMemo(() => {
    const allTs = [...new Set(data.map(r => r.ts))].sort()
    const readMap = new Map<string, number>()
    const writeMap = new Map<string, number>()
    for (const r of data) {
      const m = r.metric
      const target = m.includes('ReadBytes') || m.includes('Read') ? readMap : writeMap
      target.set(r.ts, (target.get(r.ts) ?? 0) + r.avg_value)
    }
    return allTs.map(ts => ({ ts, read_bytes: readMap.get(ts) ?? 0, write_bytes: writeMap.get(ts) ?? 0 }))
  }, [data])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <AnalyzeTabBtn
          label="Disk I/O"
          data={{ data: pivoted }}
          tab="diskio"
          onAnalyze={onAnalyze}
          disabled={pivoted.length === 0}
        />
      </div>
      <HistoryChart
        title="Disk I/O"
        data={pivoted}
        series={[
          { key: 'read_bytes', label: 'Read Bytes', color: C.blue },
          { key: 'write_bytes', label: 'Write Bytes', color: C.orange },
        ]}
        yFormat="bytes"
        onAnalyze={(d, s, title) =>
          onAnalyze(title, { data: d, series: s }, { contextType: 'chart', tab: 'diskio' })
        }
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

function LoadingSkeleton() {
  return (
    <Card className="animate-pulse">
      <div className="h-4 bg-[var(--border)] rounded w-1/4 mb-3" />
      <div className="h-48 bg-[var(--border)] rounded" />
    </Card>
  )
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-4 text-sm text-red-400">
      {message}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Parts Age Tab                                                      */
/* ------------------------------------------------------------------ */

function PartsAgeTab({ instance, refreshKey }: { instance: string; refreshKey?: number }) {
  const [rows, setRows] = useState<PartsAgeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    api.partsAge(instance)
      .then(data => setRows(data))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [instance, refreshKey])

  const ageColor = (hours: number) => {
    if (hours > 168) return 'text-[#ef4444]'   // >7d
    if (hours > 72)  return 'text-[#f97316]'   // >3d
    if (hours > 24)  return 'text-[#f59e0b]'   // >1d
    return 'text-[var(--text)]'
  }

  const fmtAge = (hours: number) => {
    if (hours < 24) return `${Math.round(hours)}h`
    return `${Math.round(hours / 24)}d`
  }

  if (loading) return <div className="animate-pulse h-40 rounded-lg bg-[var(--hover)]" />
  if (error) return <ErrorBox message={error} />

  if (rows.length === 0) {
    return (
      <Card>
        <div className="text-sm text-[var(--text-muted)] text-center py-8">
          No tables with stale parts found (all parts &lt; 2 days old)
        </div>
      </Card>
    )
  }

  return (
    <Card title={`Parts Age — ${rows.length} tables sorted by oldest unmerged part`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-[var(--text-muted)] border-b border-[var(--border)]">
              <th className="pb-2 pr-4 font-medium">Table</th>
              <th className="pb-2 pr-4 font-medium text-right">Parts</th>
              <th className="pb-2 pr-4 font-medium text-right">Oldest Part</th>
              <th className="pb-2 pr-4 font-medium text-right">Oldest Date</th>
              <th className="pb-2 pr-4 font-medium text-right">Rows</th>
              <th className="pb-2 font-medium text-right">Size</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-[var(--border)]/40 hover:bg-[var(--hover)] transition-colors">
                <td className="py-2 pr-4 font-mono text-xs">
                  <span className="text-[var(--text-muted)]">{r.database}.</span>
                  <span>{r.table}</span>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{fmtNum(r.part_count)}</td>
                <td className={cn('py-2 pr-4 text-right tabular-nums font-semibold', ageColor(r.oldest_part_hours))}>
                  {fmtAge(r.oldest_part_hours)}
                </td>
                <td className="py-2 pr-4 text-right text-xs text-[var(--text-muted)]">
                  {r.oldest_modification ? r.oldest_modification.slice(0, 10) : '—'}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-[var(--text-muted)]">
                  {fmtNum(r.total_rows)}
                </td>
                <td className="py-2 text-right tabular-nums text-[var(--text-muted)]">
                  {fmtBytes(r.total_bytes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex gap-4 text-xs text-[var(--text-muted)]">
        <span className="flex items-center gap-1"><span className="text-[#ef4444]">■</span> &gt;7 days</span>
        <span className="flex items-center gap-1"><span className="text-[#f97316]">■</span> &gt;3 days</span>
        <span className="flex items-center gap-1"><span className="text-[#f59e0b]">■</span> &gt;1 day</span>
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Main Explore Component                                             */
/* ------------------------------------------------------------------ */

export default function Explore({ refreshKey }: { refreshKey?: number }) {
  const { instances, selectedInstance, setSelectedInstance, setView, from, to } = useStore()
  const [tab, setTab] = useState<Tab>('patterns')
  const [queryModal, setQueryModal] = useState<string | null>(null)
  // Drill state: clicking "Samples →" in Patterns tab or a row in Users tab navigates to Samples with filter pre-set.
  const [drillHash, setDrillHash] = useState<string | undefined>()
  const [drillUser, setDrillUser] = useState<string | undefined>()
  const inst = selectedInstance || instances[0] || ''

  const { analyze } = useAIAnalysis(inst)

  const handleInstChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => setSelectedInstance(e.target.value),
    [setSelectedInstance],
  )

  const handleAnalyze = useCallback(
    (label: string, data: Record<string, any>, options: AnalyzeOptions) => {
      analyze(label, data, options)
    },
    [analyze],
  )

  const handleShowQuery = useCallback((query: string) => setQueryModal(query), [])

  const handleDrillHash = useCallback((hash: string) => {
    setDrillHash(hash)
    setDrillUser(undefined)
    setTab('samples')
  }, [])

  const handleDrillUser = useCallback((user: string) => {
    setDrillUser(user)
    setDrillHash(undefined)
    setTab('samples')
  }, [])

  const handleClearDrill = useCallback(() => {
    setDrillHash(undefined)
    setDrillUser(undefined)
  }, [])

  return (
    <div className="space-y-4">
      {/* Instance selector + global AI button */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-[var(--dim)]">Instance</label>
        <select
          value={inst}
          onChange={handleInstChange}
          className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm text-[var(--text)] focus:outline-none focus:border-[var(--accent)]"
        >
          {instances.map(i => (
            <option key={i} value={i}>{i}</option>
          ))}
        </select>
        <button
          onClick={() => setView('analyzer')}
          className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-purple-500/15 text-purple-400 hover:bg-purple-500/25 transition-colors border border-purple-500/20"
        >
          <Sparkles size={14} />
          Full Analysis
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-[var(--border)] pb-px">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'px-3 py-2 text-sm whitespace-nowrap rounded-t-md transition-colors',
              tab === t.key
                ? 'text-[var(--accent)] border-b-2 border-[var(--accent)] font-medium'
                : 'text-[var(--dim)] hover:text-[var(--text)]',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {!inst ? (
        <div className="text-sm text-[var(--dim)] text-center py-12">
          Select an instance to explore
        </div>
      ) : (
        <>
          {tab === 'patterns' && (
            <QueryPatternsTab
              instance={inst} from={from} to={to} refreshKey={refreshKey}
              onAnalyze={handleAnalyze} onShowQuery={handleShowQuery}
              onDrillHash={handleDrillHash}
            />
          )}
          {tab === 'samples' && (
            <SamplesTab
              instance={inst} from={from} to={to} refreshKey={refreshKey}
              onAnalyze={handleAnalyze} onShowQuery={handleShowQuery}
              initialHash={drillHash}
              initialUser={drillUser}
              onClearDrill={handleClearDrill}
            />
          )}
          {tab === 'live' && (
            <LiveTab instance={inst} onShowQuery={handleShowQuery} />
          )}
          {tab === 'users' && (
            <UsersTab
              instance={inst} from={from} to={to} refreshKey={refreshKey}
              onAnalyze={handleAnalyze} onShowQuery={handleShowQuery}
              onDrillUser={handleDrillUser}
            />
          )}
          {tab === 'failures' && <FailuresTab instance={inst} from={from} to={to} refreshKey={refreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
          {tab === 'merges' && <MergesTab instance={inst} from={from} to={to} refreshKey={refreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
          {tab === 'partsage' && <PartsAgeTab instance={inst} refreshKey={refreshKey} />}
          {tab === 'mvs' && <MVTab instance={inst} from={from} to={to} refreshKey={refreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
          {tab === 's3' && <S3Tab instance={inst} from={from} to={to} refreshKey={refreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
          {tab === 'inserts' && <InsertsTab instance={inst} from={from} to={to} refreshKey={refreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
          {tab === 'metrics' && <SystemMetricsTab instance={inst} from={from} to={to} refreshKey={refreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
          {tab === 'diskio' && <DiskIOTab instance={inst} from={from} to={to} refreshKey={refreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
        </>
      )}

      {/* Full-query modal */}
      {queryModal && (
        <QueryModal
          query={queryModal}
          instance={inst}
          onClose={() => setQueryModal(null)}
        />
      )}
    </div>
  )
}
