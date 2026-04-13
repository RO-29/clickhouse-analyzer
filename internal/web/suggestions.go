package web

import (
	"log/slog"
	"net/http"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// alertSuggestions maps alert category keys to best-practice suggestions.
// Loaded from configs/suggestions.yaml if it exists, otherwise uses defaults.
var alertSuggestions map[string][]string

// defaultSuggestions are the built-in suggestions used when no config file exists.
var defaultSuggestions = map[string][]string{
	"memory": {
		"Check max_memory_usage setting: SELECT name, value FROM system.settings WHERE name = 'max_memory_usage'",
		"Find memory-heavy queries: SELECT query_id, memory_usage, query FROM system.processes ORDER BY memory_usage DESC LIMIT 5",
		"Consider reducing max_bytes_before_external_group_by",
	},
	"rss": {
		"RSS includes OS page cache used by CH — may not indicate a problem if available memory is sufficient",
		"Check if mark cache or uncompressed cache is too large: SELECT * FROM system.asynchronous_metrics WHERE metric LIKE '%Cache%'",
		"Monitor CGroup memory limit vs actual: SELECT metric, value FROM system.asynchronous_metrics WHERE metric LIKE '%CGroup%'",
	},
	"cpu": {
		"Find CPU-heavy queries: SELECT query_id, elapsed, read_rows, query FROM system.processes ORDER BY elapsed DESC LIMIT 5",
		"Check if too many parallel queries: SELECT count() FROM system.processes",
		"Consider setting max_threads per query lower to reduce contention",
	},
	"parts": {
		"Check merge backlog: SELECT database, table, count() as parts FROM system.parts WHERE active GROUP BY database, table ORDER BY parts DESC LIMIT 10",
		"Force merge: OPTIMIZE TABLE {table} FINAL",
		"Check if parts_to_delay_insert / parts_to_throw_insert thresholds are being hit",
		"Consider increasing max_bytes_to_merge_at_max_space_in_pool",
	},
	"merges": {
		"Check current merges: SELECT database, table, elapsed, progress, num_parts FROM system.merges ORDER BY elapsed DESC",
		"Too many concurrent merges saturate disk I/O — consider reducing background_pool_size",
		"Check if large mutations are blocking regular merges",
	},
	"mutations": {
		"Check stuck mutations: SELECT database, table, mutation_id, command, create_time, parts_to_do, latest_fail_reason FROM system.mutations WHERE NOT is_done",
		"Kill stuck mutation: KILL MUTATION WHERE mutation_id = 'xxx'",
		"Mutations rewrite entire parts — schedule during low-traffic periods",
	},
	"disk": {
		"Check per-disk usage: SELECT name, formatReadableSize(free_space), formatReadableSize(total_space), round((total_space-free_space)*100/total_space,1) as used_pct FROM system.disks",
		"Check which tables use most space: SELECT database, table, formatReadableSize(sum(bytes_on_disk)) as size FROM system.parts WHERE active GROUP BY database, table ORDER BY sum(bytes_on_disk) DESC LIMIT 10",
		"Check if TTL is cleaning up old data: SELECT database, table, engine_full FROM system.tables WHERE engine_full LIKE '%TTL%'",
	},
	"s3_latency": {
		"Find slow S3 queries: SELECT query_id, ProfileEvents['S3ReadMicroseconds']/1000 as s3_ms, ProfileEvents['S3ReadRequestsCount'] as reqs, substring(query,1,200) FROM system.query_log WHERE type='QueryFinish' AND ProfileEvents['S3ReadRequestsCount'] > 0 ORDER BY s3_ms DESC LIMIT 10",
		"Check S3 cache hit rate — if low, consider increasing s3 cache size",
		"Queries hitting cold S3 data are always slower — consider keeping hot data on local disk longer",
	},
	"query_storms": {
		"Find storm source: SELECT user, client_name, count() FROM system.processes GROUP BY user, client_name ORDER BY count() DESC",
		"Consider setting max_concurrent_queries per user",
		"Check if application is retrying failed queries in a tight loop",
	},
	"failed_queries": {
		"Recent failures: SELECT exception_code, count() as cnt, any(exception), any(user) FROM system.query_log WHERE type='ExceptionWhileProcessing' AND event_time >= now() - INTERVAL 5 MINUTE GROUP BY exception_code ORDER BY cnt DESC",
		"Common codes: 241=memory limit, 159=timeout, 60=table not found, 47=unknown column",
	},
	"dictionaries": {
		"Check dictionary status: SELECT name, status, last_exception, source FROM system.dictionaries",
		"Reload a dictionary: SYSTEM RELOAD DICTIONARY dict_name",
	},
	"inserts": {
		"Batch inserts — many small inserts create too many parts and kill merge performance",
		"Ideal batch size: 10,000-100,000 rows per INSERT",
		"Check current insert load: SELECT databases[1] as db, tables[1] as tbl, count(), avg(written_rows) FROM system.query_log WHERE type='QueryFinish' AND query_kind='Insert' AND event_time >= now() - INTERVAL 5 MINUTE GROUP BY db, tbl ORDER BY count() DESC",
	},
	"mvs": {
		"Check MV performance: SELECT view_name, avg(view_duration_ms), max(view_duration_ms), countIf(status != 'QueryFinish') as failures FROM system.query_views_log WHERE event_time >= now() - INTERVAL 1 HOUR GROUP BY view_name ORDER BY avg(view_duration_ms) DESC",
		"Slow MVs block the INSERT pipeline — consider async materialized views",
		"Chained MVs (MV reading from another MV's target) can silently break — verify chains periodically",
		"Use POPULATE cautiously — it locks the source table during backfill",
	},
	"query_optimization": {
		"Avoid SELECT * — always specify columns to reduce I/O and memory",
		"Use PREWHERE instead of WHERE for conditions on large columns — CH moves the filter before decompression",
		"Check if queries use primary key: SELECT query_id, read_rows, read_bytes, query FROM system.query_log WHERE type='QueryFinish' AND read_rows > 1000000 AND event_time >= now() - INTERVAL 1 HOUR ORDER BY read_rows DESC LIMIT 10",
		"Add LIMIT to exploratory queries — unbounded SELECTs can OOM the server",
		"For JOINs: put the smaller table on the RIGHT side — CH loads it into memory",
		"Use IN with subquery instead of JOIN when only checking existence",
		"Avoid FINAL on large ReplacingMergeTree tables in hot paths — use argMax() pattern instead",
	},
	"schema_design": {
		"Partition key should have low cardinality (10-100 partitions) — too many partitions kills merge performance",
		"ORDER BY should match your most common query filters — put the most selective column first",
		"Use LowCardinality(String) for string columns with <10K distinct values — saves 2-10x memory and storage",
		"Don't use Nullable unnecessarily — it adds a separate column of UInt8 flags and prevents some optimizations",
		"Choose the narrowest data type: UInt32 instead of UInt64, Date instead of DateTime when time-of-day isn't needed",
	},
	"insert_optimization": {
		"Batch INSERTs: 10,000-100,000 rows per batch is ideal",
		"Avoid inserting <100 rows per INSERT — each INSERT creates a new part that needs merging",
		"Use async_insert=1 for high-frequency small inserts — CH batches them server-side",
		"Check async insert status: SELECT * FROM system.asynchronous_inserts",
		"Inserting into tables with many MVs is slower — each MV executes synchronously unless parallel_view_processing=1",
	},
	"mergetree_tuning": {
		"max_bytes_to_merge_at_max_space_in_pool: increase to allow larger merges (default 150GB)",
		"parts_to_delay_insert: when parts exceed this, INSERTs are throttled (default 150)",
		"parts_to_throw_insert: when parts exceed this, INSERTs fail (default 300)",
		"min_age_to_force_merge_seconds: force merge of old parts even if few — useful for ReplacingMergeTree cleanup",
		"Check current settings: SELECT name, value, description FROM system.merge_tree_settings WHERE changed ORDER BY name",
	},
	"memory_management": {
		"max_memory_usage: per-query limit — set to 50-75% of total RAM for single-user, lower for multi-tenant",
		"max_bytes_before_external_group_by: when GROUP BY exceeds this, spill to disk (set to ~50% of max_memory_usage)",
		"max_bytes_before_external_sort: same for ORDER BY — prevents OOM on large sorts",
		"join_algorithm: set to 'auto' or 'partial_merge' for large JOINs instead of default 'hash'",
		"Check memory-heavy queries: SELECT query_id, memory_usage, peak_memory_usage, query FROM system.query_log WHERE type='QueryFinish' AND event_time >= now() - INTERVAL 1 HOUR ORDER BY peak_memory_usage DESC LIMIT 10",
	},
	"monitoring": {
		"Top queries by resource: SELECT normalized_query_hash, count(), avg(query_duration_ms), avg(read_rows), avg(memory_usage), any(query) FROM system.query_log WHERE type='QueryFinish' AND event_time >= now() - INTERVAL 1 HOUR GROUP BY normalized_query_hash ORDER BY count()*avg(query_duration_ms) DESC LIMIT 20",
		"Current server load: SELECT metric, value FROM system.metrics WHERE metric IN ('Query','Merge','PartMutation','HTTPConnection','TCPConnection')",
		"Table compression ratios: SELECT database, table, formatReadableSize(sum(data_compressed_bytes)) as compressed, formatReadableSize(sum(data_uncompressed_bytes)) as uncompressed, round(sum(data_uncompressed_bytes)/sum(data_compressed_bytes), 2) as ratio FROM system.columns GROUP BY database, table ORDER BY sum(data_compressed_bytes) DESC LIMIT 20",
	},
	"disk_balance": {
		"JBOD data should be evenly distributed — imbalance means some disks fill faster",
		"Check per-disk data: SELECT disk_name, formatReadableSize(sum(bytes_on_disk)) as size, count() as parts FROM system.parts WHERE active GROUP BY disk_name ORDER BY disk_name",
		"JBOD uses round-robin for new parts — existing imbalance is from historical data placement",
	},
}

func init() {
	alertSuggestions = defaultSuggestions
}

// LoadSuggestions loads suggestions from a YAML file. If the file doesn't
// exist, built-in defaults are used. Call this from main before starting the server.
func LoadSuggestions(path string) {
	if path == "" {
		return
	}

	data, err := os.ReadFile(path)
	if err != nil {
		slog.Info("no suggestions config file, using built-in defaults", "path", path)
		return
	}

	var custom map[string][]string
	if err := yaml.Unmarshal(data, &custom); err != nil {
		slog.Error("failed to parse suggestions config, using defaults", "path", path, "error", err)
		return
	}

	// Merge: custom overrides defaults per category.
	// If a category exists in custom, it replaces the default entirely.
	// Categories not in custom keep their defaults.
	merged := make(map[string][]string)
	for k, v := range defaultSuggestions {
		merged[k] = v
	}
	for k, v := range custom {
		merged[k] = v
	}
	alertSuggestions = merged

	slog.Info("loaded custom suggestions", "path", path, "categories", len(custom))
}

// categoryKeywords maps health check IDs and title keywords to suggestion
// categories for automatic matching.
var categoryKeywords = map[string]string{
	"memory_used":    "memory",
	"rss":            "rss",
	"cpu":            "cpu",
	"load":           "cpu",
	"running_queries": "query_storms",
	"long_running":   "cpu",
	"failed_queries": "failed_queries",
	"parts":          "parts",
	"active_merges":  "merges",
	"stuck_mutations": "mutations",
	"disk_usage":     "disk",
	"dictionaries":   "dictionaries",
	"s3_latency":     "s3_latency",
	"query_storms":   "query_storms",
	"uptime":         "",
}

var titleKeywordMap = map[string]string{
	"memory":     "memory",
	"rss":        "rss",
	"cpu":        "cpu",
	"load":       "cpu",
	"parts":      "parts",
	"merge":      "merges",
	"mutation":   "mutations",
	"disk":       "disk",
	"s3":         "s3_latency",
	"storm":      "query_storms",
	"failed":     "failed_queries",
	"exception":  "failed_queries",
	"dictionary": "dictionaries",
	"insert":     "inserts",
	"materialized": "mvs",
	"mv":         "mvs",
	"imbalance":  "disk_balance",
	"jbod":       "disk_balance",
}

// GetSuggestions returns the suggestions for the given category key.
func GetSuggestions(category string) []string {
	return alertSuggestions[strings.ToLower(category)]
}

// GetSuggestionsForAlert returns suggestions matching the alert's category and title.
func GetSuggestionsForAlert(category, title string) []string {
	seen := make(map[string]bool)
	var result []string

	addUnique := func(suggestions []string) {
		for _, s := range suggestions {
			if !seen[s] {
				seen[s] = true
				result = append(result, s)
			}
		}
	}

	cat := strings.ToLower(category)
	if sug, ok := alertSuggestions[cat]; ok {
		addUnique(sug)
	}

	if mapped, ok := categoryKeywords[cat]; ok && mapped != "" {
		if sug, ok := alertSuggestions[mapped]; ok {
			addUnique(sug)
		}
	}

	lowerTitle := strings.ToLower(title)
	for keyword, sugCat := range titleKeywordMap {
		if strings.Contains(lowerTitle, keyword) {
			if sug, ok := alertSuggestions[sugCat]; ok {
				addUnique(sug)
			}
		}
	}

	return result
}

// handleSuggestions serves GET /api/suggestions/{category}
func (s *Server) handleSuggestions(w http.ResponseWriter, r *http.Request) {
	category := r.PathValue("category")
	if category == "" {
		writeErr(w, http.StatusBadRequest, "category is required")
		return
	}

	suggestions := GetSuggestions(category)
	if suggestions == nil {
		suggestions = GetSuggestionsForAlert(category, "")
	}
	if suggestions == nil {
		suggestions = []string{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"category":    category,
		"suggestions": suggestions,
	})
}
