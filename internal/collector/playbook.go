package collector

// Playbook helpers.
//
// Several alerts embed near-identical "Investigate:" SQL blocks in their
// Slack message bodies. Centralizing those blocks here keeps them in lockstep
// when a CH upgrade renames a system-table column and stops drift between
// crit/warn variants of the same check.

import "fmt"

// queryExceptionPlaybook renders the standard aggregated view of
// system.query_log exceptions, grouped by exception_code.
//
//	extraWhere: extra SQL spliced after "type='ExceptionWhileProcessing'".
//	            Must start with " AND ..." if non-empty.
//	window:     event_time window, e.g. "INTERVAL 5 MINUTE".
//
// avg_ms is always included so operators get duration context for any
// exception bucket, not just timeouts.
func queryExceptionPlaybook(extraWhere, window string) string {
	return fmt.Sprintf("*Investigate:*\n```\n"+
		"SELECT exception_code, count() as cnt, avg(query_duration_ms) as avg_ms,\n"+
		"  any(exception) as sample\n"+
		"FROM system.query_log\n"+
		"WHERE type='ExceptionWhileProcessing'%s\n"+
		"  AND event_time >= now() - %s\n"+
		"GROUP BY exception_code ORDER BY cnt DESC\n```",
		extraWhere, window)
}

// insertExceptionPlaybook renders per-row INSERT errors for a specific table,
// used when one table's INSERTs are failing so operators can see the exact
// queries and exception strings.
func insertExceptionPlaybook(database, table string) string {
	return fmt.Sprintf("*Investigate:*\n```\n"+
		"SELECT query, exception, event_time, query_duration_ms\n"+
		"FROM system.query_log\n"+
		"WHERE type = 'ExceptionWhileProcessing'\n"+
		"  AND query_kind = 'Insert'\n"+
		"  AND databases[1] = '%s'\n"+
		"  AND tables[1] = '%s'\n"+
		"  AND event_time > now() - INTERVAL 1 HOUR\n"+
		"ORDER BY event_time DESC LIMIT 20\n```",
		database, table)
}

// processesPlaybook renders the "what's running right now" view against
// system.processes. When withKill is true, appends the KILL QUERY hint used
// by the critical variant of long-running-query alerts.
func processesPlaybook(withKill bool) string {
	block := "*Investigate:*\n```\n" +
		"SELECT query_id, user, elapsed, formatReadableSize(memory_usage) as mem,\n" +
		"  read_rows, query\n" +
		"FROM system.processes ORDER BY elapsed DESC\n```"
	if withKill {
		block += "\n*Kill a query:*\n```\nKILL QUERY WHERE query_id = '<id>'\n```"
	}
	return block
}

// asyncInsertErrorPlaybook renders async-insert flush errors, with the LIMIT
// parameterized (20 for the critical variant, 10 for warn).
func asyncInsertErrorPlaybook(limit int) string {
	return fmt.Sprintf("*Investigate:*\n```\n"+
		"SELECT query, exception, event_time\n"+
		"FROM system.asynchronous_insert_log\n"+
		"WHERE status = 'ExceptionWhileFlushing'\n"+
		"  AND event_time > now() - INTERVAL 5 MINUTE\n"+
		"ORDER BY event_time DESC LIMIT %d\n```", limit)
}

// ttlStuckPlaybook renders pending mutations on a specific table — shared by
// the TTL-stuck critical and warn alerts.
func ttlStuckPlaybook(database, table string) string {
	return fmt.Sprintf("*Investigate:*\n```\n"+
		"SELECT * FROM system.mutations\n"+
		"WHERE database='%s' AND table='%s' AND NOT is_done\n```",
		database, table)
}

// keeperConnectionPlaybook is shared by every Keeper-category alert
// (unreachable / backlog / latency). The SELECT has no parameters.
const keeperConnectionPlaybook = "*Investigate:*\n```\nSELECT * FROM system.zookeeper_connection\n```"

// ---------------------------------------------------------------------------
// System-resource playbooks (memory / CPU / disk)
// ---------------------------------------------------------------------------

// memoryConsumersPlaybook: running queries ordered by memory_usage, plus the
// async OS memory breakdown. Matches the "memory.os_used" and "memory.rss"
// alerts — operator wants to know WHICH query is eating memory, not just
// that "memory is high".
const memoryConsumersPlaybook = "*Investigate:*\n```\n" +
	"-- Top memory consumers right now\n" +
	"SELECT query_id, user, formatReadableSize(memory_usage) AS mem,\n" +
	"  elapsed, substring(query, 1, 200) AS q\n" +
	"FROM system.processes\n" +
	"ORDER BY memory_usage DESC LIMIT 10;\n\n" +
	"-- CH process + OS memory breakdown\n" +
	"SELECT metric, formatReadableSize(value) AS val\n" +
	"FROM system.asynchronous_metrics\n" +
	"WHERE metric IN ('MemoryTracking','MemoryResident',\n" +
	"  'OSMemoryTotal','OSMemoryAvailable','OSMemoryBuffers','OSMemoryCached')\n" +
	"ORDER BY value DESC\n```"

// cpuConsumersPlaybook: running queries ordered by elapsed (those currently
// burning CPU) plus per-core OS CPU breakdown. Matches cpu.busy.*.
const cpuConsumersPlaybook = "*Investigate:*\n```\n" +
	"-- Longest-running queries (typically the CPU hogs)\n" +
	"SELECT query_id, user, elapsed, read_rows,\n" +
	"  formatReadableSize(memory_usage) AS mem, substring(query, 1, 200) AS q\n" +
	"FROM system.processes\n" +
	"ORDER BY elapsed DESC LIMIT 10;\n\n" +
	"-- OS-level CPU breakdown\n" +
	"SELECT metric, value\n" +
	"FROM system.asynchronous_metrics\n" +
	"WHERE metric LIKE 'OS%CPU%' OR metric = 'LoadAverage1'\n" +
	"ORDER BY metric\n```"

// topTablesBySizePlaybook: tables taking the most disk, for disk-full alerts.
const topTablesBySizePlaybook = "*Investigate:*\n```\n" +
	"SELECT database, table,\n" +
	"  formatReadableSize(sum(bytes_on_disk)) AS size_on_disk,\n" +
	"  sum(rows) AS total_rows,\n" +
	"  count() AS parts\n" +
	"FROM system.parts\n" +
	"WHERE active\n" +
	"GROUP BY database, table\n" +
	"ORDER BY sum(bytes_on_disk) DESC\n" +
	"LIMIT 20\n```"

// disksOverviewPlaybook: raw view of every disk. Matches storage.disk_broken.
const disksOverviewPlaybook = "*Investigate:*\n```\n" +
	"SELECT name, path, formatReadableSize(free_space) AS free,\n" +
	"  formatReadableSize(total_space) AS total,\n" +
	"  round(100 * (total_space - free_space) / total_space, 1) AS used_pct,\n" +
	"  type\n" +
	"FROM system.disks\n```"

// s3SlowRequestsPlaybook: per-table S3 request profile for S3 latency alerts.
// ProfileEvents S3 keys are reliable across CH versions ≥ 22.8.
const s3SlowRequestsPlaybook = "*Investigate:*\n```\n" +
	"-- S3 ops per table in the last hour\n" +
	"SELECT\n" +
	"  databases[1] AS db, tables[1] AS table,\n" +
	"  sum(ProfileEvents['S3GetObject']) AS gets,\n" +
	"  sum(ProfileEvents['S3PutObject']) AS puts,\n" +
	"  sum(ProfileEvents['S3ReadMicroseconds']) / 1000 AS read_ms_total,\n" +
	"  avg(query_duration_ms) AS avg_query_ms\n" +
	"FROM system.query_log\n" +
	"WHERE event_time > now() - INTERVAL 1 HOUR\n" +
	"  AND type = 'QueryFinish'\n" +
	"  AND ProfileEvents['S3GetObject'] + ProfileEvents['S3PutObject'] > 0\n" +
	"GROUP BY db, table\n" +
	"ORDER BY read_ms_total DESC\n" +
	"LIMIT 20\n```"

// partMovesPlaybook: recent cross-tier part moves. Window matches the
// 10-minute alert observation window in collectTierMovement so the SQL
// shows the same moves the alert counted.
const partMovesPlaybook = "*Investigate:*\n```\n" +
	"SELECT event_time, database, table, part_name,\n" +
	"  merge_reason, disk_name, path_on_disk\n" +
	"FROM system.part_log\n" +
	"WHERE event_type = 'MovePart'\n" +
	"  AND event_time > now() - INTERVAL 10 MINUTE\n" +
	"ORDER BY event_time DESC LIMIT 100\n```"

// ---------------------------------------------------------------------------
// Table / merges / mutations playbooks
// ---------------------------------------------------------------------------

// activeMergesPlaybook: in-flight merges ordered by age. For tables.merges.*.
const activeMergesPlaybook = "*Investigate:*\n```\n" +
	"SELECT database, table, elapsed,\n" +
	"  round(progress * 100, 1) AS pct,\n" +
	"  num_parts, formatReadableSize(total_size_bytes_compressed) AS size,\n" +
	"  merge_type\n" +
	"FROM system.merges\n" +
	"ORDER BY elapsed DESC\n" +
	"LIMIT 20\n```"

// stuckMutationsPlaybook: the generic "show me every in-flight mutation".
// ttl.go uses the per-table version; this is for tables.mutation.stuck which
// is raised per-row when a specific mutation is late.
const stuckMutationsPlaybook = "*Investigate:*\n```\n" +
	"SELECT database, table, mutation_id,\n" +
	"  create_time, latest_fail_reason,\n" +
	"  parts_to_do, is_done\n" +
	"FROM system.mutations\n" +
	"WHERE NOT is_done\n" +
	"ORDER BY create_time\n```"

// disksBalancePlaybook: bytes per disk for the current node. For
// tables.disk_balance (JBOD imbalance).
const disksBalancePlaybook = "*Investigate:*\n```\n" +
	"SELECT disk_name,\n" +
	"  formatReadableSize(sum(bytes_on_disk)) AS used,\n" +
	"  count() AS parts\n" +
	"FROM system.parts\n" +
	"WHERE active\n" +
	"GROUP BY disk_name\n" +
	"ORDER BY sum(bytes_on_disk) DESC\n```"

// ---------------------------------------------------------------------------
// Query-behaviour playbooks
// ---------------------------------------------------------------------------

// fullScansPlaybook: running queries with massive read_rows.
const fullScansPlaybook = "*Investigate:*\n```\n" +
	"SELECT query_id, user, elapsed,\n" +
	"  read_rows, formatReadableSize(read_bytes) AS bytes,\n" +
	"  substring(query, 1, 200) AS q\n" +
	"FROM system.processes\n" +
	"WHERE read_rows > 1e9\n" +
	"ORDER BY read_rows DESC\n```"

// zombieQueriesPlaybook: HTTP queries whose client has likely disconnected.
// elapsed > 600s (10 min) matches the collectZombieQueries alert threshold
// so the playbook returns exactly the rows the alert flagged.
const zombieQueriesPlaybook = "*Investigate:*\n```\n" +
	"SELECT query_id, user, elapsed, http_user_agent,\n" +
	"  formatReadableSize(memory_usage) AS mem,\n" +
	"  substring(query, 1, 200) AS q\n" +
	"FROM system.processes\n" +
	"WHERE http_user_agent != '' AND elapsed > 600\n" +
	"ORDER BY elapsed DESC\n```"

// querySlowInWindowPlaybook: top slow queries in the recent window, for
// query-latency spike alerts. The "window" mirrors the alert's evaluation.
func querySlowInWindowPlaybook(window string) string {
	return fmt.Sprintf("*Investigate:*\n```\n"+
		"SELECT user, query_duration_ms,\n"+
		"  formatReadableSize(memory_usage) AS mem,\n"+
		"  substring(query, 1, 200) AS q,\n"+
		"  event_time\n"+
		"FROM system.query_log\n"+
		"WHERE type = 'QueryFinish'\n"+
		"  AND event_time > now() - %s\n"+
		"ORDER BY query_duration_ms DESC\n"+
		"LIMIT 20\n```", window)
}

// slowQueryByHashPlaybook: per-hash dive for a fingerprint alert.
func slowQueryByHashPlaybook(hash string) string {
	return fmt.Sprintf("*Investigate:*\n```\n"+
		"SELECT user, count(), avg(query_duration_ms) AS avg_ms,\n"+
		"  max(query_duration_ms) AS max_ms\n"+
		"FROM system.query_log\n"+
		"WHERE normalized_query_hash = '%s'\n"+
		"  AND event_time > now() - INTERVAL 5 MINUTE\n"+
		"GROUP BY user\n```", hash)
}

// ---------------------------------------------------------------------------
// Materialized-view playbooks
// ---------------------------------------------------------------------------

// mvFailuresPlaybook: recent MV exceptions. Window matches the 5-minute
// alert observation window in collectMVFailures so the SQL returns exactly
// the rows the alert counted. A second query widens to 1 hour for pattern
// context (is this a burst or ongoing?).
func mvFailuresPlaybook(view string) string {
	return fmt.Sprintf("*Investigate:*\n```\n"+
		"-- The failures the alert counted (same 5-minute window)\n"+
		"SELECT event_time, exception, read_rows, written_rows\n"+
		"FROM system.query_views_log\n"+
		"WHERE status = 'ExceptionWhileProcessing'\n"+
		"  AND view_name = '%s'\n"+
		"  AND event_time >= now() - INTERVAL 5 MINUTE\n"+
		"ORDER BY event_time DESC;\n\n"+
		"-- Broader context: is this a new burst or ongoing?\n"+
		"SELECT toStartOfMinute(event_time) AS minute,\n"+
		"  count() AS failures, any(exception) AS sample\n"+
		"FROM system.query_views_log\n"+
		"WHERE status = 'ExceptionWhileProcessing'\n"+
		"  AND view_name = '%s'\n"+
		"  AND event_time >= now() - INTERVAL 1 HOUR\n"+
		"GROUP BY minute ORDER BY minute DESC\n```", view, view)
}

// mvSlowPlaybook: per-view duration stats. Window matches the alert's
// 5-minute observation window; filter includes status=QueryFinish like
// the alert (slow-view filter considers successful completions only).
func mvSlowPlaybook(view string) string {
	return fmt.Sprintf("*Investigate:*\n```\n"+
		"SELECT view_name,\n"+
		"  count() AS execs,\n"+
		"  avg(view_duration_ms) AS avg_ms,\n"+
		"  quantile(0.95)(view_duration_ms) AS p95_ms,\n"+
		"  max(view_duration_ms) AS max_ms\n"+
		"FROM system.query_views_log\n"+
		"WHERE status = 'QueryFinish'\n"+
		"  AND view_name = '%s'\n"+
		"  AND event_time >= now() - INTERVAL 5 MINUTE\n"+
		"GROUP BY view_name\n```", view)
}

// mvChainPlaybook: find other MVs whose SELECT references the given MV.
func mvChainPlaybook(database, viewName string) string {
	return fmt.Sprintf("*Investigate:*\n```\n"+
		"SELECT database, name, as_select\n"+
		"FROM system.tables\n"+
		"WHERE engine = 'MaterializedView'\n"+
		"  AND as_select ILIKE '%%%s.%s%%'\n```",
		database, viewName)
}

// ---------------------------------------------------------------------------
// Insert-pipeline playbooks
// ---------------------------------------------------------------------------

// insertThroughputPlaybook: per-table insert volume in the last 30 min.
const insertThroughputPlaybook = "*Investigate:*\n```\n" +
	"SELECT databases[1] AS db, tables[1] AS table,\n" +
	"  count() AS inserts,\n" +
	"  sum(written_rows) AS rows,\n" +
	"  formatReadableSize(sum(written_bytes)) AS bytes\n" +
	"FROM system.query_log\n" +
	"WHERE query_kind = 'Insert'\n" +
	"  AND type = 'QueryFinish'\n" +
	"  AND event_time > now() - INTERVAL 30 MINUTE\n" +
	"  AND length(tables) > 0\n" +
	"GROUP BY db, table\n" +
	"ORDER BY inserts DESC\n```"

// smallInsertsPlaybook: which tables are receiving tiny inserts.
const smallInsertsPlaybook = "*Investigate:*\n```\n" +
	"SELECT databases[1] AS db, tables[1] AS table,\n" +
	"  count() AS inserts,\n" +
	"  round(avg(written_rows), 0) AS avg_rows,\n" +
	"  min(written_rows) AS min_rows,\n" +
	"  max(written_rows) AS max_rows\n" +
	"FROM system.query_log\n" +
	"WHERE query_kind = 'Insert'\n" +
	"  AND type = 'QueryFinish'\n" +
	"  AND written_rows < 1000\n" +
	"  AND event_time > now() - INTERVAL 1 HOUR\n" +
	"  AND length(tables) > 0\n" +
	"GROUP BY db, table\n" +
	"HAVING inserts > 10\n" +
	"ORDER BY inserts DESC\n```"

// insertStallPlaybook: last-seen insert time per table.
const insertStallPlaybook = "*Investigate:*\n```\n" +
	"SELECT databases[1] AS db, tables[1] AS table,\n" +
	"  max(event_time) AS last_insert,\n" +
	"  dateDiff('second', max(event_time), now()) AS seconds_since\n" +
	"FROM system.query_log\n" +
	"WHERE query_kind = 'Insert'\n" +
	"  AND type = 'QueryFinish'\n" +
	"  AND event_time > now() - INTERVAL 1 HOUR\n" +
	"  AND length(tables) > 0\n" +
	"GROUP BY db, table\n" +
	"HAVING seconds_since > 300\n" +
	"ORDER BY seconds_since DESC\n```"

// asyncInsertQueuePlaybook: per-table pending async inserts.
const asyncInsertQueuePlaybook = "*Investigate:*\n```\n" +
	"SELECT database, table, count() AS pending,\n" +
	"  formatReadableSize(sum(length(bytes))) AS buffered\n" +
	"FROM system.asynchronous_insertions\n" +
	"GROUP BY database, table\n" +
	"ORDER BY pending DESC\n```"

// ---------------------------------------------------------------------------
// Background pool / dictionaries / cache
// ---------------------------------------------------------------------------

const backgroundPoolPlaybook = "*Investigate:*\n```\n" +
	"-- Pool task counts\n" +
	"SELECT metric, value\n" +
	"FROM system.metrics\n" +
	"WHERE metric ILIKE '%Pool%' OR metric ILIKE '%Background%'\n" +
	"ORDER BY metric;\n\n" +
	"-- In-flight merges (pool's main consumer)\n" +
	"SELECT count() AS active_merges, max(elapsed) AS oldest_sec\n" +
	"FROM system.merges\n```"

const dictionariesStatusPlaybook = "*Investigate:*\n```\n" +
	"SELECT name, status, element_count,\n" +
	"  loading_duration, last_exception\n" +
	"FROM system.dictionaries\n" +
	"ORDER BY status != 'LOADED' DESC, last_exception != '' DESC\n```"

// repeatedPatternsPlaybook: aggregated view of duplicate query patterns.
// Matches collectRepeatedPatterns — 5-minute window, HAVING cnt > 50, top 20.
const repeatedPatternsPlaybook = "*Investigate:*\n```\n" +
	"SELECT normalized_query_hash, any(user) AS user,\n" +
	"  count() AS cnt, avg(query_duration_ms) AS avg_ms,\n" +
	"  sum(read_rows) AS total_read_rows,\n" +
	"  substring(any(query), 1, 200) AS sample\n" +
	"FROM system.query_log\n" +
	"WHERE type = 'QueryFinish'\n" +
	"  AND event_time > now() - INTERVAL 5 MINUTE\n" +
	"GROUP BY normalized_query_hash\n" +
	"HAVING cnt > 50\n" +
	"ORDER BY cnt DESC\n" +
	"LIMIT 20\n```"

const cacheHitRatePlaybook = "*Investigate:*\n```\n" +
	"-- Current cache sizes + hit-rate metrics\n" +
	"SELECT metric, value\n" +
	"FROM system.metrics\n" +
	"WHERE metric ILIKE '%Cache%'\n" +
	"ORDER BY metric;\n\n" +
	"-- Queries doing the biggest reads (cache misses drive these)\n" +
	"SELECT user, count() AS execs,\n" +
	"  formatReadableSize(avg(read_bytes)) AS avg_read,\n" +
	"  substring(any(query), 1, 200) AS q\n" +
	"FROM system.query_log\n" +
	"WHERE type = 'QueryFinish'\n" +
	"  AND event_time > now() - INTERVAL 10 MINUTE\n" +
	"GROUP BY user, normalized_query_hash\n" +
	"ORDER BY avg(read_bytes) DESC\n" +
	"LIMIT 10\n```"
