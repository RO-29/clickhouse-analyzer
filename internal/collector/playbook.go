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
