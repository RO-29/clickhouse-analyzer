export interface AreaStatus {
  area: string
  status: string
  label: string
}

export interface TopAlert {
  severity: string
  category: string
  title: string
}

export interface Instance {
  name: string
  health_score: number
  status: string
  active_alerts: number
  key_metrics: Record<string, number>
  area_status?: AreaStatus[]
  top_alerts?: TopAlert[]
}

export interface MetricPoint { ts: number; value: number }
export interface MetricResponse {
  instance: string; metric: string; from: number; to: number
  points: MetricPoint[]
}

export interface Alert {
  id: number; instance: string; severity: string; category: string
  title: string; message: string; resolved: boolean
  resolved_at?: number; created_at: number; dedup_key: string
}

export interface HealthCheck {
  id: string; category: string; name: string; status: string
  value: string; threshold: string; detail: string
}

export interface QueryPattern {
  normalized_query_hash: string; cnt: number; kind: string
  avg_ms: number; max_ms: number; p95_ms: number
  avg_read_rows: number; avg_memory: number; max_memory: number
  failures: number; user: string; client: string; sample_query: string
}

export interface QueryResult {
  columns: any[]
  types?: string[]
  rows: Record<string, any>[]
  row_count: number; elapsed_ms: number; instance: string
  error?: string
}

export interface QueryHistoryEntry {
  instance: string; query: string; row_count: number
  elapsed_ms: number; error: string; timestamp: string
}

export interface HistoryMerge {
  ts: string; merge_count: number; new_part_count: number
  remove_count: number; move_count: number
  avg_merge_ms: number; merged_rows: number; merged_bytes: number
}

export interface HistoryFailure {
  ts: string; cnt: number; exception_code: number; sample: string
}

export interface HistoryInsert {
  ts: string; database: string; table: string
  insert_count: number; total_rows: number; total_bytes: number
  small_insert_count: number
}

export interface HistoryS3 {
  ts: string; query_count: number; total_s3_requests: number
  total_s3_us: number; avg_latency_ms: number
}

export interface HistoryAsyncMetric {
  ts: string; metric: string; avg_value: number; max_value: number
}

export interface S3Stats {
  volume_by_table: { database: string; table: string; disk_name: string; parts: number; bytes: number; size: string }[]
  latency_by_query: Record<string, any>[]
  latency_by_table: Record<string, any>[]
}

export interface LogEntry {
  time: string; level: string; msg: string; attrs: Record<string, any>
}

export interface CHLogEntry {
  event_time: string; level: string; logger_name: string
  message: string; query_id: string
}

export interface Suggestion {
  category: string; suggestions: string[]
}

export interface DiskInfo {
  disk_name: string; path: string; free_space: number; total_space: number
  free_readable: string; total_readable: string; used_percent: number
}
