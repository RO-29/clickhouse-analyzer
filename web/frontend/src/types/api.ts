export interface AreaStatus {
  area: string
  status: string
  label: string
}

export interface TopAlert {
  severity: string
  category: string
  title: string
  dedup_key: string
  possibly_recovered: boolean
  created_at: number
}

export interface AlertCounts {
  crit: number
  warn: number
  info: number
}

export interface Instance {
  name: string
  health_score: number
  status: string
  active_alerts: number
  alert_counts?: AlertCounts
  key_metrics: Record<string, number>
  area_status?: AreaStatus[]
  top_alerts?: TopAlert[]
  in_maintenance?: boolean
  maintenance_until?: string   // ISO timestamp, present when in_maintenance=true
  maintenance_reason?: string
}

export interface MetricPoint { ts: number; value: number }
export interface MetricResponse {
  instance: string; metric: string; from: number; to: number
  points: MetricPoint[]
}

export interface Alert {
  id: number; instance: string; severity: string; category: string
  title: string; message: string; resolved: boolean
  resolved_at?: number; created_at: number; updated_at: number; dedup_key: string
  duration_s: number
}

export interface AlertStats {
  period_hours: number
  total_fired: number
  currently_firing: number
  resolved: number
  critical: number
  warn: number
  avg_duration_secs: number
  top_categories: { category: string; count: number }[]
}

export interface PartsAgeEntry {
  database: string
  table: string
  part_count: number
  oldest_part_hours: number
  oldest_modification: string
  total_rows: number
  total_bytes: number
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

export interface QueryPatternV2 {
  normalized_query_hash: string
  cnt: number
  kind: string
  total_ms: number
  avg_ms: number
  max_ms: number
  p95_ms: number
  avg_read_rows: number
  avg_read_bytes: number
  avg_memory: number
  max_memory: number
  failures: number
  user: string
  client: string
  sample_query: string
}

export interface QuerySample {
  event_time: string
  user: string
  query_kind: string
  normalized_query_hash: string
  query_text: string
  query_duration_ms: number
  read_rows: number
  read_bytes: number
  memory_usage: number
  result_rows: number
  is_exception: number
  exception_code: number
  exception?: string
  client_name: string
  interface: string
  tables_accessed?: string
}

export interface QueryUser {
  user: string
  cnt: number
  total_ms: number
  avg_ms: number
  max_ms: number
  p95_ms: number
  total_read_bytes: number
  total_memory: number
  failures: number
  selects: number
  inserts: number
}

export interface PatternOverviewResponse {
  patterns: Array<{
    normalized_query_hash: string
    total_ms: number
    label: string
  }>
  timeline: Array<{
    ts: string
    normalized_query_hash: string
    total_ms: number
    cnt: number
  }>
}

export interface CompareQueryPattern {
  hash: string
  label: string
  kind: string
  cnt: number
  total_ms: number
  avg_ms: number
  max_ms: number
  p95_ms: number
  avg_read_rows: number
  failures: number
  user: string
}

export interface CompareQueryPatternsResult {
  instance: string
  patterns: CompareQueryPattern[]
  error?: string
}

export interface StatementResult {
  sql: string
  columns: string[]
  types: string[]
  rows: Record<string, any>[]
  row_count: number
  elapsed_ms: number
}

export interface QueryResult {
  columns: any[]
  types?: string[]
  rows: Record<string, any>[]
  row_count: number; elapsed_ms: number; instance: string
  error?: string
  statements_run?: number
  results?: StatementResult[]
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

// Chat session model (replaces AISession + AnalysisEntry)
export interface ChatSession {
  id: string
  name: string              // first user message, truncated
  instance: string
  timeWindowMins: number
  createdAt: number         // epoch ms
  updatedAt: number         // epoch ms
  messages: ChatMessage[]
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string           // user: question text; assistant: streamed markdown output
  status: 'streaming' | 'done' | 'error'
  timestamp: number         // epoch ms
  // Assistant-only fields:
  phase?: 'planning' | 'collecting' | 'streaming' | 'done' | 'error'
  thinkingLines?: ThinkingLine[]
  steps?: StepInfo[]
  logs?: ChatLogEntry[]
  evidence?: {
    promptBytes: number
    promptKb: number
    truncated: boolean
    promptHead: string
    rowCounts: Record<string, number>
    collectionErrors: string[]
    mode: string
    instance: string
  }
}

export interface ChatLogEntry {
  ts: number                // epoch ms (absolute)
  offsetMs: number          // ms since message started
  kind: 'phase' | 'tool_start' | 'tool_done' | 'debug' | 'error' | 'done'
  text: string
  phase?: string
  sql?: string
  rowCount?: number
  elapsedMs?: number
  promptKb?: number
  truncated?: boolean
  mode?: string
}

export interface ThinkingLine {
  kind: 'plan' | 'tool' | 'sql'
  text: string
}

export interface StepInfo {
  id: string
  label: string
  sql?: string
  status: 'pending' | 'running' | 'done' | 'error'
  rowCount?: number
  elapsedMs?: number
}

// Table scanner types
export interface DiskUsageEntry {
  disk_name: string
  disk_type: string
  bytes: number
  parts: number
  readable_size: string
}

export interface TableQueryPattern {
  query_prefix: string
  exec_count: number
  avg_ms: number
  max_ms: number
}

export interface TableSlowStats {
  avg_ms: number
  max_ms: number
  p95_ms: number
  slow_count: number
}

export interface TableQueryActivity {
  select_count: number
  insert_count: number
  last_select?: string
  last_insert?: string
  is_active: boolean
  slow_stats?: TableSlowStats
  top_patterns?: TableQueryPattern[]
}

export interface TableScanEntry {
  database: string
  table: string
  engine: string
  storage_policy: string
  sorting_key: string
  primary_key: string
  partition_key: string
  sampling_key: string
  total_rows: number
  total_bytes: number
  parts_count: number
  create_query: string
  disk_usage: DiskUsageEntry[]
  query_activity: TableQueryActivity
  schema_issues?: string[]
}

export interface TableScanResult {
  tables: TableScanEntry[]
  scanned_at: string
  time_from: string
  time_to: string
  warnings?: string[]
  activity_rows: number
}

// Cost Explorer
export interface CostPricing {
  model: string
  vcpu_hourly_usd: number
  server_hourly_usd: number
  ebs_gb_monthly_usd: number
  s3_gb_monthly_usd: number
}

export interface CostStorage {
  local_bytes: number
  s3_bytes: number
  local_gb: number
  s3_gb: number
  local_monthly_usd: number
  s3_monthly_usd: number
  total_monthly_usd: number
}

export interface CostCompute {
  vcpu_limit: number
  memory_gb: number
  server_count: number
  monthly_server_fee_usd: number
  monthly_vcpu_usd: number
  monthly_total_usd: number
  source: string
}

export interface CostTableEntry {
  database: string
  table: string
  local_bytes: number
  s3_bytes: number
  local_gb: number
  s3_gb: number
  monthly_usd: number
}

export interface CostReport {
  instance: string
  generated_at: string
  storage: CostStorage
  compute: CostCompute
  by_table: CostTableEntry[]
  pricing: CostPricing
  total_monthly_usd: number
  notes: string[]
}

export interface CostOverviewEntry {
  instance: string
  total_monthly_usd: number
  storage_usd: number
  compute_usd: number
  local_gb: number
  s3_gb: number
}

export interface CostOverview {
  instances: CostOverviewEntry[]
  total_monthly_usd: number
  pricing: CostPricing
}

// Keep AnalyzeOptions for inline Analyze buttons on other tabs
export interface ReplicaStatus {
  database: string
  table: string
  replica_name: string
  is_leader: boolean
  is_readonly: boolean
  is_session_expired: boolean
  future_parts: number
  parts_to_check: number
  queue_size: number
  inserts_in_queue: number
  merges_in_queue: number
  log_max_index: number
  log_pointer: number
  absolute_delay: number
  replica_is_active: boolean
  last_exception: string
}

export interface AnalyzeOptions {
  contextType: 'tab' | 'row' | 'chart' | 'followup'
  tab: string
  elementId?: string
  mode?: 'quick' | 'deep'
  deepQueries?: string[]
}

export interface MaintenanceWindow {
  id: string
  instance: string      // "*" means all instances
  reason: string
  started_at: string    // ISO timestamp
  ends_at: string       // ISO timestamp
  created_by: string
}

export interface HealthInstance {
  name: string
  status: string        // "ok" | "degraded" | "unreachable"
  last_poll_at?: string
  active_alerts: number
}

export interface HealthResponse {
  status: string        // "ok" | "degraded"
  version: string
  uptime: string
  last_poll_at?: string
  instances: HealthInstance[]
}

export interface CollectorMeta {
  name: string
  display_name: string
  description: string
  category: string
}

export interface RunCheckMetric {
  name: string
  value: number
  labels: Record<string, string>
}

export interface RunCheckAlert {
  severity: string
  category: string
  title: string
  message: string
}

export interface RunCheckResult {
  instance: string
  collector: string
  display_name: string
  duration_ms: number
  alerts: RunCheckAlert[]
  metrics: RunCheckMetric[]
  queries: string[]
  error: string
}

export interface RunCheckResponse {
  results: RunCheckResult[]
}
