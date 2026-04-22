package web

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// ---------------------------------------------------------------------------
// Time-range helpers
// ---------------------------------------------------------------------------

func parseFromTo(r *http.Request) (string, string) {
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if from == "" {
		from = fmt.Sprintf("%d", time.Now().Add(-1*time.Hour).Unix())
	}
	if to == "" {
		to = fmt.Sprintf("%d", time.Now().Unix())
	}
	fromTime := time.Unix(parseInt64(from), 0).Format("2006-01-02 15:04:05")
	toTime := time.Unix(parseInt64(to), 0).Format("2006-01-02 15:04:05")
	return fromTime, toTime
}

func parseInt64(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

// bucketSeconds computes a reasonable bucket width for the given request's
// from/to range. It aims for ~120 data points with a minimum bucket of 60s.
func bucketSeconds(r *http.Request) int64 {
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	var f, t int64
	if from != "" {
		f = parseInt64(from)
	} else {
		f = time.Now().Add(-1 * time.Hour).Unix()
	}
	if to != "" {
		t = parseInt64(to)
	} else {
		t = time.Now().Unix()
	}
	bucket := (t - f) / 120
	if bucket < 60 {
		bucket = 60
	}
	return bucket
}

// ---------------------------------------------------------------------------
// 1. Health Check
// ---------------------------------------------------------------------------

type healthCheckResult struct {
	ID        string `json:"id"`
	Category  string `json:"category"`
	Name      string `json:"name"`
	Status    string `json:"status"`
	Value     string `json:"value"`
	Threshold string `json:"threshold"`
	Detail    string `json:"detail"`
}

func (s *Server) handleHealthCheck(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	var checks []healthCheckResult

	// --- Memory ---
	rows, err := client.Query(ctx, `SELECT metric, value FROM system.asynchronous_metrics WHERE metric IN ('OSMemoryTotal','OSMemoryAvailable','OSProcessRSSMemory','MemoryResident','CGroupMemoryTotal','CGroupMemoryUsed')`)
	if err == nil {
		metrics := make(map[string]float64)
		for _, row := range rows {
			if m, ok := row["metric"].(string); ok {
				metrics[m] = toFloat64(row["value"])
			}
		}
		total := metrics["OSMemoryTotal"]
		avail := metrics["OSMemoryAvailable"]
		rss := metrics["MemoryResident"]
		if rss == 0 {
			rss = metrics["OSProcessRSSMemory"]
		}

		if total > 0 {
			usedPct := (total - avail) / total * 100
			status := "ok"
			if usedPct > 90 {
				status = "critical"
			} else if usedPct > 80 {
				status = "warn"
			}
			checks = append(checks, healthCheckResult{
				ID:        "memory_used",
				Category:  "memory",
				Name:      "OS Memory Usage",
				Status:    status,
				Value:     fmt.Sprintf("%.1f%%", usedPct),
				Threshold: "80%/90%",
				Detail:    fmt.Sprintf("Available: %s / Total: %s", formatBytes(avail), formatBytes(total)),
			})

			rssPct := rss / total * 100
			rssStatus := "ok"
			if rssPct > 95 {
				rssStatus = "critical"
			} else if rssPct > 85 {
				rssStatus = "warn"
			}
			checks = append(checks, healthCheckResult{
				ID:        "rss",
				Category:  "memory",
				Name:      "RSS Memory",
				Status:    rssStatus,
				Value:     fmt.Sprintf("%.1f%%", rssPct),
				Threshold: "85%/95%",
				Detail:    fmt.Sprintf("RSS: %s / Total: %s", formatBytes(rss), formatBytes(total)),
			})
		}
	}

	// --- CPU ---
	rows, err = client.Query(ctx, `SELECT metric, value FROM system.asynchronous_metrics WHERE metric IN ('OSUserTimeCPU','OSSystemTimeCPU','OSIdleTimeCPU','CGroupMaxCPU','LoadAverage1','LoadAverage5','LoadAverage15')`)
	if err == nil {
		metrics := make(map[string]float64)
		for _, row := range rows {
			if m, ok := row["metric"].(string); ok {
				metrics[m] = toFloat64(row["value"])
			}
		}
		// Strategy 1: OSS CH
		user := metrics["OSUserTimeCPU"]
		system := metrics["OSSystemTimeCPU"]
		idle := metrics["OSIdleTimeCPU"]
		totalCPU := user + system + idle

		var usedPct float64
		var cpuDetail string
		if totalCPU > 1.0 && idle > 0 {
			usedPct = (user + system) / totalCPU * 100
			cpuDetail = fmt.Sprintf("User: %.1f%%, System: %.1f%%, Idle: %.1f%%", user/totalCPU*100, system/totalCPU*100, idle/totalCPU*100)
		} else {
			// Strategy 2: Altinity — LoadAverage / CGroupMaxCPU
			maxCPU := metrics["CGroupMaxCPU"]
			load1 := metrics["LoadAverage1"]
			if maxCPU > 0 {
				usedPct = (load1 / maxCPU) * 100
				if usedPct > 100 {
					usedPct = 100
				}
				cpuDetail = fmt.Sprintf("Load1: %.1f, Load5: %.1f, Load15: %.1f, Cores: %.0f", load1, metrics["LoadAverage5"], metrics["LoadAverage15"], maxCPU)
			}
		}

		if usedPct > 0 || totalCPU > 0 {
			status := "ok"
			if usedPct > 95 {
				status = "critical"
			} else if usedPct > 80 {
				status = "warn"
			}
			checks = append(checks, healthCheckResult{
				ID:        "cpu",
				Category:  "cpu",
				Name:      "CPU Usage",
				Status:    status,
				Value:     fmt.Sprintf("%.1f%%", usedPct),
				Threshold: "80%/95%",
				Detail:    cpuDetail,
			})
		}
	}

	// --- Load Average ---
	rows, err = client.Query(ctx, `SELECT value FROM system.asynchronous_metrics WHERE metric = 'LoadAverage1'`)
	if err == nil && len(rows) > 0 {
		load := toFloat64(rows[0]["value"])
		status := "ok"
		if load > 16 {
			status = "critical"
		} else if load > 8 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "load",
			Category:  "cpu",
			Name:      "Load Average (1m)",
			Status:    status,
			Value:     fmt.Sprintf("%.2f", load),
			Threshold: "8/16",
			Detail:    fmt.Sprintf("1-minute load average: %.2f", load),
		})
	}

	// --- Running Queries ---
	rows, err = client.Query(ctx, `SELECT count() as cnt FROM system.processes`)
	if err == nil && len(rows) > 0 {
		cnt := toFloat64(rows[0]["cnt"])
		status := "ok"
		if cnt > 100 {
			status = "critical"
		} else if cnt > 50 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "running_queries",
			Category:  "queries",
			Name:      "Running Queries",
			Status:    status,
			Value:     fmt.Sprintf("%.0f", cnt),
			Threshold: "50/100",
			Detail:    fmt.Sprintf("Currently executing queries: %.0f", cnt),
		})
	}

	// --- Long Running Queries ---
	rows, err = client.Query(ctx, `SELECT count() as cnt FROM system.processes WHERE elapsed > 60`)
	if err == nil && len(rows) > 0 {
		cnt := toFloat64(rows[0]["cnt"])
		status := "ok"
		if cnt > 5 {
			status = "critical"
		} else if cnt > 2 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "long_running",
			Category:  "queries",
			Name:      "Long Running Queries (>60s)",
			Status:    status,
			Value:     fmt.Sprintf("%.0f", cnt),
			Threshold: "2/5",
			Detail:    fmt.Sprintf("Queries running longer than 60 seconds: %.0f", cnt),
		})
	}

	// --- Failed Queries (5m) ---
	rows, err = client.Query(ctx, `SELECT count() as cnt FROM system.query_log WHERE type='ExceptionWhileProcessing' AND event_time >= now() - INTERVAL 5 MINUTE`)
	if err == nil && len(rows) > 0 {
		cnt := toFloat64(rows[0]["cnt"])
		status := "ok"
		if cnt > 50 {
			status = "critical"
		} else if cnt > 10 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "failed_queries",
			Category:  "queries",
			Name:      "Failed Queries (5m)",
			Status:    status,
			Value:     fmt.Sprintf("%.0f", cnt),
			Threshold: "10/50",
			Detail:    fmt.Sprintf("Queries with exceptions in last 5 minutes: %.0f", cnt),
		})
	}

	// --- Parts per Table ---
	rows, err = client.Query(ctx, `SELECT database, table, count() as parts FROM system.parts WHERE active GROUP BY database, table HAVING parts > 1000 ORDER BY parts DESC`)
	if err == nil {
		status := "ok"
		detail := "All tables under 1000 active parts"
		if len(rows) > 0 {
			maxParts := toFloat64(rows[0]["parts"])
			db := fmt.Sprintf("%v", rows[0]["database"])
			tbl := fmt.Sprintf("%v", rows[0]["table"])
			if maxParts > 3000 {
				status = "critical"
			} else {
				status = "warn"
			}
			detail = fmt.Sprintf("Worst: %s.%s with %.0f parts (%d tables over 1000)", db, tbl, maxParts, len(rows))
		}
		checks = append(checks, healthCheckResult{
			ID:        "parts",
			Category:  "storage",
			Name:      "Parts per Table",
			Status:    status,
			Value:     fmt.Sprintf("%d tables >1000", len(rows)),
			Threshold: "1000/3000",
			Detail:    detail,
		})
	}

	// --- Active Merges ---
	rows, err = client.Query(ctx, `SELECT count() as cnt FROM system.merges WHERE NOT is_mutation`)
	if err == nil && len(rows) > 0 {
		cnt := toFloat64(rows[0]["cnt"])
		status := "ok"
		if cnt > 50 {
			status = "critical"
		} else if cnt > 20 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "active_merges",
			Category:  "storage",
			Name:      "Active Merges",
			Status:    status,
			Value:     fmt.Sprintf("%.0f", cnt),
			Threshold: "20/50",
			Detail:    fmt.Sprintf("Background merge operations in progress: %.0f", cnt),
		})
	}

	// --- Stuck Mutations ---
	rows, err = client.Query(ctx, `SELECT count() as cnt FROM system.mutations WHERE NOT is_done AND create_time < now() - INTERVAL 30 MINUTE`)
	if err == nil && len(rows) > 0 {
		cnt := toFloat64(rows[0]["cnt"])
		status := "ok"
		if cnt > 3 {
			status = "critical"
		} else if cnt > 0 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "stuck_mutations",
			Category:  "storage",
			Name:      "Stuck Mutations (>30m)",
			Status:    status,
			Value:     fmt.Sprintf("%.0f", cnt),
			Threshold: "0/3",
			Detail:    fmt.Sprintf("Mutations not completed after 30 minutes: %.0f", cnt),
		})
	}

	// --- Disk Usage ---
	rows, err = client.Query(ctx, `SELECT name, round((total_space-free_space)*100.0/total_space, 1) as used_pct FROM system.disks WHERE total_space > 0`)
	if err == nil {
		worstPct := 0.0
		worstName := ""
		for _, row := range rows {
			pct := toFloat64(row["used_pct"])
			if pct > worstPct {
				worstPct = pct
				worstName = fmt.Sprintf("%v", row["name"])
			}
		}
		status := "ok"
		if worstPct > 90 {
			status = "critical"
		} else if worstPct > 80 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "disk_usage",
			Category:  "storage",
			Name:      "Disk Usage",
			Status:    status,
			Value:     fmt.Sprintf("%.1f%%", worstPct),
			Threshold: "80%/90%",
			Detail:    fmt.Sprintf("Highest usage disk '%s' at %.1f%% (%d disk(s) total)", worstName, worstPct, len(rows)),
		})
	}

	// --- Dictionary Status ---
	rows, err = client.Query(ctx, `SELECT name, status FROM system.dictionaries`)
	if err == nil {
		failedCount := 0
		var failedNames []string
		for _, row := range rows {
			st := fmt.Sprintf("%v", row["status"])
			if st != "LOADED" && st != "NOT_LOADED" {
				failedCount++
				failedNames = append(failedNames, fmt.Sprintf("%v", row["name"]))
			}
		}
		status := "ok"
		detail := fmt.Sprintf("All %d dictionaries healthy", len(rows))
		if failedCount > 0 {
			status = "warn"
			detail = fmt.Sprintf("Failed dictionaries: %s", strings.Join(failedNames, ", "))
		}
		checks = append(checks, healthCheckResult{
			ID:        "dictionaries",
			Category:  "system",
			Name:      "Dictionary Status",
			Status:    status,
			Value:     fmt.Sprintf("%d/%d ok", len(rows)-failedCount, len(rows)),
			Threshold: "all loaded",
			Detail:    detail,
		})
	}

	// --- S3 Latency ---
	rows, err = client.Query(ctx, `SELECT avg(ProfileEvents['S3ReadMicroseconds']/nullIf(ProfileEvents['S3ReadRequestsCount'],0))/1000 as avg_ms FROM system.query_log WHERE type='QueryFinish' AND ProfileEvents['S3ReadRequestsCount'] > 0 AND event_time >= now() - INTERVAL 5 MINUTE`)
	if err == nil && len(rows) > 0 {
		avgMs := toFloat64(rows[0]["avg_ms"])
		status := "ok"
		if avgMs > 200 {
			status = "critical"
		} else if avgMs > 100 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "s3_latency",
			Category:  "s3",
			Name:      "S3 Read Latency (5m avg)",
			Status:    status,
			Value:     fmt.Sprintf("%.1fms", avgMs),
			Threshold: "100ms/200ms",
			Detail:    fmt.Sprintf("Average S3 read latency per request: %.1fms", avgMs),
		})
	}

	// --- Query Storms ---
	rows, err = client.Query(ctx, `SELECT user, count() as cnt FROM system.processes GROUP BY user HAVING cnt > 25`)
	if err == nil {
		status := "ok"
		detail := "No users with >25 concurrent queries"
		if len(rows) > 0 {
			status = "warn"
			var parts []string
			for _, row := range rows {
				parts = append(parts, fmt.Sprintf("%v: %.0f", row["user"], toFloat64(row["cnt"])))
			}
			detail = fmt.Sprintf("Users with >25 queries: %s", strings.Join(parts, ", "))
			for _, row := range rows {
				if toFloat64(row["cnt"]) > 100 {
					status = "critical"
					break
				}
			}
		}
		checks = append(checks, healthCheckResult{
			ID:        "query_storms",
			Category:  "queries",
			Name:      "Query Storms",
			Status:    status,
			Value:     fmt.Sprintf("%d users", len(rows)),
			Threshold: "25/100 per user",
			Detail:    detail,
		})
	}

	// --- Uptime ---
	rows, err = client.Query(ctx, `SELECT uptime() as uptime`)
	if err == nil && len(rows) > 0 {
		uptimeSec := toFloat64(rows[0]["uptime"])
		status := "ok"
		if uptimeSec < 300 {
			status = "warn"
		}
		checks = append(checks, healthCheckResult{
			ID:        "uptime",
			Category:  "system",
			Name:      "Uptime",
			Status:    status,
			Value:     formatDuration(uptimeSec),
			Threshold: ">5m",
			Detail:    fmt.Sprintf("Server uptime: %s (%.0f seconds)", formatDuration(uptimeSec), uptimeSec),
		})
	}

	writeJSON(w, http.StatusOK, checks)
}

// ---------------------------------------------------------------------------
// 2. Query Patterns
// ---------------------------------------------------------------------------

func (s *Server) handleQueryPatterns(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	fromTime, toTime := parseFromTo(r)
	limit := parseIntParam(r, "limit", 50)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`SELECT
		normalized_query_hash,
		count() as cnt,
		any(query_kind) as kind,
		avg(query_duration_ms) as avg_ms,
		max(query_duration_ms) as max_ms,
		quantile(0.95)(query_duration_ms) as p95_ms,
		avg(read_rows) as avg_read_rows,
		max(read_rows) as max_read_rows,
		avg(written_rows) as avg_written_rows,
		avg(memory_usage) as avg_memory,
		max(memory_usage) as max_memory,
		any(user) as user,
		any(client_name) as client,
		countIf(type = 'ExceptionWhileProcessing') as failures,
		substring(any(query), 1, 300) as sample_query
	FROM system.query_log
	WHERE event_time >= '%s' AND event_time <= '%s'
	  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
	GROUP BY normalized_query_hash
	ORDER BY cnt DESC
	LIMIT %d`, fromTime, toTime, limit)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		slog.Error("query patterns", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query patterns")
		return
	}

	writeJSON(w, http.StatusOK, rows)
}

// ---------------------------------------------------------------------------
// 3. Query Pattern Timeline
// ---------------------------------------------------------------------------

func (s *Server) handleQueryPatternTimeline(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	hash := r.URL.Query().Get("hash")
	if hash == "" {
		writeErr(w, http.StatusBadRequest, "query parameter 'hash' is required")
		return
	}

	fromTime, toTime := parseFromTo(r)
	bucket := bucketSeconds(r)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	// Rich timeline — try ch_analyzer.query_samples first (has is_exception column).
	samplesSQL := fmt.Sprintf(`SELECT
		toStartOfInterval(event_time, INTERVAL %d SECOND) as ts,
		count() as cnt,
		avg(query_duration_ms) as avg_ms,
		quantile(0.95)(query_duration_ms) as p95_ms,
		max(query_duration_ms) as max_ms,
		avg(memory_usage) as avg_memory,
		max(memory_usage) as max_memory,
		countIf(is_exception = 1) as failures,
		avg(read_bytes) as avg_read_bytes
	FROM ch_analyzer.query_samples
	WHERE normalized_query_hash = %s
	  AND event_time >= '%s' AND event_time <= '%s'
	GROUP BY ts ORDER BY ts`, bucket, sqlSafeUInt(hash), fromTime, toTime)

	rows, err := client.Query(ctx, samplesSQL)
	if err != nil || len(rows) == 0 {
		// Fall back to system.query_log.
		rows, err = client.Query(ctx, fmt.Sprintf(`SELECT
			toStartOfInterval(event_time, INTERVAL %d SECOND) as ts,
			count() as cnt,
			avg(query_duration_ms) as avg_ms,
			quantile(0.95)(query_duration_ms) as p95_ms,
			max(query_duration_ms) as max_ms,
			avg(memory_usage) as avg_memory,
			max(memory_usage) as max_memory,
			countIf(type = 'ExceptionWhileProcessing') as failures,
			avg(read_bytes) as avg_read_bytes
		FROM system.query_log
		WHERE normalized_query_hash = %s
		  AND event_time >= '%s' AND event_time <= '%s'
		  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
		GROUP BY ts ORDER BY ts`, bucket, sqlSafeUInt(hash), fromTime, toTime))
		if err != nil {
			slog.Error("query pattern timeline", "err", err, "instance", instance)
			writeErr(w, http.StatusInternalServerError, "failed to query pattern timeline")
			return
		}
	}

	// Always enrich with ProfileEvents from system.query_log — mark cache, S3, CPU, read rows.
	profileSQL := fmt.Sprintf(`SELECT
		toStartOfInterval(event_time, INTERVAL %d SECOND) as ts,
		avg(read_rows) as avg_read_rows,
		avg(written_rows) as avg_written_rows,
		avg(ProfileEvents['UserTimeMicroseconds'] + ProfileEvents['SystemTimeMicroseconds']) / 1000 as avg_cpu_ms,
		avgIf(
			ProfileEvents['MarkCacheHits'] * 100.0 / (ProfileEvents['MarkCacheHits'] + ProfileEvents['MarkCacheMisses']),
			ProfileEvents['MarkCacheHits'] + ProfileEvents['MarkCacheMisses'] > 0
		) as avg_mark_cache_hit_pct,
		avg(ProfileEvents['S3ReadRequestsCount']) as avg_s3_requests,
		avgIf(
			ProfileEvents['S3ReadMicroseconds'] / ProfileEvents['S3ReadRequestsCount'] / 1000,
			ProfileEvents['S3ReadRequestsCount'] > 0
		) as avg_s3_latency_ms
	FROM system.query_log
	WHERE normalized_query_hash = %s
	  AND event_time >= '%s' AND event_time <= '%s'
	  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
	GROUP BY ts ORDER BY ts`, bucket, sqlSafeUInt(hash), fromTime, toTime)

	profileRows, profileErr := client.Query(ctx, profileSQL)
	if profileErr == nil && len(profileRows) > 0 {
		// Index profile rows by ts string for merge.
		profMap := make(map[string]map[string]interface{}, len(profileRows))
		for _, pr := range profileRows {
			if ts, ok := pr["ts"]; ok {
				profMap[fmt.Sprintf("%v", ts)] = pr
			}
		}
		// Merge into main rows.
		for _, row := range rows {
			tsKey := fmt.Sprintf("%v", row["ts"])
			if pr, ok := profMap[tsKey]; ok {
				for _, k := range []string{"avg_read_rows", "avg_written_rows", "avg_cpu_ms",
					"avg_mark_cache_hit_pct", "avg_s3_requests", "avg_s3_latency_ms"} {
					if v, exists := pr[k]; exists {
						row[k] = v
					}
				}
			}
		}
	}

	writeJSON(w, http.StatusOK, rows)
}

// ---------------------------------------------------------------------------
// 4. History: Failures
// ---------------------------------------------------------------------------

func (s *Server) handleHistoryFailures(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	fromTime, toTime := parseFromTo(r)
	bucket := bucketSeconds(r)
	hash := r.URL.Query().Get("hash") // optional: filter by normalized_query_hash

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	hashFilter := ""
	if hash != "" {
		// normalized_query_hash is UInt64 — use numeric literal, not a quoted string.
		hashFilter = fmt.Sprintf(" AND normalized_query_hash = %s", sqlSafeUInt(hash))
	}

	// Time-series bucketed failures (for chart)
	tsSql := fmt.Sprintf(`SELECT
		toStartOfInterval(event_time, INTERVAL %d SECOND) as ts,
		count() as cnt,
		exception_code,
		any(exception) as sample
	FROM system.query_log
	WHERE type = 'ExceptionWhileProcessing'
	  AND event_time >= '%s' AND event_time <= '%s'%s
	GROUP BY ts, exception_code
	ORDER BY ts`, bucket, fromTime, toTime, hashFilter)

	rows, err := client.Query(ctx, tsSql)
	if err != nil {
		slog.Error("history failures", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query failure history")
		return
	}

	// Also fetch distinct messages per exception code (up to 5 per code) for display.
	msgSql := fmt.Sprintf(`SELECT
		exception_code,
		count() as cnt,
		topK(5)(exception) as messages,
		any(query) as sample_query,
		any(user) as sample_user
	FROM system.query_log
	WHERE type = 'ExceptionWhileProcessing'
	  AND event_time >= '%s' AND event_time <= '%s'%s
	GROUP BY exception_code
	ORDER BY cnt DESC`, fromTime, toTime, hashFilter)

	msgRows, _ := client.Query(ctx, msgSql) // best-effort

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"timeline":  rows,
		"by_code":   msgRows,
	})
}

// ---------------------------------------------------------------------------
// 5. History: Merges
// ---------------------------------------------------------------------------

func (s *Server) handleHistoryMerges(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	fromTime, toTime := parseFromTo(r)
	bucket := bucketSeconds(r)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`SELECT
		toStartOfInterval(event_time, INTERVAL %d SECOND) as ts,
		countIf(event_type = 'MergeParts') as merge_count,
		countIf(event_type = 'NewPart') as new_part_count,
		countIf(event_type = 'RemovePart') as remove_count,
		countIf(event_type = 'MovePart') as move_count,
		avgIf(duration_ms, event_type = 'MergeParts') as avg_merge_ms,
		sumIf(rows, event_type = 'MergeParts') as merged_rows,
		sumIf(size_in_bytes, event_type = 'MergeParts') as merged_bytes
	FROM system.part_log
	WHERE event_time >= '%s' AND event_time <= '%s'
	GROUP BY ts ORDER BY ts`, bucket, fromTime, toTime)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		slog.Error("history merges", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query merge history")
		return
	}

	writeJSON(w, http.StatusOK, rows)
}

// ---------------------------------------------------------------------------
// 6. History: Materialized Views
// ---------------------------------------------------------------------------

func (s *Server) handleHistoryMVs(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	fromTime, toTime := parseFromTo(r)
	bucket := bucketSeconds(r)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`SELECT
		view_name,
		toStartOfInterval(event_time, INTERVAL %d SECOND) as ts,
		count() as cnt,
		avg(view_duration_ms) as avg_ms,
		max(view_duration_ms) as max_ms,
		countIf(status != 'QueryFinish') as failures
	FROM system.query_views_log
	WHERE event_time >= '%s' AND event_time <= '%s'
	GROUP BY view_name, ts
	ORDER BY view_name, ts`, bucket, fromTime, toTime)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		slog.Error("history MVs", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query MV history")
		return
	}

	writeJSON(w, http.StatusOK, rows)
}

// ---------------------------------------------------------------------------
// 7. History: Inserts
// ---------------------------------------------------------------------------

func (s *Server) handleHistoryInserts(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	fromTime, toTime := parseFromTo(r)
	bucket := bucketSeconds(r)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`SELECT
		toStartOfInterval(event_time, INTERVAL %d SECOND) as ts,
		databases[1] as database,
		tables[1] as table,
		count() as insert_count,
		sum(written_rows) as total_rows,
		sum(written_bytes) as total_bytes,
		countIf(written_rows < 100) as small_insert_count
	FROM system.query_log
	WHERE type = 'QueryFinish' AND query_kind = 'Insert'
	  AND length(databases) >= 1 AND databases[1] != 'ch_analyzer'
	  AND event_time >= '%s' AND event_time <= '%s'
	GROUP BY ts, database, table
	ORDER BY ts, total_rows DESC`, bucket, fromTime, toTime)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		slog.Error("history inserts", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query insert history")
		return
	}

	writeJSON(w, http.StatusOK, rows)
}

// ---------------------------------------------------------------------------
// 8. History: S3
// ---------------------------------------------------------------------------

func (s *Server) handleHistoryS3(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	fromTime, toTime := parseFromTo(r)
	bucket := bucketSeconds(r)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`SELECT
		toStartOfInterval(event_time, INTERVAL %d SECOND) as ts,
		count() as query_count,
		sum(ProfileEvents['S3ReadRequestsCount']) as total_s3_requests,
		sum(ProfileEvents['S3ReadMicroseconds']) as total_s3_us,
		avg(ProfileEvents['S3ReadMicroseconds'] / nullIf(ProfileEvents['S3ReadRequestsCount'], 0)) / 1000 as avg_latency_ms
	FROM system.query_log
	WHERE type = 'QueryFinish'
	  AND ProfileEvents['S3ReadRequestsCount'] > 0
	  AND event_time >= '%s' AND event_time <= '%s'
	GROUP BY ts ORDER BY ts`, bucket, fromTime, toTime)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		slog.Error("history s3", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query S3 history")
		return
	}

	writeJSON(w, http.StatusOK, rows)
}

// ---------------------------------------------------------------------------
// 9. History: Async Metrics
// ---------------------------------------------------------------------------

func (s *Server) handleHistoryAsyncMetrics(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	metricsParam := r.URL.Query().Get("metrics")
	if metricsParam == "" {
		writeErr(w, http.StatusBadRequest, "query parameter 'metrics' is required")
		return
	}

	// Build a quoted, comma-separated list for the IN clause.
	metricNames := strings.Split(metricsParam, ",")
	quoted := make([]string, 0, len(metricNames))
	for _, m := range metricNames {
		m = strings.TrimSpace(m)
		if m != "" {
			quoted = append(quoted, fmt.Sprintf("'%s'", sqlSafeStr(m)))
		}
	}
	if len(quoted) == 0 {
		writeErr(w, http.StatusBadRequest, "no valid metric names provided")
		return
	}
	metricsList := strings.Join(quoted, ",")

	fromTime, toTime := parseFromTo(r)
	bucket := bucketSeconds(r)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`SELECT
		toStartOfInterval(event_time, INTERVAL %d SECOND) as ts,
		metric,
		avg(value) as avg_value,
		max(value) as max_value
	FROM system.asynchronous_metric_log
	WHERE metric IN (%s)
	  AND event_time >= '%s' AND event_time <= '%s'
	GROUP BY ts, metric
	ORDER BY ts, metric`, bucket, metricsList, fromTime, toTime)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		slog.Error("history async metrics", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query async metric history")
		return
	}

	writeJSON(w, http.StatusOK, rows)
}

// ---------------------------------------------------------------------------
// 10. History: Disk I/O
// ---------------------------------------------------------------------------

func (s *Server) handleHistoryDiskIO(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	fromTime, toTime := parseFromTo(r)
	bucket := bucketSeconds(r)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`SELECT
		toStartOfInterval(event_time, INTERVAL %d SECOND) as ts,
		metric,
		avg(value) as avg_value
	FROM system.asynchronous_metric_log
	WHERE (metric LIKE 'BlockReadBytes_%%' OR metric LIKE 'BlockWriteBytes_%%')
	  AND event_time >= '%s' AND event_time <= '%s'
	GROUP BY ts, metric
	ORDER BY ts, metric`, bucket, fromTime, toTime)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		slog.Error("history disk io", "err", err, "instance", instance)
		writeErr(w, http.StatusInternalServerError, "failed to query disk I/O history")
		return
	}

	writeJSON(w, http.StatusOK, rows)
}

// ---------------------------------------------------------------------------
// 11. Query Samples (individual executions)
// ---------------------------------------------------------------------------

func (s *Server) handleQuerySamples(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	fromTime, toTime := parseFromTo(r)
	limit := parseIntParam(r, "limit", 100)
	offset := parseIntParam(r, "offset", 0)             // pagination for Query Log
	hash := r.URL.Query().Get("hash")                   // filter by normalized_query_hash
	user := r.URL.Query().Get("user")                   // filter by user
	kind := r.URL.Query().Get("kind")                   // filter by query_kind
	minMs := r.URL.Query().Get("min_ms")                // filter by min duration
	table := r.URL.Query().Get("table")                 // filter: has(tables, table)
	textSearch := r.URL.Query().Get("q")                // ILIKE substring match on query text
	errorsOnly := r.URL.Query().Get("errors_only") == "1"

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	// Try ch_analyzer.query_samples first (fast).
	samples, err := s.queryFromSamples(ctx, client, fromTime, toTime, hash, user, kind, minMs, table, textSearch, errorsOnly, limit, offset)
	if err != nil || len(samples) == 0 {
		// Fall back to system.query_log.
		samples, err = s.queryFromQueryLog(ctx, client, fromTime, toTime, hash, user, kind, minMs, table, textSearch, errorsOnly, limit, offset)
		if err != nil {
			slog.Warn("query samples fallback failed", "err", err, "instance", instance)
			writeJSON(w, http.StatusOK, []map[string]interface{}{})
			return
		}
	}

	stringifyHashes(samples)
	writeJSON(w, http.StatusOK, samples)
}

func (s *Server) queryFromSamples(ctx context.Context, client *chclient.Client,
	fromTime, toTime, hash, user, kind, minMs, table, textSearch string, errorsOnly bool, limit, offset int) ([]map[string]interface{}, error) {

	// Check table exists first.
	rows, err := client.Query(ctx, "SELECT count() as cnt FROM ch_analyzer.query_samples LIMIT 1")
	if err != nil || len(rows) == 0 {
		return nil, err
	}

	var filters []string
	filters = append(filters,
		fmt.Sprintf("event_time >= '%s' AND event_time <= '%s'", fromTime, toTime))
	if hash != "" {
		filters = append(filters, fmt.Sprintf("normalized_query_hash = %s", sqlSafeUInt(hash)))
	}
	if user != "" {
		filters = append(filters, fmt.Sprintf("user = '%s'", sqlSafeStr(user)))
	}
	if kind != "" {
		filters = append(filters, fmt.Sprintf("query_kind = '%s'", sqlSafeStr(kind)))
	}
	if minMs != "" {
		filters = append(filters, fmt.Sprintf("query_duration_ms >= %s", sqlSafeUInt(minMs)))
	}
	if table != "" {
		filters = append(filters, fmt.Sprintf("has(tables, '%s')", sqlSafeStr(table)))
	}
	if textSearch != "" {
		// ILIKE + % wildcards for simple case-insensitive substring.
		filters = append(filters, fmt.Sprintf("query_text ILIKE '%%%s%%'", sqlSafeStr(textSearch)))
	}
	if errorsOnly {
		filters = append(filters, "is_exception = 1")
	}

	sql := fmt.Sprintf(`SELECT
		event_time,
		user,
		query_kind,
		normalized_query_hash,
		substring(query_text, 1, 500) AS query_text,
		query_duration_ms,
		read_rows,
		read_bytes,
		memory_usage,
		result_rows,
		is_exception,
		exception_code,
		ifNull(exception, '') AS exception,
		client_name,
		interface,
		cpu_user_us,
		cpu_system_us,
		tables,
		databases,
		'' AS tables_accessed
	FROM ch_analyzer.query_samples
	WHERE %s
	ORDER BY event_time DESC
	LIMIT %d OFFSET %d`, strings.Join(filters, " AND "), limit, offset)

	return client.Query(ctx, sql)
}

func (s *Server) queryFromQueryLog(ctx context.Context, client *chclient.Client,
	fromTime, toTime, hash, user, kind, minMs, table, textSearch string, errorsOnly bool, limit, offset int) ([]map[string]interface{}, error) {

	var filters []string
	filters = append(filters,
		fmt.Sprintf("event_time >= '%s' AND event_time <= '%s'", fromTime, toTime),
		"is_initial_query = 1")
	if errorsOnly {
		filters = append(filters, "type = 'ExceptionWhileProcessing'")
	} else {
		filters = append(filters, "type IN ('QueryFinish', 'ExceptionWhileProcessing')")
	}
	if hash != "" {
		filters = append(filters, fmt.Sprintf("normalized_query_hash = %s", sqlSafeUInt(hash)))
	}
	if user != "" {
		filters = append(filters, fmt.Sprintf("user = '%s'", sqlSafeStr(user)))
	}
	if kind != "" {
		filters = append(filters, fmt.Sprintf("query_kind = '%s'", sqlSafeStr(kind)))
	}
	if minMs != "" {
		filters = append(filters, fmt.Sprintf("query_duration_ms >= %s", sqlSafeUInt(minMs)))
	}
	if table != "" {
		filters = append(filters, fmt.Sprintf("has(tables, '%s')", sqlSafeStr(table)))
	}
	if textSearch != "" {
		filters = append(filters, fmt.Sprintf("query ILIKE '%%%s%%'", sqlSafeStr(textSearch)))
	}

	sql := fmt.Sprintf(`SELECT
		event_time,
		user,
		query_kind,
		normalized_query_hash,
		substring(query, 1, 500) AS query_text,
		query_duration_ms,
		read_rows,
		read_bytes,
		memory_usage,
		result_rows,
		if(type = 'ExceptionWhileProcessing', 1, 0) AS is_exception,
		exception_code,
		ifNull(exception, '') AS exception,
		client_name,
		interface,
		toUInt64(ProfileEvents['UserTimeMicroseconds']) AS cpu_user_us,
		toUInt64(ProfileEvents['SystemTimeMicroseconds']) AS cpu_system_us,
		tables,
		databases,
		arrayStringConcat(arrayFilter(x -> x != 'ch_analyzer', tables), ', ') AS tables_accessed
	FROM system.query_log
	WHERE %s
	ORDER BY event_time DESC
	LIMIT %d OFFSET %d`, strings.Join(filters, " AND "), limit, offset)

	return client.Query(ctx, sql)
}

// ---------------------------------------------------------------------------
// 12. Query Pattern Overview (stacked bar chart data)
// ---------------------------------------------------------------------------

func (s *Server) handleQueryPatternOverview(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	fromTime, toTime := parseFromTo(r)
	bucket := bucketSeconds(r)
	topN := parseIntParam(r, "top_n", 8)

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	// Get top N patterns by total_ms in this time range.
	topSQL := fmt.Sprintf(`SELECT
		normalized_query_hash,
		sum(query_duration_ms) AS total_ms,
		any(substring(query_text, 1, 80)) AS label
	FROM ch_analyzer.query_samples
	WHERE event_time >= '%s' AND event_time <= '%s'
	GROUP BY normalized_query_hash
	ORDER BY total_ms DESC
	LIMIT %d`, fromTime, toTime, topN)

	topRows, err := client.Query(ctx, topSQL)
	if err != nil || len(topRows) == 0 {
		// Fall back to system.query_log.
		topSQL = fmt.Sprintf(`SELECT
			normalized_query_hash,
			sum(query_duration_ms) AS total_ms,
			any(substring(query, 1, 80)) AS label
		FROM system.query_log
		WHERE event_time >= '%s' AND event_time <= '%s'
		  AND is_initial_query = 1
		  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
		GROUP BY normalized_query_hash
		ORDER BY total_ms DESC
		LIMIT %d`, fromTime, toTime, topN)
		topRows, err = client.Query(ctx, topSQL)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]interface{}{"patterns": []interface{}{}, "timeline": []interface{}{}})
			return
		}
	}

	if len(topRows) == 0 {
		writeJSON(w, http.StatusOK, map[string]interface{}{"patterns": topRows, "timeline": []interface{}{}})
		return
	}

	// Build list of hashes for the timeline query.
	hashes := make([]string, 0, len(topRows))
	for _, row := range topRows {
		hashes = append(hashes, toString(row["normalized_query_hash"]))
	}
	hashList := strings.Join(hashes, ", ")

	// Get time-bucketed data for those top patterns.
	timeSQL := fmt.Sprintf(`SELECT
		toStartOfInterval(event_time, INTERVAL %d SECOND) AS ts,
		normalized_query_hash,
		sum(query_duration_ms) AS total_ms,
		count() AS cnt
	FROM ch_analyzer.query_samples
	WHERE event_time >= '%s' AND event_time <= '%s'
	  AND normalized_query_hash IN (%s)
	GROUP BY ts, normalized_query_hash
	ORDER BY ts`, bucket, fromTime, toTime, hashList)

	timeRows, err := client.Query(ctx, timeSQL)
	if err != nil {
		// Fall back to system.query_log.
		timeSQL = fmt.Sprintf(`SELECT
			toStartOfInterval(event_time, INTERVAL %d SECOND) AS ts,
			normalized_query_hash,
			sum(query_duration_ms) AS total_ms,
			count() AS cnt
		FROM system.query_log
		WHERE event_time >= '%s' AND event_time <= '%s'
		  AND is_initial_query = 1
		  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
		  AND normalized_query_hash IN (%s)
		GROUP BY ts, normalized_query_hash
		ORDER BY ts`, bucket, fromTime, toTime, hashList)
		timeRows, _ = client.Query(ctx, timeSQL)
	}

	stringifyHashes(topRows)
	stringifyHashes(timeRows)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"patterns": topRows,
		"timeline": timeRows,
	})
}

// ---------------------------------------------------------------------------
// 13. Query Users (per-user aggregation)
// ---------------------------------------------------------------------------

func (s *Server) handleQueryUsers(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	fromTime, toTime := parseFromTo(r)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`SELECT
		user,
		count() AS cnt,
		sum(query_duration_ms) AS total_ms,
		avg(query_duration_ms) AS avg_ms,
		max(query_duration_ms) AS max_ms,
		quantile(0.95)(query_duration_ms) AS p95_ms,
		sum(read_bytes) AS total_read_bytes,
		sum(memory_usage) AS total_memory,
		countIf(is_exception = 1) AS failures,
		countIf(query_kind = 'Select') AS selects,
		countIf(query_kind = 'Insert') AS inserts
	FROM ch_analyzer.query_samples
	WHERE event_time >= '%s' AND event_time <= '%s'
	GROUP BY user
	ORDER BY total_ms DESC
	LIMIT 50`, fromTime, toTime)

	rows, err := client.Query(ctx, sql)
	if err != nil || len(rows) == 0 {
		// Fall back to system.query_log.
		sql = fmt.Sprintf(`SELECT
			user,
			count() AS cnt,
			sum(query_duration_ms) AS total_ms,
			avg(query_duration_ms) AS avg_ms,
			max(query_duration_ms) AS max_ms,
			quantile(0.95)(query_duration_ms) AS p95_ms,
			sum(read_bytes) AS total_read_bytes,
			sum(memory_usage) AS total_memory,
			countIf(type = 'ExceptionWhileProcessing') AS failures,
			countIf(query_kind = 'Select') AS selects,
			countIf(query_kind = 'Insert') AS inserts
		FROM system.query_log
		WHERE event_time >= '%s' AND event_time <= '%s'
		  AND is_initial_query = 1
		  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
		GROUP BY user
		ORDER BY total_ms DESC
		LIMIT 50`, fromTime, toTime)
		rows, err = client.Query(ctx, sql)
		if err != nil {
			slog.Warn("query users", "err", err, "instance", instance)
			writeJSON(w, http.StatusOK, []interface{}{})
			return
		}
	}

	writeJSON(w, http.StatusOK, rows)
}

// ---------------------------------------------------------------------------
// 13a. Connections — live view of clients talking to this CH
// ---------------------------------------------------------------------------

// handleConnections returns two shapes: interface-level connection counts
// from system.metrics (TCP / HTTP / MySQL / Postgres / Interserver — total
// connected clients, including idle ones), and a per-client breakdown from
// system.processes (user, initial_address, interface, http_user_agent, and
// how many queries that client is running). The latter only covers clients
// with at least one running query — idle connections don't show up there
// because CH doesn't expose per-connection state, only aggregate counts.
//
// Interface codes from system.processes.interface (ClickHouse enum):
//   0 = TCP, 1 = HTTP, 2 = gRPC, 3 = MySQL, 4 = PostgreSQL, 5 = TCP_Interserver
func (s *Server) handleConnections(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// 1) interface-level totals from system.metrics.
	metricsSQL := `SELECT metric, value FROM system.metrics
		WHERE metric IN (
			'TCPConnection', 'HTTPConnection', 'MySQLConnection',
			'PostgreSQLConnection', 'InterserverConnection'
		)`
	metricRows, _ := client.Query(ctx, metricsSQL)
	byInterface := make(map[string]int64, 5)
	for _, mr := range metricRows {
		m := toString(mr["metric"])
		v := int64(toFloat64(mr["value"]))
		byInterface[m] = v
	}

	// 2) per-client view from system.processes (only shows clients with at
	// least one running query). initial_address is the TCP peer; http_user
	// _agent is set for HTTP. Group by the source so we don't show the same
	// IP+user as dozens of separate rows.
	procSQL := `SELECT
		initial_address,
		initial_user AS user,
		CASE interface
			WHEN 0 THEN 'TCP'
			WHEN 1 THEN 'HTTP'
			WHEN 2 THEN 'gRPC'
			WHEN 3 THEN 'MySQL'
			WHEN 4 THEN 'PostgreSQL'
			WHEN 5 THEN 'TCP_Interserver'
			ELSE 'other'
		END AS interface_name,
		toUInt8(interface) AS interface_code,
		any(http_user_agent) AS http_user_agent,
		any(forwarded_for) AS forwarded_for,
		any(client_name) AS client_name,
		count() AS active_queries,
		max(elapsed) AS oldest_query_sec,
		sum(memory_usage) AS total_memory,
		sum(read_rows) AS total_read_rows
	FROM system.processes
	WHERE is_initial_query = 1
	GROUP BY initial_address, initial_user, interface
	ORDER BY active_queries DESC, oldest_query_sec DESC
	LIMIT 200`
	procRows, err := client.Query(ctx, procSQL)
	if err != nil {
		slog.Warn("connections: processes query failed", "err", err, "instance", instance)
		procRows = []map[string]interface{}{}
	}

	// Derive a single "total active queries" counter the UI can surface.
	var totalActive int64
	for _, p := range procRows {
		totalActive += int64(toFloat64(p["active_queries"]))
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"by_interface":         byInterface,
		"active":               procRows,
		"total_active_queries": totalActive,
	})
}

// ---------------------------------------------------------------------------
// 13b. Query Tables (per-table aggregation)
// ---------------------------------------------------------------------------

// handleQueryTables groups query_samples by the tables each query touched
// (unnesting the `tables` array with ARRAY JOIN) and aggregates the same
// cost-and-failure metrics as handleQueryUsers. Falls back to
// system.query_log when query_samples is empty or missing the new columns.
// System / ch_analyzer tables are excluded — operators don't care about
// the monitoring tool's own reads, and system schema reads flood the list.
func (s *Server) handleQueryTables(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	fromTime, toTime := parseFromTo(r)

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	// Prefer ch_analyzer.query_samples (requires Commit 3's new columns).
	sql := fmt.Sprintf(`SELECT
		concat(databases[indexOf(tables, table_name)], '.', table_name) AS table,
		databases[indexOf(tables, table_name)] AS database,
		count() AS cnt,
		sum(query_duration_ms) AS total_ms,
		avg(query_duration_ms) AS avg_ms,
		max(query_duration_ms) AS max_ms,
		quantile(0.95)(query_duration_ms) AS p95_ms,
		sum(cpu_user_us + cpu_system_us) / 1000 AS total_cpu_ms,
		sum(read_bytes) AS total_read_bytes,
		sum(memory_usage) AS total_memory,
		countIf(is_exception = 1) AS failures,
		countIf(query_kind = 'Select') AS selects,
		countIf(query_kind = 'Insert') AS inserts
	FROM ch_analyzer.query_samples
	ARRAY JOIN tables AS table_name
	WHERE event_time >= '%s' AND event_time <= '%s'
	  AND table_name != ''
	  AND databases[indexOf(tables, table_name)] NOT IN
	      ('system', 'information_schema', 'INFORMATION_SCHEMA', 'ch_analyzer')
	GROUP BY table, database
	ORDER BY total_ms DESC
	LIMIT 50`, fromTime, toTime)

	rows, err := client.Query(ctx, sql)
	if err != nil || len(rows) == 0 {
		// Fall back to system.query_log — same shape, CPU from ProfileEvents.
		sql = fmt.Sprintf(`SELECT
			concat(databases[indexOf(tables, table_name)], '.', table_name) AS table,
			databases[indexOf(tables, table_name)] AS database,
			count() AS cnt,
			sum(query_duration_ms) AS total_ms,
			avg(query_duration_ms) AS avg_ms,
			max(query_duration_ms) AS max_ms,
			quantile(0.95)(query_duration_ms) AS p95_ms,
			sum(ProfileEvents['UserTimeMicroseconds'] +
			    ProfileEvents['SystemTimeMicroseconds']) / 1000 AS total_cpu_ms,
			sum(read_bytes) AS total_read_bytes,
			sum(memory_usage) AS total_memory,
			countIf(type = 'ExceptionWhileProcessing') AS failures,
			countIf(query_kind = 'Select') AS selects,
			countIf(query_kind = 'Insert') AS inserts
		FROM system.query_log
		ARRAY JOIN tables AS table_name
		WHERE event_time >= '%s' AND event_time <= '%s'
		  AND is_initial_query = 1
		  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
		  AND table_name != ''
		  AND databases[indexOf(tables, table_name)] NOT IN
		      ('system', 'information_schema', 'INFORMATION_SCHEMA', 'ch_analyzer')
		GROUP BY table, database
		ORDER BY total_ms DESC
		LIMIT 50`, fromTime, toTime)

		rows, err = client.Query(ctx, sql)
		if err != nil {
			slog.Warn("query tables", "err", err, "instance", instance)
			writeJSON(w, http.StatusOK, []interface{}{})
			return
		}
	}

	writeJSON(w, http.StatusOK, rows)
}

// ---------------------------------------------------------------------------
// 14. Enhanced Query Patterns (total_ms, sort_by, is_initial_query)
// ---------------------------------------------------------------------------

// handleQueryPatternsV2 is the enhanced version. The old handleQueryPatterns
// is kept for backwards compatibility; this one is registered at a new path.
func (s *Server) handleQueryPatternsV2(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	fromTime, toTime := parseFromTo(r)
	limit := parseIntParam(r, "limit", 50)
	sortBy := r.URL.Query().Get("sort_by") // total_ms | cnt | avg_ms | max_ms | p95_ms | failures

	validSorts := map[string]bool{
		"total_ms": true, "cnt": true, "avg_ms": true,
		"max_ms": true, "p95_ms": true, "failures": true,
	}
	if !validSorts[sortBy] {
		sortBy = "total_ms"
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	// Try ch_analyzer.query_samples first.
	sql := fmt.Sprintf(`SELECT
		normalized_query_hash,
		count() AS cnt,
		any(query_kind) AS kind,
		sum(query_duration_ms) AS total_ms,
		avg(query_duration_ms) AS avg_ms,
		max(query_duration_ms) AS max_ms,
		quantile(0.95)(query_duration_ms) AS p95_ms,
		avg(read_rows) AS avg_read_rows,
		avg(read_bytes) AS avg_read_bytes,
		avg(memory_usage) AS avg_memory,
		max(memory_usage) AS max_memory,
		sum(cpu_user_us + cpu_system_us) / 1000 AS total_cpu_ms,
		arrayDistinct(arrayFlatten(groupArray(tables))) AS tables,
		countIf(is_exception = 1) AS failures,
		any(user) AS user,
		any(client_name) AS client,
		any(substring(query_text, 1, 300)) AS sample_query
	FROM ch_analyzer.query_samples
	WHERE event_time >= '%s' AND event_time <= '%s'
	GROUP BY normalized_query_hash
	ORDER BY %s DESC
	LIMIT %d`, fromTime, toTime, sortBy, limit)

	rows, err := client.Query(ctx, sql)
	if err != nil || len(rows) == 0 {
		// Fall back to system.query_log.
		sql = fmt.Sprintf(`SELECT
			normalized_query_hash,
			count() AS cnt,
			any(query_kind) AS kind,
			sum(query_duration_ms) AS total_ms,
			avg(query_duration_ms) AS avg_ms,
			max(query_duration_ms) AS max_ms,
			quantile(0.95)(query_duration_ms) AS p95_ms,
			avg(read_rows) AS avg_read_rows,
			avg(read_bytes) AS avg_read_bytes,
			avg(memory_usage) AS avg_memory,
			max(memory_usage) AS max_memory,
			sum(ProfileEvents['UserTimeMicroseconds'] +
			    ProfileEvents['SystemTimeMicroseconds']) / 1000 AS total_cpu_ms,
			arrayDistinct(arrayFlatten(groupArray(tables))) AS tables,
			countIf(type = 'ExceptionWhileProcessing') AS failures,
			any(user) AS user,
			any(client_name) AS client,
			any(substring(query, 1, 300)) AS sample_query
		FROM system.query_log
		WHERE event_time >= '%s' AND event_time <= '%s'
		  AND is_initial_query = 1
		  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
		GROUP BY normalized_query_hash
		ORDER BY %s DESC
		LIMIT %d`, fromTime, toTime, sortBy, limit)
		rows, err = client.Query(ctx, sql)
		if err != nil {
			slog.Warn("query patterns v2", "err", err, "instance", instance)
			writeJSON(w, http.StatusOK, []interface{}{})
			return
		}
	}

	stringifyHashes(rows)
	writeJSON(w, http.StatusOK, rows)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// sqlSafeStr sanitises a string for embedding in a SQL single-quoted literal.
// Backslash is replaced first to avoid double-escaping, then single quotes
// are doubled (standard SQL escaping).
func sqlSafeStr(s string) string {
	return strings.NewReplacer(`\`, `\\`, `'`, `''`).Replace(s)
}

// sqlSafeUInt sanitises a numeric string (allows only digits).
func sqlSafeUInt(s string) string {
	for _, c := range s {
		if c < '0' || c > '9' {
			return "0"
		}
	}
	if s == "" {
		return "0"
	}
	return s
}

// stringifyHashes converts the normalized_query_hash field in every row from
// json.Number / float64 to a plain string so the browser receives it as a
// JSON string. Without this, large UInt64 hashes (> 2^53) lose precision when
// encoded as a JSON number and parsed by JavaScript.
func stringifyHashes(rows []map[string]interface{}) {
	for _, row := range rows {
		if v, ok := row["normalized_query_hash"]; ok {
			switch n := v.(type) {
			case json.Number:
				row["normalized_query_hash"] = n.String()
			case float64:
				row["normalized_query_hash"] = fmt.Sprintf("%.0f", n)
			}
		}
	}
}

// toFloat64 coerces a ClickHouse JSON value to float64.
func toFloat64(v interface{}) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case string:
		f, _ := strconv.ParseFloat(n, 64)
		return f
	case json.Number:
		f, _ := n.Float64()
		return f
	default:
		return 0
	}
}

// formatBytes returns a human-readable byte string (e.g. "64.2GB").
func formatBytes(b float64) string {
	switch {
	case b >= 1<<40:
		return fmt.Sprintf("%.1fTB", b/(1<<40))
	case b >= 1<<30:
		return fmt.Sprintf("%.1fGB", b/(1<<30))
	case b >= 1<<20:
		return fmt.Sprintf("%.1fMB", b/(1<<20))
	case b >= 1<<10:
		return fmt.Sprintf("%.1fKB", b/(1<<10))
	default:
		return fmt.Sprintf("%.0fB", b)
	}
}

// formatDuration returns a human-readable duration from seconds.
func formatDuration(seconds float64) string {
	d := time.Duration(seconds) * time.Second
	days := int(d.Hours()) / 24
	hours := int(d.Hours()) % 24
	mins := int(d.Minutes()) % 60

	if days > 0 {
		return fmt.Sprintf("%dd %dh %dm", days, hours, mins)
	}
	if hours > 0 {
		return fmt.Sprintf("%dh %dm", hours, mins)
	}
	return fmt.Sprintf("%dm", mins)
}
