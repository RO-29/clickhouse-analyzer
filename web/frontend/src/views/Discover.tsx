import { useState } from 'react'
import {
  Search, Zap, Database, BarChart2, AlertTriangle, Shield, Terminal,
  Layers, DollarSign, GitCompareArrows, Sparkles, PlayCircle, FileText,
  Activity, Clock, Users, TrendingDown, TrendingUp, Table2, Boxes,
  HardDrive, RefreshCw, Eye, Bug, Wrench, ArrowRight, Info, Bell,
} from 'lucide-react'
import { useStore } from '../hooks/useStore'
import type { View } from '../hooks/useStore'
import { cn } from '../lib/utils'

// ── Types ────────────────────────────────────────────────────────────────────

interface Feature {
  id: string
  name: string
  description: string
  whatsToLookFor: string
  dataSources: string[]
  view: View
  tab?: string          // for Explore tabs
  icon: React.ReactNode
  severity?: 'critical' | 'warn' | 'info' | 'neutral'
  tags?: string[]
}

interface Category {
  id: string
  label: string
  color: string
  bgColor: string
  borderColor: string
  icon: React.ReactNode
  features: Feature[]
}

// ── Feature definitions ───────────────────────────────────────────────────────

const CATEGORIES: Category[] = [
  {
    id: 'query',
    label: 'Query Health',
    color: 'text-orange-400',
    bgColor: 'bg-orange-500/8',
    borderColor: 'border-orange-500/20',
    icon: <BarChart2 size={18} />,
    features: [
      {
        id: 'query-patterns',
        name: 'Query Patterns',
        description: 'Aggregate statistics per normalized query shape — execution count, avg/p95/max latency, memory, failure rate.',
        whatsToLookFor: 'High total_ms (expensive patterns), high failure count, p95 >> avg (spikes), queries with high avg_read_bytes.',
        dataSources: ['system.query_log'],
        view: 'explore',
        tab: 'patterns',
        icon: <BarChart2 size={16} />,
        severity: 'neutral',
        tags: ['performance', 'latency'],
      },
      {
        id: 'live-queries',
        name: 'Live Queries',
        description: 'Queries running right now. See elapsed time, memory, user, and read progress in real time.',
        whatsToLookFor: 'Queries running >60s, high memory_usage, blocked queries. Use kill button to abort runaway queries.',
        dataSources: ['system.processes'],
        view: 'explore',
        tab: 'live',
        icon: <Activity size={16} />,
        severity: 'warn',
        tags: ['real-time', 'operations'],
      },
      {
        id: 'query-antipatterns',
        name: 'Query Anti-patterns',
        description: 'Automatically detected bad query habits: SELECT *, no LIMIT, full scans, ORDER BY without LIMIT, heavy memory usage, low mark cache hit rate.',
        whatsToLookFor: 'SELECT * wastes I/O. Full scans skip index pruning. Queries using >10GB memory need optimization. Low mark cache hits = cold data or bad granularity.',
        dataSources: ['system.query_log', 'system.processes'],
        view: 'explore',
        tab: 'antipatterns',
        icon: <Bug size={16} />,
        severity: 'critical',
        tags: ['anti-patterns', 'performance', 'schema'],
      },
      {
        id: 'query-failures',
        name: 'Query Failures',
        description: 'Exceptions and error rates over time. Breakdown by error code and user.',
        whatsToLookFor: 'Exception code 241 = memory limit exceeded, 160 = timeout, 307 = unknown function. Spikes in failures = deployment or schema change.',
        dataSources: ['system.query_log'],
        view: 'explore',
        tab: 'failures',
        icon: <AlertTriangle size={16} />,
        severity: 'critical',
        tags: ['errors', 'reliability'],
      },
      {
        id: 'query-users',
        name: 'User Breakdown',
        description: 'Who is running what? Top users by total time, read bytes, failure rate, and query count.',
        whatsToLookFor: 'A single user consuming >50% of total query time. Users with high failure rates. Bots or scrapers with 1000s of tiny queries.',
        dataSources: ['system.query_log'],
        view: 'explore',
        tab: 'users',
        icon: <Users size={16} />,
        severity: 'neutral',
        tags: ['capacity', 'users'],
      },
      {
        id: 'query-regression',
        name: 'Query Regression',
        description: 'Queries that became >2× slower than their 24h rolling average or yesterday\'s same-hour baseline.',
        whatsToLookFor: 'Regression factor >3× = something changed (schema, data volume, missing index, hot partition). Compare with merge/insert activity.',
        dataSources: ['system.query_log'],
        view: 'advisor',
        icon: <TrendingDown size={16} />,
        severity: 'warn',
        tags: ['regression', 'performance'],
      },
      {
        id: 'new-patterns',
        name: 'New Query Patterns',
        description: 'Query patterns seen for the first time in the last 24h. Helps catch new or unexpected query shapes.',
        whatsToLookFor: 'New patterns from unknown users, suspicious queries, or patterns introduced after a deployment.',
        dataSources: ['system.query_log'],
        view: 'advisor',
        icon: <Sparkles size={16} />,
        severity: 'info',
        tags: ['security', 'monitoring'],
      },
      {
        id: 'samples',
        name: 'Query Samples',
        description: 'Individual query executions with full SQL, duration, memory, read bytes, and error messages.',
        whatsToLookFor: 'Filter by hash to find all executions of a pattern. Filter errors_only to see failed queries with full exception text.',
        dataSources: ['system.query_log'],
        view: 'explore',
        tab: 'samples',
        icon: <Eye size={16} />,
        severity: 'neutral',
        tags: ['debugging', 'investigation'],
      },
      {
        id: 'async-inserts',
        name: 'Async Inserts',
        description: 'Async insert queue depth, success rate, flush errors. Shows whether the async_insert buffer is keeping up.',
        whatsToLookFor: 'Queue depth growing = inserts arriving faster than they flush. Failure rate >1% = data loss risk. Check async_insert_max_data_size and async_insert_busy_timeout.',
        dataSources: ['system.asynchronous_insert_log'],
        view: 'explore',
        tab: 'inserts',
        icon: <TrendingUp size={16} />,
        severity: 'neutral',
        tags: ['inserts', 'reliability'],
      },
    ],
  },
  {
    id: 'schema',
    label: 'Schema & Tables',
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/8',
    borderColor: 'border-blue-500/20',
    icon: <Table2 size={18} />,
    features: [
      {
        id: 'table-antipatterns',
        name: 'Table Design Anti-patterns',
        description: 'Structural issues in table definitions: too many projections, small/large granularity, too many active parts, mutation backlog, wide primary keys, large tables without TTL or partition key.',
        whatsToLookFor: '>300 active parts = merge pressure. Pending mutations block merges. Wide PKs slow inserts. No TTL on large tables = unbounded growth.',
        dataSources: ['system.tables', 'system.parts', 'system.mutations', 'system.projection_parts'],
        view: 'explore',
        tab: 'antipatterns',
        icon: <Wrench size={16} />,
        severity: 'critical',
        tags: ['schema', 'anti-patterns', 'performance'],
      },
      {
        id: 'schema-advisor',
        name: 'Schema Advisor',
        description: 'Codec and type recommendations: LowCardinality for low-cardinality strings, ZSTD vs LZ4, Delta codec for monotonic columns.',
        whatsToLookFor: 'String columns with <10k distinct values → LowCardinality saves 5–10× storage. Timestamp columns → Delta+ZSTD. Sparse columns → Nullable.',
        dataSources: ['system.columns', 'system.tables'],
        view: 'advisor',
        icon: <Zap size={16} />,
        severity: 'info',
        tags: ['schema', 'storage', 'optimization'],
      },
      {
        id: 'cardinality',
        name: 'Cardinality Check',
        description: 'Scan String columns and check actual distinct value counts to find LowCardinality upgrade candidates.',
        whatsToLookFor: 'String columns with <10k unique values save significant memory and storage as LowCardinality(String). Warning: this runs full column scans.',
        dataSources: ['system.columns', 'table data'],
        view: 'advisor',
        icon: <Layers size={16} />,
        severity: 'info',
        tags: ['schema', 'optimization'],
      },
      {
        id: 'compression',
        name: 'Compression Analysis',
        description: 'Per-table compression ratio (uncompressed vs compressed). Low ratios indicate poor codec choice or incompressible data.',
        whatsToLookFor: 'Ratio <1.5× = poor compression, consider ZSTD(3). Ratio <1.0× = data already compressed externally. Large uncompressed size = storage cost driver.',
        dataSources: ['system.tables', 'system.columns'],
        view: 'advisor',
        icon: <HardDrive size={16} />,
        severity: 'warn',
        tags: ['storage', 'optimization'],
      },
      {
        id: 'unused-tables',
        name: 'Unused Tables',
        description: 'Tables with no queries in the last 7 days. Good candidates for archival or deletion.',
        whatsToLookFor: 'Large tables with zero query activity in 7 days. Check if they\'re written to but never read — could be silent data sinks.',
        dataSources: ['system.query_log', 'system.tables'],
        view: 'advisor',
        icon: <Database size={16} />,
        severity: 'info',
        tags: ['housekeeping', 'storage'],
      },
      {
        id: 'table-scanner',
        name: 'Table Scanner',
        description: 'Multi-instance table search by pattern, engine, size range, or database. Find tables across all nodes.',
        whatsToLookFor: 'Find all ReplacingMergeTree tables, all tables over 100GB, all tables in a specific database across nodes.',
        dataSources: ['system.tables', 'system.columns'],
        view: 'scanner',
        icon: <Search size={16} />,
        severity: 'neutral',
        tags: ['investigation', 'operations'],
      },
    ],
  },
  {
    id: 'storage',
    label: 'Storage & Cost',
    color: 'text-green-400',
    bgColor: 'bg-green-500/8',
    borderColor: 'border-green-500/20',
    icon: <HardDrive size={18} />,
    features: [
      {
        id: 'cost-explorer',
        name: 'Cost Explorer',
        description: 'Storage cost breakdown per table, database, and disk tier. Estimates S3 and local SSD costs.',
        whatsToLookFor: 'Top cost tables — are they worth the storage? Tables with all data on expensive local SSD that could move to S3.',
        dataSources: ['system.parts', 'system.disks'],
        view: 'cost',
        icon: <DollarSign size={16} />,
        severity: 'neutral',
        tags: ['cost', 'storage'],
      },
      {
        id: 'storage-policy',
        name: 'Storage Policy Advisor',
        description: 'Tables not using tiered storage policies. Large, cold tables that could be moved to cheaper S3-backed tiers.',
        whatsToLookFor: 'Large MergeTree tables on default storage with no TTL MOVE policy. Moving cold partitions to S3 can cut costs 5–10×.',
        dataSources: ['system.tables', 'system.storage_policies'],
        view: 'advisor',
        icon: <Layers size={16} />,
        severity: 'info',
        tags: ['cost', 's3', 'optimization'],
      },
      {
        id: 'parts-age',
        name: 'Parts Age',
        description: 'Distribution of part ages per table. Wide age gaps indicate merge issues or stopped merges.',
        whatsToLookFor: 'Parts older than 30 days in a table that gets daily inserts = merges are not catching up. Check for too_many_parts and mutation backlog.',
        dataSources: ['system.parts'],
        view: 'explore',
        tab: 'partsage',
        icon: <Clock size={16} />,
        severity: 'warn',
        tags: ['storage', 'merges'],
      },
      {
        id: 's3-latency',
        name: 'S3 Latency',
        description: 'S3 read latency per query pattern and table. High latency = queries spending time waiting on S3.',
        whatsToLookFor: 'Avg S3 latency >100ms/request = network or S3 throttling. Compare tables: queries hitting cold S3 data will show higher latency.',
        dataSources: ['system.query_log'],
        view: 'explore',
        tab: 's3',
        icon: <TrendingUp size={16} />,
        severity: 'warn',
        tags: ['s3', 'latency', 'cloud'],
      },
      {
        id: 'merges',
        name: 'Merges & Parts',
        description: 'Merge activity over time: merge count, new parts, merge duration, rows and bytes merged.',
        whatsToLookFor: 'New parts >> merges = parts accumulating faster than they\'re merged → too_many_parts soon. Long merge durations = large or complex merges.',
        dataSources: ['system.part_log'],
        view: 'explore',
        tab: 'merges',
        icon: <RefreshCw size={16} />,
        severity: 'warn',
        tags: ['storage', 'performance'],
      },
      {
        id: 'disk-io',
        name: 'Disk I/O',
        description: 'Read and write throughput per disk over time. Spot disk saturation.',
        whatsToLookFor: 'Sustained high write throughput during off-peak hours = background merges. Sustained high reads = queries not using caches.',
        dataSources: ['system.asynchronous_metrics'],
        view: 'explore',
        tab: 'diskio',
        icon: <HardDrive size={16} />,
        severity: 'neutral',
        tags: ['performance', 'hardware'],
      },
    ],
  },
  {
    id: 'replication',
    label: 'Replication & Ops',
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/8',
    borderColor: 'border-purple-500/20',
    icon: <Shield size={18} />,
    features: [
      {
        id: 'health-checks',
        name: 'Health Checks',
        description: 'Real-time instance health: memory usage, CPU, disk, parts count, replication lag, long-running queries, failed inserts.',
        whatsToLookFor: 'Memory >85% = OOM risk. Disk >90% = urgent. Parts >300 = merge pressure. Replication lag >30s = replica divergence.',
        dataSources: ['system.metrics', 'system.asynchronous_metrics', 'system.replicas'],
        view: 'detail',
        icon: <Shield size={16} />,
        severity: 'critical',
        tags: ['health', 'real-time', 'operations'],
      },
      {
        id: 'replication',
        name: 'Replication Status',
        description: 'Per-table replica status: queue size, leader election, lag, parts to check, readonly mode, exception messages.',
        whatsToLookFor: 'is_readonly=1 = replica is stuck. absolute_delay >30 = replica falling behind. large queue_size = replication backlog.',
        dataSources: ['system.replicas'],
        view: 'detail',
        icon: <GitCompareArrows size={16} />,
        severity: 'critical',
        tags: ['replication', 'reliability'],
      },
      {
        id: 'error-rates',
        name: 'Error Rates',
        description: 'Exception rates by code over time. Tracks ExceptionWhileProcessing events, fatal crashes from system.crash_log.',
        whatsToLookFor: 'Code 241 = memory limit exceeded. Code 160 = timeout. Code 307 = unknown function. Sustained error rate after a deployment = schema or config issue.',
        dataSources: ['system.query_log', 'system.crash_log'],
        view: 'explore',
        tab: 'failures',
        icon: <AlertTriangle size={16} />,
        severity: 'critical',
        tags: ['errors', 'reliability', 'debugging'],
      },
      {
        id: 'background-pool',
        name: 'Background Pool',
        description: 'Background merge/fetch pool utilization. Warns when the pool is saturated and merges can\'t keep pace.',
        whatsToLookFor: 'Pool utilization >80% means new merge slots are being queued. Sustained saturation → too_many_parts accumulation. Consider increasing background_pool_size.',
        dataSources: ['system.metrics', 'system.asynchronous_metrics'],
        view: 'detail',
        icon: <RefreshCw size={16} />,
        severity: 'warn',
        tags: ['performance', 'merges'],
      },
      {
        id: 'cache-hit-rates',
        name: 'Cache Hit Rates',
        description: 'Mark cache and uncompressed cache hit rates. Low hit rates mean queries are reading cold data from disk or S3 on every execution.',
        whatsToLookFor: 'Mark cache hit rate <70% = primary key range not cached, queries are doing extra I/O. Uncompressed cache hit rate <50% = data not reused between queries.',
        dataSources: ['system.metrics', 'system.asynchronous_metrics'],
        view: 'detail',
        icon: <Zap size={16} />,
        severity: 'warn',
        tags: ['performance', 'cache'],
      },
      {
        id: 'alerts',
        name: 'Alerts',
        description: 'Active alerts and alert history. Filter by severity, category, instance. Snooze, resolve, or view runbooks.',
        whatsToLookFor: 'Stale alerts (not updated in 24h) may indicate a resolved issue. Repeated firing alerts = underlying problem not fixed.',
        dataSources: ['ch_analyzer.alerts'],
        view: 'alerts',
        icon: <AlertTriangle size={16} />,
        severity: 'critical',
        tags: ['alerting', 'operations'],
      },
      {
        id: 'mv-perf',
        name: 'MV Performance',
        description: 'Materialized view execution time, failure rate, and chains. Slow MVs block the INSERT pipeline.',
        whatsToLookFor: 'MV avg_ms >1000 will slow all inserts to the source table. Failures in MVs are silent — data may be missing in target tables.',
        dataSources: ['system.query_views_log'],
        view: 'explore',
        tab: 'mvs',
        icon: <Boxes size={16} />,
        severity: 'warn',
        tags: ['mvs', 'inserts', 'reliability'],
      },
      {
        id: 'inserts',
        name: 'Insert Throughput',
        description: 'Rows/bytes inserted per second over time. Batch size distribution, error rate, user breakdown.',
        whatsToLookFor: 'Insert batch <100 rows → parts accumulate, merge pressure builds. Spike in insert errors = upstream producer issue.',
        dataSources: ['system.query_log'],
        view: 'explore',
        tab: 'inserts',
        icon: <TrendingUp size={16} />,
        severity: 'warn',
        tags: ['inserts', 'performance'],
      },
      {
        id: 'compare',
        name: 'Compare Instances',
        description: 'Side-by-side DDL, settings, system metrics, and query patterns across all instances.',
        whatsToLookFor: 'Setting differences between replicas = misconfiguration drift. Query patterns running on one node but not another = unbalanced workload.',
        dataSources: ['system.settings', 'system.tables', 'system.query_log'],
        view: 'compare',
        icon: <GitCompareArrows size={16} />,
        severity: 'neutral',
        tags: ['operations', 'replication'],
      },
    ],
  },
  {
    id: 'alerting',
    label: 'Alerting & Incidents',
    color: 'text-red-400',
    bgColor: 'bg-red-500/8',
    borderColor: 'border-red-500/20',
    icon: <Bell size={18} />,
    features: [
      {
        id: 'alert-playbooks',
        name: 'Alert Playbooks',
        description: 'Every alert has a plain-English \'what is this / why is it happening\' explanation and named SQL investigation queries pre-filled with the alert\'s time window.',
        whatsToLookFor: 'Open any alert → Overview tab shows what the alert means. Investigate tab has named queries you can copy or run directly in Terminal.',
        dataSources: ['ch_analyzer.alerts'],
        view: 'alerts',
        icon: <FileText size={16} />,
        severity: 'neutral',
        tags: ['alerting', 'investigation'],
      },
      {
        id: 'snooze-ack',
        name: 'Snooze & Acknowledge',
        description: 'Suppress noisy alerts without resolving them. Snooze expires automatically; acknowledge records who reviewed it and why.',
        whatsToLookFor: 'Snooze flapping alerts during known issues. Acknowledge alerts that are known-good to clear ops queue without auto-resolving.',
        dataSources: ['ch_analyzer.alerts'],
        view: 'alerts',
        icon: <Clock size={16} />,
        severity: 'neutral',
        tags: ['alerting', 'operations'],
      },
      {
        id: 'maintenance-windows',
        name: 'Maintenance Windows',
        description: 'Schedule a time window during which alerts are suppressed for one or all instances. Avoids false-positive noise during planned work.',
        whatsToLookFor: 'Create before schema migrations, CH version upgrades, replication rebuilds, or large backfills. Scope to a single instance or globally.',
        dataSources: ['ch_analyzer.maintenance'],
        view: 'maintenance',
        icon: <Wrench size={16} />,
        severity: 'neutral',
        tags: ['operations', 'alerting'],
      },
      {
        id: 'inhibition-escalation',
        name: 'Alert Inhibition & Escalation',
        description: 'Critical alerts suppress related warn alerts (e.g. disk_critical inhibits disk_warn). Sustained warn alerts automatically escalate to critical after N consecutive polls.',
        whatsToLookFor: 'Fewer alert noise from cascading failures. If a warn fires repeatedly over many polls, it auto-escalates — check for stuck conditions (merge backlog, replication lag that won\'t clear).',
        dataSources: ['ch_analyzer.alerts'],
        view: 'alerts',
        icon: <TrendingUp size={16} />,
        severity: 'info',
        tags: ['alerting', 'reliability'],
      },
      {
        id: 'audit-log',
        name: 'Audit Log',
        description: 'Every alert resolution, snooze, acknowledge, and maintenance window is recorded with actor and timestamp.',
        whatsToLookFor: 'Who resolved an alert? When was maintenance scheduled? Use audit log for incident post-mortems.',
        dataSources: ['ch_analyzer.audit_log'],
        view: 'alerts',
        icon: <FileText size={16} />,
        severity: 'neutral',
        tags: ['operations', 'audit'],
      },
      {
        id: 'slack-notifications',
        name: 'Slack Notifications',
        description: 'Socket Mode Slack app — no public HTTP endpoint needed. Alert notifications have inline Resolve/Snooze/Details buttons. Slash commands for status and on-demand checks.',
        whatsToLookFor: 'Configure per-instance channel routing to send prod critical alerts to a dedicated channel. Use /runcheck in Slack for quick spot diagnostics without opening the dashboard.',
        dataSources: ['Slack API'],
        view: 'alerts',
        icon: <Bell size={16} />,
        severity: 'neutral',
        tags: ['alerting', 'operations'],
      },
    ],
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics & Tools',
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/8',
    borderColor: 'border-cyan-500/20',
    icon: <Terminal size={18} />,
    features: [
      {
        id: 'run-checks',
        name: 'Run Checks',
        description: 'On-demand: run any collector against any instance right now. Results not stored, alerts not triggered. Good for quick spot checks.',
        whatsToLookFor: 'Use to validate config after a change. Run "Errors" collector to see current exception rates. Run "Queries" to see live query health.',
        dataSources: ['Various system tables'],
        view: 'runcheck',
        icon: <PlayCircle size={16} />,
        severity: 'neutral',
        tags: ['diagnostics', 'operations'],
      },
      {
        id: 'terminal',
        name: 'Terminal',
        description: 'Run read-only SQL (SELECT, SHOW, DESCRIBE, EXPLAIN) against any instance. Multi-statement, multi-node split view, schema autocomplete.',
        whatsToLookFor: 'Use EXPLAIN PIPELINE to understand query execution. DESCRIBE TABLE for schema. Run against multiple nodes to compare behavior.',
        dataSources: ['Any system or user table'],
        view: 'terminal',
        icon: <Terminal size={16} />,
        severity: 'neutral',
        tags: ['investigation', 'operations'],
      },
      {
        id: 'ai-analyzer',
        name: 'AI Analyzer',
        description: 'Conversational AI analysis of metrics, queries, schemas, and alerts. Ask questions in plain English.',
        whatsToLookFor: '"Why is query X slow?", "What\'s causing high memory?", "Suggest optimizations for this table schema." Available on every view via the Analyze button.',
        dataSources: ['All views — AI synthesizes context from the current view'],
        view: 'analyzer',
        icon: <Sparkles size={16} />,
        severity: 'neutral',
        tags: ['ai', 'investigation'],
      },
      {
        id: 'maintenance',
        name: 'Maintenance Windows',
        description: 'Schedule maintenance windows to suppress alerts and notifications during planned downtime.',
        whatsToLookFor: 'Create a window before doing schema migrations, restarts, or large backfills to avoid noisy false-positive alerts.',
        dataSources: ['ch_analyzer.maintenance'],
        view: 'maintenance',
        icon: <Wrench size={16} />,
        severity: 'neutral',
        tags: ['operations', 'alerting'],
      },
      {
        id: 'app-logs',
        name: 'App Logs',
        description: 'ch-analyzer application logs: collection errors, store writes, alert firing events, HTTP errors.',
        whatsToLookFor: 'Collection errors = can\'t reach ClickHouse. Store write failures = ch_analyzer database issue. Alert firing events for audit trail.',
        dataSources: ['In-memory log buffer (last 2000 lines)'],
        view: 'logs',
        icon: <FileText size={16} />,
        severity: 'neutral',
        tags: ['diagnostics', 'operations'],
      },
      {
        id: 'ch-logs',
        name: 'CH Server Logs',
        description: 'ClickHouse error and warning logs from the last hour. Full text search, level filter.',
        whatsToLookFor: 'HEAP_PROFILE_RUNNING = memory leak. Exception in executeQuery = query failures. MutationFinished = mutations completed. ReplicatedMergeTree errors.',
        dataSources: ['system.text_log'],
        view: 'chlogs',
        icon: <Database size={16} />,
        severity: 'neutral',
        tags: ['diagnostics', 'debugging'],
      },
      {
        id: 'system-metrics',
        name: 'System Metrics',
        description: 'CPU, memory, load average, network, and ClickHouse async metrics over your selected time range.',
        whatsToLookFor: 'Memory trending up over days = slow leak. CPU spikes aligned with query spikes. Load average > vCPU count = overloaded.',
        dataSources: ['system.asynchronous_metrics'],
        view: 'explore',
        tab: 'metrics',
        icon: <Activity size={16} />,
        severity: 'neutral',
        tags: ['performance', 'hardware'],
      },
    ],
  },
]

// ── Quick start workflows ─────────────────────────────────────────────────────

const QUICK_STARTS = [
  {
    label: 'New cluster — first checks',
    color: 'border-green-500/30 bg-green-500/5',
    steps: [
      { text: 'Health checks — memory, disk, replication', view: 'detail' as View },
      { text: 'Query anti-patterns — immediate red flags', view: 'explore' as View, tab: 'antipatterns' },
      { text: 'Table design anti-patterns — structural issues', view: 'explore' as View, tab: 'antipatterns' },
      { text: 'Compression ratios — spot bad codecs', view: 'advisor' as View },
    ],
  },
  {
    label: 'Queries are slow',
    color: 'border-orange-500/30 bg-orange-500/5',
    steps: [
      { text: 'Live queries — what\'s running right now', view: 'explore' as View, tab: 'live' },
      { text: 'Query patterns — find the expensive shapes', view: 'explore' as View, tab: 'patterns' },
      { text: 'Query regression — what got slower recently', view: 'advisor' as View },
      { text: 'Query anti-patterns — SELECT *, full scans', view: 'explore' as View, tab: 'antipatterns' },
    ],
  },
  {
    label: 'Storage growing fast',
    color: 'border-blue-500/30 bg-blue-500/5',
    steps: [
      { text: 'Cost Explorer — top tables by size', view: 'cost' as View },
      { text: 'Parts Age — merge catching up?', view: 'explore' as View, tab: 'partsage' },
      { text: 'Table anti-patterns — too many parts?', view: 'explore' as View, tab: 'antipatterns' },
      { text: 'Storage policy advisor — S3 tiering', view: 'advisor' as View },
    ],
  },
  {
    label: 'Something is broken',
    color: 'border-red-500/30 bg-red-500/5',
    steps: [
      { text: 'Active alerts', view: 'alerts' as View },
      { text: 'Query failures — exception breakdown', view: 'explore' as View, tab: 'failures' },
      { text: 'CH server logs — last hour errors', view: 'chlogs' as View },
      { text: 'Run Checks — spot scan all collectors', view: 'runcheck' as View },
    ],
  },
  {
    label: 'Alert investigation',
    color: 'border-red-500/30 bg-red-500/5',
    steps: [
      { text: 'Open alert → Overview tab for plain-English context', view: 'alerts' as View },
      { text: 'Investigate tab → run named SQL queries', view: 'alerts' as View },
      { text: 'AI Analyze for cross-signal correlation', view: 'analyzer' as View },
      { text: 'Snooze or acknowledge when handled', view: 'alerts' as View },
    ],
  },
]

// ── Severity badge ────────────────────────────────────────────────────────────

function SevBadge({ s }: { s?: string }) {
  if (!s || s === 'neutral') return null
  const cls = s === 'critical'
    ? 'bg-red-500/15 text-red-400 border-red-500/30'
    : s === 'warn'
    ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'
    : 'bg-blue-500/15 text-blue-400 border-blue-500/30'
  return (
    <span className={cn('text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border font-medium', cls)}>
      {s}
    </span>
  )
}

// ── Feature card ──────────────────────────────────────────────────────────────

function FeatureCard({ feature, onNav }: { feature: Feature; onNav: (v: View, tab?: string) => void }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={cn(
      'rounded-xl border bg-[var(--card)] flex flex-col gap-0 overflow-hidden transition-all',
      feature.severity === 'critical' ? 'border-red-500/25' : 'border-[var(--border)]',
    )}>
      {/* Header */}
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <div className="mt-0.5 shrink-0 text-[var(--dim)]">{feature.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm text-[var(--fg)]">{feature.name}</span>
            <SevBadge s={feature.severity} />
          </div>
          <p className="text-xs text-[var(--dim)] mt-1 leading-relaxed">{feature.description}</p>
        </div>
      </div>

      {/* Expand / collapse detail */}
      {expanded && (
        <div className="px-4 pb-3 space-y-3 border-t border-[var(--border)] pt-3">
          <div>
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-1.5">
              <Info size={10} /> What to look for
            </div>
            <p className="text-xs text-[var(--fg)] leading-relaxed">{feature.whatsToLookFor}</p>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-1.5">Data sources</div>
            <div className="flex flex-wrap gap-1.5">
              {feature.dataSources.map(ds => (
                <code key={ds} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--hover)] border border-[var(--border)] text-[var(--dim)] font-mono">
                  {ds}
                </code>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-[var(--hover)]/50 border-t border-[var(--border)] mt-auto">
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-[11px] text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
        >
          {expanded ? 'Less' : 'What to look for →'}
        </button>
        <div className="ml-auto flex gap-1.5 flex-wrap justify-end">
          {feature.tags?.slice(0, 2).map(t => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--hover)] border border-[var(--border)] text-[var(--dim)]">
              {t}
            </span>
          ))}
          <button
            onClick={() => onNav(feature.view, feature.tab)}
            className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded bg-[var(--accent)]/10 border border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white transition-colors"
          >
            Open <ArrowRight size={11} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Discover() {
  const { setView } = useStore()
  const [search, setSearch] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)

  const allTags = Array.from(new Set(
    CATEGORIES.flatMap(c => c.features.flatMap(f => f.tags ?? []))
  )).sort()

  const q = search.toLowerCase()
  const filtered = CATEGORIES.map(cat => ({
    ...cat,
    features: cat.features.filter(f => {
      const matchesTag = !activeTag || f.tags?.includes(activeTag)
      const matchesSearch = !q
        || f.name.toLowerCase().includes(q)
        || f.description.toLowerCase().includes(q)
        || f.dataSources.some(d => d.toLowerCase().includes(q))
        || f.tags?.some(t => t.includes(q))
      return matchesTag && matchesSearch
    }),
  })).filter(cat => cat.features.length > 0)

  const handleNav = (view: View, tab?: string) => {
    // Navigate to view; if tab specified, use URL param so Explore picks it up
    if (tab) {
      const url = new URL(window.location.href)
      url.searchParams.set('view', view)
      url.searchParams.set('tab', tab)
      window.history.pushState({}, '', url)
    }
    setView(view)
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[15px] font-semibold text-[var(--text)]">Feature Guide</h1>
          <p className="text-[12px] text-[var(--dim)] mt-1">
            Everything ch-analyzer can surface — what each feature does, what to look for, and where the data comes from.
          </p>
        </div>
      </div>

      {/* Quick start workflows */}
      <div>
        <div className="flex items-center gap-3 mb-3">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--dim)] shrink-0">— Start Here</span>
          <div className="flex-1 h-px bg-[var(--border)]" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {QUICK_STARTS.map(qs => (
            <div key={qs.label} className={cn('rounded-xl border p-4 space-y-2.5', qs.color)}>
              <div className="text-sm font-semibold text-[var(--fg)]">{qs.label}</div>
              <ol className="space-y-1.5">
                {qs.steps.map((step, i) => (
                  <li key={i}>
                    <button
                      onClick={() => handleNav(step.view, step.tab)}
                      className="text-left text-xs text-[var(--dim)] hover:text-[var(--accent)] transition-colors flex items-start gap-1.5 w-full"
                    >
                      <span className="shrink-0 tabular-nums text-[var(--dim)]/60 mt-0.5">{i + 1}.</span>
                      {step.text}
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </div>

      {/* Search + tag filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--dim)]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search features, data sources…"
            className="pl-8 pr-3 py-1.5 text-[12px] rounded-md border border-[var(--border)] bg-[var(--card)] text-[var(--text)] placeholder:text-[var(--dim)] focus:outline-none focus:border-[var(--accent)] w-64"
          />
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <button
            onClick={() => setActiveTag(null)}
            className={cn('text-[11px] px-2 py-1 rounded border transition-colors',
              !activeTag ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border-[var(--accent)]/30' : 'border-[var(--border)] text-[var(--dim)] hover:text-[var(--text)]')}
          >
            All
          </button>
          {allTags.map(t => (
            <button
              key={t}
              onClick={() => setActiveTag(activeTag === t ? null : t)}
              className={cn('text-[11px] px-2 py-1 rounded border transition-colors',
                activeTag === t ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border-[var(--accent)]/30' : 'border-[var(--border)] text-[var(--dim)] hover:text-[var(--text)]')}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Feature categories */}
      {filtered.map(cat => (
        <div key={cat.id} className="space-y-3">
          <div className="flex items-center gap-3">
            <span className={cn('text-[10px] font-semibold uppercase tracking-widest shrink-0 flex items-center gap-1.5', cat.color)}>
              — {cat.label}
            </span>
            <div className={cn('flex-1 h-px', cat.borderColor)} style={{ background: 'var(--border)' }} />
            <span className="text-[10px] text-[var(--dim)] shrink-0">{cat.features.length}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {cat.features.map(f => (
              <FeatureCard key={f.id} feature={f} onNav={handleNav} />
            ))}
          </div>
        </div>
      ))}

      {filtered.length === 0 && (
        <div className="text-center py-16 text-[var(--dim)]">
          <Search size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No features match "{search}"</p>
        </div>
      )}

      {/* Data sources legend */}
      <div className="pt-2">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--dim)] shrink-0">— Data Sources Reference</span>
          <div className="flex-1 h-px bg-[var(--border)]" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs text-[var(--dim)]">
          {[
            ['system.query_log', 'Historical queries — latency, memory, read bytes, errors. Populated after query finishes.'],
            ['system.processes', 'Live queries running right now. No history — real-time only.'],
            ['system.tables', 'Table metadata — engine, partition key, TTL, row count, disk size.'],
            ['system.parts', 'Active parts — size, row count, part age, disk location.'],
            ['system.mutations', 'Pending and completed ALTER UPDATE/DELETE mutations.'],
            ['system.replicas', 'Replication status — lag, queue size, leader, readonly flag.'],
            ['system.columns', 'Column metadata — name, type, default expression, codec.'],
            ['system.text_log', 'ClickHouse server error log. Contains stack traces and warnings.'],
            ['system.asynchronous_metrics', 'Async system metrics — CPU, memory, network, merges (sampled ~1s).'],
            ['system.metrics', 'Real-time CH counters — connections, queries, inserts, merges in progress.'],
            ['system.query_views_log', 'Per-MV execution log — which MV ran for which insert, duration, errors.'],
            ['system.asynchronous_insert_log', 'Async insert tracking — queue depth, flush successes and failures.'],
            ['system.crash_log', 'Fatal errors and stack traces from CH server crashes.'],
            ['ch_analyzer.alerts', 'Alerts stored by ch-analyzer — history, severity, category, dedup_key.'],
            ['ch_analyzer.audit_log', 'All admin actions — resolutions, snoozes, maintenance windows, acknowledges.'],
            ['ch_analyzer.query_samples', 'Per-query samples stored by ch-analyzer for trend analysis.'],
          ].map(([src, desc]) => (
            <div key={src} className="flex flex-col gap-0.5">
              <code className="font-mono text-[11px] text-[var(--fg)]">{src}</code>
              <span className="leading-relaxed">{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
