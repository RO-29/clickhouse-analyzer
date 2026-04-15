// Package prometheus provides an optional metrics exporter that exposes all
// collected ClickHouse metrics on a /metrics HTTP endpoint for Prometheus
// scraping.
package prometheus

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/collector"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const metricPrefix = "ch_analyzer_"

// knownMetrics maps collector metric names to their expected label sets
// (excluding "instance", which is always present). This allows pre-registration
// of well-known metrics with the correct label dimensions.
var knownMetrics = map[string][]string{
	// System — actual collector names (dots → underscores via sanitizeName)
	"system_memory_rss_bytes":        {},
	"system_memory_total_bytes":      {},
	"system_memory_available_bytes":  {},
	"system_memory_used_percent":     {},
	"system_cpu_busy_percent":        {},
	"system_uptime_seconds":          {},
	// system.async.* metrics are dynamic (LoadAverage1, LoadAverage5, etc.)
	// system.metrics.* metrics are dynamic (MemoryTracking, etc.)
	// Queries
	"queries_running_count":          {},
	"queries_failed_5m":              {},
	"queries_p95_ms_current":         {},
	"queries_p95_ms_baseline":        {},
	"queries_zombie_count":           {},
	"queries_timeouts_5m":            {"exception_code", "name"},
	"queries_pattern_exec_count_5m":  {"hash", "user"},
	// Parts & merges
	"tables_parts_count":             {"database", "table"},
	"parts_oldest_hours":             {"database", "table"},
	"tables_detached_parts_count":    {},
	"tables_merges_active_count":     {},
	"tables_mutations_stuck_count":   {},
	// TTL
	"ttl_stuck_mutations":            {"database", "table"},
	"ttl_stale_table_days":           {"database", "table"},
	// Async inserts
	"async_inserts_total_5m":         {},
	"async_inserts_errors_5m":        {},
	"async_inserts_queue_depth":      {},
	// Replication (names already match)
	"replication_max_delay_sec":      {},
	"replication_replicated_tables":  {},
	"replication_absolute_delay_sec": {"database", "table"},
	"replication_queue_size":         {"database", "table"},
	"replication_inserts_in_queue":   {"database", "table"},
	"replication_merges_in_queue":    {"database", "table"},
	"replication_parts_to_check":     {"database", "table"},
	"replication_future_parts":       {"database", "table"},
	"replication_log_lag":            {"database", "table"},
	// Errors
	"errors_system_count":            {"error"},
	"errors_system_total_recent":     {},
	// Keeper / ZooKeeper
	"keeper_connected_nodes":         {},
	"keeper_outstanding_requests":    {},
	"keeper_max_avg_latency_ms":      {},
	// Storage
	"storage_disk_free_space":        {"disk", "path", "type"},
	"storage_disk_total_space":       {"disk", "path", "type"},
	"storage_disk_used_percent":      {"disk", "path", "type"},
	"storage_distribution_bytes":     {"disk"},
	"storage_distribution_part_count": {"disk"},
	"storage_distribution_rows":      {"disk"},
	"storage_s3_avg_latency_ms":      {},
	"storage_s3_max_latency_ms":      {},
	"storage_s3_total_requests":      {},
	"storage_s3_concurrent_reads":    {},
	// Inserts
	"inserts_total_rows":             {},
	"inserts_total_count":            {},
	"inserts_total_bytes":            {},
	"inserts_table_rows":             {"database", "table"},
	"inserts_table_count":            {"database", "table"},
	"inserts_table_bytes":            {"database", "table"},
	"inserts_rolling_avg_rows":       {},
	"inserts_throughput_drop_percent": {},
	// Dictionaries
	"dictionaries_total_count":       {},
	"dictionaries_not_loaded_count":  {},
	"dictionaries_element_count":     {"database", "dictionary", "status"},
	"dictionaries_loading_duration_sec": {"database", "dictionary", "status"},
	"dictionaries_bytes_allocated":   {"database", "dictionary", "status"},
	"dictionaries_loaded":            {"database", "dictionary", "status"},
	// Materialized views
	"mvs_total_count":                {},
	"mvs_total_failures_5m":          {},
	"mvs_chained_count":              {},
	"mvs_failures":                   {"view", "target"},
	"mvs_timing_executions":          {"view", "target"},
	"mvs_timing_avg_ms":              {"view", "target"},
	"mvs_timing_max_ms":              {"view", "target"},
	"mvs_timing_p95_ms":              {"view", "target"},
	"mvs_target_bytes":               {"database", "mv"},
	"mvs_target_rows":                {"database", "mv"},
	// Cache
	"system_cache_mark_hits":         {},
	"system_cache_mark_misses":       {},
	"system_cache_mark_hit_rate":     {},
	// Background pools
	"system_bg_pool_merges_mutations_used_pct": {},
	"system_bg_pool_fetches_used_pct":          {},
	"system_bg_pool_processing_used_pct":       {},
	// Table freshness & schema drift
	"tables_freshness_minutes_since_insert": {"database", "table"},
	"tables_schema_changes_detected":        {},
	// Health
	"health_score":                   {},
	"active_alerts":                  {"severity"},
}

// Exporter exposes collected ClickHouse metrics as Prometheus gauges on an
// HTTP /metrics endpoint.
type Exporter struct {
	addr          string
	metrics       map[string]*prometheus.GaugeVec
	mu            sync.RWMutex
	registered    map[string]bool
	registry      *prometheus.Registry
	server        *http.Server
	instanceCache sync.Map   // map[string][]collector.Metric — latest metrics per instance
	updateMu      sync.Mutex // serialises reset+republish cycles
}

// New creates a new Exporter that will listen on addr (e.g. ":9090").
func New(addr string) *Exporter {
	reg := prometheus.NewRegistry()
	e := &Exporter{
		addr:       addr,
		metrics:    make(map[string]*prometheus.GaugeVec),
		registered: make(map[string]bool),
		registry:   reg,
	}

	// Pre-register all known metrics so they appear even before the first
	// poll cycle delivers data.
	for name, extraLabels := range knownMetrics {
		e.ensureMetric(name, extraLabels)
	}

	return e
}

// Start begins serving the /metrics endpoint. It blocks until the context is
// cancelled or the server encounters a fatal error.
func (e *Exporter) Start(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(e.registry, promhttp.HandlerOpts{
		EnableOpenMetrics: true,
	}))
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	e.server = &http.Server{
		Addr:              e.addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	slog.Info("prometheus exporter starting", "addr", e.addr)

	errCh := make(chan error, 1)
	go func() {
		if err := e.server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("prometheus exporter listen: %w", err)
		}
		close(errCh)
	}()

	select {
	case <-ctx.Done():
		return e.Stop(context.Background())
	case err := <-errCh:
		return err
	}
}

// Stop gracefully shuts down the HTTP server.
func (e *Exporter) Stop(ctx context.Context) error {
	if e.server == nil {
		return nil
	}

	slog.Info("prometheus exporter shutting down")

	shutdownCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := e.server.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("prometheus exporter shutdown: %w", err)
	}
	return nil
}

// Update replaces the gauge values for the instance(s) represented in metrics.
// It caches the latest metrics per instance so that a concurrent Update for
// one instance does not wipe another instance's data. Safe to call concurrently.
func (e *Exporter) Update(metrics []collector.Metric) {
	if len(metrics) == 0 {
		return
	}

	// Store the latest snapshot for this instance.
	instance := metrics[0].Instance
	cached := make([]collector.Metric, len(metrics))
	copy(cached, metrics)
	e.instanceCache.Store(instance, cached)

	// Serialise the reset+republish cycle so concurrent calls don't interleave.
	e.updateMu.Lock()
	defer e.updateMu.Unlock()

	// Reset all existing gauges.
	e.mu.RLock()
	for _, gv := range e.metrics {
		gv.Reset()
	}
	e.mu.RUnlock()

	// Republish every instance's latest metrics from the cache.
	e.instanceCache.Range(func(_, value any) bool {
		for i := range value.([]collector.Metric) {
			m := &value.([]collector.Metric)[i]
			extraLabels := sortedExtraLabelNames(m.Labels)
			gv := e.getOrCreateMetric(m.Name, extraLabels)

			labels := prometheus.Labels{"instance": m.Instance}
			for k, v := range m.Labels {
				labels[k] = v
			}
			gv.With(labels).Set(m.Value)
		}
		return true
	})
}

// getOrCreateMetric returns the GaugeVec for the given metric name, creating
// and registering it if it does not yet exist.
func (e *Exporter) getOrCreateMetric(name string, extraLabels []string) *prometheus.GaugeVec {
	key := metricKey(name, extraLabels)

	e.mu.RLock()
	gv, ok := e.metrics[key]
	e.mu.RUnlock()
	if ok {
		return gv
	}

	return e.ensureMetric(name, extraLabels)
}

// ensureMetric registers a GaugeVec if it has not been registered yet.
func (e *Exporter) ensureMetric(name string, extraLabels []string) *prometheus.GaugeVec {
	key := metricKey(name, extraLabels)

	e.mu.Lock()
	defer e.mu.Unlock()

	// Double-check under write lock.
	if gv, ok := e.metrics[key]; ok {
		return gv
	}

	allLabels := make([]string, 0, 1+len(extraLabels))
	allLabels = append(allLabels, "instance")
	allLabels = append(allLabels, extraLabels...)

	fqName := metricPrefix + sanitizeName(name)

	gv := prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: fqName,
		Help: fmt.Sprintf("ClickHouse metric: %s", name),
	}, allLabels)

	if err := e.registry.Register(gv); err != nil {
		// If a collector with the same fully-qualified name but different
		// labels was already registered, log and return a no-op gauge to
		// avoid panicking.
		var are prometheus.AlreadyRegisteredError
		if errors.As(err, &are) {
			slog.Warn("prometheus metric already registered",
				"name", fqName,
				"labels", allLabels,
			)
			if existing, ok := are.ExistingCollector.(*prometheus.GaugeVec); ok {
				e.metrics[key] = existing
				e.registered[key] = true
				return existing
			}
			// Fallback: return the new (unregistered) gauge; Set calls will
			// be silently dropped by Prometheus but we avoid a panic.
			e.metrics[key] = gv
			e.registered[key] = true
			return gv
		}
		slog.Error("failed to register prometheus metric",
			"name", fqName,
			"error", err,
		)
		// Return the gauge anyway so callers don't nil-pointer.
		e.metrics[key] = gv
		e.registered[key] = true
		return gv
	}

	slog.Debug("registered prometheus metric", "name", fqName, "labels", allLabels)

	e.metrics[key] = gv
	e.registered[key] = true
	return gv
}

// metricKey produces a unique map key from a metric name and its extra label
// names. Two metrics with the same name but different label sets are stored
// separately (though Prometheus will reject the second registration).
func metricKey(name string, extraLabels []string) string {
	if len(extraLabels) == 0 {
		return name
	}
	return name + "|" + strings.Join(extraLabels, ",")
}

// sanitizeName converts a collector metric name into a Prometheus-safe metric
// name component. Dots and dashes become underscores; only [a-zA-Z0-9_] are
// kept.
func sanitizeName(name string) string {
	var b strings.Builder
	b.Grow(len(name))
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

// sortedExtraLabelNames returns the sorted keys of m, which are the label
// names beyond the implicit "instance" label.
func sortedExtraLabelNames(m map[string]string) []string {
	if len(m) == 0 {
		return nil
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
