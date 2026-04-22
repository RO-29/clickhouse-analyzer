package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// QuerySamplesCollector periodically copies rows from system.query_log into a
// local ch_analyzer.query_samples table. This gives the dashboard a fast,
// 30-day rolling window of query history without hammering system.query_log on
// every UI request.
//
// Storage design:
//   - One ch_analyzer.query_samples table per monitored CH instance (stored on
//     that instance itself — no cross-instance dependency).
//   - Incremental: each run reads events newer than the previous watermark
//     (max event_time seen so far), so the collector is cheap after warm-up.
//   - TTL 30 days handles retention automatically.
type QuerySamplesCollector struct {
	Logger *slog.Logger

	mu         sync.Mutex
	watermarks map[string]time.Time // instance name → last collected event_time
}

func (c *QuerySamplesCollector) Name() string { return "query_samples" }

func (c *QuerySamplesCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *QuerySamplesCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	// Determine watermark.
	watermark := c.getWatermark(ctx, client)

	// Read new rows from system.query_log.
	rows, err := c.readQueryLog(ctx, client, watermark)
	if err != nil {
		c.logger().Warn("query_samples: failed to read query_log",
			slog.String("instance", client.Name()),
			slog.String("error", err.Error()))
		result.Duration = time.Since(start)
		return result, nil
	}

	if len(rows) == 0 {
		result.Duration = time.Since(start)
		return result, nil
	}

	// Write to ch_analyzer.query_samples.
	inserted, newWatermark, err := c.insertRows(ctx, client, rows)
	if err != nil {
		c.logger().Warn("query_samples: failed to insert rows",
			slog.String("instance", client.Name()),
			slog.String("error", err.Error()))
	} else if inserted > 0 {
		c.setWatermark(client.Name(), newWatermark)
		c.logger().Debug("query_samples: collected",
			slog.String("instance", client.Name()),
			slog.Int("rows", inserted),
			slog.Time("watermark", newWatermark))
	}

	result.Duration = time.Since(start)
	return result, nil
}

// getWatermark returns the high-water mark for incremental collection.
// On first run (no in-memory state) it queries the table; if the table is
// empty it falls back to now-7d.
func (c *QuerySamplesCollector) getWatermark(ctx context.Context, client *chclient.Client) time.Time {
	c.mu.Lock()
	wm, ok := c.watermarks[client.Name()]
	c.mu.Unlock()
	if ok {
		return wm
	}

	// Try to load from table.
	val, err := client.QuerySingleValue(ctx,
		"SELECT max(event_time) FROM ch_analyzer.query_samples FORMAT TabSeparated")
	if err == nil && val != "" && val != "0000-00-00 00:00:00" && val != "1970-01-01 00:00:00" {
		t, parseErr := time.Parse("2006-01-02 15:04:05", val)
		if parseErr == nil && !t.IsZero() {
			c.mu.Lock()
			if c.watermarks == nil {
				c.watermarks = make(map[string]time.Time)
			}
			c.watermarks[client.Name()] = t
			c.mu.Unlock()
			return t
		}
	}

	// First run — collect 7 days of history.
	return time.Now().Add(-7 * 24 * time.Hour)
}

func (c *QuerySamplesCollector) setWatermark(instance string, t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.watermarks == nil {
		c.watermarks = make(map[string]time.Time)
	}
	c.watermarks[instance] = t
}

func (c *QuerySamplesCollector) readQueryLog(ctx context.Context, client *chclient.Client, since time.Time) ([]map[string]interface{}, error) {
	sinceStr := since.Format("2006-01-02 15:04:05")
	// ProfileEvents.Names/Values are parallel arrays. Guard with indexOf > 0
	// because older CH versions may not have UserTimeMicroseconds /
	// SystemTimeMicroseconds entries — indexOf returns 0 when absent.
	sql := fmt.Sprintf(`
		SELECT
			event_time,
			user,
			query_kind,
			normalized_query_hash,
			query AS query_text,
			query_duration_ms,
			memory_usage,
			read_rows,
			read_bytes,
			written_rows,
			written_bytes,
			result_rows,
			result_bytes,
			exception_code,
			if(type = 'ExceptionWhileProcessing', 1, 0) AS is_exception,
			client_name,
			interface,
			databases,
			tables,
			if(indexOf(ProfileEvents.Names, 'UserTimeMicroseconds') > 0,
				arrayElement(ProfileEvents.Values,
					indexOf(ProfileEvents.Names, 'UserTimeMicroseconds')),
				toUInt64(0)) AS cpu_user_us,
			if(indexOf(ProfileEvents.Names, 'SystemTimeMicroseconds') > 0,
				arrayElement(ProfileEvents.Values,
					indexOf(ProfileEvents.Names, 'SystemTimeMicroseconds')),
				toUInt64(0)) AS cpu_system_us,
			initial_address,
			toUInt8(interface) AS interface_code,
			ifNull(http_user_agent, '') AS http_user_agent,
			ifNull(forwarded_for, '') AS forwarded_for
		FROM system.query_log
		WHERE event_time > '%s'
		  AND is_initial_query = 1
		  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
		  AND (length(databases) = 0 OR NOT has(databases, 'ch_analyzer'))
		ORDER BY event_time ASC
		LIMIT 10000`, sinceStr)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") ||
			strings.Contains(err.Error(), "UNKNOWN_COLUMN") {
			return nil, nil // older CH, skip gracefully
		}
		return nil, err
	}
	return rows, nil
}

func (c *QuerySamplesCollector) insertRows(ctx context.Context, client *chclient.Client, rows []map[string]interface{}) (int, time.Time, error) {
	const batchSize = 1000
	var maxTime time.Time
	inserted := 0

	for start := 0; start < len(rows); start += batchSize {
		end := start + batchSize
		if end > len(rows) {
			end = len(rows)
		}
		batch := rows[start:end]

		var sb strings.Builder
		sb.WriteString(`INSERT INTO ch_analyzer.query_samples
			(event_time, user, query_kind, normalized_query_hash, query_text,
			 query_duration_ms, memory_usage, read_rows, read_bytes,
			 written_rows, written_bytes, result_rows, result_bytes,
			 exception_code, is_exception, client_name, interface,
			 databases, tables, cpu_user_us, cpu_system_us,
			 initial_address, interface_code, http_user_agent, forwarded_for) VALUES `)

		for i, row := range batch {
			if i > 0 {
				sb.WriteString(", ")
			}

			evtTime := toString(row["event_time"])
			t, err := time.Parse("2006-01-02 15:04:05", evtTime)
			if err == nil && t.After(maxTime) {
				maxTime = t
			}

			sb.WriteString(fmt.Sprintf("('%s','%s','%s',%s,'%s',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'%s','%s',%s,%s,%s,%s,'%s',%s,'%s','%s')",
				sqlEscape(evtTime),
				sqlEscape(toString(row["user"])),
				sqlEscape(toString(row["query_kind"])),
				safeUInt64(row["normalized_query_hash"]),
				sqlEscape(toString(row["query_text"])),
				safeUInt64(row["query_duration_ms"]),
				safeUInt64(row["memory_usage"]),
				safeUInt64(row["read_rows"]),
				safeUInt64(row["read_bytes"]),
				safeUInt64(row["written_rows"]),
				safeUInt64(row["written_bytes"]),
				safeUInt64(row["result_rows"]),
				safeUInt64(row["result_bytes"]),
				safeInt32(row["exception_code"]),
				safeUInt8(row["is_exception"]),
				sqlEscape(toString(row["client_name"])),
				sqlEscape(toString(row["interface"])),
				safeStringArray(row["databases"]),
				safeStringArray(row["tables"]),
				safeUInt64(row["cpu_user_us"]),
				safeUInt64(row["cpu_system_us"]),
				sqlEscape(toString(row["initial_address"])),
				safeUInt8(row["interface_code"]),
				sqlEscape(toString(row["http_user_agent"])),
				sqlEscape(toString(row["forwarded_for"])),
			))
		}

		if _, err := client.QuerySingleValue(ctx, sb.String()); err != nil {
			return inserted, maxTime, err
		}
		inserted += len(batch)
	}

	return inserted, maxTime, nil
}

// ── SQL value helpers ──────────────────────────────────────────────────────

func sqlEscape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `'`, `\'`)
	return s
}

func safeUInt64(v interface{}) string {
	f := mustFloat64(v)
	if f < 0 {
		f = 0
	}
	return fmt.Sprintf("%.0f", f)
}

func safeInt32(v interface{}) string {
	f := mustFloat64(v)
	return fmt.Sprintf("%.0f", f)
}

func safeUInt8(v interface{}) string {
	f := mustFloat64(v)
	if f < 0 {
		f = 0
	}
	if f > 1 {
		f = 1
	}
	return fmt.Sprintf("%.0f", f)
}

// safeStringArray formats an Array(String) value from a ClickHouse JSON
// response (typically []interface{} of strings) as a CH array literal
// suitable for inclusion in an INSERT VALUES clause. A nil or empty
// array produces "[]". Individual strings are SQL-escaped.
func safeStringArray(v interface{}) string {
	if v == nil {
		return "[]"
	}
	items, ok := v.([]interface{})
	if !ok {
		return "[]"
	}
	if len(items) == 0 {
		return "[]"
	}
	parts := make([]string, 0, len(items))
	for _, it := range items {
		s, ok := it.(string)
		if !ok {
			s = toString(it)
		}
		parts = append(parts, "'"+sqlEscape(s)+"'")
	}
	return "[" + strings.Join(parts, ",") + "]"
}
