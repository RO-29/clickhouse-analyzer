import type {
  Instance,
  MetricResponse,
  HealthCheck,
  Alert,
  AlertStats,
  PartsAgeEntry,
  QueryPattern,
  QueryPatternV2,
  QuerySample,
  QueryUser,
  QueryTable,
  PatternOverviewResponse,
  CompareQueryPatternsResult,
  QueryResult,
  QueryHistoryEntry,
  HistoryMerge,
  HistoryFailure,
  HistoryInsert,
  HistoryS3,
  HistoryAsyncMetric,
  S3Stats,
  S3LatencyByTableRow,
  LogEntry,
  CHLogEntry,
  Suggestion,
  DiskInfo,
  TableScanResult,
  PartitionDiskRow,
  CostReport,
  CostOverview,
  ReplicaStatus,
  MaintenanceWindow,
  HealthResponse,
  CollectorMeta,
  RunCheckResponse,
  SnoozeEntry,
  AckEntry,
  AuditEvent,
  SLOReport,
  AnomalyContext,
  ThresholdsConfig,
} from '../types/api'

const BASE = ''

function toastApiError(path: string, status: number) {
  // Don't toast on auth errors (will be handled by auth flow) or 404s (expected)
  if (status === 401) {
    window.dispatchEvent(new CustomEvent('ch:auth-expired'))
    return
  }
  if (status === 403 || status === 404) return
  const event = new CustomEvent('ch-toast', {
    detail: {
      id: Date.now().toString(36),
      kind: 'error',
      title: 'API error',
      body: `${status} — ${path.split('?')[0]}`,
      timestamp: Date.now(),
      ephemeral: true,
    }
  })
  window.dispatchEvent(event)
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(30_000) })
  if (!r.ok) {
    toastApiError(path, r.status)
    throw new Error(`HTTP ${r.status}`)
  }
  return r.json()
}

async function post<T>(path: string, body: any): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try { const j = await r.json(); if (j?.error) msg = j.error } catch {}
    throw new Error(msg)
  }
  return r.json()
}

async function postWithSignal<T>(path: string, body: any, signal?: AbortSignal): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(30_000),
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
    active: (instance?: string) =>
      get<Alert[]>(`/api/alerts/active${instance ? `?instance=${encodeURIComponent(instance)}` : ''}`),
    history: (params?: { limit?: number; from?: number; to?: number; instance?: string; severity?: string; category?: string }) => {
      const p = new URLSearchParams({ limit: String(params?.limit ?? 500) })
      if (params?.from) p.set('from', String(params.from))
      if (params?.to) p.set('to', String(params.to))
      if (params?.instance) p.set('instance', params.instance)
      if (params?.severity) p.set('severity', params.severity)
      if (params?.category) p.set('category', params.category)
      return get<Alert[]>(`/api/alerts/history?${p}`)
    },
    stats: (hours = 24) => get<AlertStats>(`/api/alerts/stats?hours=${hours}`),
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
  s3LatencyByTable: (inst: string, from: number, to: number) =>
    get<S3LatencyByTableRow[]>(`/api/instances/${inst}/s3-latency-by-table?from=${from}&to=${to}`),
  suggestions: (category: string) => get<Suggestion>(`/api/suggestions/${category}`),
  terminal: {
    execute: (instance: string, query: string, limit = 1000, signal?: AbortSignal) =>
      postWithSignal<QueryResult>('/api/query', { instance, query, limit }, signal),
    history: () => get<QueryHistoryEntry[]>('/api/query/history'),
  },
  history: {
    merges: (inst: string, from: number, to: number) =>
      get<HistoryMerge[]>(`/api/instances/${inst}/history/merges?from=${from}&to=${to}`),
    failures: (inst: string, from: number, to: number, hash?: string) => {
      const p = new URLSearchParams({ from: String(from), to: String(to) })
      if (hash) p.set('hash', hash)
      return get<{ timeline: HistoryFailure[]; by_code: Record<string, any>[] }>(`/api/instances/${inst}/history/failures?${p}`)
    },
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
    queryPatternsV2: (inst: string, from: number, to: number, limit = 50, sortBy = 'total_ms') =>
      get<QueryPatternV2[]>(`/api/instances/${inst}/query-patterns-v2?from=${from}&to=${to}&limit=${limit}&sort_by=${sortBy}`),
    queryPatternTimeline: (inst: string, hash: string, from: number, to: number) =>
      get<Record<string, any>[]>(`/api/instances/${inst}/query-pattern-timeline?hash=${hash}&from=${from}&to=${to}`),
    querySamples: (inst: string, from: number, to: number, opts?: { hash?: string; user?: string; kind?: string; minMs?: string; limit?: number; errorsOnly?: boolean; table?: string }) => {
      const p = new URLSearchParams({ from: String(from), to: String(to), limit: String(opts?.limit ?? 100) })
      if (opts?.hash) p.set('hash', opts.hash)
      if (opts?.user) p.set('user', opts.user)
      if (opts?.kind) p.set('kind', opts.kind)
      if (opts?.minMs) p.set('min_ms', opts.minMs)
      if (opts?.errorsOnly) p.set('errors_only', '1')
      if (opts?.table) p.set('table', opts.table)
      return get<QuerySample[]>(`/api/instances/${inst}/query-samples?${p}`)
    },
    queryPatternOverview: (inst: string, from: number, to: number, topN = 8) =>
      get<PatternOverviewResponse>(`/api/instances/${inst}/query-pattern-overview?from=${from}&to=${to}&top_n=${topN}`),
    queryUsers: (inst: string, from: number, to: number) =>
      get<QueryUser[]>(`/api/instances/${inst}/query-users?from=${from}&to=${to}`),
    queryTables: (inst: string, from: number, to: number) =>
      get<QueryTable[]>(`/api/instances/${inst}/query-tables?from=${from}&to=${to}`),
  },
  killQuery: (inst: string, queryId: string) =>
    post<{ status: string; query_id: string }>(`/api/instances/${inst}/kill-query`, { query_id: queryId }),
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
    queryStats: () => get<any>('/api/compare/query-stats'),
    queryPatterns: (from?: number, to?: number) => {
      const p = new URLSearchParams()
      if (from) p.set('from', String(from))
      if (to) p.set('to', String(to))
      const qs = p.toString()
      return get<CompareQueryPatternsResult[]>(`/api/compare/query-patterns${qs ? '?' + qs : ''}`)
    },
    timeline: (metric: string, from: number, to: number, points = 60) =>
      get<{ metric: string; series: Array<{ instance: string; color: string; points: Array<{ ts: number; value: number }> }> }>(`/api/compare/metrics-timeline?metric=${encodeURIComponent(metric)}&from=${from}&to=${to}&points=${points}`),
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
    queryAntiPatterns: (inst: string) => get<any[]>(`/api/instances/${inst}/advisor/query-antipatterns`),
    tableAntiPatterns: (inst: string) => get<any[]>(`/api/instances/${inst}/advisor/table-antipatterns`),
  },
  tableDetail: (inst: string, db: string, table: string) => get<any>(`/api/instances/${inst}/table-detail/${db}/${table}`),
  tablePartitions: (inst: string, db: string, table: string) =>
    get<PartitionDiskRow[]>(`/api/instances/${inst}/table-partitions?db=${encodeURIComponent(db)}&table=${encodeURIComponent(table)}`),
  tableScan: (inst: string, from?: number, to?: number, includeSystem?: boolean, db?: string) => {
    const params = new URLSearchParams()
    if (from) params.set('from', String(from))
    if (to) params.set('to', String(to))
    if (includeSystem) params.set('include_system', 'true')
    if (db) params.set('db', db)
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
  maintenance: {
    list: () => get<MaintenanceWindow[]>('/api/maintenance'),
    create: (instance: string, reason: string, durationMinutes: number, createdBy?: string) =>
      post<MaintenanceWindow>('/api/maintenance', { instance, reason, duration_minutes: durationMinutes, created_by: createdBy ?? 'user' }),
    update: (id: string, updates: { end_time?: number; reason?: string }) =>
      fetch(`/api/maintenance/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
        signal: AbortSignal.timeout(30_000),
      }).then(async r => { if (!r.ok) { let msg = `HTTP ${r.status}`; try { const j = await r.json(); if (j?.error) msg = j.error } catch {} throw new Error(msg) } return r.json() as Promise<MaintenanceWindow> }),
    delete: (id: string) => fetch(`/api/maintenance/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(30_000) }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`) }).catch(err => { console.error('delete failed:', err); throw err }),
  },
  snooze: {
    list: () => get<SnoozeEntry[]>('/api/alerts/snoozes'),
    create: (dedupKey: string, instance: string, reason: string, durationMinutes: number) =>
      post<SnoozeEntry>('/api/alerts/snooze', { dedup_key: dedupKey, instance, reason, snoozed_by: 'user', duration_minutes: durationMinutes }),
    delete: (id: string) => fetch(`/api/alerts/snooze/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(30_000) }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`) }).catch(err => { console.error('delete failed:', err); throw err }),
  },
  ack: {
    list: () => get<AckEntry[]>('/api/alerts/acks'),
    create: (dedupKey: string, instance: string, reason: string) =>
      post<AckEntry>('/api/alerts/ack', { dedup_key: dedupKey, instance, reason, acked_by: 'user' }),
    delete: (id: string) => fetch(`/api/alerts/ack/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(30_000) }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`) }).catch(err => { console.error('delete failed:', err); throw err }),
  },
  healthTrend: (inst: string, from: number, to: number) =>
    get<Array<{ ts: string; score: number; criticals: number; warns: number }>>(`/api/instances/${inst}/health-trend?from=${from}&to=${to}`),
  notifyStatus: () => get<{
    slack: { configured: boolean; channel: string; has_token: boolean }
    pagerduty: { configured: boolean }
    webhook: { configured: boolean; url: string }
  }>('/api/notify/status'),
  auth: {
    status: () => get<{ logged_in: boolean; method?: string }>('/api/auth/status'),
  },
  health: () => get<HealthResponse>('/health'),
  collectors: () => get<CollectorMeta[]>('/api/collectors'),
  runCheck: (collectors: string[], instances: string[], from?: number, to?: number) =>
    post<RunCheckResponse>('/api/run-check', { collectors, instances, from, to }),
  forcePoll: () => post<{ status: string }>('/api/force-poll', {}),
  triggerAlert: (alert: { instance: string; severity: string; category: string; title: string; message: string; dedup_key?: string }) =>
    post<{ id: number; dedup_key: string }>('/api/alerts/trigger', alert),
  schedules: {
    list: () => get<any[]>('/api/schedules'),
    create: (instance: string, collectorName: string, intervalMins: number) =>
      post<any>('/api/schedules', { instance, collector_name: collectorName, interval_mins: intervalMins }),
    delete: (id: string) => fetch(`/api/schedules/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(30_000) }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`) }).catch(err => { console.error('delete failed:', err); throw err }),
    setEnabled: (id: string, enabled: boolean) =>
      fetch(`/api/schedules/${id}/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
        signal: AbortSignal.timeout(30_000),
      }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`) }).catch(err => { console.error('set enabled failed:', err); throw err }),
  },
  partsAge: (inst: string) => get<PartsAgeEntry[]>(`/api/instances/${inst}/parts-age`),
  audit: (opts?: { from?: number; to?: number; instance?: string; action?: string; limit?: number }) => {
    const p = new URLSearchParams({ limit: String(opts?.limit ?? 200) })
    if (opts?.from) p.set('from', String(opts.from))
    if (opts?.to) p.set('to', String(opts.to))
    if (opts?.instance) p.set('instance', opts.instance)
    if (opts?.action) p.set('action', opts.action)
    return get<AuditEvent[]>(`/api/audit?${p}`)
  },
  slo: (inst: string, windowDays = 7) => get<SLOReport>(`/api/instances/${inst}/slo?window=${windowDays}`),
  anomalyContext: (inst: string, metric: string) =>
    get<AnomalyContext>(`/api/instances/${inst}/anomaly-context?metric=${encodeURIComponent(metric)}`),
  thresholds: {
    get: () => get<ThresholdsConfig>('/api/thresholds'),
    save: (t: ThresholdsConfig) => post<ThresholdsConfig>('/api/thresholds', t),
  },
}
