import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  X, Bell, BellOff, Sparkles, Table2, ChevronRight,
  Clock, Server, Tag, Search, Info, AlertTriangle,
} from 'lucide-react'
import { cn, fmtTime } from '../lib/utils'
import { api } from '../lib/api'
import { Badge } from './Badge'
import { SqlBlock } from './SqlBlock'
import { useStore } from '../hooks/useStore'
import type { Alert, Suggestion, SnoozeEntry, AckEntry, AnomalyContext } from '../types/api'

/* ------------------------------------------------------------------ */
/*  Playbook system                                                     */
/* ------------------------------------------------------------------ */
interface PlaybookQuery { label: string; sql: string }
interface Playbook {
  what: string
  why: string[]
  queries: PlaybookQuery[]
}

const PLAYBOOKS: Record<string, Playbook> = {
  'inserts:throughput_drop': {
    what: 'Insert throughput dropped significantly below the recent rolling average. Fewer rows than expected are being written to ClickHouse.',
    why: [
      'Upstream producer paused, crashed, or is rate-limited',
      'Network partition between the producer and ClickHouse',
      'CH applying back-pressure — too many parts or merges backing up',
      'A single large slow insert blocking the pipeline',
    ],
    queries: [
      { label: 'Insert rate per table (last 5 min)', sql: `SELECT\n    databases[1] AS database,\n    tables[1] AS table,\n    count() AS inserts,\n    sum(written_rows) AS rows_written\nFROM system.query_log\nWHERE type = 'QueryFinish'\n  AND query_kind = 'Insert'\n  AND event_time > now() - INTERVAL 5 MINUTE\n  AND length(databases) >= 1\nGROUP BY database, table\nORDER BY rows_written DESC` },
      { label: 'Insert exceptions in the last hour', sql: `SELECT\n    databases[1] AS database,\n    tables[1] AS table,\n    count() AS failed,\n    any(exception) AS last_error\nFROM system.query_log\nWHERE type = 'ExceptionWhileProcessing'\n  AND query_kind = 'Insert'\n  AND event_time > now() - INTERVAL 1 HOUR\n  AND length(databases) >= 1\nGROUP BY database, table\nORDER BY failed DESC` },
      { label: 'Merge backlog (causes insert back-pressure)', sql: `SELECT database, table, elapsed, progress, num_parts\nFROM system.merges\nORDER BY elapsed DESC` },
      { label: 'Active connections by user', sql: `SELECT user, query_kind, count() AS cnt\nFROM system.processes\nGROUP BY user, query_kind\nORDER BY cnt DESC` },
    ],
  },

  'inserts:small': {
    what: 'Many small inserts detected — each insert writes fewer rows than recommended. This creates excessive parts, slowing down reads and causing merge backlog.',
    why: [
      'Producer inserting row-by-row instead of batching to ≥100K rows',
      'No buffer layer — Buffer table or async inserts not configured',
      'Each microservice event triggering a separate INSERT call',
    ],
    queries: [
      { label: 'Small inserts per table (last 10 min)', sql: `SELECT\n    databases[1] AS database,\n    tables[1] AS table,\n    count() AS insert_count,\n    round(avg(written_rows), 1) AS avg_rows_per_insert,\n    min(written_rows) AS min_rows\nFROM system.query_log\nWHERE type = 'QueryFinish'\n  AND query_kind = 'Insert'\n  AND written_rows < 1000\n  AND event_time > now() - INTERVAL 10 MINUTE\n  AND length(databases) >= 1\nGROUP BY database, table\nORDER BY insert_count DESC\nLIMIT 20` },
      { label: 'Part count for affected tables', sql: `SELECT database, table, count() AS part_count, sum(rows) AS total_rows\nFROM system.parts\nWHERE active\nGROUP BY database, table\nHAVING part_count > 100\nORDER BY part_count DESC\nLIMIT 20` },
      { label: 'Current merge backlog', sql: `SELECT database, table, elapsed, progress\nFROM system.merges\nORDER BY elapsed DESC` },
    ],
  },

  'inserts:stall': {
    what: 'A table that was regularly receiving inserts has stopped entirely. No inserts have been seen for several poll intervals — likely a silent pipeline failure.',
    why: [
      'Producer process crashed or restarted without recovery',
      'Upstream queue (Kafka/RabbitMQ) consumer is paused or disconnected',
      'Network partition or DNS failure preventing the producer from reaching CH',
      'Table was dropped, renamed, or permissions were revoked',
    ],
    queries: [
      { label: 'Last insert time for recently-active tables', sql: `SELECT\n    databases[1] AS database,\n    tables[1] AS table,\n    max(event_time) AS last_insert,\n    dateDiff('second', max(event_time), now()) AS seconds_ago\nFROM system.query_log\nWHERE type = 'QueryFinish'\n  AND query_kind = 'Insert'\n  AND event_time > now() - INTERVAL 2 HOUR\n  AND length(databases) >= 1\nGROUP BY database, table\nORDER BY seconds_ago DESC\nLIMIT 20` },
      { label: 'Recent exceptions on this table', sql: `SELECT event_time, exception, substring(query, 1, 200) AS q\nFROM system.query_log\nWHERE type = 'ExceptionWhileProcessing'\n  AND query_kind = 'Insert'\n  AND tables[1] = '{table}'\n  AND event_time > now() - INTERVAL 1 HOUR\nORDER BY event_time DESC\nLIMIT 20` },
      { label: 'Check table exists', sql: `SELECT database, name AS table, engine\nFROM system.tables\nWHERE database = '{database}' AND name = '{table}'` },
    ],
  },

  'inserts:errors': {
    what: 'INSERT statements are throwing exceptions. Some or all inserts to this table are failing — data will be lost unless the producer retries.',
    why: [
      'Column type mismatch between producer schema and the CH table',
      'User quota or rate limits exceeded',
      'Disk space exhausted — CH cannot write new parts',
      'NOT NULL constraint violation or unexpected NULL value',
    ],
    queries: [
      { label: 'Recent INSERT exceptions with error details', sql: `SELECT\n    event_time,\n    exception_code,\n    substring(exception, 1, 300) AS exception,\n    substring(query, 1, 200) AS query_excerpt\nFROM system.query_log\nWHERE type = 'ExceptionWhileProcessing'\n  AND query_kind = 'Insert'\n  AND event_time > now() - INTERVAL 1 HOUR\nORDER BY event_time DESC\nLIMIT 20` },
      { label: 'Grouped by exception code', sql: `SELECT\n    exception_code, count() AS cnt, any(exception) AS sample_error\nFROM system.query_log\nWHERE type = 'ExceptionWhileProcessing'\n  AND query_kind = 'Insert'\n  AND event_time > now() - INTERVAL 1 HOUR\nGROUP BY exception_code\nORDER BY cnt DESC` },
      { label: 'Table schema (check for recent changes)', sql: `SELECT name, type, default_expression\nFROM system.columns\nWHERE database = '{database}' AND table = '{table}'\nORDER BY position` },
      { label: 'Disk space', sql: `SELECT name, formatReadableSize(free_space) AS free,\n  formatReadableSize(total_space) AS total,\n  round((1 - free_space/total_space)*100, 1) AS used_pct\nFROM system.disks` },
    ],
  },

  'async_inserts:errors': {
    what: 'Async insert buffers are failing to flush to storage. Data in the buffer may be permanently lost if CH restarts before a successful retry.',
    why: [
      'Disk space exhausted — CH cannot write the buffered data',
      'Schema changed after the buffer was filled (column mismatch on flush)',
      'Memory limit hit during the flush operation',
      'CH internal error during the write to MergeTree',
    ],
    queries: [
      { label: 'Async insert flush errors (last 30 min)', sql: `SELECT event_time, status, exception, substring(query, 1, 200) AS q\nFROM system.asynchronous_insert_log\nWHERE status = 'ExceptionWhileFlushing'\n  AND event_time > now() - INTERVAL 30 MINUTE\nORDER BY event_time DESC\nLIMIT 20` },
      { label: 'Currently pending async queue', sql: `SELECT database, table, count() AS queue_entries\nFROM system.asynchronous_insertions\nGROUP BY database, table\nORDER BY queue_entries DESC` },
      { label: 'Disk space', sql: `SELECT name, formatReadableSize(free_space) AS free, formatReadableSize(total_space) AS total\nFROM system.disks` },
    ],
  },

  'async_inserts:queue': {
    what: 'The async insert queue is growing — the flush thread cannot keep up with incoming data. If the queue fills completely, new inserts will be rejected.',
    why: [
      'Insert rate exceeds the flush thread throughput',
      'Flush thread blocked by slow disk or overloaded CH',
      'async_insert_busy_timeout_ms is too high — accumulating before flush',
    ],
    queries: [
      { label: 'Queue depth by table', sql: `SELECT database, table, count() AS queue_entries\nFROM system.asynchronous_insertions\nGROUP BY database, table\nORDER BY queue_entries DESC` },
      { label: 'Recent flush stats', sql: `SELECT status, count() AS cnt,\n  avg(flush_time_microseconds)/1000 AS avg_flush_ms\nFROM system.asynchronous_insert_log\nWHERE event_time > now() - INTERVAL 5 MINUTE\nGROUP BY status` },
    ],
  },

  'queries': {
    what: 'Query latency is elevated or query failures are occurring. Queries are taking longer than the historical baseline or error rates are up.',
    why: [
      'Queries scanning full table due to missing partition key or index hit',
      'CPU or memory pressure from concurrent heavy queries',
      'Merge or mutation operations competing for I/O bandwidth',
      'Cold data requiring S3 fetches adding significant latency',
    ],
    queries: [
      { label: 'Currently running queries (slowest first)', sql: `SELECT query_id, elapsed, read_rows,\n  formatReadableSize(memory_usage) AS mem, user,\n  substring(query, 1, 200) AS q\nFROM system.processes\nORDER BY elapsed DESC` },
      { label: 'Slowest queries in last 10 min', sql: `SELECT query_duration_ms, read_rows,\n  formatReadableSize(memory_usage) AS mem, user, exception_code,\n  substring(query, 1, 300) AS q\nFROM system.query_log\nWHERE type IN ('QueryFinish', 'ExceptionWhileProcessing')\n  AND event_time > now() - INTERVAL 10 MINUTE\nORDER BY query_duration_ms DESC\nLIMIT 20` },
      { label: 'Query exceptions in last hour by error code', sql: `SELECT exception_code, count() AS cnt, any(exception) AS sample\nFROM system.query_log\nWHERE type = 'ExceptionWhileProcessing'\n  AND event_time > now() - INTERVAL 1 HOUR\nGROUP BY exception_code\nORDER BY cnt DESC` },
      { label: 'Active merges / mutations (I/O competition)', sql: `SELECT database, table, elapsed, progress, is_mutation\nFROM system.merges\nORDER BY elapsed DESC` },
    ],
  },

  'tables:parts': {
    what: 'A table has too many active parts. CH performance degrades as part count rises — reads become slower and inserts are eventually throttled or rejected.',
    why: [
      'Too-frequent small inserts — each insert creates one new part',
      'Merge background threads falling behind the insert rate',
      'Recent large bulk load not yet merged down',
      'Background pool full with other operations (mutations, etc.)',
    ],
    queries: [
      { label: 'Tables with highest part count', sql: `SELECT database, table,\n  count() AS part_count,\n  sum(rows) AS total_rows,\n  formatReadableSize(sum(bytes_on_disk)) AS size\nFROM system.parts\nWHERE active\nGROUP BY database, table\nORDER BY part_count DESC\nLIMIT 20` },
      { label: 'Current merge operations', sql: `SELECT database, table, elapsed,\n  round(progress*100,1) AS progress_pct,\n  num_parts, is_mutation\nFROM system.merges\nORDER BY elapsed DESC` },
      { label: 'Background pool utilization', sql: `SELECT metric, value FROM system.metrics\nWHERE metric IN (\n  'BackgroundMergesAndMutationsPoolTask',\n  'BackgroundMergesAndMutationsPoolSize',\n  'BackgroundCommonPoolTask'\n)` },
      { label: 'Force merge (manual — run on the node, not here)', sql: `-- OPTIMIZE TABLE {database}.{table} FINAL\n-- WARNING: expensive on large tables, use during low traffic` },
    ],
  },

  'tables:detached': {
    what: 'Detached parts found — parts excluded from all queries. They consume disk space and typically indicate a data integrity issue.',
    why: [
      'Checksum mismatch after partial write or disk error',
      'A merge was rolled back, leaving intermediate parts behind',
      'Manual DETACH operation that was not cleaned up',
      'Replica inconsistency — part has different checksums across nodes',
    ],
    queries: [
      { label: 'All detached parts by table and reason', sql: `SELECT database, table, name, reason, disk,\n  formatReadableSize(bytes_on_disk) AS size\nFROM system.detached_parts\nWHERE reason NOT IN ('', 'ignored')\nORDER BY database, table` },
      { label: 'Verify integrity (run CHECK TABLE)', sql: `-- CHECK TABLE {database}.{table}\n-- Run this before deciding to reattach or drop` },
      { label: 'Reattach or drop a part', sql: `-- Reattach (only if CHECK TABLE passes):\n-- ALTER TABLE {database}.{table} ATTACH PART '<part_name>'\n\n-- Drop detached part:\n-- ALTER TABLE {database}.{table} DROP DETACHED PART '<part_name>'` },
    ],
  },

  'replication': {
    what: 'A replicated table is lagging behind or has replication errors. Queries on the lagging replica may return stale data.',
    why: [
      'Slow disk I/O on this replica node',
      'Network bandwidth saturated during large part transfer',
      'Active large mutation consuming all I/O bandwidth',
      'ZooKeeper session expired — replica becomes read-only until reconnected',
    ],
    queries: [
      { label: 'Replication status (lagging tables)', sql: `SELECT database, table, is_leader, is_readonly,\n  absolute_delay, queue_size, inserts_in_queue,\n  merges_in_queue, last_exception\nFROM system.replicas\nWHERE absolute_delay > 0 OR last_exception != ''\nORDER BY absolute_delay DESC` },
      { label: 'Replication queue depth', sql: `SELECT database, table, type, source_replica,\n  created_time, exception\nFROM system.replication_queue\nORDER BY created_time\nLIMIT 30` },
      { label: 'Stuck mutations', sql: `SELECT database, table, mutation_id, command,\n  create_time, is_done, latest_fail_reason\nFROM system.mutations\nWHERE is_done = 0\nORDER BY create_time` },
      { label: 'ZooKeeper connectivity', sql: `SELECT * FROM system.zookeeper WHERE path = '/'` },
    ],
  },

  'storage:disk': {
    what: 'Disk usage is approaching a warning or critical threshold. When disks fill completely, CH stops accepting inserts and may become unstable.',
    why: [
      'Table data growing faster than TTL can clean it up',
      'Merges producing temporary files larger than final output',
      'Orphaned temp files from failed mutations or imports',
      'S3 tiered storage not draining local disk fast enough',
    ],
    queries: [
      { label: 'Disk free space', sql: `SELECT name, path,\n  formatReadableSize(free_space) AS free,\n  formatReadableSize(total_space) AS total,\n  round((1 - free_space/total_space)*100, 1) AS used_pct\nFROM system.disks\nORDER BY used_pct DESC` },
      { label: 'Largest tables on disk', sql: `SELECT database, table,\n  formatReadableSize(sum(bytes_on_disk)) AS size,\n  count() AS parts\nFROM system.parts\nWHERE active\nGROUP BY database, table\nORDER BY sum(bytes_on_disk) DESC\nLIMIT 20` },
      { label: 'Tables with TTL configured', sql: `SELECT database, name AS table, engine_full\nFROM system.tables\nWHERE engine LIKE '%MergeTree%'\n  AND engine_full LIKE '%TTL%'` },
      { label: 'Disk space reserved for merges', sql: `SELECT metric, value FROM system.metrics\nWHERE metric IN ('DiskSpaceReservedForMerge', 'BackgroundMergesAndMutationsPoolTask')` },
    ],
  },

  'storage:s3': {
    what: 'S3 latency is elevated. Queries reading cold data from tiered object storage will be significantly slower than usual.',
    why: [
      'S3 endpoint throttling requests (too many concurrent reads hitting limits)',
      'Network congestion between CH nodes and the S3 endpoint',
      'Large number of simultaneous cold-data queries',
      'S3 service degradation in the region',
    ],
    queries: [
      { label: 'S3 / object storage metrics', sql: `SELECT metric, value FROM system.metrics\nWHERE metric LIKE '%S3%' OR metric LIKE '%ObjectStorage%'\nORDER BY metric` },
      { label: 'Queries currently reading cold data', sql: `SELECT query_id, elapsed, read_rows,\n  formatReadableSize(read_bytes) AS read_bytes,\n  substring(query, 1, 200) AS q\nFROM system.processes\nORDER BY read_bytes DESC` },
      { label: 'S3 disk configuration', sql: `SELECT name, type, path FROM system.disks\nWHERE type IN ('s3', 'object_storage', 's3_plain')` },
    ],
  },

  'errors:system': {
    what: 'ClickHouse internal error counters are elevated. These accumulate in system.errors since the last restart and indicate recurring internal failures.',
    why: [
      'MEMORY_LIMIT_EXCEEDED: queries or server hitting memory caps',
      'KEEPER_EXCEPTION / NO_ZOOKEEPER: ZooKeeper cluster unreachable',
      'CORRUPTED_DATA / CHECKSUM_DOESNT_MATCH: disk or network corruption',
      'TOO_MANY_SIMULTANEOUS_QUERIES: connection flood from application',
    ],
    queries: [
      { label: 'All recent errors with count and last message', sql: `SELECT name, value AS count, last_error_time,\n  substring(last_error_message, 1, 250) AS last_message\nFROM system.errors\nWHERE value > 0\n  AND last_error_time > now() - INTERVAL 1 HOUR\nORDER BY value DESC\nLIMIT 20` },
      { label: 'Fatal/Critical log entries', sql: `SELECT event_time, level, logger_name,\n  substring(message, 1, 300) AS message\nFROM system.text_log\nWHERE level IN ('Fatal', 'Critical')\n  AND event_time > now() - INTERVAL 1 HOUR\nORDER BY event_time DESC\nLIMIT 20` },
      { label: 'Currently running queries (check for problem queries)', sql: `SELECT user, elapsed, formatReadableSize(memory_usage) AS mem,\n  substring(query, 1, 200) AS q\nFROM system.processes\nORDER BY memory_usage DESC` },
    ],
  },

  'errors:fatal': {
    what: 'Fatal or Critical log entries detected in ClickHouse logs. These are extremely rare and almost always indicate a serious system problem requiring immediate attention.',
    why: [
      'Out-of-memory kill (OOMKiller or CH internal memory limit breach)',
      'Internal assertion failure — CH bug or unexpected system state',
      'Corrupted metadata on disk',
      'OS signal received (SIGKILL from Kubernetes eviction, SIGSEGV)',
    ],
    queries: [
      { label: 'Recent Fatal/Critical entries', sql: `SELECT event_time, level, logger_name,\n  substring(message, 1, 400) AS message\nFROM system.text_log\nWHERE level IN ('Fatal', 'Critical')\n  AND event_time > now() - INTERVAL 1 HOUR\nORDER BY event_time DESC\nLIMIT 30` },
      { label: 'CH error counters', sql: `SELECT name, value, last_error_time,\n  substring(last_error_message, 1, 200) AS last_msg\nFROM system.errors\nWHERE value > 0\nORDER BY last_error_time DESC\nLIMIT 20` },
      { label: 'Server uptime (detect recent restart)', sql: `SELECT metric, value FROM system.metrics WHERE metric = 'Uptime'` },
    ],
  },

  'mvs': {
    what: 'A materialized view is executing slowly on inserts, or has thrown exceptions. Slow MVs block source table inserts — exceptions mean data is not reaching the MV target.',
    why: [
      'MV query is complex (heavy aggregation, joins, large subqueries)',
      'MV target table has too many parts, slowing writes',
      'Schema mismatch between source and MV — exception on write',
      'Chained MVs compounding latency (MV → MV)',
    ],
    queries: [
      { label: 'MV execution times (last 10 min)', sql: `SELECT view,\n  round(avg(view_duration_ms), 1) AS avg_ms,\n  max(view_duration_ms) AS max_ms,\n  count() AS executions,\n  countIf(status = 'ExceptionWhileProcessing') AS errors\nFROM system.query_views_log\nWHERE event_time > now() - INTERVAL 10 MINUTE\nGROUP BY view\nORDER BY avg_ms DESC\nLIMIT 20` },
      { label: 'MV exceptions (last hour)', sql: `SELECT event_time, view, status, exception\nFROM system.query_views_log\nWHERE status = 'ExceptionWhileProcessing'\n  AND event_time > now() - INTERVAL 1 HOUR\nORDER BY event_time DESC\nLIMIT 20` },
      { label: 'Part count of MV inner/target tables', sql: `SELECT database, table, count() AS parts,\n  formatReadableSize(sum(bytes_on_disk)) AS size\nFROM system.parts\nWHERE active\nGROUP BY database, table\nHAVING parts > 50\nORDER BY parts DESC\nLIMIT 20` },
    ],
  },

  'dictionaries': {
    what: 'A dictionary failed to load or has zero elements. Queries using this dictionary will fail with an error or silently return default values.',
    why: [
      'Source database, HTTP endpoint, or file is unreachable',
      'Source table is empty or the WHERE clause returns no rows',
      'Schema change in the source — column names no longer match',
      'Dictionary load timed out (slow source)',
    ],
    queries: [
      { label: 'Dictionary status overview', sql: `SELECT name, status, element_count, bytes_allocated,\n  last_successful_update_time, last_exception\nFROM system.dictionaries\nORDER BY name` },
      { label: 'Reload a dictionary', sql: `-- SYSTEM RELOAD DICTIONARY '<dictionary_name>'` },
    ],
  },

  'memory': {
    what: 'Memory usage is elevated or growing anomalously. ClickHouse or the OS is consuming more RAM than the historical baseline.',
    why: [
      'Large analytical queries holding data in memory mid-execution',
      'Mark cache or primary key index growing with data volume',
      'OS page cache accumulating CH data files (shows in CGroup, but evictable)',
      'Memory leak in a long-running CH process (rare)',
    ],
    queries: [
      { label: 'Current memory-heavy queries', sql: `SELECT query_id,\n  formatReadableSize(memory_usage) AS mem,\n  formatReadableSize(peak_memory_usage) AS peak,\n  elapsed, user,\n  substring(query, 1, 200) AS q\nFROM system.processes\nORDER BY memory_usage DESC` },
      { label: 'Memory metrics (OS + CH)', sql: `SELECT metric, value\nFROM system.asynchronous_metrics\nWHERE metric IN (\n  'MemoryResident', 'OSMemoryAvailable', 'OSMemoryTotal',\n  'CGroupMemoryUsed'\n)\nORDER BY metric` },
      { label: 'Cache sizes', sql: `SELECT metric, value FROM system.metrics\nWHERE metric IN (\n  'MarkCacheBytes', 'MarkCacheFiles',\n  'UncompressedCacheBytes', 'CompiledExpressionCacheCount'\n)` },
    ],
  },

  'cpu': {
    what: 'CPU usage is high or sustained. ClickHouse is CPU-bound — queries, merges, or background operations are saturating available cores.',
    why: [
      'Heavy queries without effective partition or primary key pruning (full scans)',
      'Merge or mutation operations consuming many CPU cores simultaneously',
      'Too many concurrent queries exceeding thread pool capacity',
      'High data compression/decompression overhead at peak load',
    ],
    queries: [
      { label: 'Currently running queries (by elapsed time)', sql: `SELECT query_id, elapsed, read_rows,\n  formatReadableSize(memory_usage) AS mem, user,\n  substring(query, 1, 200) AS q\nFROM system.processes\nORDER BY elapsed DESC` },
      { label: 'CPU metrics timeline (last 30 min)', sql: `SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE metric IN ('OSUserTimeCPUMicroseconds','OSSystemTimeCPUMicroseconds','LoadAverage1')\n  AND event_time > now() - INTERVAL 30 MINUTE\nORDER BY event_time DESC\nLIMIT 100` },
      { label: 'Active merges and mutations', sql: `SELECT database, table, elapsed, progress, is_mutation\nFROM system.merges\nORDER BY elapsed DESC` },
      { label: 'Background pool utilization', sql: `SELECT metric, value FROM system.metrics\nWHERE metric IN (\n  'BackgroundMergesAndMutationsPoolTask',\n  'BackgroundMergesAndMutationsPoolSize',\n  'ConcurrentInsertThreads'\n)` },
    ],
  },

  'anomaly': {
    what: 'A metric deviated significantly from its recent baseline (z-score ≥ 2σ). The current value is outside the normal range established over recent history.',
    why: [
      'Sudden workload change — new query pattern or data volume spike',
      'Background operation starting (bulk import, migration, OPTIMIZE)',
      'External event: deployment, schema change, scheduled cron job',
      'Progressive degradation crossing the statistical detection threshold',
    ],
    queries: [
      { label: 'Metric history around alert time (±1 hour)', sql: `SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE metric = '{metric}'\n  AND event_time BETWEEN '{fromH}' AND '{toH}'\nORDER BY event_time` },
      { label: 'Resource-heavy queries at alert time', sql: `SELECT query_duration_ms, read_rows,\n  formatReadableSize(memory_usage) AS mem, user, type,\n  substring(query, 1, 200) AS q\nFROM system.query_log\nWHERE event_time BETWEEN '{from}' AND '{to}'\n  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')\nORDER BY query_duration_ms DESC\nLIMIT 20` },
      { label: 'Background operations at alert time', sql: `SELECT event_time, type, database, table, duration_ms\nFROM system.part_log\nWHERE event_time BETWEEN '{from}' AND '{to}'\n  AND type IN ('MergePartsStart', 'MutatePartsStart')\nORDER BY event_time DESC\nLIMIT 20` },
    ],
  },

  'sustained': {
    what: 'A metric has been continuously elevated above its historical mean for an extended period. This is a persistent shift, not a transient spike.',
    why: [
      'New workload pattern — a new feature or query type is now regularly running',
      'Data volume growth reaching an inflection point',
      'Configuration change permanently increasing resource consumption',
      'Background job that now runs continuously instead of periodically',
    ],
    queries: [
      { label: 'Metric trend over last 6 hours', sql: `SELECT toStartOfFiveMinutes(event_time) AS t,\n  avg(value) AS avg_val, max(value) AS max_val\nFROM system.asynchronous_metric_log\nWHERE metric = '{metric}'\n  AND event_time > now() - INTERVAL 6 HOUR\nGROUP BY t\nORDER BY t` },
      { label: 'Query volume trend (more load?)', sql: `SELECT toStartOfFiveMinutes(event_time) AS t,\n  count() AS query_count, avg(query_duration_ms) AS avg_ms\nFROM system.query_log\nWHERE type = 'QueryFinish'\n  AND event_time > now() - INTERVAL 6 HOUR\nGROUP BY t\nORDER BY t` },
      { label: 'Active merges (sustained merge activity?)', sql: `SELECT database, table, elapsed, progress, is_mutation\nFROM system.merges\nORDER BY elapsed DESC` },
    ],
  },

  'generic': {
    what: 'An alert fired for this category. Review the alert message below for specific details about what was detected.',
    why: ['See the alert details section below for specific cause', 'Check relevant system tables for context'],
    queries: [
      { label: 'Queries around alert time', sql: `SELECT event_time, type, query_duration_ms, read_rows,\n  formatReadableSize(memory_usage) AS mem, user,\n  substring(query, 1, 200) AS q\nFROM system.query_log\nWHERE event_time BETWEEN '{from}' AND '{to}'\nORDER BY event_time DESC\nLIMIT 50` },
      { label: 'System errors in last hour', sql: `SELECT name, value, last_error_time,\n  substring(last_error_message, 1, 150) AS msg\nFROM system.errors\nWHERE value > 0 AND last_error_time > now() - INTERVAL 1 HOUR\nORDER BY value DESC\nLIMIT 10` },
    ],
  },
}

function getPlaybookKey(alert: Alert): string {
  const dk = (alert.dedup_key ?? '').replace(/^[^:]+:/, '') // strip instance prefix

  if (dk.startsWith('inserts:throughput_drop')) return 'inserts:throughput_drop'
  if (dk.startsWith('inserts:small')) return 'inserts:small'
  if (dk.startsWith('inserts:stall')) return 'inserts:stall'
  if (dk.startsWith('inserts:errors')) return 'inserts:errors'
  if (dk.startsWith('async_inserts:flush_errors')) return 'async_inserts:errors'
  if (dk.startsWith('async_inserts:queue_depth')) return 'async_inserts:queue'
  if (dk.startsWith('tables:detached_parts')) return 'tables:detached'
  if (dk.startsWith('tables:')) return 'tables:parts'
  if (dk.startsWith('replication:')) return 'replication'
  if (dk.startsWith('storage:disk')) return 'storage:disk'
  if (dk.startsWith('storage:s3') || dk.startsWith('s3:')) return 'storage:s3'
  if (dk.startsWith('errors:textlog:')) return 'errors:fatal'
  if (dk.startsWith('errors:')) return 'errors:system'
  if (dk.startsWith('mvs:')) return 'mvs'
  if (dk.startsWith('dictionaries:')) return 'dictionaries'
  if (dk.startsWith('queries:') || dk.startsWith('query_latency:')) return 'queries'

  const cat = (alert.category ?? '').toLowerCase()
  const title = (alert.title ?? '').toLowerCase()
  if (cat.includes('memory') || cat.includes('cgroup') || title.includes('memory')) return 'memory'
  if (cat.includes('cpu') || cat.includes('load') || title.includes('cpu')) return 'cpu'
  if (cat === 'anomaly' || cat.includes('anomaly')) return 'anomaly'
  if (cat.includes('sustained') || cat.includes('drop')) return 'sustained'
  if (cat.includes('inserts')) return 'inserts:throughput_drop'
  if (cat.includes('queries') || cat.includes('query')) return 'queries'
  if (cat.includes('replication')) return 'replication'
  if (cat.includes('storage') || cat.includes('disk')) return 'storage:disk'
  if (cat.includes('tables') || cat.includes('parts')) return 'tables:parts'
  if (cat.includes('errors')) return 'errors:system'
  if (cat.includes('mvs') || cat.includes('materialized')) return 'mvs'
  if (cat.includes('dictionaries')) return 'dictionaries'
  return 'generic'
}

function buildPlaybookQueries(alert: Alert, queries: PlaybookQuery[]): PlaybookQuery[] {
  const from = new Date((alert.created_at - 600) * 1000).toISOString().replace('T', ' ').slice(0, 19)
  const to = new Date((alert.created_at + 600) * 1000).toISOString().replace('T', ' ').slice(0, 19)
  const fromH = new Date((alert.created_at - 3600) * 1000).toISOString().replace('T', ' ').slice(0, 19)
  const toH = new Date((alert.created_at + 3600) * 1000).toISOString().replace('T', ' ').slice(0, 19)
  const tableMatch = (alert.dedup_key ?? '').match(/:([^:.]+)\.([^:]+)$/)
  const database = tableMatch?.[1] ?? ''
  const table = tableMatch?.[2] ?? ''
  const metricMatch = (alert.title ?? '').match(/[:\s]([a-zA-Z0-9_.]+)\s*$/)
  const metric = metricMatch?.[1] ?? ''
  const vars: Record<string, string> = { from, to, fromH, toH, database, table, metric }
  return queries.map(q => ({
    label: q.label,
    sql: q.sql.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`),
  }))
}

/* ------------------------------------------------------------------ */
/*  Alert message renderer                                             */
/* ------------------------------------------------------------------ */
function looksLikeSql(s: string): boolean {
  const u = s.toUpperCase()
  return (u.includes('SELECT') && u.includes('FROM')) || u.includes('SHOW ') || u.includes('SYSTEM ') || u.includes('OPTIMIZE ') || u.includes('KILL ') || u.includes('CHECK TABLE') || u.includes('ALTER TABLE')
}

interface MessageSegment { type: 'text' | 'sql'; content: string }

function parseAlertMessage(message: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  const parts = message.split(/```(?:\w+)?\n?([\s\S]*?)```/g)
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const text = parts[i].trim()
      if (text) segments.push({ type: 'text', content: text })
    } else {
      const code = parts[i].trim()
      if (code) segments.push({ type: looksLikeSql(code) ? 'sql' : 'text', content: code })
    }
  }
  return segments
}

function AlertMessageRenderer({ message, instance }: { message: string; instance: string }) {
  const segments = parseAlertMessage(message)
  return (
    <div className="space-y-2">
      {segments.map((seg, i) => {
        if (seg.type === 'sql') return <SqlBlock key={i} sql={seg.content} instance={instance} />
        const lines = seg.content.split('\n')
        return (
          <div key={i} className="text-xs bg-[var(--hover)] rounded-md p-3 border border-[var(--border)] space-y-0.5">
            {lines.map((line, j) => {
              const parts = line.split(/\*([^*]+)\*/g)
              const rendered = parts.map((p, k) => k % 2 === 1 ? <strong key={k}>{p}</strong> : <span key={k}>{p}</span>)
              return <div key={j}>{rendered}</div>
            })}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Table parser                                                       */
/* ------------------------------------------------------------------ */
function parseTableFromAlert(alert: Alert): { database: string; table: string } | null {
  const dedupMatch = alert.dedup_key?.match(/^[^:]+:tables:[^:]+:([^.]+)\.(.+)$/)
  if (dedupMatch) return { database: dedupMatch[1], table: dedupMatch[2] }
  const msgMatch = alert.message?.match(/`?(\w+)`?\.`?(\w+)`?/)
  if (msgMatch) return { database: msgMatch[1], table: msgMatch[2] }
  return null
}

/* ------------------------------------------------------------------ */
/*  Severity colors                                                    */
/* ------------------------------------------------------------------ */
const SEV_BG: Record<string, string> = {
  critical: 'bg-red-500/10 border-red-500/30',
  warn: 'bg-yellow-500/10 border-yellow-500/30',
  info: 'bg-blue-500/10 border-blue-500/30',
}
const SEV_TEXT: Record<string, string> = {
  critical: 'text-red-400',
  warn: 'text-yellow-400',
  info: 'text-blue-400',
}

/* ------------------------------------------------------------------ */
/*  Anomaly section                                                    */
/* ------------------------------------------------------------------ */
const METRIC_MAP: [RegExp, string][] = [
  [/memory|mem/i, 'MemoryResident'],
  [/cpu|osc/i, 'OSUserTimeCPU'],
  [/query|queries/i, 'Query'],
  [/merge/i, 'Merge'],
  [/insert/i, 'DelayedInserts'],
  [/part/i, 'PartsCount'],
]
function deriveMetric(alert: Alert): string | null {
  const text = `${alert.title} ${alert.category}`
  for (const [re, metric] of METRIC_MAP) {
    if (re.test(text)) return metric
  }
  return null
}
function isAnomalyAlert(alert: Alert): boolean {
  return (
    (alert.category ?? '').toLowerCase().includes('anomaly') ||
    /(baseline|z=[\d.]+\u03c3)/i.test(alert.message ?? '')
  )
}
function AnomalySparkline({ values, mean, threshold, current }: { values: number[]; mean: number; threshold: number; current: number }) {
  if (values.length < 2) return null
  const W = 200, H = 48, pad = 4
  const min = Math.min(...values, mean)
  const max = Math.max(...values, threshold)
  const range = max - min || 1
  const sx = (i: number) => pad + (i / (values.length - 1)) * (W - 2 * pad)
  const sy = (v: number) => H - pad - ((v - min) / range) * (H - 2 * pad)
  const pts = values.map((v, i) => `${sx(i)},${sy(v)}`).join(' ')
  const meanY = sy(mean), thrY = sy(threshold)
  const cx = sx(values.length - 1), cy = sy(current)
  return (
    <svg width={W} height={H} className="overflow-visible">
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
      <line x1={pad} y1={meanY} x2={W - pad} y2={meanY} stroke="#6b7280" strokeWidth="1" strokeDasharray="3 2" />
      <line x1={pad} y1={thrY} x2={W - pad} y2={thrY} stroke="#f59e0b" strokeWidth="1" strokeDasharray="3 2" />
      <circle cx={cx} cy={cy} r={3} fill={current > threshold ? '#ef4444' : '#22c55e'} />
    </svg>
  )
}
function AnomalySection({ alert }: { alert: Alert }) {
  const [ctx, setCtx] = useState<AnomalyContext | null>(null)
  const metric = useMemo(() => deriveMetric(alert), [alert])
  useEffect(() => {
    if (!metric) return
    api.anomalyContext(alert.instance, metric).then(setCtx).catch(() => {})
  }, [alert.instance, metric]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!isAnomalyAlert(alert) || !metric || !ctx?.values?.length) return null
  const { z_score, mean, std_dev, current, threshold, values } = ctx
  if (z_score < 1.5) return null
  const badge = z_score >= 2.0
    ? <span className="text-[10px] font-semibold text-red-400 bg-red-500/10 border border-red-500/20 rounded px-1.5 py-0.5">Anomaly</span>
    : <span className="text-[10px] font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5">Elevated</span>
  return (
    <div className="rounded-lg border border-[var(--border)] p-3 space-y-2">
      <div className="flex items-center gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">Anomaly Context</div>
        {badge}
      </div>
      <AnomalySparkline values={values} mean={mean} threshold={threshold} current={current} />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--dim)]">
        <span>Baseline: <strong className="text-[var(--text)]">{mean.toFixed(2)}</strong></span>
        <span>σ: <strong className="text-[var(--text)]">{std_dev.toFixed(2)}</strong></span>
        <span>Z-score: <strong className={z_score >= 2.0 ? 'text-red-400' : 'text-amber-400'}>{z_score.toFixed(1)}σ</strong></span>
        <span>Threshold: <strong className="text-amber-400">{threshold.toFixed(2)}</strong></span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  AlertDetailPanel                                                   */
/* ------------------------------------------------------------------ */
type PanelTab = 'overview' | 'investigate' | 'actions'

export interface AlertDetailPanelProps {
  alert: Alert
  staleHours?: number
  onClose: () => void
  onResolve?: (dedupKey: string) => void
  isResolving?: boolean
  onSnoozeChange?: () => void
  onAckChange?: () => void
  onAnalyze?: (alert: Alert) => void
  onNavToInstance?: (instance: string) => void
}

export function AlertDetailPanel({
  alert,
  staleHours = 24,
  onClose,
  onResolve,
  isResolving = false,
  onSnoozeChange,
  onAckChange,
  onAnalyze,
  onNavToInstance,
}: AlertDetailPanelProps) {
  const { openTableDetail, navToExploreWithRange } = useStore()
  const [tab, setTab] = useState<PanelTab>('overview')
  const [suggestions, setSuggestions] = useState<Suggestion | null>(null)
  const [loadingSugg, setLoadingSugg] = useState(false)
  const [suggError, setSuggError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [snoozeEntries, setSnoozeEntries] = useState<SnoozeEntry[]>([])
  const [ackEntries, setAckEntries] = useState<AckEntry[]>([])
  const [customSnoozeActive, setCustomSnoozeActive] = useState(false)
  const [customSnoozeMinutes, setCustomSnoozeMinutes] = useState(60)

  const activeSnoozedEntry = useMemo(
    () => snoozeEntries.find(s => s.dedup_key === alert.dedup_key && s.expires_at > Math.floor(Date.now() / 1000)) ?? null,
    [snoozeEntries, alert.dedup_key],
  )
  const activeAckEntry = useMemo(
    () => ackEntries.find(a => a.dedup_key === alert.dedup_key) ?? null,
    [ackEntries, alert.dedup_key],
  )

  const playbook = useMemo(() => PLAYBOOKS[getPlaybookKey(alert)] ?? PLAYBOOKS.generic, [alert])
  const playbookQueries = useMemo(() => buildPlaybookQueries(alert, playbook.queries), [alert, playbook])
  const tableInfo = useMemo(() => parseTableFromAlert(alert), [alert])

  const isStale = useMemo(() => {
    if (alert.resolved) return false
    const updatedAt = alert.updated_at ?? alert.created_at
    return (Date.now() / 1000 - updatedAt) > staleHours * 3600
  }, [alert, staleHours])

  useEffect(() => {
    Promise.all([api.snooze.list(), api.ack.list()])
      .then(([snoozes, acks]) => { setSnoozeEntries(snoozes); setAckEntries(acks) })
      .catch(() => {})
  }, [refreshTick]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!suggestions && !loadingSugg) {
      setLoadingSugg(true)
      api.suggestions(alert.category)
        .then(setSuggestions)
        .catch((e: any) => setSuggError(e?.message ?? 'Failed'))
        .finally(() => setLoadingSugg(false))
    }
  }, [alert.category]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSnooze = useCallback(async (durationMinutes: number) => {
    await api.snooze.create(alert.dedup_key, alert.instance, '', durationMinutes)
    setRefreshTick(t => t + 1)
    onSnoozeChange?.()
  }, [alert.dedup_key, alert.instance, onSnoozeChange])

  const handleUnsnooze = useCallback(async () => {
    if (!activeSnoozedEntry) return
    await api.snooze.delete(activeSnoozedEntry.id)
    setRefreshTick(t => t + 1)
    onSnoozeChange?.()
  }, [activeSnoozedEntry, onSnoozeChange])

  const handleAck = useCallback(async () => {
    await api.ack.create(alert.dedup_key, alert.instance, '')
    setRefreshTick(t => t + 1)
    onAckChange?.()
  }, [alert.dedup_key, alert.instance, onAckChange])

  const handleUnack = useCallback(async () => {
    if (!activeAckEntry) return
    await api.ack.delete(activeAckEntry.id)
    setRefreshTick(t => t + 1)
    onAckChange?.()
  }, [activeAckEntry, onAckChange])

  const TABS: { id: PanelTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'investigate', label: 'Investigate' },
    { id: 'actions', label: 'Actions' },
  ]

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full z-50 w-full sm:w-[45vw] sm:min-w-[480px] max-w-full bg-[var(--card)] border-l border-[var(--border)] flex flex-col shadow-2xl">

        {/* Header */}
        <div className={cn(
          'flex items-start gap-3 px-4 py-3 border-b border-[var(--border)] shrink-0 border-l-4',
          alert.severity === 'critical' ? 'border-l-red-500' : alert.severity === 'warn' ? 'border-l-yellow-500' : 'border-l-blue-500',
        )}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <Badge severity={alert.severity} />
              {alert.resolved && <span className="text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 rounded px-1.5 py-0.5">resolved</span>}
              {isStale && !alert.resolved && <span className="text-[10px] text-[var(--dim)] bg-[var(--border)] border border-[var(--border)] rounded px-1.5 py-0.5">stale</span>}
              {activeSnoozedEntry && <span className="inline-flex items-center gap-1 text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5"><BellOff size={9} /> snoozed</span>}
              {activeAckEntry && <span className="text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 rounded px-1.5 py-0.5">investigating</span>}
            </div>
            <div className="text-[13px] font-semibold text-[var(--text)] leading-snug">{alert.title}</div>
            <div className="flex items-center gap-3 mt-1.5 text-[11px] text-[var(--dim)]">
              <span className="flex items-center gap-1"><Server size={10} />{alert.instance}</span>
              <span className="flex items-center gap-1"><Tag size={10} />{alert.category}</span>
              <span className="flex items-center gap-1"><Clock size={10} />{fmtTime(alert.created_at)}</span>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--hover)] text-[var(--dim)] hover:text-[var(--text)] transition-colors shrink-0">
            <X size={14} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[var(--border)] shrink-0 px-2">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'px-3 py-2 text-[11px] font-medium transition-colors relative',
                tab === t.id
                  ? 'text-[var(--accent)] after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:bg-[var(--accent)]'
                  : 'text-[var(--dim)] hover:text-[var(--text)]',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {/* ── Overview tab ── */}
          {tab === 'overview' && (
            <>
              {activeSnoozedEntry && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
                  <BellOff size={12} className="shrink-0" />
                  <span>Snoozed until {new Date(activeSnoozedEntry.expires_at * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              )}
              {activeAckEntry && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20 text-xs text-green-300">
                  <span className="shrink-0">✓</span>
                  <span>Acknowledged by <strong>{activeAckEntry.acked_by}</strong> — notifications suppressed until resolved</span>
                </div>
              )}

              {/* Metadata grid */}
              <div className={cn('rounded-lg border p-3 grid grid-cols-2 gap-x-4 gap-y-2', SEV_BG[alert.severity] ?? 'border-[var(--border)]')}>
                <div>
                  <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-0.5">Instance</div>
                  <div className="text-[11px] font-medium">{alert.instance}</div>
                </div>
                <div>
                  <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-0.5">Category</div>
                  <div className="text-[11px] font-medium">{alert.category}</div>
                </div>
                <div>
                  <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-0.5">First fired</div>
                  <div className="text-[11px]">{fmtTime(alert.first_seen_at ?? alert.created_at)}</div>
                </div>
                {alert.fire_count != null && alert.fire_count > 1 && (
                  <div>
                    <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-0.5">Fire count</div>
                    <div className="text-[11px] text-amber-400 font-medium">{alert.fire_count}×</div>
                  </div>
                )}
                {alert.updated_at && alert.updated_at !== alert.created_at && (
                  <div>
                    <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-0.5">Last seen</div>
                    <div className={cn('text-[11px]', isStale ? 'text-yellow-400' : '')}>{fmtTime(alert.updated_at)}</div>
                  </div>
                )}
                {alert.resolved_at && (
                  <div>
                    <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-0.5">Resolved</div>
                    <div className="text-[11px] text-green-400">{fmtTime(alert.resolved_at)}</div>
                  </div>
                )}
              </div>

              {/* What is this? */}
              <div className="rounded-lg border border-[var(--border)] p-3 space-y-2">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">
                  <Info size={11} className="text-blue-400" />
                  What is this alert?
                </div>
                <p className="text-[12px] text-[var(--text)] leading-relaxed">{playbook.what}</p>
              </div>

              {/* Common causes */}
              <div className="rounded-lg border border-[var(--border)] p-3 space-y-2">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">
                  <AlertTriangle size={11} className="text-amber-400" />
                  Common causes
                </div>
                <ul className="space-y-1.5">
                  {playbook.why.map((reason, i) => (
                    <li key={i} className="flex items-start gap-2 text-[11px] text-[var(--dim)]">
                      <span className="text-[var(--accent)] mt-0.5 shrink-0">·</span>
                      {reason}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Alert details */}
              {alert.message && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-2">Alert details</div>
                  <AlertMessageRenderer message={alert.message} instance={alert.instance} />
                </div>
              )}

              {/* Anomaly context */}
              <AnomalySection alert={alert} />

              {/* Table / instance shortcuts */}
              <div className="flex flex-wrap gap-2">
                {tableInfo && (
                  <button
                    onClick={() => openTableDetail(alert.instance, tableInfo.database, tableInfo.table)}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25 transition-colors"
                  >
                    <Table2 size={12} />
                    Explore table: {tableInfo.database}.{tableInfo.table}
                  </button>
                )}
                {onNavToInstance && (
                  <button
                    onClick={() => onNavToInstance(alert.instance)}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--hover)] border border-[var(--border)] transition-colors"
                  >
                    <ChevronRight size={12} />
                    Instance detail →
                  </button>
                )}
              </div>
            </>
          )}

          {/* ── Investigate tab ── */}
          {tab === 'investigate' && (
            <div className="space-y-4">
              {/* Open in Explore */}
              <button
                onClick={() => {
                  navToExploreWithRange(alert.instance, alert.created_at - 600, alert.created_at + 600)
                  onClose()
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 transition-colors"
              >
                <Search size={11} />
                Open Explore at alert time ±10m
              </button>

              {/* Playbook queries */}
              <div className="space-y-4">
                {playbookQueries.map((q, i) => (
                  <div key={i} className="space-y-1.5">
                    <div className="text-[11px] font-medium text-[var(--text)]">
                      <span className="text-[var(--accent)] mr-1.5">{i + 1}.</span>{q.label}
                    </div>
                    <SqlBlock sql={q.sql} instance={alert.instance} />
                  </div>
                ))}
              </div>

              {/* Suggestions from backend */}
              {loadingSugg && <div className="text-[11px] text-[var(--dim)] italic">Loading suggestions…</div>}
              {suggError && <div className="text-[11px] text-red-400">Suggestions unavailable: {suggError}</div>}
              {suggestions && suggestions.suggestions.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-3 mt-2">Additional suggestions</div>
                  <div className="space-y-2">
                    {suggestions.suggestions.map((tip, i) => {
                      const backtickMatch = tip.match(/^([\s\S]*?)```(?:\w+)?\n?([\s\S]+?)```([\s\S]*)$/s)
                      if (backtickMatch) {
                        const before = backtickMatch[1].trim(), sql = backtickMatch[2].trim(), after = backtickMatch[3].trim()
                        return (
                          <div key={i} className="space-y-1">
                            {before && <div className="text-xs pl-2 border-l-2 border-[var(--border)]">{before}</div>}
                            {looksLikeSql(sql) ? <SqlBlock sql={sql} instance={alert.instance} /> : <pre className="text-xs bg-[var(--hover)] rounded p-2 border border-[var(--border)] font-mono">{sql}</pre>}
                            {after && <div className="text-xs pl-2 border-l-2 border-[var(--border)]">{after}</div>}
                          </div>
                        )
                      }
                      const sqlMatch = tip.match(/^(.*?):\s*(SELECT\s|SHOW\s|SYSTEM\s|OPTIMIZE\s|KILL\s)(.*)/is)
                      if (sqlMatch) {
                        return (
                          <div key={i} className="space-y-1">
                            <div className="text-xs pl-2 border-l-2 border-[var(--border)]">{sqlMatch[1].trim()}</div>
                            <SqlBlock sql={(sqlMatch[2] + sqlMatch[3]).trim()} instance={alert.instance} />
                          </div>
                        )
                      }
                      if (looksLikeSql(tip)) return <SqlBlock key={i} sql={tip} instance={alert.instance} />
                      return <div key={i} className="text-xs pl-2 border-l-2 border-[var(--border)]">{tip}</div>
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Actions tab ── */}
          {tab === 'actions' && (
            <div className="space-y-3">
              {onAnalyze && (
                <div className="rounded-lg border border-[var(--border)] p-3">
                  <div className="text-[11px] font-semibold text-[var(--text)] mb-1">AI Analysis</div>
                  <div className="text-[11px] text-[var(--dim)] mb-2">Get AI-powered root cause analysis and remediation steps for this alert.</div>
                  <button
                    onClick={() => { onAnalyze(alert); onClose() }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 transition-colors"
                  >
                    <Sparkles size={11} />
                    Analyze with AI
                  </button>
                </div>
              )}

              {onResolve && !alert.resolved && (
                <div className="rounded-lg border border-[var(--border)] p-3">
                  <div className="text-[11px] font-semibold text-[var(--text)] mb-1">Resolve</div>
                  <div className="text-[11px] text-[var(--dim)] mb-2">Mark this alert as resolved. It will no longer appear in the active alerts list.</div>
                  <button
                    onClick={() => { if (!isResolving) { onResolve(alert.dedup_key); onClose() } }}
                    disabled={isResolving}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-green-400 bg-green-500/10 hover:bg-green-500/20 border border-green-500/20 transition-colors disabled:opacity-50"
                  >
                    {isResolving ? <><Clock size={11} className="animate-spin" /> Resolving…</> : 'Mark resolved'}
                  </button>
                </div>
              )}

              {!alert.resolved && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3">
                  <div className="text-[11px] font-semibold text-amber-400 mb-1">Acknowledge</div>
                  {activeAckEntry ? (
                    <div className="space-y-2">
                      <div className="text-[11px] text-amber-400">Acknowledged by <strong>{activeAckEntry.acked_by}</strong></div>
                      <button onClick={handleUnack} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 transition-colors">Remove ACK</button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="text-[11px] text-[var(--dim)] mb-2">Mark that you are actively investigating this alert.</div>
                      <button onClick={handleAck} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 transition-colors">Acknowledge</button>
                    </div>
                  )}
                </div>
              )}

              {!alert.resolved && (
                <div className="rounded-lg border border-[var(--border)] p-3">
                  <div className="text-[11px] font-semibold text-[var(--text)] mb-1">Snooze</div>
                  {activeSnoozedEntry ? (
                    <div className="space-y-2">
                      <div className="text-[11px] text-amber-400 flex items-center gap-1.5"><BellOff size={11} /> Snoozed until {fmtTime(activeSnoozedEntry.expires_at)}</div>
                      <button onClick={handleUnsnooze} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 transition-colors"><Bell size={11} /> Unsnooze</button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="text-[11px] text-[var(--dim)] mb-2">Temporarily hide this alert for the selected duration.</div>
                      <div className="flex gap-2 flex-wrap">
                        {[{ label: '15m', minutes: 15 }, { label: '1h', minutes: 60 }, { label: '4h', minutes: 240 }, { label: '24h', minutes: 1440 }].map(opt => (
                          <button key={opt.minutes} onClick={() => handleSnooze(opt.minutes)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 transition-colors">
                            <BellOff size={11} /> {opt.label}
                          </button>
                        ))}
                        <button onClick={() => setCustomSnoozeActive(v => !v)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 transition-colors">
                          <BellOff size={11} /> Custom
                        </button>
                      </div>
                      {customSnoozeActive && (
                        <div className="flex items-center gap-2 mt-1">
                          <input
                            type="number" min={1} max={10080}
                            value={customSnoozeMinutes}
                            onChange={e => setCustomSnoozeMinutes(Math.max(1, Math.min(10080, Number(e.target.value))))}
                            className="w-20 bg-[var(--surface)] border border-amber-500/30 rounded px-2 py-1 text-[11px] text-amber-400 focus:outline-none focus:border-amber-500/60"
                          />
                          <span className="text-[11px] text-[var(--dim)]">minutes</span>
                          <button onClick={() => { handleSnooze(customSnoozeMinutes); setCustomSnoozeActive(false) }} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-amber-400 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 transition-colors">Apply</button>
                          <button onClick={() => setCustomSnoozeActive(false)} className="text-[11px] text-[var(--dim)] hover:text-[var(--text)] transition-colors">Cancel</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-[var(--border)] px-4 py-2 flex items-center justify-between">
          <span className="text-[10px] text-[var(--dim)]">Press Esc to close</span>
          {alert.severity && (
            <span className={cn('text-[10px] font-medium uppercase tracking-wider', SEV_TEXT[alert.severity] ?? 'text-[var(--dim)]')}>
              {alert.severity}
            </span>
          )}
        </div>
      </div>
    </>
  )
}
