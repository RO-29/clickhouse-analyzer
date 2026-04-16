package web

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Query Anti-patterns Advisor
//
// Detects 10 classes of problematic query patterns from system.query_log:
//
//  1. select_star      — SELECT * fetching all columns
//  2. high_memory      — queries averaging >512 MB RAM
//  3. full_scan        — read_rows / result_rows > 10 000 (poor filtering)
//  4. no_limit         — large result sets with no LIMIT clause
//  5. order_no_limit   — ORDER BY without LIMIT (unbounded sort)
//  6. high_error_rate  — patterns with ≥20% exception rate
//  7. low_mark_cache   — mark-cache hit rate <50% (bad index utilisation)
//  8. high_frequency   — same pattern running ≥200×/hour (N+1 / missing cache)
//  9. uses_final       — FINAL keyword forces full-merge scans
// 10. global_in_join   — GLOBAL IN / GLOBAL JOIN (expensive distributed ops)
// ---------------------------------------------------------------------------

// AntiPatternQuery is one representative query inside an anti-pattern group.
type AntiPatternQuery struct {
	Hash          string  `json:"hash"`
	SampleQuery   string  `json:"sample_query"`
	ExecCount     int64   `json:"exec_count"`
	AvgMs         float64 `json:"avg_ms"`
	AvgMemory     int64   `json:"avg_memory,omitempty"`
	AvgReadRows   int64   `json:"avg_read_rows,omitempty"`
	AvgResultRows int64   `json:"avg_result_rows,omitempty"`
	AvgReadBytes  int64   `json:"avg_read_bytes,omitempty"`
	ScanRatio     float64 `json:"scan_ratio,omitempty"`
	ErrorRatePct  float64 `json:"error_rate_pct,omitempty"`
	ErrorCount    int64   `json:"error_count,omitempty"`
	CacheHitPct   float64 `json:"cache_hit_pct,omitempty"`
}

// QueryAntiPattern is one category of anti-pattern with all affected queries.
type QueryAntiPattern struct {
	Type        string             `json:"type"`
	Severity    string             `json:"severity"`
	Title       string             `json:"title"`
	Description string             `json:"description"`
	Count       int                `json:"count"`
	Queries     []AntiPatternQuery `json:"queries"`
}

func (s *Server) handleAdvisorQueryAntiPatterns(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	type checkFn func() ([]AntiPatternQuery, error)

	type check struct {
		typ  string
		sev  string
		title string
		desc string
		fn   checkFn
	}

	const colSelect = `normalized_query_hash AS hash, any(query) AS sample_query,
		count() AS exec_count, avg(query_duration_ms) AS avg_ms`

	const baseWhere = `event_time >= now() - INTERVAL 24 HOUR
		AND is_initial_query = 1`

	// ── helpers ──────────────────────────────────────────────────────────────

	runQ := func(sql string) ([]AntiPatternQuery, error) {
		rows, err := client.Query(ctx, sql)
		if err != nil {
			return nil, err
		}
		out := make([]AntiPatternQuery, 0, len(rows))
		for _, row := range rows {
			out = append(out, AntiPatternQuery{
				Hash:          toString(row["hash"]),
				SampleQuery:   toString(row["sample_query"]),
				ExecCount:     int64(toFloat64(row["exec_count"])),
				AvgMs:         toFloat64(row["avg_ms"]),
				AvgMemory:     int64(toFloat64(row["avg_memory"])),
				AvgReadRows:   int64(toFloat64(row["avg_read_rows"])),
				AvgResultRows: int64(toFloat64(row["avg_result_rows"])),
				AvgReadBytes:  int64(toFloat64(row["avg_read_bytes"])),
				ScanRatio:     toFloat64(row["scan_ratio"]),
				ErrorRatePct:  toFloat64(row["error_rate_pct"]),
				ErrorCount:    int64(toFloat64(row["error_count"])),
				CacheHitPct:   toFloat64(row["cache_hit_pct"]),
			})
		}
		return out, nil
	}

	checks := []check{
		// 1. SELECT *
		{
			typ:  "select_star",
			sev:  "warn",
			title: "SELECT * Usage",
			desc: "Queries selecting all columns waste I/O and prevent column pruning. " +
				"Specify only the columns you need.",
			fn: func() ([]AntiPatternQuery, error) {
				return runQ(`SELECT ` + colSelect + `,
					avg(read_bytes) AS avg_read_bytes,
					avg(read_rows)  AS avg_read_rows
				FROM system.query_log
				WHERE ` + baseWhere + `
				  AND type = 'QueryFinish'
				  AND match(query, '(?i)\bSELECT\s+\*')
				GROUP BY hash
				HAVING exec_count >= 3
				ORDER BY avg_read_bytes DESC
				LIMIT 25`)
			},
		},

		// 2. High memory usage (>512 MB avg)
		{
			typ:  "high_memory",
			sev:  "critical",
			title: "High Memory Usage",
			desc: "Queries averaging more than 512 MB RAM. These put pressure on the " +
				"server and may cause OOM kills. Consider adding LIMIT, sampling, or " +
				"pre-aggregation.",
			fn: func() ([]AntiPatternQuery, error) {
				return runQ(`SELECT ` + colSelect + `,
					avg(memory_usage) AS avg_memory,
					avg(read_rows)    AS avg_read_rows
				FROM system.query_log
				WHERE ` + baseWhere + `
				  AND type = 'QueryFinish'
				  AND memory_usage > 536870912
				GROUP BY hash
				ORDER BY avg_memory DESC
				LIMIT 25`)
			},
		},

		// 3. Full table scan (read/result ratio > 10 000)
		{
			typ:  "full_scan",
			sev:  "warn",
			title: "Full Table Scan (Poor Filtering)",
			desc: "Queries reading 10 000× more rows than they return. This suggests " +
				"missing or ineffective WHERE clause conditions on the primary key or " +
				"partition key.",
			fn: func() ([]AntiPatternQuery, error) {
				return runQ(`SELECT ` + colSelect + `,
					avg(read_rows)    AS avg_read_rows,
					avg(result_rows)  AS avg_result_rows,
					round(avg(read_rows) / nullIf(avg(result_rows), 0)) AS scan_ratio
				FROM system.query_log
				WHERE ` + baseWhere + `
				  AND type = 'QueryFinish'
				  AND result_rows  > 0
				  AND read_rows > 1000000
				GROUP BY hash
				HAVING scan_ratio > 10000
				ORDER BY scan_ratio DESC
				LIMIT 25`)
			},
		},

		// 4. Large result set without LIMIT
		{
			typ:  "no_limit",
			sev:  "warn",
			title: "Large Result Set Without LIMIT",
			desc: "Queries returning more than 10 000 rows with no LIMIT clause. " +
				"Clients often can't process that many rows anyway; add LIMIT or " +
				"paginate the results.",
			fn: func() ([]AntiPatternQuery, error) {
				return runQ(`SELECT ` + colSelect + `,
					avg(result_rows) AS avg_result_rows,
					avg(read_bytes)  AS avg_read_bytes
				FROM system.query_log
				WHERE ` + baseWhere + `
				  AND type = 'QueryFinish'
				  AND result_rows > 10000
				  AND NOT match(query, '(?i)\bLIMIT\b')
				GROUP BY hash
				ORDER BY avg_result_rows DESC
				LIMIT 25`)
			},
		},

		// 5. ORDER BY without LIMIT
		{
			typ:  "order_no_limit",
			sev:  "warn",
			title: "ORDER BY Without LIMIT",
			desc: "Sorting the full result set is expensive. If you only need the " +
				"top N rows, add LIMIT. If you need all rows sorted, consider whether " +
				"sorting on the client is cheaper.",
			fn: func() ([]AntiPatternQuery, error) {
				return runQ(`SELECT ` + colSelect + `,
					avg(result_rows) AS avg_result_rows,
					avg(read_rows)   AS avg_read_rows
				FROM system.query_log
				WHERE ` + baseWhere + `
				  AND type = 'QueryFinish'
				  AND match(query, '(?i)\bORDER\s+BY\b')
				  AND NOT match(query, '(?i)\bLIMIT\b')
				  AND result_rows > 1000
				GROUP BY hash
				ORDER BY avg_ms DESC
				LIMIT 25`)
			},
		},

		// 6. High error rate (≥20% exceptions)
		{
			typ:  "high_error_rate",
			sev:  "critical",
			title: "High Query Error Rate",
			desc: "Query patterns where ≥20% of executions throw an exception. " +
				"Investigate the root cause — bad data, missing columns, or broken " +
				"application logic.",
			fn: func() ([]AntiPatternQuery, error) {
				return runQ(`SELECT
					normalized_query_hash AS hash,
					any(query) AS sample_query,
					countIf(type = 'ExceptionWhileProcessing') AS error_count,
					count()    AS exec_count,
					round(countIf(type = 'ExceptionWhileProcessing') * 100.0 / count(), 1) AS error_rate_pct,
					avg(query_duration_ms) AS avg_ms
				FROM system.query_log
				WHERE ` + baseWhere + `
				  AND type IN ('QueryFinish','ExceptionWhileProcessing')
				GROUP BY hash
				HAVING error_count >= 5 AND error_rate_pct >= 20
				ORDER BY error_count DESC
				LIMIT 25`)
			},
		},

		// 7. Low mark-cache hit rate (<50%)
		{
			typ:  "low_mark_cache",
			sev:  "warn",
			title: "Low Mark Cache Hit Rate",
			desc: "Queries with <50% mark cache hits are doing expensive disk seeks " +
				"for every granule. This often means the primary key doesn't match " +
				"the query filter — consider a projection or a skip index.",
			fn: func() ([]AntiPatternQuery, error) {
				return runQ(`SELECT ` + colSelect + `,
					round(avgIf(
						ProfileEvents['MarkCacheHits'] * 100.0
						  / (ProfileEvents['MarkCacheHits'] + ProfileEvents['MarkCacheMisses']),
						ProfileEvents['MarkCacheHits'] + ProfileEvents['MarkCacheMisses'] >= 10
					), 1) AS cache_hit_pct,
					avg(read_rows) AS avg_read_rows
				FROM system.query_log
				WHERE ` + baseWhere + `
				  AND type = 'QueryFinish'
				  AND ProfileEvents['MarkCacheHits'] + ProfileEvents['MarkCacheMisses'] >= 10
				GROUP BY hash
				HAVING cache_hit_pct > 0 AND cache_hit_pct < 50
				ORDER BY cache_hit_pct ASC
				LIMIT 25`)
			},
		},

		// 8. High-frequency patterns (≥200/hour — N+1 / missing cache)
		{
			typ:  "high_frequency",
			sev:  "warn",
			title: "High-Frequency Query Pattern (N+1 / Missing Cache)",
			desc: "The same normalised query ran ≥200 times in the last hour. " +
				"This is usually an N+1 loop in application code or a missing result " +
				"cache. Batch or cache these queries.",
			fn: func() ([]AntiPatternQuery, error) {
				return runQ(`SELECT
					normalized_query_hash AS hash,
					any(query) AS sample_query,
					count()    AS exec_count,
					avg(query_duration_ms) AS avg_ms,
					avg(memory_usage)      AS avg_memory
				FROM system.query_log
				WHERE event_time >= now() - INTERVAL 1 HOUR
				  AND is_initial_query = 1
				  AND type = 'QueryFinish'
				GROUP BY hash
				HAVING exec_count >= 200
				ORDER BY exec_count DESC
				LIMIT 25`)
			},
		},

		// 9. FINAL keyword (forces full-merge scan)
		{
			typ:  "uses_final",
			sev:  "warn",
			title: "FINAL Keyword (Full-Merge Scan)",
			desc: "FINAL forces ClickHouse to merge all parts on-the-fly, which is " +
				"very expensive. Use background merges or a GROUP BY deduplification " +
				"instead where possible.",
			fn: func() ([]AntiPatternQuery, error) {
				return runQ(`SELECT ` + colSelect + `,
					avg(read_rows)    AS avg_read_rows,
					avg(memory_usage) AS avg_memory
				FROM system.query_log
				WHERE ` + baseWhere + `
				  AND type = 'QueryFinish'
				  AND match(query, '(?i)\bFINAL\b')
				GROUP BY hash
				HAVING exec_count >= 3
				ORDER BY exec_count * avg_ms DESC
				LIMIT 25`)
			},
		},

		// 10. GLOBAL IN / GLOBAL JOIN
		{
			typ:  "global_in_join",
			sev:  "critical",
			title: "GLOBAL IN / GLOBAL JOIN",
			desc: "GLOBAL IN and GLOBAL JOIN broadcast the subquery result to every " +
				"shard, which is extremely expensive. Use distributed_product_mode or " +
				"restructure the query to avoid broadcast joins.",
			fn: func() ([]AntiPatternQuery, error) {
				return runQ(`SELECT ` + colSelect + `,
					avg(read_rows)    AS avg_read_rows,
					avg(memory_usage) AS avg_memory
				FROM system.query_log
				WHERE ` + baseWhere + `
				  AND type = 'QueryFinish'
				  AND match(query, '(?i)\bGLOBAL\s+(IN|JOIN)\b')
				GROUP BY hash
				ORDER BY exec_count DESC
				LIMIT 25`)
			},
		},
	}

	// Run all checks concurrently.
	type result struct {
		idx     int
		queries []AntiPatternQuery
		err     error
	}

	results := make([]result, len(checks))
	var wg sync.WaitGroup
	for i, c := range checks {
		wg.Add(1)
		go func(idx int, fn checkFn) {
			defer wg.Done()
			q, err := fn()
			results[idx] = result{idx: idx, queries: q, err: err}
		}(i, c.fn)
	}
	wg.Wait()

	out := make([]QueryAntiPattern, 0, len(checks))
	for i, c := range checks {
		res := results[i]
		queries := res.queries
		if queries == nil {
			queries = []AntiPatternQuery{}
		}
		out = append(out, QueryAntiPattern{
			Type:        c.typ,
			Severity:    c.sev,
			Title:       c.title,
			Description: c.desc,
			Count:       len(queries),
			Queries:     queries,
		})
	}

	writeJSON(w, http.StatusOK, out)
}
