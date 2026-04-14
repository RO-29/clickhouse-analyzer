package collector

// CollectorMeta describes a collector for the UI.
type CollectorMeta struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Description string `json:"description"`
	Category    string `json:"category"`
}

// AllCollectorMeta returns metadata for every collector.
func AllCollectorMeta() []CollectorMeta {
	return []CollectorMeta{
		{
			Name:        "system",
			DisplayName: "System Resources",
			Description: "Reports memory and CPU utilization from system.asynchronous_metrics and system.metrics.",
			Category:    "system",
		},
		{
			Name:        "queries",
			DisplayName: "Query Activity",
			Description: "Detects slow-running queries and reports the count of currently running queries.",
			Category:    "queries",
		},
		{
			Name:        "tables",
			DisplayName: "Table Health",
			Description: "Monitors active parts count, running merges, and pending mutations per table.",
			Category:    "tables",
		},
		{
			Name:        "storage",
			DisplayName: "Storage Usage",
			Description: "Tracks disk utilization and S3 object-storage usage across all configured disks.",
			Category:    "storage",
		},
		{
			Name:        "inserts",
			DisplayName: "Insert Throughput",
			Description: "Measures insert rows/s and bytes/s; alerts on insert stalls or unusual throughput drops.",
			Category:    "inserts",
		},
		{
			Name:        "mvs",
			DisplayName: "Materialized Views",
			Description: "Checks for stalled or erroring materialized view refresh chains.",
			Category:    "mvs",
		},
		{
			Name:        "dictionaries",
			DisplayName: "Dictionary Health",
			Description: "Reports dictionaries that failed to load or refresh from system.dictionaries.",
			Category:    "dictionaries",
		},
		{
			Name:        "replication",
			DisplayName: "Replication Status",
			Description: "Measures replication queue depth, lag, and reports any replication errors.",
			Category:    "replication",
		},
		{
			Name:        "errors",
			DisplayName: "System Errors",
			Description: "Surfaces recent entries from system.errors that indicate internal ClickHouse failures.",
			Category:    "errors",
		},
		{
			Name:        "background_pool",
			DisplayName: "Background Pool",
			Description: "Checks background merge and mutation thread pool saturation.",
			Category:    "system",
		},
		{
			Name:        "cache_health",
			DisplayName: "Cache Health",
			Description: "Reports mark-cache and uncompressed-cache hit rates; alerts on poor cache utilization.",
			Category:    "system",
		},
		{
			Name:        "query_latency",
			DisplayName: "Query Latency",
			Description: "Detects P95 query latency spikes compared to a rolling baseline.",
			Category:    "queries",
		},
		{
			Name:        "freshness",
			DisplayName: "Insert Freshness",
			Description: "Identifies tables that received inserts recently but have since stopped, indicating pipeline stalls.",
			Category:    "tables",
		},
		{
			Name:        "schema_drift",
			DisplayName: "Schema Drift",
			Description: "Detects column additions, removals, or type changes between polls. Note: first run initializes baseline, no alerts on first execution.",
			Category:    "tables",
		},
		{
			Name:        "projections",
			DisplayName: "Projection Parts",
			Description: "Finds projection parts that have not yet been built, which may degrade query performance.",
			Category:    "tables",
		},
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
	case "query_latency":
		return &QueryLatencyCollector{}, true
	case "freshness":
		return &FreshnessCollector{}, true
	case "schema_drift":
		return &SchemaDriftCollector{}, true
	case "projections":
		return &ProjectionCollector{}, true
	default:
		return nil, false
	}
}
