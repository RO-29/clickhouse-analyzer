import type {
  Instance,
  MetricResponse,
  HealthCheck,
  Alert,
  QueryPattern,
  QueryResult,
  QueryHistoryEntry,
  HistoryMerge,
  HistoryFailure,
  HistoryInsert,
  HistoryS3,
  HistoryAsyncMetric,
  S3Stats,
  LogEntry,
  CHLogEntry,
  Suggestion,
  DiskInfo,
  TableScanResult,
  CostReport,
  CostOverview,
  ReplicaStatus,
} from '../types/api'

const BASE = ''

async function get<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

async function post<T>(path: string, body: any): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try { const j = await r.json(); if (j?.error) msg = j.error } catch {}
    throw new Error(msg)
  }
  return r.json()
}

export const api = {
  overview: () => get<Instance[]>('/api/overview'),
  instances: () => get<Instance[]>('/api/instances'),
  metrics: (inst: string, name: string, from: number, to: number, points = 120) =>
    get<MetricResponse>(`/api/instances/${inst}/metrics?name=${name}&from=${from}&to=${to}&points=${points}`),
  healthCheck: (inst: string) => get<HealthCheck[]>(`/api/instances/${inst}/health-check`),
  alerts: {
    active: () => get<Alert[]>('/api/alerts/active'),
    history: (limit = 500) => get<Alert[]>(`/api/alerts/history?limit=${limit}`),
    at: (inst: string, from: number, to: number) =>
      get<HealthCheck[]>(`/api/instances/${inst}/alerts-at?from=${from}&to=${to}`),
    resolveStale: (hours: number) =>
      post<{ resolved: number }>(`/api/alerts/resolve-stale?hours=${hours}`, {}),
    resolve: (dedupKey: string) =>
      post<{ status: string }>('/api/alerts/resolve', { dedup_key: dedupKey }),
  },
  queries: (inst: string) => get<Record<string, any>[]>(`/api/instances/${inst}/queries`),
  tables: (inst: string) => get<Record<string, any>[]>(`/api/instances/${inst}/tables`),
  disks: (inst: string) => get<DiskInfo[]>(`/api/instances/${inst}/disks`),
  mvs: (inst: string) => get<Record<string, any>[]>(`/api/instances/${inst}/mvs`),
  s3Stats: (inst: string) => get<S3Stats>(`/api/instances/${inst}/s3-stats`),
  suggestions: (category: string) => get<Suggestion>(`/api/suggestions/${category}`),
  terminal: {
    execute: (instance: string, query: string, limit = 1000) =>
      post<QueryResult>('/api/query', { instance, query, limit }),
    history: () => get<QueryHistoryEntry[]>('/api/query/history'),
  },
  history: {
    merges: (inst: string, from: number, to: number) =>
      get<HistoryMerge[]>(`/api/instances/${inst}/history/merges?from=${from}&to=${to}`),
    failures: (inst: string, from: number, to: number) =>
      get<HistoryFailure[]>(`/api/instances/${inst}/history/failures?from=${from}&to=${to}`),
    inserts: (inst: string, from: number, to: number) =>
      get<HistoryInsert[]>(`/api/instances/${inst}/history/inserts?from=${from}&to=${to}`),
    s3: (inst: string, from: number, to: number) =>
      get<HistoryS3[]>(`/api/instances/${inst}/history/s3?from=${from}&to=${to}`),
    mvs: (inst: string, from: number, to: number) =>
      get<Record<string, any>[]>(`/api/instances/${inst}/history/mvs?from=${from}&to=${to}`),
    asyncMetrics: (inst: string, from: number, to: number, metrics: string) =>
      get<HistoryAsyncMetric[]>(`/api/instances/${inst}/history/async-metrics?from=${from}&to=${to}&metrics=${metrics}`),
    diskIO: (inst: string, from: number, to: number) =>
      get<HistoryAsyncMetric[]>(`/api/instances/${inst}/history/disk-io?from=${from}&to=${to}`),
    queryPatterns: (inst: string, from: number, to: number, limit = 50) =>
      get<QueryPattern[]>(`/api/instances/${inst}/query-patterns?from=${from}&to=${to}&limit=${limit}`),
    queryPatternTimeline: (inst: string, hash: string, from: number, to: number) =>
      get<Record<string, any>[]>(`/api/instances/${inst}/query-pattern-timeline?hash=${hash}&from=${from}&to=${to}`),
  },
  logs: (level?: string, search?: string, limit = 500) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (level) params.set('level', level)
    if (search) params.set('search', search)
    return get<LogEntry[]>(`/api/logs?${params}`)
  },
  chLogs: (inst: string, level?: string, search?: string, minutes = 60, limit = 200) => {
    const params = new URLSearchParams({ limit: String(limit), minutes: String(minutes) })
    if (level) params.set('level', level)
    if (search) params.set('search', search)
    return get<CHLogEntry[]>(`/api/instances/${inst}/ch-logs?${params}`)
  },
  compare: {
    tables: () => get<any>('/api/compare/tables'),
    settings: () => get<any>('/api/compare/settings'),
    metrics: () => get<any>('/api/compare/metrics'),
  },
  tableMemory: (inst: string) => get<any[]>(`/api/instances/${inst}/table-memory`),
  cacheStats: (inst: string) => get<any>(`/api/instances/${inst}/cache-stats`),
  advisor: {
    compression: (inst: string) => get<any[]>(`/api/instances/${inst}/advisor/compression`),
    queryRegression: (inst: string) => get<any[]>(`/api/instances/${inst}/advisor/query-regression`),
    newPatterns: (inst: string) => get<any[]>(`/api/instances/${inst}/advisor/new-patterns`),
    unusedTables: (inst: string) => get<any[]>(`/api/instances/${inst}/advisor/unused-tables`),
    schema: (inst: string) => get<any[]>(`/api/instances/${inst}/advisor/schema`),
    cardinality: (inst: string) => get<any[]>(`/api/instances/${inst}/advisor/cardinality`),
    storagePolicy: (inst: string) => get<any[]>(`/api/instances/${inst}/advisor/storage-policy`),
  },
  tableDetail: (inst: string, db: string, table: string) => get<any>(`/api/instances/${inst}/table-detail/${db}/${table}`),
  tableScan: (inst: string, from?: number, to?: number) => {
    const params = new URLSearchParams()
    if (from) params.set('from', String(from))
    if (to) params.set('to', String(to))
    const qs = params.toString()
    return get<TableScanResult>(`/api/instances/${inst}/table-scan${qs ? '?' + qs : ''}`)
  },
  cost: (inst: string) => get<CostReport>(`/api/instances/${inst}/cost`),
  costOverview: () => get<CostOverview>('/api/cost'),
  replication: (inst: string) => get<ReplicaStatus[]>(`/api/instances/${inst}/replication`),
  analyzeElementQueries: (inst: string, tab: string, elementId?: string) => {
    const params = new URLSearchParams({ tab })
    if (elementId) params.set('element_id', elementId)
    return get<{ queries: Array<{ sql: string; description: string }>; description: string }>(
      `/api/instances/${inst}/analyze-element/queries?${params}`,
    )
  },
}
