import { useState, useEffect, useMemo, useCallback, type ChangeEvent } from 'react'
import { useStore } from '../hooks/useStore'
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

/* ------------------------------------------------------------------ */
/*  Query Patterns Tab                                                 */
/* ------------------------------------------------------------------ */

function QueryPatternsTab({ instance, from, to }: { instance: string; from: number; to: number }) {
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
      .then((d) => { if (!c) setPatterns(d) })
      .catch((e) => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to])

  useEffect(() => {
    if (!selectedHash) return
    let c = false
    setTlLoading(true)
    api.history.queryPatternTimeline(instance, selectedHash, from, to)
      .then((d) => { if (!c) setTimeline(Array.isArray(d) ? d : []) })
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
      format: (v: any) => (
        <span className="text-[var(--dim)]" title={String(v ?? '')}>
          {String(v ?? '').length > 100 ? String(v).slice(0, 100) + '...' : String(v ?? '')}
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <Card>
        <DataTable
          columns={columns}
          data={patterns}
          onRowClick={(r) => setSelectedHash(String(r.normalized_query_hash))}
          emptyText="No query patterns found"
        />
      </Card>
      {selectedHash && (
        <div className="mt-4">
          {tlLoading
            ? <div className="text-sm text-[var(--dim)] p-4">Loading timeline for {selectedHash.slice(0, 12)}...</div>
            : timeline.length === 0
              ? <div className="text-sm text-[var(--dim)] p-4 bg-[var(--surface)] border border-[var(--border)] rounded-xl">No timeline data for hash {selectedHash.slice(0, 12)} in selected time range. Try expanding the time range.</div>
              : <HistoryChart
                  title={`Timeline: ${selectedHash.slice(0, 12)}`}
                  data={timeline}
                  series={[
                    { key: 'cnt', label: 'Count', color: C.blue },
                    { key: 'avg_ms', label: 'Avg ms', color: C.yellow },
                  ]}
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

function FailuresTab({ instance, from, to }: { instance: string; from: number; to: number }) {
  const [data, setData] = useState<HistoryFailure[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.failures(instance, from, to)
      .then((d) => { if (!c) setData(d) })
      .catch((e) => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to])

  const byTs = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of data) {
      map.set(r.ts, (map.get(r.ts) ?? 0) + r.cnt)
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ts, cnt]) => ({ ts, cnt }))
  }, [data])

  const byCode = useMemo(() => {
    const map = new Map<number, { count: number; sample: string }>()
    for (const r of data) {
      const prev = map.get(r.exception_code)
      if (prev) {
        prev.count += r.cnt
      } else {
        map.set(r.exception_code, { count: r.cnt, sample: r.sample })
      }
    }
    return [...map.entries()]
      .map(([code, v]) => ({ exception_code: code, count: v.count, sample: v.sample }))
      .sort((a, b) => b.count - a.count)
  }, [data])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  return (
    <div className="space-y-4">
      <HistoryChart
        title="Failures Over Time"
        data={byTs}
        series={[{ key: 'cnt', label: 'Count', color: C.red }]}
      />
      <Card>
        <div className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider mb-2">
          By Exception Code
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
                  {String(v ?? '').length > 120 ? String(v).slice(0, 120) + '...' : String(v ?? '')}
                </span>
              ),
            },
          ]}
          data={byCode}
          emptyText="No failures"
        />
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Merges & Parts Tab                                                 */
/* ------------------------------------------------------------------ */

function MergesTab({ instance, from, to }: { instance: string; from: number; to: number }) {
  const [data, setData] = useState<HistoryMerge[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.merges(instance, from, to)
      .then((d) => { if (!c) setData(d) })
      .catch((e) => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  return (
    <div className="space-y-4">
      <HistoryChart
        title="Merges & Parts"
        data={data}
        series={[
          { key: 'merge_count', label: 'Merge Count', color: C.blue },
          { key: 'new_part_count', label: 'New Parts', color: C.green },
          { key: 'remove_count', label: 'Removed', color: C.red },
        ]}
      />
      <HistoryChart
        title="Average Merge Duration"
        data={data}
        series={[{ key: 'avg_merge_ms', label: 'Avg Merge ms', color: C.orange }]}
        yFormat="ms"
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  MV Performance Tab                                                 */
/* ------------------------------------------------------------------ */

function MVTab({ instance, from, to }: { instance: string; from: number; to: number }) {
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
      .then((d) => { if (!c) setData(d) })
      .catch((e) => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to])

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
      view_name: name,
      cnt: v.cnt,
      avg_ms: v.n > 0 ? v.sumAvg / v.n : 0,
      max_ms: v.maxMax,
      failures: v.failures,
    })).sort((a, b) => b.cnt - a.cnt)
  }, [data])

  const selectedData = useMemo(() => {
    if (!selectedView) return []
    return data
      .filter((r) => (r.view_name ?? r.target_name) === selectedView)
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  }, [data, selectedView])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  return (
    <div className="space-y-4">
      <Card>
        <DataTable
          columns={[
            { key: 'view_name', label: 'View Name' },
            { key: 'cnt', label: 'Count', format: (v: any) => fmtNum(v) },
            { key: 'avg_ms', label: 'Avg ms', format: (v: any) => fmtDuration(v) },
            { key: 'max_ms', label: 'Max ms', format: (v: any) => fmtDuration(v) },
            { key: 'failures', label: 'Failures', format: (v: any) => fmtNum(v) },
          ]}
          data={aggregated}
          onRowClick={(r) => setSelectedView(r.view_name)}
          emptyText="No materialized view data"
        />
      </Card>
      {selectedView && selectedData.length > 0 && (
        <HistoryChart
          title={`MV: ${selectedView}`}
          data={selectedData}
          series={[{ key: 'avg_ms', label: 'Avg ms', color: C.purple }]}
          yFormat="ms"
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  S3 Latency Tab                                                     */
/* ------------------------------------------------------------------ */

function S3Tab({ instance, from, to }: { instance: string; from: number; to: number }) {
  const [history, setHistory] = useState<HistoryS3[]>([])
  const [stats, setStats] = useState<S3Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    Promise.all([
      api.history.s3(instance, from, to),
      api.s3Stats(instance),
    ])
      .then(([h, s]) => { if (!c) { setHistory(h); setStats(s) } })
      .catch((e) => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  return (
    <div className="space-y-4">
      <HistoryChart
        title="S3 Latency & Requests"
        data={history}
        series={[
          { key: 'avg_latency_ms', label: 'Avg Latency ms', color: C.blue },
          { key: 'total_s3_requests', label: 'Total Requests', color: C.green },
        ]}
      />
      {stats?.latency_by_query && stats.latency_by_query.length > 0 && (
        <Card>
          <div className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider mb-2">
            S3 Latency by Query
          </div>
          <DataTable
            columns={[
              {
                key: 'normalized_query_hash',
                label: 'Hash',
                format: (v: any) => String(v ?? '').slice(0, 12),
              },
              { key: 'cnt', label: 'Count', format: (v: any) => fmtNum(v) },
              { key: 'avg_latency_ms', label: 'Avg ms', format: (v: any) => fmtDuration(Number(v ?? 0)) },
              { key: 'max_latency_ms', label: 'Max ms', format: (v: any) => fmtDuration(Number(v ?? 0)) },
              {
                key: 'sample_query',
                label: 'Sample',
                format: (v: any) => (
                  <span className="text-[var(--dim)]" title={String(v ?? '')}>
                    {String(v ?? '').slice(0, 100)}
                  </span>
                ),
              },
            ]}
            data={stats.latency_by_query}
            emptyText="No query data"
          />
        </Card>
      )}
      {stats?.latency_by_table && stats.latency_by_table.length > 0 && (
        <Card>
          <div className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider mb-2">
            S3 Latency by Table
          </div>
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
/*  Insert Throughput Tab                                               */
/* ------------------------------------------------------------------ */

function InsertsTab({ instance, from, to }: { instance: string; from: number; to: number }) {
  const [data, setData] = useState<HistoryInsert[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.inserts(instance, from, to)
      .then((d) => { if (!c) setData(d) })
      .catch((e) => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to])

  const byTs = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of data) {
      map.set(r.ts, (map.get(r.ts) ?? 0) + r.total_rows)
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ts, total_rows]) => ({ ts, total_rows }))
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
    return [...map.entries()]
      .map(([table, v]) => ({ table, ...v }))
      .sort((a, b) => b.total_rows - a.total_rows)
  }, [data])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  return (
    <div className="space-y-4">
      <HistoryChart
        title="Insert Throughput (Rows)"
        data={byTs}
        series={[{ key: 'total_rows', label: 'Total Rows', color: C.blue }]}
      />
      <Card>
        <div className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider mb-2">
          By Table
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
          emptyText="No insert data"
        />
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  System Metrics Tab                                                 */
/* ------------------------------------------------------------------ */

function SystemMetricsTab({ instance, from, to }: { instance: string; from: number; to: number }) {
  const [data, setData] = useState<HistoryAsyncMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.asyncMetrics(
      instance, from, to,
      'MemoryResident,CGroupMemoryUsed,LoadAverage1,LoadAverage5,LoadAverage15',
    )
      .then((d) => { if (!c) setData(d) })
      .catch((e) => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to])

  // Pivot: for each unique ts, create a row with each metric as a column
  const { memoryData, loadData } = useMemo(() => {
    const allTs = [...new Set(data.map((r) => r.ts))].sort()
    const grouped = new Map<string, Map<string, number>>()
    for (const r of data) {
      if (!grouped.has(r.metric)) grouped.set(r.metric, new Map())
      grouped.get(r.metric)!.set(r.ts, r.avg_value)
    }

    const memoryMetrics = ['MemoryResident', 'CGroupMemoryUsed']
    const loadMetrics = ['LoadAverage1', 'LoadAverage5', 'LoadAverage15']

    const memoryData = allTs.map((ts) => {
      const row: Record<string, any> = { ts }
      for (const m of memoryMetrics) {
        row[m] = grouped.get(m)?.get(ts) ?? 0
      }
      return row
    })

    const loadData = allTs.map((ts) => {
      const row: Record<string, any> = { ts }
      for (const m of loadMetrics) {
        row[m] = grouped.get(m)?.get(ts) ?? 0
      }
      return row
    })

    return { memoryData, loadData }
  }, [data])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  return (
    <div className="space-y-4">
      <HistoryChart
        title="Memory"
        data={memoryData}
        series={[
          { key: 'MemoryResident', label: 'MemoryResident', color: C.blue },
          { key: 'CGroupMemoryUsed', label: 'CGroupMemoryUsed', color: C.green },
        ]}
        yFormat="bytes"
      />
      <HistoryChart
        title="Load Average"
        data={loadData}
        series={[
          { key: 'LoadAverage1', label: 'LoadAverage1', color: C.blue },
          { key: 'LoadAverage5', label: 'LoadAverage5', color: C.yellow },
          { key: 'LoadAverage15', label: 'LoadAverage15', color: C.red },
        ]}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Disk I/O Tab                                                       */
/* ------------------------------------------------------------------ */

function DiskIOTab({ instance, from, to }: { instance: string; from: number; to: number }) {
  const [data, setData] = useState<HistoryAsyncMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    api.history.diskIO(instance, from, to)
      .then((d) => { if (!c) setData(d) })
      .catch((e) => { if (!c) setError(e.message) })
      .finally(() => { if (!c) setLoading(false) })
    return () => { c = true }
  }, [instance, from, to])

  // Pivot into rows with ts, read_bytes, write_bytes
  const pivoted = useMemo(() => {
    const allTs = [...new Set(data.map((r) => r.ts))].sort()
    const readMap = new Map<string, number>()
    const writeMap = new Map<string, number>()
    for (const r of data) {
      const m = r.metric
      const target = m.includes('ReadBytes') || m.includes('Read') ? readMap : writeMap
      target.set(r.ts, (target.get(r.ts) ?? 0) + r.avg_value)
    }
    return allTs.map((ts) => ({
      ts,
      read_bytes: readMap.get(ts) ?? 0,
      write_bytes: writeMap.get(ts) ?? 0,
    }))
  }, [data])

  if (loading) return <LoadingSkeleton />
  if (error) return <ErrorBox message={error} />

  return (
    <HistoryChart
      title="Disk I/O"
      data={pivoted}
      series={[
        { key: 'read_bytes', label: 'Read Bytes', color: C.blue },
        { key: 'write_bytes', label: 'Write Bytes', color: C.orange },
      ]}
      yFormat="bytes"
    />
  )
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

function LoadingSkeleton() {
  return (
    <Card className="animate-pulse">
      <div className="h-4 bg-[var(--hover)] rounded w-1/4 mb-3" />
      <div className="h-48 bg-[var(--hover)] rounded" />
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

export default function Explore() {
  const { instances, selectedInstance, setSelectedInstance, from, to } = useStore()
  const [tab, setTab] = useState<Tab>('patterns')
  const inst = selectedInstance || instances[0] || ''

  const handleInstChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => setSelectedInstance(e.target.value),
    [setSelectedInstance],
  )

  return (
    <div className="space-y-4">
      {/* Instance selector */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-[var(--dim)]">Instance</label>
        <select
          value={inst}
          onChange={handleInstChange}
          className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
        >
          {instances.map((i) => (
            <option key={i} value={i}>{i}</option>
          ))}
        </select>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-[var(--border)] pb-px">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'px-3 py-2 text-sm whitespace-nowrap rounded-t-md transition-colors',
              tab === t.key
                ? 'text-[var(--accent)] border-b-2 border-[var(--accent)] font-medium'
                : 'text-[var(--dim)] hover:text-[var(--fg)]',
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
          {tab === 'patterns' && <QueryPatternsTab instance={inst} from={from} to={to} />}
          {tab === 'failures' && <FailuresTab instance={inst} from={from} to={to} />}
          {tab === 'merges' && <MergesTab instance={inst} from={from} to={to} />}
          {tab === 'mvs' && <MVTab instance={inst} from={from} to={to} />}
          {tab === 's3' && <S3Tab instance={inst} from={from} to={to} />}
          {tab === 'inserts' && <InsertsTab instance={inst} from={from} to={to} />}
          {tab === 'metrics' && <SystemMetricsTab instance={inst} from={from} to={to} />}
          {tab === 'diskio' && <DiskIOTab instance={inst} from={from} to={to} />}
        </>
      )}
    </div>
  )
}
