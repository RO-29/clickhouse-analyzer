package web

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

// S3LatencyByTableRow is one row returned by GET /api/instances/{name}/s3-latency-by-table.
type S3LatencyByTableRow struct {
	TableName    string  `json:"table_name"`
	QueryCount   int64   `json:"query_count"`
	AvgLatencyMs float64 `json:"avg_latency_ms"`
	TotalS3Bytes int64   `json:"total_s3_bytes"`
	S3Requests   int64   `json:"s3_requests"`
}

// handleS3LatencyByTable handles GET /api/instances/{name}/s3-latency-by-table?from=<epoch>&to=<epoch>.
// It queries system.query_log on the target ClickHouse instance.
func (s *Server) handleS3LatencyByTable(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	fromStr := r.URL.Query().Get("from")
	toStr := r.URL.Query().Get("to")

	// Default to last 1 hour if not supplied.
	var fromEpoch, toEpoch int64
	if fromStr == "" {
		fromEpoch = time.Now().Add(-1 * time.Hour).Unix()
	} else {
		fromEpoch = parseInt64(fromStr)
	}
	if toStr == "" {
		toEpoch = time.Now().Unix()
	} else {
		toEpoch = parseInt64(toStr)
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	query := fmt.Sprintf(`
SELECT
  tables[1] AS table_name,
  count() AS query_count,
  avg(ProfileEvents['S3ReadMicroseconds']) / 1000 AS avg_latency_ms,
  sum(ProfileEvents['S3ReadBytes']) AS total_s3_bytes,
  sum(ProfileEvents['S3ReadRequestsCount']) AS s3_requests
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time >= toDateTime(%d)
  AND event_time <= toDateTime(%d)
  AND notEmpty(tables)
  AND ProfileEvents['S3ReadMicroseconds'] > 0
GROUP BY table_name
ORDER BY avg_latency_ms DESC
LIMIT 20`, fromEpoch, toEpoch)

	rows, err := client.Query(ctx, query)
	if err != nil {
		slog.Warn("s3 latency by table: query failed", "instance", instance, "err", err)
		writeJSON(w, http.StatusOK, []S3LatencyByTableRow{})
		return
	}

	result := make([]S3LatencyByTableRow, 0, len(rows))
	for _, row := range rows {
		result = append(result, S3LatencyByTableRow{
			TableName:    fmt.Sprintf("%v", row["table_name"]),
			QueryCount:   int64(toFloat64(row["query_count"])),
			AvgLatencyMs: toFloat64(row["avg_latency_ms"]),
			TotalS3Bytes: int64(toFloat64(row["total_s3_bytes"])),
			S3Requests:   int64(toFloat64(row["s3_requests"])),
		})
	}

	writeJSON(w, http.StatusOK, result)
}
