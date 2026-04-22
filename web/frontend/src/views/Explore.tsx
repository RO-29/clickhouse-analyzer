import { useState, useEffect, useMemo, useCallback, useRef, type ChangeEvent } from 'react'
import { Sparkles, X, Copy, Play, Maximize2, Minimize2, Skull, RefreshCw, ChevronDown, ChevronRight, Wrench, ArrowRight, BarChart2, AlertTriangle, ExternalLink, Zap } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell, PieChart, Pie, Legend } from 'recharts'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { fmtBytes, fmtNum, fmtDuration, fmtCompact, cn, latencyBg, kindBg, tokenizeSql } from '../lib/utils'
import { Card } from '../components/Card'
import { HistoryChart } from '../components/HistoryChart'
import { DataTable } from '../components/DataTable'

import type {
  QueryPattern,
  QueryPatternV2,
  QuerySample,
  QueryUser,
  QueryTable,
  ConnectionsResponse,
  PatternOverviewResponse,
  HistoryFailure,
  HistoryMerge,
  HistoryInsert,
  HistoryS3,
  HistoryAsyncMetric,
  S3Stats,
  S3LatencyByTableRow,
  PartsAgeEntry,
} from '../types/api'
import type { AnalyzeOptions } from '../hooks/useAIAnalysis'

type Tab =
  | 'patterns'
  | 'samples'
  | 'querylog'
  | 'live'
  | 'connections'
  | 'users'
  | 'tables'
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
  { key: 'antipatterns', label: 'Anti-patterns' },
  { key: 'patterns', label: 'Query Patterns' },
  { key: 'samples', label: 'Samples' },
  { key: 'querylog', label: 'Query Log' },
  { key: 'live', label: 'Live Queries' },
  { key: 'connections', label: 'Connections' },
  { key: 'users', label: 'Users' },
  { key: 'tables', label: 'Tables' },
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
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(query)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
      .catch(() => {})
  }
  const handleRun = () => { navToTerminal(query, instance); onClose() }

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-4xl bg-[var(--card)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)] shrink-0 bg-[var(--surface)]">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--dim)]">Query</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--hover)] text-[var(--dim)] border border-[var(--border)] font-mono">SQL</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--border)] text-[11px] text-[var(--dim)] hover:text-[var(--text)] hover:border-[var(--accent)]/40 transition-colors"
            >
              <Copy size={11} />
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              onClick={handleRun}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent)] text-white text-[11px] font-medium hover:bg-[var(--accent-hover)] transition-colors"
            >
              <Play size={11} />
              Run in Terminal
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--hover)] transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        {/* Query body */}
        <div className="flex-1 overflow-auto p-5 bg-[var(--bg)]">
          <pre className="font-mono text-[12px] text-[var(--text)] whitespace-pre-wrap break-all leading-[1.7] tracking-tight">
            {query}
          </pre>
        </div>
        {/* Footer hint */}
        <div className="px-5 py-2 border-t border-[var(--border)] bg-[var(--surface)] shrink-0">
          <span className="text-[10px] text-[var(--dim)]">Press <kbd className="px-1.5 py-0.5 rounded bg-[var(--hover)] border border-[var(--border)] font-mono text-[10px]">Esc</kbd> to close</span>
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

/* ── Tables list cell — truncates to 2 visible + "+N more" ───────────────── */

function shortTableName(t: string): string {
  const s = String(t || '')
  return s.startsWith('default.') ? s.slice('default.'.length) : s
}

// inferTablesFromQuery extracts table references from a query string as a
// fallback when system.processes.tables / query_samples.tables are empty
// (older CH doesn't populate those columns for in-flight queries). Not a full
// SQL parser — misses subqueries, CTEs, lateral joins — but catches the
// common FROM/INTO/JOIN cases that cover ~90% of real queries.
function inferTablesFromQuery(sql: string): string[] {
  if (!sql) return []
  const seen = new Set<string>()
  // (?:FROM|INTO|JOIN|UPDATE|OPTIMIZE\s+TABLE)  →  optional backtick  →
  // ident (db.table | table)  →  optional backtick. Case-insensitive.
  const re = /\b(?:FROM|INTO|JOIN|UPDATE|OPTIMIZE\s+TABLE)\s+`?([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)`?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    const t = m[1]
    // Drop FORMAT clause noise and system-internal targets.
    if (!t || t.toUpperCase() === 'FORMAT') continue
    if (t.startsWith('system.') || t.startsWith('information_schema.')) continue
    seen.add(t)
  }
  return Array.from(seen)
}

function TablesCell({ tables, onSelect, inferred }: { tables: string[]; onSelect?: (table: string) => void; inferred?: boolean }) {
  if (!tables || tables.length === 0) {
    return <span className="text-[var(--dim)] text-[11px]">—</span>
  }
  const visible = tables.slice(0, 2)
  const rest = tables.slice(2)
  const full = tables.join('\n')
  const inferredTitle = inferred ? ' (inferred from query text)' : ''
  return (
    <span className="flex items-center gap-1 flex-wrap max-w-[220px]" title={full + inferredTitle}>
      {visible.map((t, i) => {
        const short = shortTableName(t)
        const pill = (
          <span
            key={i}
            className={cn(
              'inline-flex px-1.5 py-0.5 rounded border font-mono text-[10px] truncate max-w-[140px]',
              inferred && 'opacity-70 border-dashed',
              onSelect
                ? 'border-[var(--border)] bg-[var(--hover)] text-[var(--text)] hover:border-[var(--accent)]/40 hover:text-[var(--accent)] cursor-pointer'
                : 'border-[var(--border)] bg-[var(--hover)] text-[var(--text)]',
            )}
            title={t + inferredTitle}
            onClick={onSelect ? (e) => { e.stopPropagation(); onSelect(t) } : undefined}
          >
            {short}
          </span>
        )
        return pill
      })}
      {rest.length > 0 && (
        <span
          className="text-[10px] text-[var(--dim)] shrink-0"
          title={rest.join('\n')}
        >
          +{rest.length} more
        </span>
      )}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/*  Query Detail Panel — Datadog-style right slide-in                 */
/* ------------------------------------------------------------------ */

interface QueryDetailPanelProps {
  pattern: QueryPatternV2
  timeline: Record<string, any>[]
  tlLoading: boolean
  instance: string
  onClose: () => void
  onDrillHash?: (hash: string, opts?: { table?: string }) => void
  onAnalyze: TabProps['onAnalyze']
  onShowQuery: (q: string) => void
}

function QueryDetailPanel({ pattern, timeline, tlLoading, instance, onClose, onDrillHash, onAnalyze, onShowQuery }: QueryDetailPanelProps) {
  const [panelTab, setPanelTab] = useState<'metrics' | 'query'>('metrics')
  const [sqlCopied, setSqlCopied] = useState(false)
  const [patternFullscreen, setPatternFullscreen] = useState(false)
  const hash = String(pattern.normalized_query_hash)

  const handleCopySql = () => {
    navigator.clipboard.writeText(pattern.sample_query)
      .then(() => { setSqlCopied(true); setTimeout(() => setSqlCopied(false), 1500) })
      .catch(() => {})
  }

  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const statChips = [
    { label: 'Executions', value: fmtCompact(pattern.cnt) },
    { label: 'Avg', value: fmtDuration(pattern.avg_ms), color: latencyBg(pattern.avg_ms) },
    { label: 'P95', value: fmtDuration(pattern.p95_ms), color: latencyBg(pattern.p95_ms) },
    { label: 'Total CPU', value: fmtDuration(pattern.total_ms) },
    { label: 'Rd Bytes', value: fmtBytes(pattern.avg_read_bytes) },
    { label: 'Rd Rows', value: fmtCompact(pattern.avg_read_rows) },
    { label: 'Failures', value: fmtCompact(pattern.failures), color: pattern.failures > 0 ? 'text-red-400' : '' },
  ]

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
      />
      {/* Panel */}
      <div className={cn(
        'fixed z-50 flex flex-col bg-[var(--card)] border-[var(--border)] shadow-2xl',
        patternFullscreen
          ? 'inset-0'
          : 'right-0 top-0 h-full border-l w-full sm:w-[45vw] sm:min-w-[440px] max-w-full',
      )}>

        {/* ── Header ── */}
        <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)]">
          {/* SQL preview row */}
          <div className="flex items-center gap-2 px-4 py-3">
            <button
              onClick={() => onShowQuery(pattern.sample_query)}
              className="flex-1 min-w-0 text-left"
            >
              <div className="font-mono text-[11px] text-[var(--text)] truncate leading-relaxed" title={pattern.sample_query}>
                <SqlHighlight text={pattern.sample_query} maxLen={90} />
              </div>
            </button>
            <button
              onClick={() => onShowQuery(pattern.sample_query)}
              className="shrink-0 p-1 rounded text-[var(--dim)] hover:text-[var(--accent)] transition-colors"
              title="View full query"
            >
              <Maximize2 size={12} />
            </button>
            <button
              onClick={() => setPatternFullscreen(v => !v)}
              className="shrink-0 p-1 rounded text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--hover)] transition-colors"
              title={patternFullscreen ? 'Restore panel' : 'Maximize panel'}
            >
              {patternFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button
              onClick={onClose}
              className="shrink-0 p-1 rounded text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--hover)] transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          {/* Meta row */}
          <div className="flex items-center gap-3 px-4 pb-2.5">
            <span className="font-mono text-[10px] text-[var(--accent)] bg-[var(--accent-subtle)] px-1.5 py-0.5 rounded border border-[var(--accent)]/20">
              {hash.slice(0, 12)}
            </span>
            <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', kindBg(pattern.kind))}>
              {pattern.kind || 'SELECT'}
            </span>
            {pattern.user && (
              <span className="text-[10px] text-[var(--dim)]">user: <span className="text-[var(--text)]">{pattern.user}</span></span>
            )}
            <button
              onClick={() => onDrillHash?.(hash)}
              className="ml-auto flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
            >
              Samples <ArrowRight size={10} />
            </button>
          </div>
        </div>

        {/* ── Stat chips ── */}
        <div className="shrink-0 grid grid-cols-7 border-b border-[var(--border)]">
          {statChips.map(chip => (
            <div key={chip.label} className="flex flex-col items-center justify-center py-3 border-r border-[var(--border)] last:border-0">
              <div className={cn('text-[13px] font-bold tabular-nums', chip.color)}>{chip.value}</div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--dim)] mt-0.5">{chip.label}</div>
            </div>
          ))}
        </div>

        {/* ── Sub-tabs ── */}
        <div className="shrink-0 flex border-b border-[var(--border)]">
          {(['metrics', 'query'] as const).map(t => (
            <button
              key={t}
              onClick={() => setPanelTab(t)}
              className={cn(
                'px-5 py-2 text-[12px] capitalize relative transition-colors',
                panelTab === t
                  ? 'text-[var(--accent)] font-medium after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-[var(--accent)]'
                  : 'text-[var(--dim)] hover:text-[var(--text)]',
              )}
            >
              {t === 'metrics' ? 'Metrics' : 'Query'}
            </button>
          ))}
          <div className="flex-1" />
          <button
            onClick={() => onAnalyze(`Query ${hash.slice(0, 8)}`, { row: pattern, timeline }, { contextType: 'row', tab: 'patterns', elementId: hash })}
            className="flex items-center gap-1 px-3 py-2 text-[11px] text-[var(--accent)] hover:bg-[var(--accent-subtle)] transition-colors"
          >
            <Sparkles size={10} /> Analyze
          </button>
        </div>

        {/* ── Content ── */}
        <div className="flex-1 overflow-y-auto">
          {panelTab === 'metrics' && (
            <div className="p-4 space-y-4">
              {tlLoading ? (
                <div className="space-y-3">
                  {[140, 140, 100].map((h, i) => (
                    <div key={i} className="rounded-lg bg-[var(--surface)] animate-pulse" style={{ height: h }} />
                  ))}
                </div>
              ) : timeline.length === 0 ? (
                <div className="text-[12px] text-[var(--dim)] text-center py-12 border border-[var(--border)] rounded-lg">
                  No timeline data in this range — try expanding the time window.
                </div>
              ) : (
                <>
                  <HistoryChart
                    title="Latency — Avg / P95 / Max"
                    data={timeline}
                    series={[
                      { key: 'avg_ms', label: 'Avg', color: C.green },
                      { key: 'p95_ms', label: 'P95', color: C.yellow },
                      { key: 'max_ms', label: 'Max', color: C.red },
                    ]}
                    yFormat="ms"
                    height={140}
                    onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                  />
                  <HistoryChart
                    title="Executions & Failures"
                    data={timeline}
                    series={[
                      { key: 'cnt', label: 'Execs', color: C.blue },
                      { key: 'failures', label: 'Failures', color: C.red },
                    ]}
                    height={110}
                    onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                  />
                  <HistoryChart
                    title="Memory & Read Bytes"
                    data={timeline}
                    series={[
                      { key: 'avg_memory', label: 'Memory', color: C.purple },
                      { key: 'avg_read_bytes', label: 'Read Bytes', color: C.cyan },
                    ]}
                    yFormat="bytes"
                    height={110}
                    onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                  />
                  {timeline.some(r => Number(r.avg_read_rows) > 0) && (
                    <HistoryChart
                      title="Rows Read"
                      data={timeline}
                      series={[{ key: 'avg_read_rows', label: 'Rows', color: C.orange }]}
                      height={90}
                      onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                    />
                  )}
                  <HistoryChart
                    title="Mark Cache Hit Rate %"
                    data={timeline}
                    series={[{ key: 'avg_mark_cache_hit_pct', label: 'Hit %', color: C.cyan }]}
                    note="No disk index reads — data served from cache"
                    height={90}
                    onAnalyze={(d, s, t) => onAnalyze(t, { data: d, series: s }, { contextType: 'chart', tab: 'patterns' })}
                  />
                </>
              )}
            </div>
          )}

          {panelTab === 'query' && (
            <div className="p-4 space-y-3">
              {/* Full SQL */}
              <div className="rounded-lg border border-[var(--border)] overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-[var(--surface)] border-b border-[var(--border)]">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--dim)]">SQL</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleCopySql}
                      className="flex items-center gap-1 text-[10px] text-[var(--dim)] hover:text-[var(--text)] transition-colors"
                    >
                      <Copy size={10} /> {sqlCopied ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                      onClick={() => onShowQuery(pattern.sample_query)}
                      className="flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline"
                    >
                      <Maximize2 size={10} /> Expand
                    </button>
                  </div>
                </div>
                <div className="p-3 bg-[var(--bg)] max-h-[400px] overflow-auto">
                  <pre className="font-mono text-[11px] leading-[1.7] whitespace-pre-wrap break-all text-[var(--text)]">
                    {pattern.sample_query}
                  </pre>
                </div>
              </div>

              {/* Pattern metadata */}
              <div className="rounded-lg border border-[var(--border)] overflow-hidden">
                <div className="px-3 py-2 bg-[var(--surface)] border-b border-[var(--border)]">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--dim)]">Pattern Info</span>
                </div>
                <div className="divide-y divide-[var(--border)]">
                  {[
                    ['Hash', hash],
                    ['Kind', pattern.kind],
                    ['User', pattern.user || '—'],
                    ['Client', pattern.client || '—'],
                    ['Avg Memory', fmtBytes(pattern.avg_memory)],
                    ['Max Memory', fmtBytes(pattern.max_memory)],
                    ['Max Duration', fmtDuration(pattern.max_ms)],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center px-3 py-1.5 text-[11px]">
                      <span className="text-[var(--dim)] w-28 shrink-0">{k}</span>
                      <span className="font-mono text-[var(--text)] truncate" title={String(v ?? '')}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
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
  onDrillHash?: (hash: string, opts?: { user?: string; table?: string }) => void
  onDrillFail?: (hash: string) => void
  onFetched?: () => void
}

function QueryPatternsTab({ instance, from, to, refreshKey, onAnalyze, onShowQuery, onDrillHash, onDrillFail, onFetched }: QueryPatternsTabProps) {
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
      .finally(() => { if (!c) { setLoading(false); onFetched?.() } })
    return () => { c = true }
  }, [instance, from, to, refreshKey, sortBy, onFetched])

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

  // Deep-link: ?hash=<value> auto-opens the detail panel for that pattern
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const hash = params.get('hash')
    if (hash && patterns.length > 0) {
      const match = patterns.find(p => String(p.normalized_query_hash) === hash)
      if (match) setSelectedHash(hash)
      params.delete('hash')
      const qs = params.toString()
      window.history.replaceState(null, '', qs ? '?' + qs : window.location.pathname)
    }
  }, [patterns])

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

  // ── Recharts stacked bar data for overview ─────────────────────────────────
  const COLORS = ['#7c3aed','#22c55e','#f59e0b','#ef4444','#3b82f6','#06b6d4','#f97316','#ec4899']
  const { stackedChartData, patternKeys } = (() => {
    if (!overview || !overview.timeline?.length || !overview.patterns?.length) return { stackedChartData: null, patternKeys: [] }
    const allTs = [...new Set(overview.timeline.map(r => r.ts))].sort()
    const fmtTs = (ts: string) => {
      const d = new Date(ts)
      return isNaN(d.getTime()) ? ts : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    }
    const keys = overview.patterns.map(p => String(p.normalized_query_hash).slice(0, 10))
    const data = allTs.map(ts => {
      const row: Record<string, any> = { ts: fmtTs(ts) }
      overview.patterns.forEach((p, i) => {
        const rec = overview.timeline.find(r => r.ts === ts && String(r.normalized_query_hash) === String(p.normalized_query_hash))
        row[keys[i]] = rec ? Number(rec.total_ms) || 0 : 0
      })
      return row
    })
    return { stackedChartData: data, patternKeys: keys }
  })()

  // ── table columns — Datadog order: query first, then metrics ─────────────
  const columns: any[] = [
    {
      key: 'sample_query',
      label: 'Query Statement',
      tooltip: 'Normalized query pattern — parameters stripped. Click row to open detail panel.',
      className: 'max-w-0 w-full',
      format: (v: any, row: any) => {
        const q = String(v ?? '')
        const kind = String(row.kind || '')
        return (
          <span className="flex items-center gap-2 min-w-0">
            <span className={cn('shrink-0 text-[9px] px-1 py-0.5 rounded font-semibold uppercase tracking-wide', kindBg(kind))}>
              {kind.slice(0, 3) || 'SQL'}
            </span>
            <span className="truncate min-w-0 font-mono text-[11px]" title={q}>
              <SqlHighlight text={q} maxLen={80} />
            </span>
            {q && (
              <button
                onClick={e => { e.stopPropagation(); setSelectedHash(prev => { const h = String(row.normalized_query_hash); return prev === h ? null : h }) }}
                className="shrink-0 p-0.5 rounded text-[var(--dim)] hover:text-[var(--accent)] opacity-0 group-hover/row:opacity-100 transition-all"
                title="Open detail panel"
              >
                <Maximize2 size={10} />
              </button>
            )}
          </span>
        )
      },
    },
    {
      key: 'cnt',
      label: 'Count',
      tooltip: 'Total executions in selected time range',
      format: (v: any) => <span className="tabular-nums text-[11px]">{fmtCompact(v)}</span>,
    },
    {
      key: 'avg_ms',
      label: 'Avg Duration',
      tooltip: 'Average query duration. Green <1s · Amber 1–10s · Red >10s',
      format: (v: any) => (
        <span className={cn('inline-flex px-1.5 py-0.5 rounded text-[11px] tabular-nums font-medium', latencyBg(v))}>
          {fmtDuration(v)}
        </span>
      ),
    },
    {
      key: 'total_ms',
      label: 'Total Duration',
      tooltip: 'Sum of all execution times — bar shows share of total load',
      format: (v: any, row: any) => (
        <span className="flex items-center gap-1.5 min-w-[90px]">
          <span className="tabular-nums text-[11px]">{fmtDuration(v)}</span>
          <span
            className="h-1 rounded-full shrink-0 bg-[var(--accent)] opacity-50"
            style={{ width: `${Math.max(3, ((row.total_ms || 0) / maxTotalMs) * 40)}px` }}
          />
        </span>
      ),
    },
    {
      key: 'total_cpu_ms',
      label: 'CPU Time',
      tooltip: 'Sum of CPU time across all executions — present when ProfileEvents.OSCPUVirtualTimeMicroseconds is available',
      format: (v: any) => v == null ? <span className="text-[var(--dim)] text-[11px]">—</span>
        : <span className="tabular-nums text-[11px] text-[var(--dim)]">{fmtDuration(Number(v) || 0)}</span>,
    },
    {
      key: 'tables',
      label: 'Tables',
      tooltip: 'db.table names this query pattern touches. Click a table to drill into Samples filtered by that table.',
      format: (v: any, row: any) => (
        <TablesCell
          tables={Array.isArray(v) ? v : []}
          onSelect={onDrillHash ? (t) => onDrillHash(String(row.normalized_query_hash), { table: t }) : undefined}
        />
      ),
    },
    {
      key: 'avg_read_bytes',
      label: 'Avg Read Bytes',
      tooltip: 'Average bytes read from disk per execution',
      format: (v: any) => <span className="tabular-nums text-[11px] text-[var(--dim)]">{fmtBytes(v)}</span>,
    },
    {
      key: 'avg_read_rows',
      label: 'Avg Read Rows',
      tooltip: 'Average rows scanned per execution',
      format: (v: any) => <span className="tabular-nums text-[11px] text-[var(--dim)]">{fmtCompact(v)}</span>,
    },
    {
      key: 'avg_memory',
      label: 'Avg Memory',
      tooltip: 'Average peak memory per execution',
      format: (v: any) => v == null ? <span className="text-[var(--dim)] text-[11px]">—</span>
        : <span className="tabular-nums text-[11px] text-[var(--dim)]">{fmtBytes(Number(v) || 0)}</span>,
    },
    {
      key: 'p95_ms',
      label: 'P95',
      tooltip: '95th-percentile latency',
      format: (v: any) => (
        <span className={cn('inline-flex px-1.5 py-0.5 rounded text-[11px] tabular-nums', latencyBg(v))}>
          {fmtDuration(v)}
        </span>
      ),
    },
    {
      key: 'failures',
      label: 'Errors',
      tooltip: 'Executions that raised an exception. Click to drill into failure details.',
      format: (v: any, row: any) => {
        const n = Number(v)
        const hash = String(row.normalized_query_hash)
        if (n === 0) return <span className="text-[var(--dim)] text-[11px]">—</span>
        return (
          <button
            onClick={e => { e.stopPropagation(); onDrillFail?.(hash) }}
            className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
            title="Click to see failed query samples"
          >
            {fmtCompact(n)}
          </button>
        )
      },
    },
    ...(onDrillHash ? [{
      key: '_drill',
      label: '',
      format: (_v: any, row: any) => (
        <button
          onClick={(e: any) => { e.stopPropagation(); onDrillHash(String(row.normalized_query_hash)) }}
          className="text-[11px] text-[var(--accent)] hover:underline whitespace-nowrap opacity-0 group-hover/row:opacity-100 transition-opacity"
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

      {/* ── Overview: stacked bar chart ── */}
      {stackedChartData && (
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)]">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--dim)]">% Overview</span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[var(--dim)]">Average load by query pattern</span>
              <AnalyzeTabBtn label="Query Patterns" data={{ patterns }} tab="patterns" onAnalyze={onAnalyze} disabled={patterns.length === 0} />
            </div>
          </div>
          <div className="px-4 pt-3 pb-2" style={{ height: 180 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stackedChartData} margin={{ top: 4, right: 4, bottom: 4, left: 0 }}>
                <XAxis dataKey="ts" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} tickFormatter={(v) => fmtDuration(Number(v))} axisLine={false} tickLine={false} width={42} />
                <Tooltip
                  contentStyle={{ background: '#0f1420', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 11 }}
                  formatter={(v: any, name: any) => [fmtDuration(Number(v)), name]}
                  cursor={{ fill: 'rgba(124,58,237,0.06)' }}
                />
                {patternKeys.map((k, i) => (
                  <Bar key={k} dataKey={k} stackId="a" fill={COLORS[i % COLORS.length]} fillOpacity={0.85} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* Legend */}
          <div className="px-4 pb-2.5 flex items-center gap-3 flex-wrap border-t border-[var(--border)] pt-2">
            {patternKeys.slice(0, 8).map((k, i) => (
              <span key={k} className="flex items-center gap-1.5 text-[10px] text-[var(--dim)]">
                <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                {k}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Queries section ── */}
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)]">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--dim)]">% Queries</span>
            <span className="text-[11px] text-[var(--dim)]">
              Showing 1–{Math.min(patterns.length, 50)} of {patterns.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-[var(--dim)]">Sort</label>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value)}
              className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--text)] focus:outline-none focus:border-[var(--accent)]"
            >
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
        {patterns.length > 0 && (
          <div className="text-[10px] text-[var(--dim)] px-1 mb-1">
            {patterns.length} patterns{patterns.length === 1000 ? ' (limit reached — narrow the time range)' : ''}
          </div>
        )}
        <DataTable
          columns={columns}
          data={patterns}
          onRowClick={r => setSelectedHash(prev => {
            const hash = String(r.normalized_query_hash)
            return prev === hash ? null : hash
          })}
          onRowAnalyze={row => {
            if (!row) return
            onAnalyze(
              `Query: ${String(row.normalized_query_hash).slice(0, 12)}`,
              { row, allPatterns: patterns },
              { contextType: 'row', tab: 'patterns', elementId: String(row.normalized_query_hash) },
            )
          }}
          emptyText="No query patterns found"
          showColumnToggle={true}
          storageKey="explore-patterns"
        />
      </div>

      {/* ── Failure Detail Panel ─────────────────────────────────── */}
      {failHash && (
        <div className="space-y-3 mt-2">
          <div className="flex items-center gap-2 px-1">
            <span className="text-xs font-semibold text-red-400 uppercase tracking-wider">
              Failure Detail — hash {failHash.slice(0, 14)}
            </span>
            <span className="text-[11px] text-[var(--dim)] truncate max-w-md font-mono" title={patterns.find(p => String(p.normalized_query_hash) === failHash)?.sample_query ?? ''}>
              {patterns.find(p => String(p.normalized_query_hash) === failHash)?.sample_query ?? ''}
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

      {/* ── Slide-in detail panel ── */}
      {selectedHash && (() => {
        const pattern = patterns.find(p => String(p.normalized_query_hash) === selectedHash)
        if (!pattern) return null
        return (
          <QueryDetailPanel
            pattern={pattern}
            timeline={timeline}
            tlLoading={tlLoading}
            instance={instance}
            onClose={() => setSelectedHash(null)}
            onDrillHash={onDrillHash}
            onAnalyze={onAnalyze}
            onShowQuery={onShowQuery}
          />
        )
      })()}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Connections Tab                                                    */
/*                                                                     */
/*  Summarises who is currently talking to this CH. Two data sources:  */
/*   - system.metrics: total connections per interface (incl. idle)    */
/*   - system.processes: per-client view (only clients with at least   */
/*     one running query; CH doesn't expose idle-connection detail).   */
/* ------------------------------------------------------------------ */

function ConnectionsTab({ instance, onShowQuery: _onShowQuery }: TabProps) {
  const [data, setData] = useState<ConnectionsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api.history.connections(instance)
      .then(d => { setData(d); setError(null) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [instance])

  useEffect(() => {
    setLoading(true)
    load()
    const id = setInterval(load, 5000) // live refresh
    return () => clearInterval(id)
  }, [load])

  if (loading && !data) return <LoadingSkeleton />
  if (error && !data) return <ErrorBox message={error} />
  if (!data) return null

  const ifaces: Array<{ key: keyof ConnectionsResponse['by_interface']; label: string; color: string }> = [
    { key: 'TCPConnection',          label: 'TCP',        color: C.blue },
    { key: 'HTTPConnection',         label: 'HTTP',       color: C.green },
    { key: 'MySQLConnection',        label: 'MySQL',      color: C.orange },
    { key: 'PostgreSQLConnection',   label: 'PostgreSQL', color: C.purple },
    { key: 'InterserverConnection',  label: 'Interserver', color: C.cyan },
  ]

  const grandTotal = ifaces.reduce((s, i) => s + (data.by_interface?.[i.key] ?? 0), 0)

  return (
    <div className="space-y-4">
      {/* Stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Total connections" value={String(grandTotal)} sub="incl. idle" />
        {ifaces.map(i => {
          const v = data.by_interface?.[i.key] ?? 0
          return (
            <StatCard
              key={i.key}
              label={i.label}
              value={String(v)}
              color={v > 0 ? i.color : undefined}
            />
          )
        })}
      </div>

      {/* Active clients (with running queries) */}
      <Card noPad>
        <div className="px-3 py-2 flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)]">
          <span className="text-xs font-semibold text-[var(--dim)] uppercase tracking-wider">
            Active Clients · {data.active.length}
          </span>
          <span className="text-[11px] text-[var(--dim)]">
            {data.total_active_queries} running quer{data.total_active_queries === 1 ? 'y' : 'ies'}
          </span>
          <span className="ml-auto text-[10px] text-[var(--dim)]">
            only clients with ≥1 running query — idle clients aren&apos;t visible here
          </span>
        </div>
        {data.active.length === 0 ? (
          <div className="text-sm text-[var(--dim)] text-center py-10">
            No running queries right now.
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {/* Header */}
            <div className="grid gap-2 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)] bg-[var(--surface)]"
                 style={{ gridTemplateColumns: '170px 120px 70px 80px 90px 90px 1fr' }}>
              <span>Address</span>
              <span>User</span>
              <span>Iface</span>
              <span className="text-right">Queries</span>
              <span className="text-right">Oldest</span>
              <span className="text-right">Memory</span>
              <span>Client / UA</span>
            </div>
            {data.active.map((c, i) => {
              const addr = c.initial_address || '—'
              const agent = c.http_user_agent || c.client_name || ''
              const fwd = c.forwarded_for
              const oldest = Number(c.oldest_query_sec) || 0
              const oldestColor = oldest > 300 ? 'text-red-400'
                : oldest > 60 ? 'text-orange-400'
                : oldest > 10 ? 'text-yellow-400'
                : 'text-[var(--dim)]'
              return (
                <div
                  key={i}
                  className="grid gap-2 px-3 py-2 text-xs hover:bg-[var(--hover)] transition-colors"
                  style={{ gridTemplateColumns: '170px 120px 70px 80px 90px 90px 1fr' }}
                >
                  <span className="font-mono text-[var(--fg)] truncate" title={addr + (fwd ? ` (fwd: ${fwd})` : '')}>
                    {addr}
                  </span>
                  <span className="truncate text-[var(--dim)]" title={c.user}>{c.user || '—'}</span>
                  <span>
                    <span className="inline-flex px-1.5 py-0.5 rounded bg-[var(--hover)] border border-[var(--border)] text-[10px] font-mono">
                      {c.interface_name}
                    </span>
                  </span>
                  <span className="text-right font-mono tabular-nums text-[var(--fg)]">
                    {c.active_queries}
                  </span>
                  <span className={cn('text-right font-mono tabular-nums', oldestColor)}>
                    {oldest > 0 ? fmtDuration(oldest * 1000) : '—'}
                  </span>
                  <span className="text-right font-mono tabular-nums text-[var(--dim)]">
                    {Number(c.total_memory) > 0 ? fmtBytes(Number(c.total_memory)) : '—'}
                  </span>
                  <span className="truncate text-[var(--dim)] font-mono text-[11px]" title={agent}>
                    {agent || '—'}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Query Log Tab                                                      */
/*                                                                     */
/*  A free-form query browser — different from Samples, which is       */
/*  optimized for drilling in from a specific pattern hash. This tab   */
/*  lets operators sift through every query that ran in range, filter  */
/*  by user / kind / status / table / min duration, and full-text      */
/*  search the query body. Reuses the /api/instances/:inst/query-      */
/*  samples endpoint with the ?q= and ?offset= params we just added.   */
/* ------------------------------------------------------------------ */

function QueryLogTab({ instance, from, to, refreshKey, onShowQuery }: TabProps) {
  const PAGE_SIZE = 200

  const [rows, setRows] = useState<QuerySample[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exhausted, setExhausted] = useState(false)

  // Filters
  const [searchRaw, setSearchRaw] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [userFilter, setUserFilter] = useState('')
  const [kindFilter, setKindFilter] = useState<'' | 'Select' | 'Insert' | 'Alter' | 'System' | 'Create' | 'Drop'>('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'error'>('all')
  const [tableRaw, setTableRaw] = useState('')
  const [tableQuery, setTableQuery] = useState('')
  const [minMs, setMinMs] = useState<string>('')

  // Debounce search + table inputs so we don't fire a CH query per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setSearchQuery(searchRaw.trim()), 300)
    return () => clearTimeout(id)
  }, [searchRaw])
  useEffect(() => {
    const id = setTimeout(() => setTableQuery(tableRaw.trim()), 300)
    return () => clearTimeout(id)
  }, [tableRaw])

  const filterKey = `${instance}|${from}|${to}|${searchQuery}|${userFilter}|${kindFilter}|${statusFilter}|${tableQuery}|${minMs}|${refreshKey ?? 0}`

  // Initial load + reload when any filter changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setExhausted(false)
    api.history.querySamples(instance, from, to, {
      limit: PAGE_SIZE,
      offset: 0,
      user: userFilter || undefined,
      kind: kindFilter || undefined,
      minMs: minMs || undefined,
      errorsOnly: statusFilter === 'error' || undefined,
      table: tableQuery || undefined,
      q: searchQuery || undefined,
    })
      .then(d => {
        if (cancelled) return
        const list = Array.isArray(d) ? d : []
        setRows(list)
        if (list.length < PAGE_SIZE) setExhausted(true)
      })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  const loadMore = useCallback(() => {
    if (loadingMore || exhausted) return
    setLoadingMore(true)
    api.history.querySamples(instance, from, to, {
      limit: PAGE_SIZE,
      offset: rows.length,
      user: userFilter || undefined,
      kind: kindFilter || undefined,
      minMs: minMs || undefined,
      errorsOnly: statusFilter === 'error' || undefined,
      table: tableQuery || undefined,
      q: searchQuery || undefined,
    })
      .then(d => {
        const list = Array.isArray(d) ? d : []
        if (list.length === 0) setExhausted(true)
        else {
          setRows(prev => [...prev, ...list])
          if (list.length < PAGE_SIZE) setExhausted(true)
        }
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }, [instance, from, to, rows.length, loadingMore, exhausted,
      userFilter, kindFilter, statusFilter, tableQuery, minMs, searchQuery])

  const resetFilters = () => {
    setSearchRaw('')
    setUserFilter('')
    setKindFilter('')
    setStatusFilter('all')
    setTableRaw('')
    setMinMs('')
  }

  const totalShown = rows.length
  const statusSuccess = statusFilter === 'success'
    ? rows.filter(r => !r.is_exception)
    : rows
  const displayRows = statusSuccess

  // Client-side "success only" filter because the server only has
  // errors_only (not success_only). Cheap — everything returned is already
  // paginated server-side.
  if (loading && rows.length === 0) return <LoadingSkeleton />
  if (error && rows.length === 0) return <ErrorBox message={error} />

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={searchRaw}
            onChange={e => setSearchRaw(e.target.value)}
            placeholder="Search query text…"
            className="flex-1 min-w-[200px] bg-[var(--surface)] border border-[var(--border)] rounded-md px-3 py-1.5 text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
          />
          <input
            type="text"
            value={userFilter}
            onChange={e => setUserFilter(e.target.value)}
            placeholder="User"
            className="w-28 bg-[var(--surface)] border border-[var(--border)] rounded-md px-3 py-1.5 text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
          />
          <select
            value={kindFilter}
            onChange={e => setKindFilter(e.target.value as any)}
            className="bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1.5 text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
          >
            <option value="">All kinds</option>
            <option value="Select">Select</option>
            <option value="Insert">Insert</option>
            <option value="Alter">Alter</option>
            <option value="Create">Create</option>
            <option value="Drop">Drop</option>
            <option value="System">System</option>
          </select>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as any)}
            className="bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1.5 text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
          >
            <option value="all">All statuses</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
          </select>
          <input
            type="text"
            value={tableRaw}
            onChange={e => setTableRaw(e.target.value)}
            placeholder="Table (bare name)"
            className="w-36 bg-[var(--surface)] border border-[var(--border)] rounded-md px-3 py-1.5 text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
          />
          <input
            type="number"
            value={minMs}
            onChange={e => setMinMs(e.target.value)}
            placeholder="Min ms"
            min={0}
            className="w-24 bg-[var(--surface)] border border-[var(--border)] rounded-md px-3 py-1.5 text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
          />
          <button
            onClick={resetFilters}
            className="text-[11px] text-[var(--dim)] hover:text-[var(--fg)] px-2 py-1 rounded border border-[var(--border)] transition-colors"
          >
            Reset
          </button>
        </div>
        <div className="mt-2 text-[11px] text-[var(--dim)]">
          {loading
            ? 'Loading…'
            : `Showing ${displayRows.length.toLocaleString()} queries${exhausted ? '' : ' (more available)'}${searchQuery ? ` matching "${searchQuery}"` : ''}`}
        </div>
      </Card>

      {/* Rows */}
      <Card noPad>
        {displayRows.length === 0 && !loading ? (
          <div className="text-sm text-[var(--dim)] text-center py-10">
            No queries matched.
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {/* Header */}
            <div className="grid gap-2 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)] bg-[var(--surface)]"
                 style={{ gridTemplateColumns: '120px 80px 60px 60px 90px 80px 90px 1fr 160px' }}>
              <span>Time</span>
              <span>User</span>
              <span>Kind</span>
              <span>Status</span>
              <span className="text-right">Duration</span>
              <span className="text-right">CPU</span>
              <span className="text-right">Memory</span>
              <span>Query</span>
              <span>Tables</span>
            </div>
            {displayRows.map((s, i) => {
              const cpuMs = (Number(s.cpu_user_us) || 0) / 1000 + (Number(s.cpu_system_us) || 0) / 1000
              const q = String(s.query_text ?? '')
              const fromServer: string[] = Array.isArray(s.tables) ? s.tables : []
              const tablesArr = fromServer.length > 0 ? fromServer : inferTablesFromQuery(q)
              const tablesInferred = fromServer.length === 0 && tablesArr.length > 0
              const dur = Number(s.query_duration_ms) || 0
              const durColor = dur > 30000 ? 'text-red-400' : dur > 5000 ? 'text-orange-400' : dur > 1000 ? 'text-yellow-400' : 'text-[var(--fg)]'
              const evtTime = String(s.event_time ?? '')
              return (
                <div
                  key={i}
                  className="grid gap-2 px-3 py-2 text-xs hover:bg-[var(--hover)] transition-colors cursor-pointer"
                  style={{ gridTemplateColumns: '120px 80px 60px 60px 90px 80px 90px 1fr 160px' }}
                  onClick={() => onShowQuery(q)}
                >
                  <span className="font-mono text-[var(--dim)] tabular-nums truncate" title={evtTime}>
                    {evtTime.slice(5, 19)}
                  </span>
                  <span className="truncate text-[var(--dim)]" title={String(s.user ?? '')}>
                    {String(s.user ?? '')}
                  </span>
                  <span>
                    {s.query_kind && (
                      <span className={cn('inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium', kindBg(String(s.query_kind)))}>
                        {String(s.query_kind).slice(0, 3).toUpperCase()}
                      </span>
                    )}
                  </span>
                  <span>
                    {s.is_exception
                      ? <span className="inline-flex px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 text-[10px] font-medium">err</span>
                      : <span className="inline-flex px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[10px] font-medium">ok</span>}
                  </span>
                  <span className={cn('text-right font-mono tabular-nums', durColor)}>
                    {fmtDuration(dur)}
                  </span>
                  <span className="text-right font-mono tabular-nums text-[var(--dim)]">
                    {cpuMs > 0 ? fmtDuration(cpuMs) : '—'}
                  </span>
                  <span className="text-right font-mono tabular-nums text-[var(--dim)]">
                    {Number(s.memory_usage) > 0 ? fmtBytes(Number(s.memory_usage)) : '—'}
                  </span>
                  <span className="font-mono truncate min-w-0 text-[var(--fg)]" title={q}>
                    <SqlHighlight text={q} maxLen={160} />
                  </span>
                  <span className="overflow-hidden">
                    <TablesCell tables={tablesArr} inferred={tablesInferred} />
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* Load more */}
      {!loading && displayRows.length > 0 && !exhausted && (
        <div className="flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="px-4 py-1.5 rounded-md border border-[var(--border)] text-xs text-[var(--dim)] hover:text-[var(--fg)] hover:border-[var(--accent)] transition-colors disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : `Load ${PAGE_SIZE} more`}
          </button>
        </div>
      )}
      {totalShown > 0 && exhausted && (
        <div className="text-[11px] text-[var(--dim)] text-center py-2">
          End of results — {totalShown.toLocaleString()} queries total.
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
  initialTable?: string
  initialErrorsOnly?: boolean
  onClearDrill?: () => void
  onFetched?: () => void
}

function SamplesTab({ instance, from, to, refreshKey, onShowQuery, initialHash, initialUser, initialTable, initialErrorsOnly, onClearDrill, onFetched }: SamplesTabProps) {
  const { setView, setSelectedInstance } = useStore()
  const [samples, setSamples] = useState<QuerySample[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hashFilter, setHashFilter] = useState(initialHash ?? '')
  const [userFilter, setUserFilter] = useState(initialUser ?? '')
  const [kindFilter, setKindFilter] = useState('')
  const [minMs, setMinMs] = useState('')
  const [errorsOnly, setErrorsOnly] = useState(initialErrorsOnly ?? false)
  const [tableFilter, setTableFilter] = useState(initialTable ?? '')
  // Debounced copy actually sent to the API — avoids firing on every keystroke.
  const [tableFilterQuery, setTableFilterQuery] = useState(initialTable ?? '')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  // Charts shown when drilling into failures for a specific hash
  const [failTimeline, setFailTimeline] = useState<Record<string, any>[]>([])
  const [patternTimeline, setPatternTimeline] = useState<Record<string, any>[]>([])

  // When initial drill context changes, update filters.
  useEffect(() => { setHashFilter(initialHash ?? '') }, [initialHash])
  useEffect(() => { setUserFilter(initialUser ?? '') }, [initialUser])
  useEffect(() => { setErrorsOnly(initialErrorsOnly ?? false) }, [initialErrorsOnly])
  useEffect(() => {
    setTableFilter(initialTable ?? '')
    setTableFilterQuery(initialTable ?? '')
  }, [initialTable])

  // Debounce text input → actual query param by 300ms.
  useEffect(() => {
    const id = setTimeout(() => setTableFilterQuery(tableFilter.trim()), 300)
    return () => clearTimeout(id)
  }, [tableFilter])

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
    }).catch(() => { if (!c) { setFailTimeline([]); setPatternTimeline([]) } })
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
      table: tableFilterQuery || undefined,
      limit: 200,
    })
      .then(d => { if (!c) setSamples(d) })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) { setLoading(false); onFetched?.() } })
    return () => { c = true }
  }, [instance, from, to, refreshKey, hashFilter, userFilter, kindFilter, minMs, errorsOnly, tableFilterQuery, onFetched])

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

  const openInCHLogs = (inst: string, _sample: QuerySample) => {
    setSelectedInstance(inst)
    setView('chlogs')
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
          {(hashFilter || userFilter || errorsOnly || tableFilter) && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-[var(--accent)]/15 border border-[var(--accent)]/30 text-xs text-[var(--accent)]">
              {hashFilter && <span>hash: {hashFilter.slice(0, 12)}</span>}
              {userFilter && <span>user: {userFilter}</span>}
              {tableFilter && <span>table: {tableFilter}</span>}
              {errorsOnly && <span className="text-red-400">errors only</span>}
              <button
                onClick={() => { setHashFilter(''); setUserFilter(''); setErrorsOnly(false); setTableFilter(''); setTableFilterQuery(''); onClearDrill?.() }}
                className="ml-1 hover:text-[var(--fg)]"
              >
                <X size={10} />
              </button>
            </div>
          )}
          <div className="flex items-center gap-1">
            <label className="text-xs text-[var(--dim)]">Table</label>
            <input
              value={tableFilter}
              onChange={e => setTableFilter(e.target.value)}
              className="rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs w-44 focus:outline-none"
              placeholder="db.table or table…"
              title="Filter samples by table — accepts db.table or bare table name. Debounced 300ms."
            />
          </div>
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
            const cpuMs = (Number(s.cpu_user_us) || 0) / 1000 + (Number(s.cpu_system_us) || 0) / 1000
            const hasCpu = cpuMs > 0
            const tablesArr: string[] = Array.isArray(s.tables) && s.tables.length > 0
              ? s.tables
              : (s.tables_accessed ? String(s.tables_accessed).split(', ').filter(Boolean) : [])
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
                  <span className="text-xs text-[var(--dim)] w-16 shrink-0 tabular-nums" title="CPU time (user + system)">
                    {hasCpu ? fmtDuration(cpuMs) : <span className="text-[var(--dim)]">—</span>}
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
                  <span className="shrink-0 hidden lg:inline-flex" onClick={e => e.stopPropagation()}>
                    <TablesCell
                      tables={tablesArr}
                      onSelect={(t) => {
                        const dotted = String(t)
                        const bare = dotted.includes('.') ? dotted.slice(dotted.indexOf('.') + 1) : dotted
                        setTableFilter(bare)
                        setTableFilterQuery(bare)
                      }}
                    />
                  </span>
                  <span className="truncate min-w-0" title={String(s.query_text ?? '')}>
                    <SqlHighlight text={String(s.query_text ?? '')} maxLen={80} />
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); openInCHLogs(instance, s) }}
                    className="ml-auto flex items-center gap-1 shrink-0 text-[10px] text-[var(--accent)] hover:underline"
                    title={`Open CH Logs for ${instance} around this query's time`}
                  >
                    <ExternalLink size={10} />
                    CH Logs
                  </button>
                </button>
                {isOpen && (
                  <div className="border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3 space-y-3">
                    {/* Stats row */}
                    <div className="flex flex-wrap gap-4 text-xs">
                      <span><span className="text-[var(--dim)]">Read rows:</span> {fmtNum(s.read_rows)}</span>
                      <span><span className="text-[var(--dim)]">Read bytes:</span> {fmtBytes(s.read_bytes)}</span>
                      <span><span className="text-[var(--dim)]">Memory:</span> {fmtBytes(s.memory_usage)}</span>
                      <span><span className="text-[var(--dim)]">Result rows:</span> {fmtNum(s.result_rows)}</span>
                      {hasCpu && (
                        <span><span className="text-[var(--dim)]">CPU:</span> {fmtDuration(cpuMs)}</span>
                      )}
                      <span><span className="text-[var(--dim)]">Client:</span> {s.client_name || '—'}</span>
                      <span><span className="text-[var(--dim)]">Hash:</span>
                        <span className="font-mono ml-1">{String(s.normalized_query_hash).slice(0, 16)}</span>
                      </span>
                    </div>
                    {tablesArr.length > 0 && (
                      <div className="flex flex-wrap gap-1 text-xs">
                        <span className="text-[var(--dim)] shrink-0">Tables:</span>
                        {tablesArr.map((t, i) => (
                          <span key={i} className="inline-flex px-1.5 py-0.5 rounded bg-[var(--hover)] border border-[var(--border)] font-mono text-[11px]">{t}</span>
                        ))}
                      </div>
                    )}
                    {/* Exception message */}
                    {s.is_exception === 1 && s.exception && (
                      <div>
                        <div className="text-[11px] font-semibold text-red-400 mb-1">
                          Error {s.exception_code}
                        </div>
                        <pre className="text-xs font-mono text-red-300/80 whitespace-pre-wrap break-all leading-relaxed bg-red-500/5 border border-red-500/15 rounded p-2 max-h-28 overflow-y-auto">
                          {s.exception}
                        </pre>
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
                    {/* Navigation actions */}
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={() => openInCHLogs(instance, s)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-[var(--hover)] hover:bg-[var(--accent)]/10 text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                        title={`Open CH Logs for ${instance} around this query's time`}
                      >
                        <ExternalLink size={12} />
                        Open in CH Logs
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
  const [killError, setKillError] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // loadedAt + snapshot elapsed so we can tick live
  const loadedAtRef = useRef<number>(Date.now())
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && killTarget) { setKillTarget(null); setKillError(null) } }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [killTarget])

  const load = useCallback(() => {
    api.queries(instance)
      .then(d => {
        loadedAtRef.current = Date.now()
        setRows(Array.isArray(d) ? d : [])
        setError(null)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [instance])

  useEffect(() => {
    setLoading(true)
    load()
    intervalRef.current = setInterval(load, 5000)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [load])

  // Tick every second so elapsed time updates live between data refreshes
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const handleKill = async () => {
    if (!killTarget) return
    setKilling(true)
    setKillError(null)
    try {
      await api.killQuery(instance, killTarget)
      setKillTarget(null)
      load()
    } catch (e: any) {
      setKillError(e.message ?? 'Kill failed')
    } finally {
      setKilling(false)
    }
  }

  // Compute live elapsed: base value from last fetch + seconds since fetch
  const liveElapsed = (snapshotSec: any) => {
    const base = Number(snapshotSec) || 0
    const driftSec = (Date.now() - loadedAtRef.current) / 1000
    return base + driftSec
  }

  const elapsed = (v: any) => {
    const s = liveElapsed(v)
    if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
    if (s >= 60) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
    return `${s.toFixed(0)}s`
  }

  const elapsedColor = (v: any) => {
    const s = liveElapsed(v)
    if (s > 300) return 'text-red-400 font-semibold'
    if (s > 60) return 'text-orange-400'
    if (s > 10) return 'text-yellow-400'
    return 'text-[var(--fg)]'
  }

  // Suppress unused-variable warning for tick (it drives re-renders)
  void tick

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
        <div className="overflow-x-auto">
          <div className="space-y-1 min-w-[760px]">
            {/* Column headers */}
            <div className="flex items-center gap-2.5 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">
              <span className="w-20 shrink-0">Elapsed</span>
              <span className="w-16 shrink-0">CPU</span>
              <span className="w-20 shrink-0">User</span>
              <span className="w-12 shrink-0">Kind</span>
              <span className="flex-1">Query</span>
              <span className="w-40 shrink-0">Tables</span>
              <span className="w-16 text-right shrink-0">Memory</span>
              <span className="w-16 text-right shrink-0">Read</span>
              <span className="w-16 text-right shrink-0">Rows</span>
              <span className="w-12 shrink-0" />
            </div>
            {rows.map((r, i) => {
              const qid = String(r.query_id ?? '')
              const q = String(r.query_short ?? r.query ?? '')
              const sec = Number(r.elapsed) || 0
              const pct = Math.min(100, (sec / 300) * 100) // 300s = 100%
              const pill = sec > 300 ? 'bg-red-500' : sec > 60 ? 'bg-orange-500' : sec > 10 ? 'bg-yellow-500' : 'bg-emerald-500'
              const kind = String(r.query_kind || r.kind || '').toLowerCase()
              const cpuMs = (Number(r.cpu_user_us) || 0) / 1000 + (Number(r.cpu_system_us) || 0) / 1000
              const fromServer: string[] = Array.isArray(r.tables) ? r.tables : []
              // On older CH versions system.processes.tables is absent, so the
              // backend emits `[]`. Fall back to regex-parsing the query text.
              const tablesArr = fromServer.length > 0
                ? fromServer
                : inferTablesFromQuery(String(r.query ?? r.query_short ?? ''))
              const tablesInferred = fromServer.length === 0 && tablesArr.length > 0
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
                  {/* CPU time */}
                  <span className="text-xs text-[var(--dim)] w-16 shrink-0 tabular-nums" title="CPU time (user + system)">
                    {cpuMs > 0 ? fmtDuration(cpuMs) : '—'}
                  </span>
                  {/* User */}
                  <span className="text-xs text-[var(--dim)] w-20 shrink-0 truncate" title={r.user}>{r.user}</span>
                  {/* Kind badge */}
                  <span className="w-12 shrink-0">
                    {kind && (
                      <span className={cn('inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium', kindBg(kind))}>
                        {kind.slice(0, 3).toUpperCase()}
                      </span>
                    )}
                  </span>
                  {/* Query preview */}
                  <span className="text-xs font-mono text-[var(--fg)] truncate flex-1 min-w-0" title={q}>
                    <SqlHighlight text={q} maxLen={120} />
                  </span>
                  {/* Tables */}
                  <span className="w-40 shrink-0 overflow-hidden">
                    <TablesCell tables={tablesArr} inferred={tablesInferred} />
                  </span>
                  {/* Memory */}
                  <span className="text-xs text-[var(--dim)] w-16 text-right shrink-0 tabular-nums" title="Memory usage">
                    {r.memory || '—'}
                  </span>
                  {/* Read bytes */}
                  <span className="text-xs text-[var(--dim)] w-16 text-right shrink-0 tabular-nums" title="Read bytes">
                    {r.read_size || '—'}
                  </span>
                  {/* Read rows */}
                  <span className="text-xs text-[var(--dim)] w-16 text-right shrink-0 tabular-nums" title="Read rows">
                    {r.read_rows != null ? fmtCompact(Number(r.read_rows)) : '—'}
                  </span>
                  <div className="flex items-center gap-0.5 w-12 shrink-0 justify-end">
                    <button onClick={() => onShowQuery(q)}
                      className="p-1 rounded text-[var(--dim)] hover:text-[var(--accent)] opacity-0 group-hover:opacity-100 transition-all"
                      title="View query"><Maximize2 size={12} /></button>
                    <button onClick={() => setKillTarget(qid)}
                      className="p-1 rounded text-[var(--dim)] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                      title="Kill query"><Skull size={12} /></button>
                  </div>
                </div>
              )
            })}
          </div>
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
            {killError && (
              <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                <span className="font-semibold">Error:</span> {killError}
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setKillTarget(null); setKillError(null) }}
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
  onFetched?: () => void
}

const USER_COLORS = ['#7c3aed','#22c55e','#f59e0b','#ef4444','#3b82f6','#06b6d4','#f97316','#ec4899']

function UsersTab({ instance, from, to, refreshKey, onDrillUser, onFetched }: UsersTabProps) {
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
      .finally(() => { if (!c) { setLoading(false); onFetched?.() } })
    return () => { c = true }
  }, [instance, from, to, refreshKey, onFetched])

  // ALL hooks BEFORE any early return (Rules of Hooks)
  const pieData = useMemo(() => {
    if (users.length === 0) return null
    const top = users.slice(0, 7)
    const otherMs = users.slice(7).reduce((s, u) => s + (u.total_ms || 0), 0)
    const entries = [...top.map((u, i) => ({ name: u.user || '(unknown)', value: u.total_ms || 0, color: USER_COLORS[i % USER_COLORS.length] })),
      ...(otherMs > 0 ? [{ name: 'other', value: otherMs, color: '#475569' }] : [])]
    return entries
  }, [users])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  const maxTotalMs = users.reduce((m, u) => Math.max(m, u.total_ms || 0), 1)
  const grandTotal = users.reduce((s, u) => s + (u.total_ms || 0), 0)
  const topUser = users[0]

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
                    <span className="text-sm font-medium w-28 shrink-0 truncate" title={u.user || '(unknown)'}>{u.user || '(unknown)'}</span>
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

        {/* Pie chart */}
        {pieData && (
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 flex flex-col">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-3">CPU Share</div>
            <div className="flex-1" style={{ minHeight: 180 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius="55%" outerRadius="80%">
                    {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: '#0f1420', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 11 }}
                    formatter={(v: any, name: any) => {
                      const pct = grandTotal > 0 ? ((Number(v) / grandTotal) * 100).toFixed(1) : '0'
                      return [`${fmtDuration(Number(v))} (${pct}%)`, name]
                    }}
                  />
                  <Legend iconSize={8} wrapperStyle={{ fontSize: 10, color: '#9ca3af' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Tables Tab — mirrors UsersTab shape but grouped by table           */
/* ------------------------------------------------------------------ */

interface TablesTabProps extends TabProps {
  onDrillTable?: (database: string, table: string) => void
  onFetched?: () => void
}

function TablesTab({ instance, from, to, refreshKey, onDrillTable, onFetched }: TablesTabProps) {
  const [tables, setTables] = useState<QueryTable[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.queryTables(instance, from, to)
      .then(d => { if (!c) setTables(Array.isArray(d) ? d : []) })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) { setLoading(false); onFetched?.() } })
    return () => { c = true }
  }, [instance, from, to, refreshKey, onFetched])

  // ALL hooks BEFORE any early return (Rules of Hooks)
  // pie.mode tells the panel header whether we're showing real CPU data or
  // falling back to total query duration. Both values come back from the
  // same backend, but ProfileEvents-based CPU columns can be zero on older
  // ClickHouse versions or for freshly-ingested rows.
  const pie = useMemo(() => {
    if (tables.length === 0) return { data: null as null | { name: string; value: number; color: string }[], mode: 'cpu' as 'cpu' | 'total', sum: 0 }
    const cpuSum = tables.reduce((s, t) => s + (Number(t.total_cpu_ms) || 0), 0)
    const useCpu = cpuSum > 0
    const valFor = (t: QueryTable) => useCpu ? (Number(t.total_cpu_ms) || 0) : (Number(t.total_ms) || 0)
    const top = tables.slice(0, 7)
    const otherMs = tables.slice(7).reduce((s, t) => s + valFor(t), 0)
    const entries = [...top.map((t, i) => ({ name: t.table || '(unknown)', value: valFor(t), color: USER_COLORS[i % USER_COLORS.length] })),
      ...(otherMs > 0 ? [{ name: 'other', value: otherMs, color: '#475569' }] : [])]
    const sum = entries.reduce((s, e) => s + e.value, 0)
    return { data: entries, mode: useCpu ? 'cpu' : 'total', sum }
  }, [tables])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  const maxTotalMs = tables.reduce((m, t) => Math.max(m, t.total_ms || 0), 1)
  const cpuOf = (t: QueryTable) => Number(t.total_cpu_ms) || Number(t.total_ms) || 0
  const grandCpu = tables.reduce((s, t) => s + cpuOf(t), 0)
  const topTable = tables[0]

  return (
    <div className="space-y-4">
      {/* Stat cards */}
      {tables.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          <StatCard label="Active Tables" value={String(tables.length)} />
          {topTable && (
            <StatCard
              label="Top Table"
              value={topTable.table || '(unknown)'}
              sub={grandCpu > 0 ? `${((cpuOf(topTable) / grandCpu) * 100).toFixed(0)}% of total CPU` : ''}
              color="text-[var(--accent)]"
            />
          )}
          <StatCard label="Total CPU" value={fmtDuration(grandCpu)} />
          <StatCard
            label="Total Execs"
            value={fmtCompact(tables.reduce((s, t) => s + (t.cnt || 0), 0))}
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
        {/* Horizontal bars */}
        <Card>
          <div className="text-xs text-[var(--dim)] uppercase tracking-wider font-medium mb-3">
            {tables.length} tables — by total query time
          </div>
          {tables.length === 0 ? (
            <div className="text-sm text-[var(--dim)] text-center py-8">No data in range</div>
          ) : (
            <div className="space-y-1.5">
              {tables.map((t, i) => {
                const pct = (t.total_ms / maxTotalMs) * 100
                const color = USER_COLORS[i % USER_COLORS.length]
                const clickable = !!onDrillTable && !!t.database && !!t.table
                return (
                  <div
                    key={i}
                    onClick={() => {
                      if (!clickable) return
                      const dotted = t.table || ''
                      const bare = dotted.includes('.') ? dotted.slice(dotted.indexOf('.') + 1) : dotted
                      onDrillTable!(t.database, bare)
                    }}
                    className={cn(
                      'group flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--border)] hover:bg-[var(--hover)] transition-colors',
                      clickable && 'cursor-pointer',
                    )}
                  >
                    <span className="text-sm font-medium w-40 shrink-0 truncate font-mono" title={t.table || '(unknown)'}>{t.table || '(unknown)'}</span>
                    <div className="flex-1 flex items-center gap-2 min-w-0">
                      <div className="flex-1 h-2 rounded-full bg-[var(--border)] overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${pct}%`, background: color }} />
                      </div>
                      <span className="text-xs tabular-nums text-[var(--dim)] w-16 text-right shrink-0">{fmtDuration(t.total_ms)}</span>
                    </div>
                    <div className="hidden lg:flex gap-3 text-xs text-[var(--dim)] shrink-0">
                      <span><span className="text-[var(--fg)]">{fmtCompact(t.cnt)}</span> execs</span>
                      <span className={cn('font-mono', latencyBg(t.avg_ms), 'px-1.5 py-0.5 rounded text-[11px]')}>{fmtDuration(t.avg_ms)}</span>
                      {t.failures > 0 && <span className="text-red-400">{t.failures} err</span>}
                    </div>
                    {clickable && (
                      <span className="text-xs text-[var(--accent)] opacity-0 group-hover:opacity-100 shrink-0 transition-opacity">→</span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        {/* Pie chart — panel always renders once tables load so the user never
            sees a silent empty column. Explicit height (not flex-1) prevents
            the inner ResponsiveContainer from collapsing to 0 when the outer
            is self-sizing. */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 self-start">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-3">
            {pie.mode === 'cpu' ? 'CPU Share' : 'Query Time Share'}
          </div>
          {!pie.data || pie.sum === 0 ? (
            <div className="text-[11px] text-[var(--dim)] text-center py-14 px-2 leading-relaxed">
              {tables.length === 0
                ? 'No data in range'
                : 'No CPU data yet — ProfileEvents will populate within a poll cycle or two'}
            </div>
          ) : (
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pie.data} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius="55%" outerRadius="80%">
                    {pie.data.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: '#0f1420', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 11 }}
                    formatter={(v: any, name: any) => {
                      const pct = pie.sum > 0 ? ((Number(v) / pie.sum) * 100).toFixed(1) : '0'
                      return [`${fmtDuration(Number(v))} (${pct}%)`, name]
                    }}
                  />
                  <Legend iconSize={8} wrapperStyle={{ fontSize: 10, color: '#9ca3af' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
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
                  <span className="text-xs text-[var(--dim)] truncate flex-1 font-mono" title={msgs[0] || undefined}>
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
          onRowAnalyze={row => {
            if (!row) return
            onAnalyze(
              `MV: ${row.view_name}`,
              { row, allViews: aggregated },
              { contextType: 'row', tab: 'mvs', elementId: String(row.view_name) },
            )
          }}
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
  const [latencyByTable, setLatencyByTable] = useState<S3LatencyByTableRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    Promise.all([
      api.history.s3(instance, from, to),
      api.s3Stats(instance),
      api.s3LatencyByTable(instance, from, to),
    ])
      .then(([h, s, lbt]) => { if (!c) { setHistory(h); setStats(s); setLatencyByTable(lbt) } })
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
                      <span className="text-[var(--dim)] text-xs font-mono truncate block max-w-[400px]">
                        {q}
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
            onRowAnalyze={row => {
              if (!row) return
              onAnalyze(
                `S3 query ${String(row.normalized_query_hash).slice(0, 12)}`,
                { row, allQueries: stats.latency_by_query },
                { contextType: 'row', tab: 's3', elementId: String(row.normalized_query_hash) },
              )
            }}
            emptyText="No query data"
          />
        </Card>
      )}
      <Card>
        <div className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider mb-2">BY TABLE</div>
        <DataTable
          columns={[
            { key: 'table_name', label: 'Table', tooltip: 'Table reading data from S3 within the selected time range' },
            { key: 'avg_latency_ms', label: 'Avg Latency ms', tooltip: 'Average S3 read latency across all queries touching this table', format: (v: any) => fmtDuration(Number(v ?? 0)) },
            { key: 's3_requests', label: 'S3 Requests', tooltip: 'Total number of S3 API requests made for this table', format: (v: any) => fmtNum(v) },
            { key: 'total_s3_bytes', label: 'Total S3 Bytes', tooltip: 'Total bytes read from S3 for this table', format: (v: any) => fmtBytes(v) },
            { key: 'query_count', label: 'Queries', tooltip: 'Number of queries that accessed this table via S3', format: (v: any) => fmtNum(v) },
          ]}
          data={latencyByTable}
          emptyText="No S3 table data in this time range"
        />
      </Card>
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
          onRowAnalyze={row => {
            if (!row) return
            onAnalyze(
              `Inserts: ${row.table}`,
              { row, allTables: byTable },
              { contextType: 'row', tab: 'inserts', elementId: String(row.table) },
            )
          }}
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

// Query anti-pattern row: hash, sample_query, exec_count, avg_ms, avg_memory,
// avg_read_rows, avg_result_rows, avg_read_bytes, scan_ratio, error_rate_pct,
// error_count, cache_hit_pct
function QueryAPCard({ group, onRunQuery }: { group: any; onRunQuery: (q: string) => void }) {
  const [open, setOpen] = useState(false)
  const hasIssues = group.count > 0

  const metricCols = (() => {
    switch (group.type) {
      case 'high_memory':   return [{ key: 'avg_memory',     label: 'Avg Memory',   format: (v: any) => fmtBytes(Number(v)) }]
      case 'full_scan':     return [{ key: 'scan_ratio',     label: 'Scan Ratio',   format: (v: any) => `${fmtCompact(Number(v))}×` }, { key: 'avg_read_rows', label: 'Read Rows', format: (v: any) => fmtCompact(Number(v)) }]
      case 'high_frequency':return [{ key: 'exec_count',     label: 'Execs/day',    format: (v: any) => fmtCompact(Number(v)) }]
      case 'high_error_rate':return [{ key: 'error_rate_pct', label: 'Error Rate',  format: (v: any) => `${Number(v).toFixed(1)}%` }, { key: 'error_count', label: 'Errors', format: (v: any) => fmtCompact(Number(v)) }]
      case 'low_mark_cache':return [{ key: 'cache_hit_pct',  label: 'Cache Hit %',  format: (v: any) => `${Number(v).toFixed(1)}%` }]
      case 'no_limit':
      case 'select_star':   return [{ key: 'avg_read_bytes', label: 'Avg Read',     format: (v: any) => fmtBytes(Number(v)) }, { key: 'avg_read_rows', label: 'Read Rows', format: (v: any) => fmtCompact(Number(v)) }]
      default:              return [{ key: 'exec_count',     label: 'Execs',        format: (v: any) => fmtCompact(Number(v)) }]
    }
  })()

  return (
    <div className={cn('rounded-xl border overflow-hidden', hasIssues ? group.severity === 'critical' ? 'border-red-500/30' : 'border-yellow-500/30' : 'border-[var(--border)]')}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--hover)] transition-colors">
        {open ? <ChevronDown size={14} className="text-[var(--dim)] shrink-0" /> : <ChevronRight size={14} className="text-[var(--dim)] shrink-0" />}
        <span className="font-medium text-sm flex-1">{group.title}</span>
        {hasIssues && <SevBadge s={group.severity} />}
        <span className={cn('text-xs font-semibold ml-2 px-2 py-0.5 rounded-full', hasIssues ? group.severity === 'critical' ? 'bg-red-500/15 text-red-400' : 'bg-yellow-500/15 text-yellow-400' : 'bg-[var(--hover)] text-[var(--dim)]')}>
          {group.count} pattern{group.count !== 1 ? 's' : ''}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-[var(--border)]">
          <p className="text-xs text-[var(--dim)] pt-3 leading-relaxed">{group.description}</p>
          {group.count === 0
            ? <div className="text-xs text-green-400 bg-green-500/10 rounded-lg px-3 py-2 border border-green-500/20">No issues detected</div>
            : <DataTable
                columns={[
                  { key: 'avg_ms', label: 'Avg Ms', format: (v: any) => fmtDuration(Number(v)) },
                  ...metricCols,
                  { key: 'sample_query', label: 'Sample Query', format: (v: any) => (
                    <button onClick={() => onRunQuery(String(v ?? ''))} className="font-mono text-xs text-left text-[var(--accent)] hover:underline truncate block max-w-sm" title={String(v ?? '')}>
                      {String(v ?? '')}
                    </button>
                  )},
                ]}
                data={group.queries ?? []}
                maxHeight="280px"
              />
          }
        </div>
      )}
    </div>
  )
}

// Table anti-pattern row: database, table, engine, detail, metric, metric_label,
// size_bytes, size_human, fix_hint
function TableAPCard({ group, onRunQuery }: { group: any; onRunQuery: (q: string) => void }) {
  const [open, setOpen] = useState(false)
  const hasIssues = group.count > 0
  const metricLabel = group.tables?.[0]?.metric_label ?? 'value'

  return (
    <div className={cn('rounded-xl border overflow-hidden', hasIssues ? group.severity === 'critical' ? 'border-red-500/30' : 'border-yellow-500/30' : 'border-[var(--border)]')}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--hover)] transition-colors">
        {open ? <ChevronDown size={14} className="text-[var(--dim)] shrink-0" /> : <ChevronRight size={14} className="text-[var(--dim)] shrink-0" />}
        <span className="font-medium text-sm flex-1">{group.title}</span>
        {hasIssues && <SevBadge s={group.severity} />}
        <span className={cn('text-xs font-semibold ml-2 px-2 py-0.5 rounded-full', hasIssues ? group.severity === 'critical' ? 'bg-red-500/15 text-red-400' : 'bg-yellow-500/15 text-yellow-400' : 'bg-[var(--hover)] text-[var(--dim)]')}>
          {group.count} table{group.count !== 1 ? 's' : ''}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-[var(--border)]">
          <p className="text-xs text-[var(--dim)] pt-3 leading-relaxed">{group.description}</p>
          {group.count === 0
            ? <div className="text-xs text-green-400 bg-green-500/10 rounded-lg px-3 py-2 border border-green-500/20">No issues detected</div>
            : <DataTable
                columns={[
                  { key: 'database', label: 'Table', format: (_v: any, row: any) => (
                    <span className="font-mono text-xs font-medium">{row.database}.{row.table}</span>
                  )},
                  { key: 'detail', label: 'Detail', format: (v: any) => <span className="text-xs text-[var(--dim)] truncate block max-w-xs" title={v}>{v || '—'}</span> },
                  { key: 'metric', label: metricLabel, format: (v: any, row: any) => (
                    <span className="tabular-nums text-xs">{row.size_human && row.metric_label === 'GB' ? row.size_human : fmtNum(Number(v))}</span>
                  )},
                  { key: 'size_human', label: 'Size', format: (v: any) => <span className="text-xs">{v || '—'}</span> },
                  { key: 'fix_hint', label: '', format: (v: any) => v
                    ? <button onClick={() => onRunQuery(v)} className="text-xs text-[var(--accent)] hover:underline font-mono truncate block max-w-xs text-left" title={v}>Run fix →</button>
                    : null },
                ]}
                data={group.tables ?? []}
                maxHeight="280px"
              />
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
                <QueryAPCard key={group.type} group={group} onRunQuery={onShowQuery} />
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
                <TableAPCard key={group.type} group={group} onRunQuery={onShowQuery} />
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

function fmtAgo(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export default function Explore({ refreshKey }: { refreshKey?: number }) {
  const { instances, selectedInstance, setSelectedInstance, setView, from, to, openTableDetail } = useStore()

  // Read initial tab from URL params (set by Discover page navigation)
  const [tab, setTab] = useState<Tab>(() => {
    const p = new URLSearchParams(window.location.search)
    const t = p.get('tab') as Tab | null
    const validTabs: Tab[] = ['antipatterns','patterns','samples','live','users','tables','failures','merges','mvs','s3','inserts','metrics','diskio','partsage']
    return t && validTabs.includes(t) ? t : 'patterns'
  })
  const [queryModal, setQueryModal] = useState<string | null>(null)
  // Drill state
  const [drillHash, setDrillHash] = useState<string | undefined>()
  const [drillUser, setDrillUser] = useState<string | undefined>()
  const [drillTable, setDrillTable] = useState<string | undefined>()
  const [drillErrorsOnly, setDrillErrorsOnly] = useState(false)
  // Manual refresh
  const [manualTick, setManualTick] = useState(0)
  const [lastRefreshed, setLastRefreshed] = useState(new Date())
  const [agoStr, setAgoStr] = useState('just now')
  // Stale banner — per-tab lastFetchedAt tracking
  const [lastFetchedAt, setLastFetchedAt] = useState<Partial<Record<Tab, Date>>>({})
  const [staleAgoStr, setStaleAgoStr] = useState('')
  const inst = selectedInstance || instances[0] || ''

  const effectiveRefreshKey = (refreshKey ?? 0) + manualTick

  // Update "X ago" every 10s
  useEffect(() => {
    const id = setInterval(() => setAgoStr(fmtAgo(lastRefreshed)), 10_000)
    return () => clearInterval(id)
  }, [lastRefreshed])

  // Update stale banner display string every 10s (based on current tab's fetch time)
  const currentTabFetchedAt = lastFetchedAt[tab] ?? null
  useEffect(() => {
    if (!currentTabFetchedAt) return
    setStaleAgoStr(fmtAgo(currentTabFetchedAt))
    const id = setInterval(() => setStaleAgoStr(fmtAgo(currentTabFetchedAt)), 10_000)
    return () => clearInterval(id)
  }, [currentTabFetchedAt])

  // Stale if data is older than 5 minutes (re-evaluated on each render triggered by agoStr interval)
  const isStale = (Date.now() - lastRefreshed.getTime()) > 5 * 60 * 1000

  const handleManualRefresh = useCallback(() => {
    setManualTick(t => t + 1)
    setLastRefreshed(new Date())
    setAgoStr('just now')
  }, [])

  const handleDataFetched = useCallback((t: Tab) => {
    setLastFetchedAt(prev => ({ ...prev, [t]: new Date() }))
  }, [])
  const handlePatternsFetched = useCallback(() => handleDataFetched('patterns'), [handleDataFetched])
  const handleSamplesFetched = useCallback(() => handleDataFetched('samples'), [handleDataFetched])
  const handleUsersFetched = useCallback(() => handleDataFetched('users'), [handleDataFetched])
  const handleTablesFetched = useCallback(() => handleDataFetched('tables'), [handleDataFetched])

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

  const switchTab = useCallback((t: Tab) => {
    setTab(t)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', t)
    window.history.replaceState(null, '', url.toString())
  }, [])

  const handleDrillHash = useCallback((hash: string, opts?: { user?: string; table?: string }) => {
    setDrillHash(hash)
    setDrillUser(opts?.user)
    // When the caller passes a table, drill filters Samples by that table too.
    // Accept db.table or bare table; SamplesTab strips the "db." prefix server-side via ?table=.
    setDrillTable(opts?.table)
    setDrillErrorsOnly(false)
    switchTab('samples')
  }, [switchTab])

  const handleDrillFail = useCallback((hash: string) => {
    setDrillHash(hash)
    setDrillUser(undefined)
    setDrillTable(undefined)
    setDrillErrorsOnly(true)
    switchTab('samples')
  }, [switchTab])

  const handleDrillUser = useCallback((user: string) => {
    setDrillUser(user)
    setDrillHash(undefined)
    setDrillTable(undefined)
    setDrillErrorsOnly(false)
    switchTab('samples')
  }, [switchTab])

  const handleDrillTable = useCallback((database: string, table: string) => {
    if (!database || !table) return
    openTableDetail(inst, database, table)
  }, [openTableDetail, inst])

  const handleClearDrill = useCallback(() => {
    setDrillHash(undefined)
    setDrillUser(undefined)
    setDrillTable(undefined)
    setDrillErrorsOnly(false)
  }, [])

  return (
    <div className="space-y-0">
      {/* Header bar: instance selector + refresh + AI button */}
      <div className="flex items-center gap-3 pb-3 flex-wrap">
        <div className="flex items-center gap-2 bg-[var(--card)] border border-[var(--border)] rounded-md px-3 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--dim)]">Instance</span>
          <select
            value={inst}
            onChange={handleInstChange}
            className="bg-transparent text-[12px] text-[var(--text)] focus:outline-none"
          >
            {instances.map(i => (
              <option key={i} value={i}>{i}</option>
            ))}
          </select>
        </div>
        <button
          onClick={handleManualRefresh}
          title="Reload all tab data"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--hover)] border border-[var(--border)] transition-colors"
        >
          <RefreshCw size={11} />
          Refresh
        </button>
        <span className={cn(
          'text-[11px] hidden sm:flex items-center gap-1',
          isStale ? 'text-amber-400' : 'text-[var(--dim)]'
        )}>
          {isStale && <AlertTriangle size={11} className="shrink-0" />}
          Updated {agoStr}
          {isStale && (
            <button
              onClick={handleManualRefresh}
              className="underline hover:no-underline"
            >
              Refresh now
            </button>
          )}
        </span>
        <button
          onClick={() => setView('analyzer')}
          className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent-subtle)] border border-[var(--accent)]/20 transition-colors"
        >
          <Sparkles size={10} />
          Full Analysis
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex gap-0 overflow-x-auto border-b border-[var(--border)]">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => switchTab(t.key)}
            className={cn(
              'px-4 py-2 text-[12px] whitespace-nowrap transition-colors relative',
              tab === t.key
                ? t.key === 'antipatterns'
                  ? 'text-purple-300 font-medium after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-purple-400'
                  : 'text-[var(--accent)] font-medium after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-[var(--accent)]'
                : 'text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)]',
            )}
          >
            {t.key === 'antipatterns' ? (
              <span className="flex items-center gap-1">
                <Zap size={11} className="text-purple-400" />
                {t.label}
                <span className="ml-0.5 text-[9px] px-1 py-px rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">AI</span>
              </span>
            ) : t.label}
          </button>
        ))}
      </div>

      {/* Stale data banner — shown for patterns/samples/users tabs when current tab's fetch is >5 min old */}
      {currentTabFetchedAt && (Date.now() - currentTabFetchedAt.getTime()) > 5 * 60_000 && (tab === 'patterns' || tab === 'samples' || tab === 'users' || tab === 'tables') && (
        <div className="flex items-center gap-2 px-3 py-1.5 mt-2 mb-0 rounded text-xs bg-amber-500/10 border border-amber-500/20 text-amber-400">
          <span>Data may be stale — fetched {staleAgoStr} ago.</span>
          <button onClick={handleManualRefresh} className="underline hover:no-underline ml-1">Refresh</button>
        </div>
      )}

      {/* Tab content */}
      <div className="pt-4">
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
              instance={inst} from={from} to={to} refreshKey={effectiveRefreshKey}
              onAnalyze={handleAnalyze} onShowQuery={handleShowQuery}
              onDrillHash={handleDrillHash}
              onDrillFail={handleDrillFail}
              onFetched={handlePatternsFetched}
            />
          )}
          {tab === 'samples' && (
            <SamplesTab
              instance={inst} from={from} to={to} refreshKey={effectiveRefreshKey}
              onAnalyze={handleAnalyze} onShowQuery={handleShowQuery}
              initialHash={drillHash}
              initialUser={drillUser}
              initialTable={drillTable}
              initialErrorsOnly={drillErrorsOnly}
              onClearDrill={handleClearDrill}
              onFetched={handleSamplesFetched}
            />
          )}
          {tab === 'querylog' && (
            <QueryLogTab
              instance={inst} from={from} to={to} refreshKey={effectiveRefreshKey}
              onAnalyze={handleAnalyze} onShowQuery={handleShowQuery}
            />
          )}
          {tab === 'live' && (
            <LiveTab instance={inst} onShowQuery={handleShowQuery} />
          )}
          {tab === 'connections' && (
            <ConnectionsTab
              instance={inst} from={from} to={to} refreshKey={effectiveRefreshKey}
              onAnalyze={handleAnalyze} onShowQuery={handleShowQuery}
            />
          )}
          {tab === 'users' && (
            <UsersTab
              instance={inst} from={from} to={to} refreshKey={effectiveRefreshKey}
              onAnalyze={handleAnalyze} onShowQuery={handleShowQuery}
              onDrillUser={handleDrillUser}
              onFetched={handleUsersFetched}
            />
          )}
          {tab === 'tables' && (
            <TablesTab
              instance={inst} from={from} to={to} refreshKey={effectiveRefreshKey}
              onAnalyze={handleAnalyze} onShowQuery={handleShowQuery}
              onDrillTable={handleDrillTable}
              onFetched={handleTablesFetched}
            />
          )}
          {tab === 'failures' && <FailuresTab instance={inst} from={from} to={to} refreshKey={effectiveRefreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
          {tab === 'merges' && <MergesTab instance={inst} from={from} to={to} refreshKey={effectiveRefreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
          {tab === 'partsage' && <PartsAgeTab instance={inst} refreshKey={effectiveRefreshKey} />}
          {tab === 'mvs' && <MVTab instance={inst} from={from} to={to} refreshKey={effectiveRefreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
          {tab === 's3' && <S3Tab instance={inst} from={from} to={to} refreshKey={effectiveRefreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
          {tab === 'inserts' && <InsertsTab instance={inst} from={from} to={to} refreshKey={effectiveRefreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
          {tab === 'metrics' && <SystemMetricsTab instance={inst} from={from} to={to} refreshKey={effectiveRefreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
          {tab === 'diskio' && <DiskIOTab instance={inst} from={from} to={to} refreshKey={effectiveRefreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
        </>
      )}

      </div>

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
