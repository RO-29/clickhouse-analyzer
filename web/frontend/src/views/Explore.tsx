import { useState, useEffect, useMemo, useCallback, type ChangeEvent } from 'react'
import { Sparkles, X, Copy, Play, Maximize2 } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { fmtBytes, fmtNum, fmtDuration, cn } from '../lib/utils'
import { Card } from '../components/Card'
import { HistoryChart } from '../components/HistoryChart'
import { DataTable } from '../components/DataTable'
import type {
  QueryPattern,
  HistoryFailure,
  HistoryMerge,
  HistoryInsert,
  HistoryS3,
  HistoryAsyncMetric,
  S3Stats,
} from '../types/api'
import type { AnalyzeOptions } from '../hooks/useAIAnalysis'

type Tab =
  | 'patterns'
  | 'failures'
  | 'merges'
  | 'mvs'
  | 's3'
  | 'inserts'
  | 'metrics'
  | 'diskio'

const TABS: { key: Tab; label: string }[] = [
  { key: 'patterns', label: 'Query Patterns' },
  { key: 'failures', label: 'Failures' },
  { key: 'merges', label: 'Merges & Parts' },
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

function QueryPatternsTab({ instance, from, to, refreshKey, onAnalyze, onShowQuery }: TabProps) {
  const [patterns, setPatterns] = useState<QueryPattern[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<Record<string, any>[]>([])
  const [tlLoading, setTlLoading] = useState(false)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    setSelectedHash(null)
    api.history.queryPatterns(instance, from, to)
      .then(d => { if (!c) setPatterns(d) })
      .catch(e => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to, refreshKey])

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

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  const columns = [
    { key: 'normalized_query_hash', label: 'Hash', format: (v: any) => String(v).slice(0, 12) },
    { key: 'cnt', label: 'Count', format: (v: any) => fmtNum(v) },
    { key: 'kind', label: 'Kind' },
    { key: 'avg_ms', label: 'Avg ms', format: (v: any) => fmtDuration(v) },
    { key: 'max_ms', label: 'Max ms', format: (v: any) => fmtDuration(v) },
    { key: 'p95_ms', label: 'P95 ms', format: (v: any) => fmtDuration(v) },
    { key: 'avg_memory', label: 'Avg Memory', format: (v: any) => fmtBytes(v) },
    { key: 'failures', label: 'Failures', format: (v: any) => fmtNum(v) },
    {
      key: 'sample_query',
      label: 'Sample Query',
      format: (v: any) => {
        const q = String(v ?? '')
        return (
          <span className="flex items-center gap-1.5 group/q min-w-0">
            <span className="text-[var(--dim)] text-xs font-mono truncate">
              {q.length > 70 ? q.slice(0, 70) + '…' : q}
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
  ]

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-[var(--dim)] uppercase tracking-wider font-medium">
            {patterns.length} patterns
          </span>
          <AnalyzeTabBtn
            label="Query Patterns"
            data={{ patterns }}
            tab="patterns"
            onAnalyze={onAnalyze}
            disabled={patterns.length === 0}
          />
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
/*  Main Explore Component                                             */
/* ------------------------------------------------------------------ */

export default function Explore({ refreshKey }: { refreshKey?: number }) {
  const { instances, selectedInstance, setSelectedInstance, setView, from, to } = useStore()
  const [tab, setTab] = useState<Tab>('patterns')
  const [queryModal, setQueryModal] = useState<string | null>(null)
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
          {tab === 'patterns' && <QueryPatternsTab instance={inst} from={from} to={to} refreshKey={refreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
          {tab === 'failures' && <FailuresTab instance={inst} from={from} to={to} refreshKey={refreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
          {tab === 'merges' && <MergesTab instance={inst} from={from} to={to} refreshKey={refreshKey} onAnalyze={handleAnalyze} onShowQuery={handleShowQuery} />}
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
