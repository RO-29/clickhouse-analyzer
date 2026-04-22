package collector

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// ErrorsCollector monitors ClickHouse's built-in error tracking via system.errors
// and scans system.text_log for recent FATAL/Critical messages.
// These are completely un-monitored despite being high-value signals.
type ErrorsCollector struct {
	Logger *slog.Logger
}

func (c *ErrorsCollector) Name() string { return "errors" }

func (c *ErrorsCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *ErrorsCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	c.collectSystemErrors(ctx, client, result)
	c.collectTextLog(ctx, client, result)
	c.collectDetachedParts(ctx, client, result)

	result.Duration = time.Since(start)
	return result, nil
}

// collectSystemErrors queries system.errors for persistent error patterns.
// This table accumulates error counts since last restart — very useful for spotting
// recurring internal ClickHouse errors.
func (c *ErrorsCollector) collectSystemErrors(ctx context.Context, client *chclient.Client, result *CollectResult) {
	// CH 22+: column is `value`; older builds used `times`. Try modern schema first.
	rows, err := client.Query(ctx, `
		SELECT name, value AS cnt, last_error_time, last_error_message
		FROM system.errors
		WHERE value > 0 AND last_error_time > now() - INTERVAL 1 HOUR
		ORDER BY value DESC LIMIT 20`)
	if err != nil {
		// Fall back to old schema (pre-22 builds that use `times`)
		rows, err = client.Query(ctx, `
			SELECT name, times AS cnt, last_error_time, last_error_message
			FROM system.errors
			WHERE times > 0 AND last_error_time > now() - INTERVAL 1 HOUR
			ORDER BY times DESC LIMIT 20`)
		if err != nil {
			if strings.Contains(err.Error(), "UNKNOWN_TABLE") {
				return
			}
			c.logger().Warn("failed to query system.errors", slog.String("error", err.Error()))
			return
		}
	}

	// Errors that indicate serious issues vs. normal operational noise
	seriousErrors := []string{
		"CANNOT_WRITE_TO_FILE_DESCRIPTOR",
		"CANNOT_ALLOCATE_MEMORY",
		"MEMORY_LIMIT_EXCEEDED",
		"TOO_MANY_SIMULTANEOUS_QUERIES",
		"CORRUPTED_DATA",
		"CHECKSUM_DOESNT_MATCH",
		"BAD_DATA_PART_NAME",
		"CANNOT_OPEN_FILE",
		"SOCKET_TIMEOUT",
		"KEEPER_EXCEPTION",
		"ZOOKEEPER_ERROR",
		"SESSION_EXPIRED",
		"REPLICA_IS_ALREADY_ACTIVE",
		"NO_ZOOKEEPER",
	}
	seriousSet := make(map[string]bool, len(seriousErrors))
	for _, e := range seriousErrors {
		seriousSet[e] = true
	}

	var criticalErrors []string
	var warnErrors []string
	totalErrorCount := 0.0

	for _, row := range rows {
		name := getString(row, "name")
		times := getFloat(row, "times")
		lastMsg := getString(row, "last_error_message")

		totalErrorCount += times

		labels := map[string]string{"error": name}
		result.AddMetric(client.Name(), "errors.system.count", times, labels)

		// Truncate long messages
		if len(lastMsg) > 150 {
			lastMsg = lastMsg[:150] + "…"
		}
		entry := fmt.Sprintf("  - *%s* (×%.0f): %s", name, times, lastMsg)

		if seriousSet[name] && times >= 5 {
			criticalErrors = append(criticalErrors, entry)
		} else if times >= 10 || seriousSet[name] {
			warnErrors = append(warnErrors, entry)
		}
	}

	result.AddMetric(client.Name(), "errors.system.total_recent", totalErrorCount, nil)

	// Build a CH array literal of serious error names so the playbook can
	// filter exactly what the alert filtered on. COALESCE(value, times) lets
	// the SQL run on both modern (22+) and older CH without a fork.
	seriousArr := "[" + strings.Join(func() []string {
		q := make([]string, 0, len(seriousErrors))
		for _, e := range seriousErrors {
			q = append(q, "'"+e+"'")
		}
		return q
	}(), ",") + "]"

	if len(criticalErrors) > 0 {
		sort.Strings(criticalErrors)
		// Playbook matches the critical filter: name ∈ seriousErrors AND
		// occurrence ≥ 5, in the last hour (same window as alert).
		msg := fmt.Sprintf("*%d serious ClickHouse error type(s)* detected in the last hour:\n%s\n\n"+
			"*Investigate:*\n```\n-- Serious errors flagged by the alert\n"+
			"SELECT name, coalesce(value, times) AS occurrences,\n"+
			"  last_error_time, last_error_message\n"+
			"FROM system.errors\n"+
			"WHERE name IN %s\n"+
			"  AND coalesce(value, times) >= 5\n"+
			"  AND last_error_time > now() - INTERVAL 1 HOUR\n"+
			"ORDER BY occurrences DESC;\n\n"+
			"-- Broader context: all errors in the last hour\n"+
			"SELECT name, coalesce(value, times) AS occurrences,\n"+
			"  last_error_time, last_error_message\n"+
			"FROM system.errors\n"+
			"WHERE last_error_time > now() - INTERVAL 1 HOUR\n"+
			"ORDER BY occurrences DESC LIMIT 20\n```",
			len(criticalErrors), strings.Join(criticalErrors, "\n"), seriousArr)
		result.AddAlert(client.Name(), SeverityCritical, "errors",
			fmt.Sprintf("Serious ClickHouse errors: %d types", len(criticalErrors)),
			msg,
			fmt.Sprintf("%s:errors:system:critical", client.Name()))
	} else if len(warnErrors) > 0 {
		sort.Strings(warnErrors)
		// Warn fires when occurrences ≥ 10 OR name ∈ seriousErrors. Playbook
		// surfaces the same union.
		msg := fmt.Sprintf("*%d ClickHouse error type(s)* have elevated occurrence in the last hour:\n%s\n\n"+
			"*Investigate:*\n```\nSELECT name, coalesce(value, times) AS occurrences,\n"+
			"  last_error_time, last_error_message\n"+
			"FROM system.errors\n"+
			"WHERE last_error_time > now() - INTERVAL 1 HOUR\n"+
			"  AND (coalesce(value, times) >= 10 OR name IN %s)\n"+
			"ORDER BY occurrences DESC\n```",
			len(warnErrors), strings.Join(warnErrors, "\n"), seriousArr)
		result.AddAlert(client.Name(), SeverityWarn, "errors",
			fmt.Sprintf("Repeated ClickHouse errors: %d types", len(warnErrors)),
			msg,
			fmt.Sprintf("%s:errors:system:warn", client.Name()))
	}
}

// collectTextLog scans system.text_log for recent Fatal/Critical log entries.
// These are extremely rare and always indicate serious problems.
func (c *ErrorsCollector) collectTextLog(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := fmt.Sprintf(`
		SELECT
			level,
			message,
			logger_name,
			event_time
		FROM system.text_log
		WHERE level IN ('Fatal', 'Critical')
		  AND %s
		ORDER BY event_time DESC
		LIMIT 10`,
		EventTimeCond(ctx, "event_time", "now() - INTERVAL 10 MINUTE"))

	rows, err := client.Query(ctx, sql)
	if err != nil {
		// text_log may be disabled or unavailable
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") ||
			strings.Contains(err.Error(), "text_log") {
			return
		}
		c.logger().Warn("failed to query system.text_log", slog.String("error", err.Error()))
		return
	}

	if len(rows) == 0 {
		return
	}

	var entries []string
	for _, row := range rows {
		level := getString(row, "level")
		msg := getString(row, "message")
		logger := getString(row, "logger_name")
		ts := getString(row, "event_time")

		if len(msg) > 200 {
			msg = msg[:200] + "…"
		}
		entries = append(entries, fmt.Sprintf("  [%s] *%s* (%s): %s", ts, level, logger, msg))
	}

	severity := SeverityWarn
	for _, row := range rows {
		if getString(row, "level") == "Fatal" {
			severity = SeverityCritical
			break
		}
	}

	// Playbook window matches the alert's 10-minute observation window so the
	// SQL returns the same rows the alert counted, not a superset from the
	// last hour.
	alertMsg := fmt.Sprintf("*%d %s log entr(ies)* in the last 10 minutes:\n%s\n\n"+
		"*Investigate:*\n```\nSELECT event_time, level, logger_name, message\n"+
		"FROM system.text_log\nWHERE level IN ('Fatal', 'Critical')\n"+
		"  AND event_time > now() - INTERVAL 10 MINUTE\nORDER BY event_time DESC\n```",
		len(entries), "Fatal/Critical", strings.Join(entries, "\n"))

	result.AddAlert(client.Name(), severity, "errors",
		fmt.Sprintf("Fatal/Critical log entries: %d in 10 min", len(entries)),
		alertMsg,
		fmt.Sprintf("%s:errors:textlog:fatal", client.Name()))
}

// collectDetachedParts looks for orphaned parts in system.detached_parts.
// Detached parts indicate data that ClickHouse has excluded from tables —
// often after checksums failures, broken merges, or manual DETACH operations.
// They consume disk space and may indicate data integrity issues.
func (c *ErrorsCollector) collectDetachedParts(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT
			database,
			table,
			name,
			reason,
			disk
		FROM system.detached_parts
		WHERE reason NOT IN ('', 'ignored')
		  AND database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')
		LIMIT 50`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") {
			return
		}
		c.logger().Warn("failed to query system.detached_parts", slog.String("error", err.Error()))
		return
	}

	result.AddMetric(client.Name(), "tables.detached_parts.count", float64(len(rows)), nil)

	if len(rows) == 0 {
		return
	}

	// Group by table
	type tableDetach struct {
		count   int
		reasons map[string]bool
	}
	byTable := make(map[string]*tableDetach)

	for _, row := range rows {
		db := getString(row, "database")
		table := getString(row, "table")
		reason := getString(row, "reason")
		fqn := db + "." + table

		if _, ok := byTable[fqn]; !ok {
			byTable[fqn] = &tableDetach{reasons: make(map[string]bool)}
		}
		byTable[fqn].count++
		if reason != "" {
			byTable[fqn].reasons[reason] = true
		}
	}

	var entries []string
	for fqn, td := range byTable {
		var reasons []string
		for r := range td.reasons {
			reasons = append(reasons, r)
		}
		sort.Strings(reasons)
		entries = append(entries, fmt.Sprintf("  - %s: %d part(s) [%s]",
			fqn, td.count, strings.Join(reasons, ", ")))
	}
	sort.Strings(entries)

	severity := SeverityWarn
	if len(rows) > 10 {
		severity = SeverityCritical
	}

	// Playbook mirrors the collector's exact filter (reason NOT IN ('', 'ignored')
	// AND database NOT IN (system/information_schema)) so the SQL returns the
	// same set the alert counted.
	msg := fmt.Sprintf("*%d detached part(s)* found across %d table(s). "+
		"These parts are excluded from queries and may indicate data integrity issues:\n%s\n\n"+
		"*Investigate:*\n```\nSELECT database, table, name, reason, disk\n"+
		"FROM system.detached_parts\n"+
		"WHERE reason NOT IN ('', 'ignored')\n"+
		"  AND database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')\n"+
		"ORDER BY database, table\n```\n"+
		"*Suggestions:*\n"+
		"- `ATTACH PART '<name>' TO TABLE <db>.<table>` to re-attach if safe\n"+
		"- Or remove with: `ALTER TABLE <db>.<table> DROP DETACHED PART '<name>'`\n"+
		"- Check ClickHouse logs around the time parts were detached",
		len(rows), len(byTable), strings.Join(entries, "\n"))

	result.AddAlert(client.Name(), severity, "tables",
		fmt.Sprintf("Detached parts: %d across %d tables", len(rows), len(byTable)),
		msg,
		fmt.Sprintf("%s:tables:detached_parts", client.Name()))
}
