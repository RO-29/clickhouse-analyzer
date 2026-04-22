package collector

import (
	"time"

	"github.com/rohitjain/ch-analyzer/internal/config"
)

// CollectorMeta describes a collector for the UI.
type CollectorMeta struct {
	Name        string   `json:"name"`
	DisplayName string   `json:"display_name"`
	Description string   `json:"description"`
	Category    string   `json:"category"`
	Queries     []string `json:"queries"`
}

// AllCollectorMeta returns metadata for every collector.
func AllCollectorMeta() []CollectorMeta {
	return []CollectorMeta{
		{
			Name:        "system",
			DisplayName: "System Resources",
			Description: "Reports memory and CPU utilization from system.asynchronous_metrics and system.metrics.",
			Category:    "system",
			Queries: []string{
				`SELECT metric, value FROM system.asynchronous_metrics
WHERE metric IN ('MemoryResident','OSMemoryAvailable','OSMemoryTotal',
                 'OSCPUWaitMicroseconds','OSCPUVirtualTimeMicroseconds')`,
				`SELECT metric, value FROM system.metrics
WHERE metric IN ('MemoryTracking','BackgroundMergesMutationsPoolTask')`,
			},
		},
		{
			Name:        "queries",
			DisplayName: "Query Activity",
			Description: "Detects slow queries (WARN >30s, CRIT >60s), query timeouts (TIMEOUT_EXCEEDED/TOO_SLOW), zombie HTTP queries, and query storms.",
			Category:    "queries",
			Queries: []string{
				`-- Running queries by elapsed time
SELECT query_id, user, elapsed, formatReadableSize(memory_usage) AS mem, query
FROM system.processes
WHERE elapsed > 30
ORDER BY elapsed DESC LIMIT 20`,
				`-- Zombie HTTP queries (client likely disconnected)
SELECT query_id, user, http_user_agent, elapsed, query
FROM system.processes
WHERE http_user_agent != '' AND elapsed > 600
ORDER BY elapsed DESC`,
				`-- Recent timeout/cancellation exceptions
SELECT exception_code, count() AS cnt, any(exception) AS sample
FROM system.query_log
WHERE type = 'ExceptionWhileProcessing'
  AND exception_code IN (159, 160, 394)
  AND event_time >= now() - INTERVAL 5 MINUTE
GROUP BY exception_code ORDER BY cnt DESC`,
			},
		},
		{
			Name:        "tables",
			DisplayName: "Table Health",
			Description: "Monitors active parts count, running merges, and pending mutations per table.",
			Category:    "tables",
			Queries: []string{
				`SELECT database, table, count() AS active_parts
FROM system.parts WHERE active = 1
AND database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
GROUP BY database, table
ORDER BY active_parts DESC LIMIT 20`,
				`SELECT database, table, count() AS merges
FROM system.merges GROUP BY database, table`,
				`SELECT database, table, count() AS mutations
FROM system.mutations WHERE is_done = 0
GROUP BY database, table`,
			},
		},
		{
			Name:        "storage",
			DisplayName: "Storage Usage",
			Description: "Tracks disk utilization and S3 object-storage usage across all configured disks.",
			Category:    "storage",
			Queries: []string{
				`SELECT name, path, free_space, total_space,
       round((1 - free_space / total_space) * 100, 1) AS used_pct
FROM system.disks`,
				`SELECT formatReadableSize(sum(bytes_on_disk)) AS total_s3
FROM system.parts
WHERE disk_name LIKE '%s3%' OR disk_name LIKE '%object%'`,
			},
		},
		{
			Name:        "inserts",
			DisplayName: "Insert Throughput",
			Description: "Measures insert rows/s and bytes/s; alerts on insert stalls or unusual throughput drops.",
			Category:    "inserts",
			Queries: []string{
				`SELECT
  countIf(query_kind='Insert') AS insert_queries,
  sumIf(written_rows, query_kind='Insert') AS rows_written,
  sumIf(written_bytes, query_kind='Insert') AS bytes_written
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time > now() - INTERVAL 1 MINUTE`,
			},
		},
		{
			Name:        "mvs",
			DisplayName: "Materialized Views",
			Description: "Checks for stalled or erroring materialized view refresh chains.",
			Category:    "mvs",
			Queries: []string{
				`SELECT database, name, last_exception
FROM system.tables
WHERE engine = 'MaterializedView'
  AND database NOT IN ('system','information_schema','INFORMATION_SCHEMA')`,
			},
		},
		{
			Name:        "dictionaries",
			DisplayName: "Dictionary Health",
			Description: "Reports dictionaries that failed to load or refresh from system.dictionaries.",
			Category:    "dictionaries",
			Queries: []string{
				`SELECT database, name, status, last_exception,
       loading_duration, bytes_allocated
FROM system.dictionaries
WHERE database NOT IN ('system','information_schema','INFORMATION_SCHEMA')`,
			},
		},
		{
			Name:        "replication",
			DisplayName: "Replication Status",
			Description: "Measures replication queue depth, lag, and reports any replication errors.",
			Category:    "replication",
			Queries: []string{
				`SELECT database, table, is_leader,
       absolute_delay, queue_size, inserts_in_queue, merges_in_queue
FROM system.replicas`,
				`SELECT database, table, last_exception
FROM system.replication_queue
WHERE last_exception != ''
LIMIT 20`,
			},
		},
		{
			Name:        "errors",
			DisplayName: "System Errors",
			Description: "Surfaces recent entries from system.errors that indicate internal ClickHouse failures.",
			Category:    "errors",
			Queries: []string{
				`SELECT name, code, value AS count,
       remote, last_error_time, last_error_message
FROM system.errors
WHERE last_error_time > now() - INTERVAL 1 HOUR
ORDER BY count DESC
LIMIT 20`,
			},
		},
		{
			Name:        "background_pool",
			DisplayName: "Background Pool",
			Description: "Checks background merge and mutation thread pool saturation.",
			Category:    "system",
			Queries: []string{
				`SELECT metric, value FROM system.metrics
WHERE metric IN (
  'BackgroundMergesMutationsPoolTask','BackgroundMergesMutationsPoolSize',
  'BackgroundFetchesPoolTask','BackgroundFetchesPoolSize',
  'BackgroundProcessingPoolTask','BackgroundProcessingPoolSize'
)`,
			},
		},
		{
			Name:        "cache_health",
			DisplayName: "Cache Health",
			Description: "Reports mark-cache and uncompressed-cache hit rates; alerts on poor cache utilization.",
			Category:    "system",
			Queries: []string{
				`SELECT
  sum(ProfileEvents['MarkCacheHits']) AS hits,
  sum(ProfileEvents['MarkCacheMisses']) AS misses,
  count() AS queries
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time > now() - INTERVAL 5 MINUTE`,
			},
		},
		{
			Name:        "connections",
			DisplayName: "Connections",
			Description: "Samples per-interface connection counts (TCP / HTTP / MySQL / PostgreSQL / Interserver) so the Connections tab can chart history.",
			Category:    "system",
			Queries: []string{
				`SELECT metric, value FROM system.metrics
WHERE metric IN (
  'TCPConnection', 'HTTPConnection', 'MySQLConnection',
  'PostgreSQLConnection', 'InterserverConnection'
)`,
			},
		},
		{
			Name:        "query_latency",
			DisplayName: "Query Latency",
			Description: "Detects P95 query latency spikes compared to a rolling 24h baseline.",
			Category:    "queries",
			Queries: []string{
				`-- Current 5-minute P95
SELECT query_kind,
  quantile(0.95)(query_duration_ms) AS p95_ms,
  count() AS query_count
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time > now() - INTERVAL 5 MINUTE
GROUP BY query_kind`,
				`-- 24-hour baseline P95
SELECT query_kind,
  quantile(0.95)(query_duration_ms) AS baseline_p95_ms
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time BETWEEN now() - INTERVAL 24 HOUR AND now() - INTERVAL 5 MINUTE
GROUP BY query_kind`,
			},
		},
		{
			Name:        "freshness",
			DisplayName: "Insert Freshness",
			Description: "Identifies tables that received inserts in last 24h but stopped receiving in last 20 minutes.",
			Category:    "tables",
			Queries: []string{
				`SELECT databases[1] AS database, tables[1] AS table,
  max(event_time) AS last_insert,
  count() AS inserts_24h
FROM system.query_log
WHERE type = 'QueryFinish'
  AND query_kind = 'Insert'
  AND event_time > now() - INTERVAL 24 HOUR
  AND length(databases) > 0
  AND databases[1] NOT IN ('system','information_schema','INFORMATION_SCHEMA')
GROUP BY databases[1], tables[1]
HAVING inserts_24h > 5
   AND last_insert < now() - INTERVAL 20 MINUTE
ORDER BY last_insert ASC
LIMIT 20`,
			},
		},
		{
			Name:        "schema_drift",
			DisplayName: "Schema Drift",
			Description: "Detects column additions, removals, or type changes between polls. First run initializes baseline silently.",
			Category:    "tables",
			Queries: []string{
				`SELECT database, table, name AS column, type
FROM system.columns
WHERE database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
ORDER BY database, table, name`,
			},
		},
		{
			Name:        "projections",
			DisplayName: "Projection Parts",
			Description: "Finds projection parts that have not yet been built, which may degrade query performance.",
			Category:    "tables",
			Queries: []string{
				`SELECT p.database, p.table, proj.name AS projection_name,
  countIf(NOT has(p.projections, proj.name)) AS missing_parts,
  count() AS total_parts
FROM system.parts p
CROSS JOIN (
  SELECT DISTINCT database, table, name FROM system.projections
  WHERE database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
) proj
WHERE p.database = proj.database AND p.table = proj.table AND p.active = 1
GROUP BY p.database, p.table, proj.name
HAVING missing_parts > 0`,
				`SELECT database, table, name FROM system.projections
WHERE database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
LIMIT 100`,
			},
		},
		{
			Name:        "ttl",
			DisplayName: "TTL Health",
			Description: "Detects stuck TTL mutations and tables with TTL configured whose parts are suspiciously old.",
			Category:    "tables",
			Queries: []string{
				`SELECT database, table, count() AS pending, min(create_time) AS oldest_create
FROM system.mutations
WHERE NOT is_done AND (command LIKE '%TTL%' OR command LIKE '%MODIFY%')
  AND create_time < now() - INTERVAL 1 HOUR
GROUP BY database, table`,
				`SELECT t.database, t.name, count(p.name) AS part_count,
  max(dateDiff('day', p.modification_time, now())) AS oldest_part_days
FROM system.tables t JOIN system.parts p ON t.database = p.database AND t.name = p.table
WHERE t.ttl_expression != '' AND p.active = 1
  AND t.database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
GROUP BY t.database, t.name HAVING part_count > 5 AND oldest_part_days > 14`,
			},
		},
		{
			Name:        "async_inserts",
			DisplayName: "Async Insert Health",
			Description: "Monitors async insert flush failures and queue depth. No-ops gracefully if async inserts are not configured.",
			Category:    "inserts",
			Queries: []string{
				`SELECT count() AS total, countIf(status = 'ExceptionWhileFlushing') AS errors
FROM system.asynchronous_insert_log
WHERE event_time > now() - INTERVAL 5 MINUTE`,
				`SELECT count() AS queue_depth FROM system.asynchronous_insertions`,
			},
		},
		{
			Name:        "parts_age",
			DisplayName: "Parts Age",
			Description: "Detects tables where active parts have not been merged for an unusually long time, indicating merge pressure.",
			Category:    "tables",
			Queries: []string{
				`SELECT database, table, count() AS part_count,
  max(toUnixTimestamp(now()) - toUnixTimestamp(modification_time)) / 3600 AS oldest_part_hours,
  sum(rows) AS total_rows, sum(bytes_on_disk) AS total_bytes
FROM system.parts
WHERE active = 1
  AND database NOT IN ('system','information_schema','INFORMATION_SCHEMA')
GROUP BY database, table
HAVING part_count > 5 AND oldest_part_hours > 48
ORDER BY oldest_part_hours DESC LIMIT 20`,
			},
		},
		{
			Name:        "slow_query_fingerprint",
			DisplayName: "Query Storm Detection",
			Description: "Detects repeated execution of the same query pattern at high frequency (query storms).",
			Category:    "queries",
			Queries: []string{
				`SELECT normalized_query_hash, any(query) AS sample_query,
  count() AS exec_count, avg(query_duration_ms) AS avg_ms, max(query_duration_ms) AS max_ms,
  any(user) AS user
FROM system.query_log
WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL 5 MINUTE
  AND query_kind NOT IN ('Insert','Set','Create','Drop','Alter','Show','System')
GROUP BY normalized_query_hash
HAVING exec_count > 20 OR (exec_count > 5 AND avg_ms > 10000)
ORDER BY exec_count DESC LIMIT 10`,
			},
		},
		{
			Name:        "keeper",
			DisplayName: "Keeper / ZooKeeper Health",
			Description: "Checks ClickHouse Keeper or ZooKeeper reachability and monitors connection latency and request backlog.",
			Category:    "system",
			Queries: []string{
				`SELECT count() AS cnt FROM system.zookeeper WHERE path = '/'`,
				`SELECT count() AS connected_nodes, sum(outstanding_requests) AS total_outstanding,
  max(avg_latency) AS max_avg_latency_ms, max(max_latency) AS max_latency_ms
FROM system.zookeeper_connection`,
			},
		},
	}
}

// BuildCollectorFromConfig creates a Collector instance using the configured
// thresholds from cfg. This is what Run Check uses so results match the
// same sensitivity as the background polling loop.
func BuildCollectorFromConfig(name string, cfg *config.Config) (Collector, bool) {
	switch name {
	case "system":
		return &SystemCollector{
			MemoryThresholds: cfg.Thresholds.Memory,
			CPUThresholds:    cfg.Thresholds.CPU,
		}, true
	case "queries":
		return &QueryCollector{
			Thresholds: cfg.Thresholds.Queries,
		}, true
	case "tables":
		return &TableCollector{
			PartsThresholds:     cfg.Thresholds.Parts,
			MergesThresholds:    cfg.Thresholds.Merges,
			MutationsThresholds: cfg.Thresholds.Mutations,
		}, true
	case "storage":
		return &StorageCollector{
			DiskThresholds: cfg.Thresholds.Disk,
			S3Thresholds:   cfg.Thresholds.S3,
		}, true
	case "inserts":
		return &InsertCollector{
			Thresholds:      cfg.Thresholds.Inserts,
			PollingInterval: 60 * time.Second,
		}, true
	case "mvs":
		return &MVCollector{
			Thresholds: cfg.Thresholds.MV,
		}, true
	case "dictionaries":
		return &DictionaryCollector{
			Thresholds: cfg.Thresholds.Dictionaries,
		}, true
	case "replication":
		return &ReplicationCollector{
			Thresholds: cfg.Thresholds.Replication,
		}, true
	// These collectors have hardcoded thresholds — no config needed.
	case "errors":
		return &ErrorsCollector{}, true
	case "background_pool":
		return &BackgroundPoolCollector{}, true
	case "cache_health":
		return &CacheHealthCollector{}, true
	case "connections":
		return &ConnectionsCollector{}, true
	case "query_latency":
		return &QueryLatencyCollector{}, true
	case "freshness":
		return &FreshnessCollector{}, true
	case "schema_drift":
		return &SchemaDriftCollector{}, true
	case "projections":
		return &ProjectionCollector{}, true
	case "ttl":
		return &TTLCollector{}, true
	case "async_inserts":
		return &AsyncInsertsCollector{}, true
	case "parts_age":
		return &PartsAgeCollector{}, true
	case "slow_query_fingerprint":
		return &SlowQueryFingerprintCollector{}, true
	case "keeper":
		return &KeeperCollector{}, true
	default:
		return nil, false
	}
}

// BuildCollector creates a Collector instance by name using zero-value thresholds.
// Returns nil, false if the name is unknown.
func BuildCollector(name string) (Collector, bool) {
	switch name {
	case "system":
		return &SystemCollector{}, true
	case "queries":
		return &QueryCollector{}, true
	case "tables":
		return &TableCollector{}, true
	case "storage":
		return &StorageCollector{}, true
	case "inserts":
		return &InsertCollector{}, true
	case "mvs":
		return &MVCollector{}, true
	case "dictionaries":
		return &DictionaryCollector{}, true
	case "replication":
		return &ReplicationCollector{}, true
	case "errors":
		return &ErrorsCollector{}, true
	case "background_pool":
		return &BackgroundPoolCollector{}, true
	case "cache_health":
		return &CacheHealthCollector{}, true
	case "connections":
		return &ConnectionsCollector{}, true
	case "query_latency":
		return &QueryLatencyCollector{}, true
	case "freshness":
		return &FreshnessCollector{}, true
	case "schema_drift":
		return &SchemaDriftCollector{}, true
	case "projections":
		return &ProjectionCollector{}, true
	case "ttl":
		return &TTLCollector{}, true
	case "async_inserts":
		return &AsyncInsertsCollector{}, true
	case "parts_age":
		return &PartsAgeCollector{}, true
	case "slow_query_fingerprint":
		return &SlowQueryFingerprintCollector{}, true
	case "keeper":
		return &KeeperCollector{}, true
	default:
		return nil, false
	}
}
