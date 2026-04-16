import { useState, useEffect, useMemo, useCallback, useRef, type ChangeEvent } from 'react'
import { Sparkles, X, Copy, Play, Maximize2, Skull, RefreshCw, ChevronDown, ChevronRight, Wrench } from 'lucide-react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  DoughnutController,
  Tooltip,
  Legend,
} from 'chart.js'
import { Bar, Doughnut } from 'react-chartjs-2'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { fmtBytes, fmtNum, fmtDuration, fmtCompact, cn, latencyBg, kindBg, tokenizeSql } from '../lib/utils'
import { Card } from '../components/Card'
import { HistoryChart } from '../components/HistoryChart'
import { DataTable } from '../components/DataTable'

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, DoughnutController, Tooltip, Legend)
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
  | 'antipatterns'

const TABS: { key: Tab; label: string }[] = [
  { key: 'antipatterns', label: '⚡ Anti-patterns' },
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

/* ── Tooltip helper ─────────────────────────────────────────────────────── */

function Tip({ children, text, side = 'top' }: { children: React.ReactNode; text: string; side?: 'top' | 'bottom' }) {
  const base = 'absolute z-50 hidden group-hover/tip:block px-2.5 py-1.5 rounded-lg text-[11px] leading-snug bg-gray-950 text-gray-100 border border-white/10 shadow-xl pointer-events-none max-w-[220px] whitespace-normal'
  const pos = side === 'top'
    ? 'bottom-full left-1/2 -translate-x-1/2 mb-2'
    : 'top-full left-1/2 -translate-x-1/2 mt-2'
  const arrow = side === 'top'
    ? 'absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-950'
    : 'absolute bottom-full left-1/2 -translate-x-1/2 border-4 border-transparent border-b-gray-950'
  return (
    <span className="relative group/tip inline-flex items-center">
      {children}
      <span className={cn(base, pos)}>
        {text}
        <span className={arrow} />
      </span>
    </span>
  )
}

/* ── SQL inline highlighter ─────────────────────────────────────────────── */

function SqlHighlight({ text, maxLen = 90 }: { text: string; maxLen?: number }) {
  const src = text.length > maxLen ? text.slice(0, maxLen) + '…' : text
  const tokens = tokenizeSql(src)
  return (
    <span className="font-mono text-xs">
      {tokens.map((tok, i) => {
        if (tok.k === 'kw') return <span key={i} className="text-[var(--syn-kw)] font-medium">{tok.t}</span>
        if (tok.k === 'fn') return <span key={i} className="text-[var(--syn-fn)]">{tok.t}</span>
        if (tok.k === 'str') return <span key={i} className="text-[var(--syn-str)]">{tok.t}</span>
        if (tok.k === 'num') return <span key={i} className="text-[var(--syn-num)]">{tok.t}</span>
        if (tok.k === 'cmt') return <span key={i} className="text-[var(--syn-cmt)] italic">{tok.t}</span>
        if (tok.k === 'op') return <span key={i} className="text-[var(--syn-op)]">{tok.t}</span>
        return <span key={i} className="text-[var(--fg)]">{tok.t}</span>
      })}
    </span>
  )
}

/* ── Stat card row ───────────────────────────────────────────────────────── */

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex-1 min-w-[120px] bg-[var(--surface)] border border-[var(--border)] rounded-xl px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-[var(--dim)] mb-1">{label}</div>
      <div className={cn('text-xl font-bold tabular-nums', color ?? 'text-[var(--fg)]')}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--dim)] mt-0.5">{sub}</div>}
    </div>
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
  onDrillFail?: (hash: string) => void
}

function QueryPatternsTab({ instance, from, to, refreshKey, onAnalyze, onShowQuery, onDrillHash, onDrillFail }: QueryPatternsTabProps) {
  const [patterns, setPatterns] = useState<QueryPatternV2[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<Record<string, any>[]>([])
  const [tlLoading, setTlLoading] = useState(false)
  const [sortBy, setSortBy] = useState<string>('total_ms')
  const [overview, setOverview] = useState<PatternOverviewResponse | null>(null)
  // Failure detail panel
  const [failHash, setFailHash] = useState<string | null>(null)
  const [failData, setFailData] = useState<{ byCode: Record<string, any>[]; byTs: Record<string, any>[] } | null>(null)
  const [failLoading, setFailLoading] = useState(false)
  const [failTimeline, setFailTimeline] = useState<Record<string, any>[]>([])

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

  useEffect(() => {
    if (!failHash) { setFailTimeline([]); return }
    let c = false
    api.history.queryPatternTimeline(instance, failHash, from, to)
      .then(d => { if (!c) setFailTimeline(Array.isArray(d) ? d : []) })
      .catch(() => { if (!c) setFailTimeline([]) })
    return () => { c = true }
  }, [instance, failHash, from, to])

  useEffect(() => {
    if (!failHash) { setFailData(null); return }
    let c = false
    setFailLoading(true)
    api.history.failures(instance, from, to, failHash)
      .then(d => {
        if (c) return
        const tl = Array.isArray(d.timeline) ? d.timeline : []
        const bc = Array.isArray(d.by_code) ? d.by_code : []
        const map = new Map<string, number>()
        for (const r of tl) map.set(r.ts, (map.get(r.ts) ?? 0) + (Number(r.cnt) || 0))
        const byTs = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([ts, cnt]) => ({ ts, cnt }))
        setFailData({ byCode: bc, byTs })
      })
      .catch(() => { if (!c) setFailData({ byCode: [], byTs: [] }) })
      .finally(() => { if (!c) setFailLoading(false) })
    return () => { c = true }
  }, [instance, failHash, from, to])

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

  // ── derived stats ──────────────────────────────────────────────────────────
  const totalExecs = patterns.reduce((s, p) => s + (p.cnt || 0), 0)
  const totalCpuMs = patterns.reduce((s, p) => s + (p.total_ms || 0), 0)
  const totalFails = patterns.reduce((s, p) => s + (p.failures || 0), 0)
  const errorRate = totalExecs > 0 ? (totalFails / totalExecs) * 100 : 0
  const maxTotalMs = patterns.reduce((m, p) => Math.max(m, p.total_ms || 0), 1)

  // ── Chart.js stacked bar data for overview ─────────────────────────────────
  const COLORS = ['#3b82f6','#22c55e','#f59e0b','#ef4444','#a855f7','#06b6d4','#f97316','#ec4899']
  const stackedChartData = (() => {
    if (!overview || !overview.timeline?.length || !overview.patterns?.length) return null
    const allTs = [...new Set(overview.timeline.map(r => r.ts))].sort()
    const fmtTs = (ts: string) => {
      const d = new Date(ts)
      return isNaN(d.getTime()) ? ts : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    }
    return {
      labels: allTs.map(fmtTs),
      datasets: overview.patterns.map((p, i) => ({
        label: String(p.normalized_query_hash).slice(0, 10),
        data: allTs.map(ts => {
          const row = overview.timeline.find(r => r.ts === ts && String(r.normalized_query_hash) === String(p.normalized_query_hash))
          return row ? Number(row.total_ms) || 0 : 0
        }),
        backgroundColor: COLORS[i % COLORS.length] + 'cc',
        borderColor: COLORS[i % COLORS.length],
        borderWidth: 0,
        stack: 'load',
      })),
    }
  })()

  const stackedOpts = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { position: 'bottom' as const, labels: { color: '#9ca3af', font: { size: 10 }, boxWidth: 10, padding: 8 } },
      tooltip: {
        backgroundColor: 'rgba(15,20,30,0.95)', borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1,
        titleColor: '#f3f4f6', bodyColor: '#9ca3af', padding: 10, cornerRadius: 8,
        callbacks: { label: (ctx: any) => ` ${ctx.dataset.label}: ${fmtDuration(ctx.parsed.y)}` },
      },
    },
    scales: {
      x: { stacked: true, ticks: { maxTicksLimit: 10, color: '#6b7280', font: { size: 10 } }, grid: { display: false }, border: { display: false } },
      y: { stacked: true, ticks: { callback: (v: any) => fmtDuration(Number(v)), color: '#6b7280', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' }, border: { display: false } },
    },
  }

  // ── table columns ──────────────────────────────────────────────────────────
  const columns: any[] = [
    {
      key: 'normalized_query_hash',
      label: 'Hash',
      tooltip: 'Unique fingerprint of the normalized query (parameters stripped)',
      format: (v: any) => (
        <span className="font-mono text-[11px] text-[var(--accent)] tracking-tight">{String(v).slice(0, 12)}</span>
      ),
    },
    { key: 'cnt', label: 'Execs', tooltip: 'Total number of times this query pattern ran in the selected time range', format: (v: any) => <span className="tabular-nums">{fmtCompact(v)}</span> },
    {
      key: 'kind',
      label: 'Kind',
      tooltip: 'Query type: SELECT, INSERT, etc.',
      format: (v: any) => (
        <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium', kindBg(v))}>
          {String(v || '—').slice(0, 6)}
        </span>
      ),
    },
    {
      key: 'total_ms',
      label: 'Total CPU',
      tooltip: 'Sum of wall-clock duration for all executions — proportional bar shows share of total load',
      format: (v: any, row: any) => (
        <span className="flex items-center gap-2 min-w-[110px]">
          <span className="tabular-nums text-xs">{fmtDuration(v)}</span>
          <span className="h-1.5 rounded-full shrink-0 bg-[var(--accent)] opacity-60"
            style={{ width: `${Math.max(3, ((row.total_ms || 0) / maxTotalMs) * 56)}px` }} />
        </span>
      ),
    },
    {
      key: 'avg_ms',
      label: 'Avg',
      tooltip: 'Average query duration across all executions. Green < 1s, amber 1–10s, red > 10s',
      format: (v: any) => (
        <span className={cn('inline-flex px-1.5 py-0.5 rounded text-[11px] tabular-nums', latencyBg(v))}>
          {fmtDuration(v)}
        </span>
      ),
    },
    {
      key: 'p95_ms',
      label: 'P95',
      tooltip: '95th-percentile latency — 95% of executions were faster than this',
      format: (v: any) => (
        <span className={cn('inline-flex px-1.5 py-0.5 rounded text-[11px] tabular-nums', latencyBg(v))}>
          {fmtDuration(v)}
        </span>
      ),
    },
    { key: 'avg_memory', label: 'Avg Mem', tooltip: 'Average peak memory usage per execution (from query_log.memory_usage)', format: (v: any) => <span className="text-xs tabular-nums">{fmtBytes(v)}</span> },
    {
      key: 'failures',
      label: 'Fails',
      tooltip: 'Number of executions that raised an exception. Click to see the failed query samples.',
      format: (v: any, row: any) => {
        const n = Number(v)
        const hash = String(row.normalized_query_hash)
        if (n === 0) return <span className="text-[var(--dim)] text-xs" title="No failures">—</span>
        const chip = n > 5
          ? <span className="inline-flex px-1.5 py-0.5 rounded text-[11px] font-semibold bg-red-500/10 text-red-400 border border-red-500/20">{fmtCompact(n)}</span>
          : <span className="text-amber-400 text-xs font-medium">{n}</span>
        return (
          <button
            onClick={e => { e.stopPropagation(); onDrillFail?.(hash) }}
            className="hover:opacity-75 transition-opacity"
            title="Click to see failed query samples"
          >
            {chip}
          </button>
        )
      },
    },
    {
      key: 'sample_query',
      label: 'Sample Query',
      tooltip: 'Example SQL from this query pattern (parameters stripped and normalized)',
      format: (v: any) => {
        const q = String(v ?? '')
        return (
          <span className="flex items-center gap-1.5 group/q min-w-0">
            <span className="truncate min-w-0">
              <SqlHighlight text={q} maxLen={70} />
            </span>
            {q && (
              <button
                onClick={e => { e.stopPropagation(); onShowQuery(q) }}
                className="shrink-0 p-0.5 rounded text-[var(--dim)] hover:text-[var(--accent)] opacity-0 group-hover/q:opacity-100 transition-all"
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
          className="text-xs text-[var(--accent)] hover:underline whitespace-nowrap opacity-60 hover:opacity-100 transition-opacity"
        >
          Samples →
        </button>
      ),
    }] : []),
  ]

  return (
    <div className="space-y-4">
      {/* Stat cards */}
      {patterns.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          <StatCard label="Patterns" value={String(patterns.length)} />
          <StatCard label="Executions" value={fmtCompact(totalExecs)} sub={`${fmtCompact(totalExecs / Math.max(1, (to - from) / 60))} /min avg`} />
          <StatCard label="Total CPU" value={fmtDuration(totalCpuMs)} />
          <StatCard
            label="Error Rate"
            value={errorRate < 0.1 ? '<0.1%' : errorRate.toFixed(1) + '%'}
            color={errorRate > 5 ? 'text-red-400' : errorRate > 1 ? 'text-amber-400' : 'text-emerald-400'}
            sub={`${fmtCompact(totalFails)} failures`}
          />
        </div>
      )}

      {/* Chart.js stacked bar overview */}
      {stackedChartData && (
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-3">
            CPU Load by Query Pattern
          </div>
          <div style={{ height: 130 }}>
            <Bar data={stackedChartData} options={stackedOpts as any} />
          </div>
        </div>
      )}

      <Card>
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
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

      {/* ── Failure Detail Panel ─────────────────────────────────── */}
      {failHash && (
        <div className="space-y-3 mt-2">
          <div className="flex items-center gap-2 px-1">
            <span className="text-xs font-semibold text-red-400 uppercase tracking-wider">
              Failure Detail — hash {failHash.slice(0, 14)}
            </span>
            <span className="text-[11px] text-[var(--dim)]">
              {patterns.find(p => String(p.normalized_query_hash) === failHash)?.sample_query?.slice(0, 60)}
            </span>
            <button onClick={() => setFailHash(null)} className="ml-auto text-[var(--dim)] hover:text-[var(--fg)]">
              <X size={14} />
            </button>
          </div>

          {failLoading ? (
            <LoadingSkeleton />
          ) : !failData || (failData.byCode.length === 0 && failData.byTs.length === 0) ? (
            <div className="text-sm text-[var(--dim)] p-4 bg-[var(--surface)] border border-[var(--border)] rounded-xl">
              No failure records found for this query in the selected time range.
            </div>
          ) : (
            <>
              {/* Failures over time chart + timeline charts from pattern */}
              <div className="grid grid-cols-1 gap-3">
                <HistoryChart
                  title="Failures Over Time"
                  data={failData.byTs}
                  series={[{ key: 'cnt', label: 'Errors', color: C.red }]}
                  height={120}
                  onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                />
                {/* Latency + memory charts loaded independently for the selected fail hash */}
                {failTimeline.length > 0 && (
                  <>
                    <HistoryChart
                      title="Latency (Avg / P95 / Max)"
                      data={failTimeline}
                      series={[
                        { key: 'avg_ms', label: 'Avg', color: C.green },
                        { key: 'p95_ms', label: 'P95', color: C.yellow },
                        { key: 'max_ms', label: 'Max', color: C.red },
                      ]}
                      yFormat="ms"
                      height={120}
                      onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                    />
                    <HistoryChart
                      title="Memory & Read Bytes"
                      data={failTimeline}
                      series={[
                        { key: 'avg_memory', label: 'Memory', color: C.purple },
                        { key: 'avg_read_bytes', label: 'Read Bytes', color: C.cyan },
                      ]}
                      yFormat="bytes"
                      height={120}
                      onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                    />
                  </>
                )}
              </div>

              {/* Error messages accordion */}
              <Card>
                <div className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider mb-3">
                  Error Messages — {failData.byCode.length} exception type{failData.byCode.length !== 1 ? 's' : ''}
                </div>
                <div className="space-y-2">
                  {failData.byCode.map((row, i) => {
                    const msgs: string[] = Array.isArray(row.messages) ? row.messages : [row.messages ?? ''].filter(Boolean)
                    return (
                      <div key={i} className="rounded-lg border border-[var(--border)] overflow-hidden">
                        <div className="flex items-center gap-2 px-3 py-2.5 bg-[var(--surface)]">
                          <span className="inline-flex items-center px-2 py-0.5 rounded bg-red-500/10 border border-red-500/20 text-red-400 font-mono text-xs font-semibold shrink-0">
                            {row.exception_code}
                          </span>
                          <span className="text-xs font-semibold tabular-nums text-[var(--fg)] shrink-0">
                            {fmtCompact(row.cnt)} errors
                          </span>
                          {row.sample_user && (
                            <span className="text-[11px] text-[var(--dim)] shrink-0">user: {row.sample_user}</span>
                          )}
                        </div>
                        <div className="border-t border-[var(--border)] px-3 py-2.5 space-y-2">
                          {msgs.map((msg, j) => (
                            <pre key={j} className="text-xs font-mono text-red-300/80 whitespace-pre-wrap break-all leading-relaxed bg-red-500/5 border border-red-500/10 rounded p-2 max-h-36 overflow-y-auto">
                              {msg}
                            </pre>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </Card>
            </>
          )}
        </div>
      )}

      {selectedHash && (
        <div className="space-y-3 mt-2">
          {/* Header */}
          <div className="flex items-center gap-2 px-1">
            <span className="text-xs font-semibold text-[var(--dim)] uppercase tracking-wider">
              Query Detail — hash {selectedHash.slice(0, 14)}
            </span>
            <button
              onClick={() => onDrillHash?.(selectedHash)}
              className="ml-auto text-xs text-[var(--accent)] hover:underline"
            >
              View Samples →
            </button>
            <button
              onClick={() => setSelectedHash(null)}
              className="text-[var(--dim)] hover:text-[var(--fg)]"
            >
              <X size={14} />
            </button>
          </div>

          {tlLoading ? (
            <LoadingSkeleton />
          ) : timeline.length === 0 ? (
            <div className="text-sm text-[var(--dim)] p-4 bg-[var(--surface)] border border-[var(--border)] rounded-xl">
              No timeline data for this hash in the selected range. Try expanding the time range.
            </div>
          ) : (
            <>
              {/* Inline stat cards derived from timeline */}
              {(() => {
                const totalExecsTl = timeline.reduce((s, r) => s + (Number(r.cnt) || 0), 0)
                const avgMs = timeline.reduce((s, r) => s + (Number(r.avg_ms) || 0), 0) / Math.max(1, timeline.length)
                const totalFails = timeline.reduce((s, r) => s + (Number(r.failures) || 0), 0)
                const avgMem = timeline.reduce((s, r) => s + (Number(r.avg_memory) || 0), 0) / Math.max(1, timeline.length)
                const errRate = totalExecsTl > 0 ? (totalFails / totalExecsTl * 100) : 0
                return (
                  <div className="flex gap-2 flex-wrap">
                    <StatCard label="Executions" value={fmtCompact(totalExecsTl)} />
                    <StatCard label="Avg Latency" value={fmtDuration(avgMs)} />
                    <StatCard label="Avg Memory" value={fmtBytes(avgMem)} sub="per execution" />
                    <StatCard label="Error Rate"
                      value={errRate < 0.1 ? (totalFails === 0 ? '0%' : '<0.1%') : errRate.toFixed(1) + '%'}
                      color={errRate > 5 ? 'text-red-400' : errRate > 0 ? 'text-amber-400' : 'text-emerald-400'}
                      sub={`${fmtCompact(totalFails)} failures`}
                    />
                  </div>
                )
              })()}

              {/* Charts grid */}
              <div className="grid grid-cols-1 gap-3">
                <HistoryChart
                  title="Executions & Failures"
                  data={timeline}
                  series={[
                    { key: 'cnt', label: 'Executions', color: C.blue },
                    { key: 'failures', label: 'Failures', color: C.red },
                  ]}
                  height={120}
                  onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                />
                <HistoryChart
                  title="Latency (Avg / P95 / Max)"
                  data={timeline}
                  series={[
                    { key: 'avg_ms', label: 'Avg', color: C.green },
                    { key: 'p95_ms', label: 'P95', color: C.yellow },
                    { key: 'max_ms', label: 'Max', color: C.red },
                  ]}
                  yFormat="ms"
                  height={120}
                  onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                />
                <HistoryChart
                  title="Memory & Read Bytes"
                  data={timeline}
                  series={[
                    { key: 'avg_memory', label: 'Avg Memory', color: C.purple },
                    { key: 'avg_read_bytes', label: 'Avg Read Bytes', color: C.cyan },
                  ]}
                  yFormat="bytes"
                  height={120}
                  onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                />
                {/* CPU time */}
                {timeline.some(r => Number(r.avg_cpu_ms) > 0) && (
                  <HistoryChart
                    title="CPU Time (User + System)"
                    data={timeline}
                    series={[{ key: 'avg_cpu_ms', label: 'Avg CPU', color: C.orange }]}
                    yFormat="ms"
                    height={100}
                    onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                  />
                )}
                {/* Read rows */}
                {timeline.some(r => Number(r.avg_read_rows) > 0) && (
                  <HistoryChart
                    title="Rows Read / Written"
                    data={timeline}
                    series={[
                      { key: 'avg_read_rows', label: 'Read Rows', color: C.blue },
                      { key: 'avg_written_rows', label: 'Written Rows', color: C.green },
                    ]}
                    height={100}
                    onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                  />
                )}
                {/* Mark cache — always shown; N/A means data fully served from uncompressed/OS cache */}
                <HistoryChart
                  title="Mark Cache Hit Rate (%)"
                  data={timeline}
                  series={[{ key: 'avg_mark_cache_hit_pct', label: 'Hit %', color: C.cyan }]}
                  note="No disk index reads — data served from uncompressed or OS page cache"
                  height={100}
                  onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                />
                {/* S3 latency — always shown; N/A means this pattern does not read from S3 storage */}
                <HistoryChart
                  title="S3 Latency & Requests per Exec"
                  data={timeline}
                  series={[
                    { key: 'avg_s3_latency_ms', label: 'Avg Latency ms', color: C.yellow },
                    { key: 'avg_s3_requests', label: 'Requests/exec', color: C.orange },
                  ]}
                  yFormat="ms"
                  note="No S3 reads — this query pattern does not access S3-backed storage"
                  height={100}
                  onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                />
              </div>
            </>
          )}
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
  initialErrorsOnly?: boolean
  onClearDrill?: () => void
}

function SamplesTab({ instance, from, to, refreshKey, onShowQuery, initialHash, initialUser, initialErrorsOnly, onClearDrill }: SamplesTabProps) {
  const [samples, setSamples] = useState<QuerySample[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hashFilter, setHashFilter] = useState(initialHash ?? '')
  const [userFilter, setUserFilter] = useState(initialUser ?? '')
  const [kindFilter, setKindFilter] = useState('')
  const [minMs, setMinMs] = useState('')
  const [errorsOnly, setErrorsOnly] = useState(initialErrorsOnly ?? false)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  // Charts shown when drilling into failures for a specific hash
  const [failTimeline, setFailTimeline] = useState<Record<string, any>[]>([])
  const [patternTimeline, setPatternTimeline] = useState<Record<string, any>[]>([])

  // When initial drill context changes, update filters.
  useEffect(() => { setHashFilter(initialHash ?? '') }, [initialHash])
  useEffect(() => { setUserFilter(initialUser ?? '') }, [initialUser])
  useEffect(() => { setErrorsOnly(initialErrorsOnly ?? false) }, [initialErrorsOnly])

  // Load charts when we have a hash + errorsOnly drill (came from FAILS click)
  useEffect(() => {
    if (!hashFilter || !errorsOnly) { setFailTimeline([]); setPatternTimeline([]); return }
    let c = false
    Promise.all([
      api.history.failures(instance, from, to, hashFilter),
      api.history.queryPatternTimeline(instance, hashFilter, from, to),
    ]).then(([fd, tl]) => {
      if (c) return
      const tlArr = Array.isArray(fd.timeline) ? fd.timeline : []
      const map = new Map<string, number>()
      for (const r of tlArr) map.set(r.ts, (map.get(r.ts) ?? 0) + (Number(r.cnt) || 0))
      setFailTimeline([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([ts, cnt]) => ({ ts, cnt })))
      setPatternTimeline(Array.isArray(tl) ? tl : [])
    }).catch(() => {})
    return () => { c = true }
  }, [instance, hashFilter, errorsOnly, from, to])

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.querySamples(instance, from, to, {
      hash: hashFilter || undefined,
      user: userFilter || undefined,
      kind: kindFilter || undefined,
      minMs: minMs || undefined,
      errorsOnly: errorsOnly || undefined,
      limit: 200,
    })
      .then(d => { if (!c) setSamples(d) })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to, refreshKey, hashFilter, userFilter, kindFilter, minMs, errorsOnly])

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
      {/* Failure charts — shown when drilling from FAILS click (hash + errorsOnly) */}
      {hashFilter && errorsOnly && (failTimeline.length > 0 || patternTimeline.length > 0) && (
        <div className="space-y-3">
          {failTimeline.length > 0 && (
            <HistoryChart
              title="Failures Over Time"
              data={failTimeline}
              series={[{ key: 'cnt', label: 'Failed Executions', color: C.red }]}
              height={110}
              onAnalyze={() => {}}
            />
          )}
          {patternTimeline.length > 0 && (
            <>
              <HistoryChart
                title="Executions (All + Failures)"
                data={patternTimeline}
                series={[
                  { key: 'cnt', label: 'Total Execs', color: C.blue },
                  { key: 'failures', label: 'Failures', color: C.red },
                ]}
                height={100}
                onAnalyze={() => {}}
              />
              <HistoryChart
                title="Latency — Avg / P95 / Max"
                data={patternTimeline}
                series={[
                  { key: 'avg_ms', label: 'Avg', color: C.green },
                  { key: 'p95_ms', label: 'P95', color: C.yellow },
                  { key: 'max_ms', label: 'Max', color: C.red },
                ]}
                yFormat="ms"
                height={110}
                onAnalyze={() => {}}
              />
              <HistoryChart
                title="Memory & Read Bytes"
                data={patternTimeline}
                series={[
                  { key: 'avg_memory', label: 'Memory', color: C.purple },
                  { key: 'avg_read_bytes', label: 'Read Bytes', color: C.cyan },
                ]}
                yFormat="bytes"
                height={110}
                onAnalyze={() => {}}
              />
              {patternTimeline.some(r => Number(r.avg_cpu_ms) > 0) && (
                <HistoryChart
                  title="CPU Time (User + System)"
                  data={patternTimeline}
                  series={[{ key: 'avg_cpu_ms', label: 'Avg CPU', color: C.orange }]}
                  yFormat="ms"
                  height={100}
                  onAnalyze={() => {}}
                />
              )}
              {patternTimeline.some(r => Number(r.avg_read_rows) > 0) && (
                <HistoryChart
                  title="Rows Read / Written"
                  data={patternTimeline}
                  series={[
                    { key: 'avg_read_rows', label: 'Read Rows', color: C.blue },
                    { key: 'avg_written_rows', label: 'Written Rows', color: C.green },
                  ]}
                  height={100}
                  onAnalyze={() => {}}
                />
              )}
              <HistoryChart
                title="Mark Cache Hit Rate (%)"
                data={patternTimeline}
                series={[{ key: 'avg_mark_cache_hit_pct', label: 'Hit %', color: C.cyan }]}
                note="No disk index reads — data served from uncompressed or OS page cache"
                height={100}
                onAnalyze={() => {}}
              />
              <HistoryChart
                title="S3 Latency & Requests per Exec"
                data={patternTimeline}
                series={[
                  { key: 'avg_s3_latency_ms', label: 'Avg Latency ms', color: C.yellow },
                  { key: 'avg_s3_requests', label: 'Requests/exec', color: C.orange },
                ]}
                yFormat="ms"
                note="No S3 reads — this query pattern does not access S3-backed storage"
                height={100}
                onAnalyze={() => {}}
              />
            </>
          )}
        </div>
      )}

      {/* Filters */}
      <Card>
        <div className="flex flex-wrap gap-2 items-center">
          {(hashFilter || userFilter || errorsOnly) && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-[var(--accent)]/15 border border-[var(--accent)]/30 text-xs text-[var(--accent)]">
              {hashFilter && <span>hash: {hashFilter.slice(0, 12)}</span>}
              {userFilter && <span>user: {userFilter}</span>}
              {errorsOnly && <span className="text-red-400">errors only</span>}
              <button
                onClick={() => { setHashFilter(''); setUserFilter(''); setErrorsOnly(false); onClearDrill?.() }}
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
          <button
            onClick={() => setErrorsOnly(v => !v)}
            className={cn(
              'flex items-center gap-1 px-2 py-1 rounded text-xs border transition-colors',
              errorsOnly
                ? 'bg-red-500/15 border-red-500/30 text-red-400'
                : 'border-[var(--border)] text-[var(--dim)] hover:text-[var(--fg)]',
            )}
          >
            Errors only
          </button>
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
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0', kindBg(s.query_kind))}>
                    {String(s.query_kind || '—').slice(0, 6)}
                  </span>
                  {s.is_exception === 1 && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20 shrink-0">
                      error
                    </span>
                  )}
                  <span className="truncate min-w-0">
                    <SqlHighlight text={String(s.query_text ?? '')} maxLen={80} />
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
                    {s.tables_accessed && (
                      <div className="flex flex-wrap gap-1 text-xs">
                        <span className="text-[var(--dim)] shrink-0">Tables:</span>
                        {String(s.tables_accessed).split(', ').filter(Boolean).map((t, i) => (
                          <span key={i} className="inline-flex px-1.5 py-0.5 rounded bg-[var(--hover)] border border-[var(--border)] font-mono text-[11px]">{t}</span>
                        ))}
                      </div>
                    )}
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
            const sec = Number(r.elapsed) || 0
            const pct = Math.min(100, (sec / 300) * 100) // 300s = 100%
            const pill = sec > 300 ? 'bg-red-500' : sec > 60 ? 'bg-orange-500' : sec > 10 ? 'bg-yellow-500' : 'bg-emerald-500'
            const kind = String(r.query_kind || r.kind || '').toLowerCase()
            return (
              <div key={i} className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-[var(--border)] bg-[var(--card)] hover:bg-[var(--hover)] transition-colors group">
                {/* Elapsed pill */}
                <div className="flex items-center gap-1.5 shrink-0 w-20">
                  <div className="w-10 h-1.5 rounded-full bg-[var(--border)] overflow-hidden">
                    <div className={cn('h-full rounded-full transition-all', pill)} style={{ width: `${pct}%` }} />
                  </div>
                  <span className={cn('text-xs tabular-nums font-mono', elapsedColor(r.elapsed))}>
                    {elapsed(r.elapsed)}
                  </span>
                </div>
                {/* User */}
                <span className="text-xs text-[var(--dim)] w-20 shrink-0 truncate">{r.user}</span>
                {/* Kind badge */}
                {kind && (
                  <span className={cn('shrink-0 inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium', kindBg(kind))}>
                    {kind.slice(0, 3).toUpperCase()}
                  </span>
                )}
                {/* Query preview */}
                <span className="text-xs font-mono text-[var(--fg)] truncate flex-1">
                  <SqlHighlight text={q} maxLen={100} />
                </span>
                {/* Memory */}
                <span className="text-xs text-[var(--dim)] w-16 text-right shrink-0 tabular-nums">
                  {r.memory_usage ? fmtBytes(r.memory_usage) : ''}
                </span>
                <button onClick={() => onShowQuery(q)}
                  className="shrink-0 p-1 rounded text-[var(--dim)] hover:text-[var(--accent)] opacity-0 group-hover:opacity-100 transition-all"
                  title="View query"><Maximize2 size={12} /></button>
                <button onClick={() => setKillTarget(qid)}
                  className="shrink-0 p-1 rounded text-[var(--dim)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                  title="Kill query"><Skull size={12} /></button>
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

const USER_COLORS = ['#3b82f6','#22c55e','#f59e0b','#ef4444','#a855f7','#06b6d4','#f97316','#ec4899']

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

  // ALL hooks BEFORE any early return (Rules of Hooks)
  const donutData = useMemo(() => {
    if (users.length === 0) return null
    const top = users.slice(0, 7)
    const otherMs = users.slice(7).reduce((s, u) => s + (u.total_ms || 0), 0)
    const labels = [...top.map(u => u.user || '(unknown)'), ...(otherMs > 0 ? ['other'] : [])]
    const vals = [...top.map(u => u.total_ms || 0), ...(otherMs > 0 ? [otherMs] : [])]
    return {
      labels,
      datasets: [{ data: vals, backgroundColor: USER_COLORS.map(c => c + 'cc'), borderColor: USER_COLORS, borderWidth: 1 }],
    }
  }, [users])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  const maxTotalMs = users.reduce((m, u) => Math.max(m, u.total_ms || 0), 1)
  const grandTotal = users.reduce((s, u) => s + (u.total_ms || 0), 0)
  const topUser = users[0]

  const donutOpts = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
    plugins: {
      legend: { position: 'right' as const, labels: { color: '#9ca3af', font: { size: 11 }, padding: 10, boxWidth: 10 } },
      tooltip: {
        backgroundColor: 'rgba(15,20,30,0.95)', borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1,
        titleColor: '#f3f4f6', bodyColor: '#9ca3af', padding: 10, cornerRadius: 8,
        callbacks: {
          label: (ctx: any) => {
            const pct = grandTotal > 0 ? ((ctx.parsed / grandTotal) * 100).toFixed(1) : '0'
            return ` ${fmtDuration(ctx.parsed)} (${pct}%)`
          },
        },
      },
    },
  }

  return (
    <div className="space-y-4">
      {/* Stat cards */}
      {users.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          <StatCard label="Active Users" value={String(users.length)} />
          {topUser && (
            <StatCard
              label="Top User"
              value={topUser.user || '(unknown)'}
              sub={grandTotal > 0 ? `${((topUser.total_ms / grandTotal) * 100).toFixed(0)}% of total CPU` : ''}
              color="text-[var(--accent)]"
            />
          )}
          <StatCard label="Total CPU" value={fmtDuration(grandTotal)} />
          <StatCard
            label="Total Execs"
            value={fmtCompact(users.reduce((s, u) => s + (u.cnt || 0), 0))}
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
        {/* Horizontal bars */}
        <Card>
          <div className="text-xs text-[var(--dim)] uppercase tracking-wider font-medium mb-3">
            {users.length} users — by total CPU time
          </div>
          {users.length === 0 ? (
            <div className="text-sm text-[var(--dim)] text-center py-8">No data in range</div>
          ) : (
            <div className="space-y-1.5">
              {users.map((u, i) => {
                const pct = (u.total_ms / maxTotalMs) * 100
                const color = USER_COLORS[i % USER_COLORS.length]
                return (
                  <div
                    key={i}
                    onClick={() => onDrillUser?.(u.user)}
                    className={cn(
                      'group flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--border)] hover:bg-[var(--hover)] transition-colors',
                      onDrillUser && 'cursor-pointer',
                    )}
                  >
                    <span className="text-sm font-medium w-28 shrink-0 truncate">{u.user || '(unknown)'}</span>
                    <div className="flex-1 flex items-center gap-2 min-w-0">
                      <div className="flex-1 h-2 rounded-full bg-[var(--border)] overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${pct}%`, background: color }} />
                      </div>
                      <span className="text-xs tabular-nums text-[var(--dim)] w-16 text-right shrink-0">{fmtDuration(u.total_ms)}</span>
                    </div>
                    <div className="hidden lg:flex gap-3 text-xs text-[var(--dim)] shrink-0">
                      <span><span className="text-[var(--fg)]">{fmtCompact(u.cnt)}</span> execs</span>
                      <span className={cn('font-mono', latencyBg(u.avg_ms), 'px-1.5 py-0.5 rounded text-[11px]')}>{fmtDuration(u.avg_ms)}</span>
                      {u.failures > 0 && <span className="text-red-400">{u.failures} err</span>}
                    </div>
                    {onDrillUser && (
                      <span className="text-xs text-[var(--accent)] opacity-0 group-hover:opacity-100 shrink-0 transition-opacity">→</span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        {/* Donut chart */}
        {donutData && (
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 flex flex-col">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-3">CPU Share</div>
            <div className="flex-1" style={{ minHeight: 180 }}>
              <Doughnut data={donutData} options={donutOpts as any} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Failures Tab                                                       */
/* ------------------------------------------------------------------ */

function FailuresTab({ instance, from, to, refreshKey, onAnalyze }: TabProps) {
  const [timeline, setTimeline] = useState<HistoryFailure[]>([])
  const [byCode, setByCode] = useState<Record<string, any>[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.failures(instance, from, to)
      .then(d => {
        if (!c) {
          setTimeline(Array.isArray(d.timeline) ? d.timeline : [])
          setByCode(Array.isArray(d.by_code) ? d.by_code : [])
        }
      })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to, refreshKey])

  const byTs = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of timeline) map.set(r.ts, (map.get(r.ts) ?? 0) + r.cnt)
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([ts, cnt]) => ({ ts, cnt }))
  }, [timeline])

  const toggleExpand = (i: number) =>
    setExpanded(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n })

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  const totalFailures = byCode.reduce((s, r) => s + (Number(r.cnt) || 0), 0)

  return (
    <div className="space-y-4">
      {/* Stat cards */}
      {totalFailures > 0 && (
        <div className="flex gap-3 flex-wrap">
          <StatCard label="Total Errors" value={fmtCompact(totalFailures)} color="text-red-400" />
          <StatCard label="Error Codes" value={String(byCode.length)} sub="distinct exception types" />
          {byCode[0] && (
            <StatCard label="Top Error Code" value={String(byCode[0].exception_code)}
              sub={`${fmtCompact(byCode[0].cnt)} occurrences`} color="text-amber-400" />
          )}
        </div>
      )}

      <HistoryChart
        title="Failures Over Time"
        data={byTs}
        series={[{ key: 'cnt', label: 'Errors', color: C.red }]}
        onAnalyze={(d, s, title) => onAnalyze(title, { data: d, series: s }, { contextType: 'chart', tab: 'failures' })}
      />

      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider">
            By Exception Code — {byCode.length} types
          </div>
          <AnalyzeTabBtn label="Failures" data={{ byCode, byTs }} tab="failures" onAnalyze={onAnalyze} disabled={byCode.length === 0} />
        </div>

        {byCode.length === 0 && (
          <div className="text-sm text-[var(--dim)] text-center py-8">No failures in this time range</div>
        )}

        <div className="space-y-2">
          {byCode.map((row, i) => {
            const msgs: string[] = Array.isArray(row.messages) ? row.messages : [row.messages ?? ''].filter(Boolean)
            const isOpen = expanded.has(i)
            return (
              <div key={i} className="rounded-lg border border-[var(--border)] overflow-hidden">
                <button
                  onClick={() => toggleExpand(i)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--hover)] transition-colors text-left"
                >
                  {isOpen ? <ChevronDown size={13} className="shrink-0 text-[var(--dim)]" /> : <ChevronRight size={13} className="shrink-0 text-[var(--dim)]" />}
                  <span className="inline-flex items-center px-2 py-0.5 rounded bg-red-500/10 border border-red-500/20 text-red-400 font-mono text-xs font-semibold shrink-0">
                    {row.exception_code}
                  </span>
                  <span className="text-xs font-semibold tabular-nums text-[var(--fg)] shrink-0 w-16">
                    {fmtCompact(row.cnt)} errs
                  </span>
                  {/* First message preview */}
                  <span className="text-xs text-[var(--dim)] truncate flex-1 font-mono">
                    {msgs[0] ? msgs[0].slice(0, 120) : '—'}
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); onAnalyze(`Error code ${row.exception_code}`, { row, allErrors: byCode }, { contextType: 'row', tab: 'failures', elementId: String(row.exception_code) }) }}
                    className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-purple-400 hover:bg-purple-500/15 border border-transparent hover:border-purple-500/20 transition-colors"
                  >
                    <Sparkles size={10} /> AI
                  </button>
                </button>

                {isOpen && (
                  <div className="border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3 space-y-3">
                    {/* Stats row */}
                    <div className="flex gap-4 text-xs flex-wrap">
                      {row.sample_user && <span><span className="text-[var(--dim)]">User:</span> <span className="font-medium">{row.sample_user}</span></span>}
                      <span><span className="text-[var(--dim)]">Count:</span> <span className="font-medium text-red-400">{fmtNum(row.cnt)}</span></span>
                    </div>
                    {/* All distinct messages */}
                    <div className="space-y-2">
                      <div className="text-[11px] text-[var(--dim)] uppercase tracking-wider font-medium">
                        Distinct Error Messages ({msgs.length})
                      </div>
                      {msgs.map((msg, j) => (
                        <pre key={j} className="text-xs font-mono text-red-300/80 whitespace-pre-wrap break-all leading-relaxed bg-red-500/5 border border-red-500/10 rounded p-2.5 max-h-40 overflow-y-auto">
                          {msg}
                        </pre>
                      ))}
                    </div>
                    {/* Sample query */}
                    {row.sample_query && (
                      <div>
                        <div className="text-[11px] text-[var(--dim)] uppercase tracking-wider font-medium mb-1">Sample Query</div>
                        <pre className="text-xs font-mono text-[var(--fg)] whitespace-pre-wrap break-all leading-relaxed bg-[var(--card)] border border-[var(--border)] rounded p-2.5 max-h-32 overflow-y-auto">
                          {row.sample_query}
                        </pre>
                      </div>
                    )}
                  </div>
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
            { key: 'view_name', label: 'View Name', tooltip: 'Materialized view name' },
            { key: 'cnt', label: 'Count', tooltip: 'Number of times this MV was triggered in the time range', format: (v: any) => fmtNum(v) },
            { key: 'avg_ms', label: 'Avg ms', tooltip: 'Average MV execution time per trigger', format: (v: any) => fmtDuration(v) },
            { key: 'max_ms', label: 'Max ms', tooltip: 'Slowest single MV execution observed', format: (v: any) => fmtDuration(v) },
            { key: 'failures', label: 'Failures', tooltip: 'Number of MV executions that raised an exception', format: (v: any) => fmtNum(v) },
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
              { key: 'normalized_query_hash', label: 'Hash', tooltip: 'Normalized query fingerprint — same hash means same query structure', format: (v: any) => String(v ?? '').slice(0, 12) },
              { key: 'cnt', label: 'Count', tooltip: 'Number of S3 requests generated by this query pattern', format: (v: any) => fmtNum(v) },
              { key: 'avg_latency_ms', label: 'Avg ms', tooltip: 'Average S3 request latency for this query pattern', format: (v: any) => fmtDuration(Number(v ?? 0)) },
              { key: 'max_latency_ms', label: 'Max ms', tooltip: 'Maximum single S3 request latency observed', format: (v: any) => fmtDuration(Number(v ?? 0)) },
              {
                key: 'sample_query', label: 'Sample',
                tooltip: 'Example SQL query for this hash — hover to read, click ⤢ for full text',
                format: (v: any) => {
                  const q = String(v ?? '')
                  return (
                    <span className="flex items-center gap-1.5 group/q min-w-0" title={q}>
                      <span className="text-[var(--dim)] text-xs font-mono">
                        {q.length > 150 ? q.slice(0, 150) + '…' : q}
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
              { key: 'table_name', label: 'Table', tooltip: 'Table reading data from S3 (S3-backed or tiered storage)' },
              { key: 'queries', label: 'Queries', tooltip: 'Number of distinct query patterns that accessed this table via S3', format: (v: any) => fmtNum(v) },
              { key: 'avg_latency_ms', label: 'Avg ms', tooltip: 'Average S3 request latency across all queries for this table', format: (v: any) => fmtDuration(Number(v ?? 0)) },
              { key: 'total_requests', label: 'Total Requests', tooltip: 'Total number of S3 API calls made for this table', format: (v: any) => fmtNum(v) },
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
            { key: 'table', label: 'Table', tooltip: 'Target table receiving inserts' },
            { key: 'insert_count', label: 'Inserts', tooltip: 'Number of INSERT statements executed in the time range', format: (v: any) => fmtNum(v) },
            { key: 'total_rows', label: 'Total Rows', tooltip: 'Total rows inserted across all INSERT statements', format: (v: any) => fmtNum(v) },
            { key: 'total_bytes', label: 'Total Bytes', tooltip: 'Total uncompressed data written by inserts', format: (v: any) => fmtBytes(v) },
            { key: 'small_insert_count', label: 'Small Inserts', tooltip: 'Inserts with fewer rows than the recommended batch size — too many small inserts causes part explosion', format: (v: any) => fmtNum(v) },
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
/*  Anti-patterns Tab                                                 */
/* ------------------------------------------------------------------ */

function SevBadge({ s }: { s: string }) {
  const cls = s === 'critical'
    ? 'bg-red-500/15 text-red-400 border-red-500/30'
    : s === 'warn'
    ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'
    : 'bg-blue-500/15 text-blue-400 border-blue-500/30'
  return (
    <span className={cn('text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border font-medium shrink-0', cls)}>
      {s}
    </span>
  )
}

function APGroupCard({
  group,
  extraCols,
  onRunQuery,
}: {
  group: any
  extraCols: Array<{ key: string; label: string; format?: (v: any) => React.ReactNode }>
  onRunQuery: (sql: string) => void
}) {
  const [open, setOpen] = useState(false)
  const hasIssues = group.count > 0

  return (
    <div className={cn(
      'rounded-xl border overflow-hidden',
      hasIssues
        ? group.severity === 'critical' ? 'border-red-500/30' : 'border-yellow-500/30'
        : 'border-[var(--border)]',
    )}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--hover)] transition-colors"
      >
        {open ? <ChevronDown size={14} className="text-[var(--dim)] shrink-0" /> : <ChevronRight size={14} className="text-[var(--dim)] shrink-0" />}
        <span className="font-medium text-sm flex-1">{group.title}</span>
        <SevBadge s={group.severity} />
        <span className={cn(
          'text-xs font-semibold ml-2 px-2 py-0.5 rounded-full',
          hasIssues
            ? group.severity === 'critical' ? 'bg-red-500/15 text-red-400' : 'bg-yellow-500/15 text-yellow-400'
            : 'bg-green-500/15 text-green-400',
        )}>
          {group.count} {group.count === 1 ? 'issue' : 'issues'}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-[var(--border)]">
          <p className="text-xs text-[var(--dim)] pt-3 leading-relaxed">{group.description}</p>
          {group.count === 0
            ? <div className="text-xs text-green-400 bg-green-500/10 rounded-lg px-3 py-2 border border-green-500/20">No issues detected</div>
            : (
              <DataTable
                columns={[
                  { key: 'user', label: 'User/Table', format: (v: any, row: any) => (
                    <span className="font-mono text-xs">{row.user ?? row.database ? `${row.database}.${row.table}` : v ?? '—'}</span>
                  )},
                  { key: 'detail', label: 'Detail', format: (v: any) => <span className="text-xs text-[var(--dim)] truncate block max-w-xs" title={v}>{v || '—'}</span> },
                  ...extraCols,
                  {
                    key: 'fix_hint',
                    label: '',
                    format: (v: any) => v
                      ? <button onClick={() => onRunQuery(v)} className="text-xs text-[var(--accent)] hover:underline font-mono truncate block max-w-xs text-left" title={v}>Run →</button>
                      : null,
                  },
                ]}
                data={group.tables ?? group.queries ?? []}
                maxHeight="280px"
              />
            )
          }
        </div>
      )}
    </div>
  )
}

function AntiPatternsTab({ instance, onShowQuery }: { instance: string; onShowQuery: (q: string) => void }) {
  const [queryAP, setQueryAP] = useState<any[] | null>(null)
  const [tableAP, setTableAP] = useState<any[] | null>(null)
  const [qLoading, setQLoading] = useState(false)
  const [tLoading, setTLoading] = useState(false)
  const [qError, setQError] = useState<string | null>(null)
  const [tError, setTError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const run = useCallback(() => {
    if (!instance) return
    setLoaded(true)
    setQLoading(true); setTLoading(true)
    setQError(null); setTError(null)

    api.advisor.queryAntiPatterns(instance)
      .then(d => setQueryAP(d))
      .catch(e => setQError(e?.message ?? 'Failed'))
      .finally(() => setQLoading(false))

    api.advisor.tableAntiPatterns(instance)
      .then(d => setTableAP(d))
      .catch(e => setTError(e?.message ?? 'Failed'))
      .finally(() => setTLoading(false))
  }, [instance])

  // Summary stats
  const qIssues = queryAP?.filter(g => g.count > 0).length ?? 0
  const tIssues = tableAP?.filter(g => g.count > 0).length ?? 0
  const qCrit = queryAP?.filter(g => g.count > 0 && g.severity === 'critical').length ?? 0
  const tCrit = tableAP?.filter(g => g.count > 0 && g.severity === 'critical').length ?? 0

  const qExtraCols = (group: any): Array<{ key: string; label: string; format?: (v: any) => React.ReactNode }> => {
    switch (group.type) {
      case 'high_memory': return [{ key: 'metric', label: 'Avg Memory', format: (v: any) => fmtBytes(v) }]
      case 'high_frequency': return [{ key: 'metric', label: 'Queries/h', format: (v: any) => fmtCompact(v) }]
      default: return [{ key: 'metric', label: 'Count', format: (v: any) => fmtCompact(v) }]
    }
  }

  const tExtraCols = (group: any): Array<{ key: string; label: string; format?: (v: any) => React.ReactNode }> => {
    switch (group.type) {
      case 'no_ttl_large':
      case 'no_partition':
      case 'large_granularity':
        return [{ key: 'size_human', label: 'Size' }, { key: 'metric', label: group.tables?.[0]?.metric_label ?? 'Value', format: (v: any) => fmtNum(v) }]
      default:
        return [{ key: 'metric', label: group.tables?.[0]?.metric_label ?? 'Value', format: (v: any) => fmtNum(v) }]
    }
  }

  if (!loaded) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <div className="text-center space-y-1">
          <p className="text-sm font-medium text-[var(--fg)]">Query & Table Anti-pattern Scanner</p>
          <p className="text-xs text-[var(--dim)] max-w-md">
            Detects SELECT *, full scans, no LIMIT, high memory queries, too many parts, mutation backlogs, wide PKs, and more.
          </p>
        </div>
        <button
          onClick={run}
          disabled={!instance}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <Play size={15} /> Run Anti-pattern Scan
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Summary + re-run */}
      <div className="flex items-center gap-4 flex-wrap">
        {queryAP && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--dim)]">Query:</span>
            <span className={cn('text-xs font-semibold', qCrit > 0 ? 'text-red-400' : qIssues > 0 ? 'text-yellow-400' : 'text-green-400')}>
              {qIssues} issue types{qCrit > 0 ? ` (${qCrit} critical)` : ''}
            </span>
          </div>
        )}
        {tableAP && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--dim)]">Table:</span>
            <span className={cn('text-xs font-semibold', tCrit > 0 ? 'text-red-400' : tIssues > 0 ? 'text-yellow-400' : 'text-green-400')}>
              {tIssues} issue types{tCrit > 0 ? ` (${tCrit} critical)` : ''}
            </span>
          </div>
        )}
        <button onClick={run} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-[var(--dim)] hover:text-[var(--fg)] border border-[var(--border)] hover:border-[var(--accent)] transition-colors">
          <RefreshCw size={12} /> Re-run
        </button>
      </div>

      {/* Query anti-patterns */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-orange-400 mb-3 flex items-center gap-2">
          <Skull size={13} /> Query Anti-patterns
          {qLoading && <span className="text-[var(--dim)] normal-case font-normal">Loading…</span>}
        </h3>
        {qError && <div className="text-xs text-red-400 mb-2">{qError}</div>}
        {queryAP && (
          <div className="space-y-2">
            {[...queryAP]
              .sort((a, b) => {
                const sev = { critical: 0, warn: 1, info: 2 }
                if (b.count !== a.count) return (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0)
                return (sev[a.severity as keyof typeof sev] ?? 3) - (sev[b.severity as keyof typeof sev] ?? 3)
              })
              .map(group => (
                <APGroupCard key={group.type} group={group} extraCols={qExtraCols(group)} onRunQuery={onShowQuery} />
              ))
            }
          </div>
        )}
      </div>

      {/* Table anti-patterns */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-blue-400 mb-3 flex items-center gap-2">
          <Wrench size={13} /> Table Design Anti-patterns
          {tLoading && <span className="text-[var(--dim)] normal-case font-normal">Loading…</span>}
        </h3>
        {tError && <div className="text-xs text-red-400 mb-2">{tError}</div>}
        {tableAP && (
          <div className="space-y-2">
            {[...tableAP]
              .sort((a, b) => {
                const sev = { critical: 0, warn: 1, info: 2 }
                if (b.count !== a.count) return (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0)
                return (sev[a.severity as keyof typeof sev] ?? 3) - (sev[b.severity as keyof typeof sev] ?? 3)
              })
              .map(group => (
                <APGroupCard key={group.type} group={group} extraCols={tExtraCols(group)} onRunQuery={onShowQuery} />
              ))
            }
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main Explore Component                                             */
/* ------------------------------------------------------------------ */

export default function Explore({ refreshKey }: { refreshKey?: number }) {
  const { instances, selectedInstance, setSelectedInstance, setView, from, to } = useStore()

  // Read initial tab from URL params (set by Discover page navigation)
  const [tab, setTab] = useState<Tab>(() => {
    const p = new URLSearchParams(window.location.search)
    const t = p.get('tab') as Tab | null
    const validTabs: Tab[] = ['antipatterns','patterns','samples','live','users','failures','merges','mvs','s3','inserts','metrics','diskio','partsage']
    return t && validTabs.includes(t) ? t : 'patterns'
  })
  const [queryModal, setQueryModal] = useState<string | null>(null)
  // Drill state: clicking "Samples →" or "FAILS" in Patterns tab navigates to Samples with filter pre-set.
  const [drillHash, setDrillHash] = useState<string | undefined>()
  const [drillUser, setDrillUser] = useState<string | undefined>()
  const [drillErrorsOnly, setDrillErrorsOnly] = useState(false)
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
    setDrillErrorsOnly(false)
    setTab('samples')
  }, [])

  const handleDrillFail = useCallback((hash: string) => {
    setDrillHash(hash)
    setDrillUser(undefined)
    setDrillErrorsOnly(true)
    setTab('samples')
  }, [])

  const handleDrillUser = useCallback((user: string) => {
    setDrillUser(user)
    setDrillHash(undefined)
    setDrillErrorsOnly(false)
    setTab('samples')
  }, [])

  const handleClearDrill = useCallback(() => {
    setDrillHash(undefined)
    setDrillUser(undefined)
    setDrillErrorsOnly(false)
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
          {tab === 'antipatterns' && (
            <AntiPatternsTab instance={inst} onShowQuery={handleShowQuery} />
          )}
          {tab === 'patterns' && (
            <QueryPatternsTab
              instance={inst} from={from} to={to} refreshKey={refreshKey}
              onAnalyze={handleAnalyze} onShowQuery={handleShowQuery}
              onDrillHash={handleDrillHash}
              onDrillFail={handleDrillFail}
            />
          )}
          {tab === 'samples' && (
            <SamplesTab
              instance={inst} from={from} to={to} refreshKey={refreshKey}
              onAnalyze={handleAnalyze} onShowQuery={handleShowQuery}
              initialHash={drillHash}
              initialUser={drillUser}
              initialErrorsOnly={drillErrorsOnly}
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
