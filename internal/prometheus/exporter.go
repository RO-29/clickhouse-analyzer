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
	// System
	"memory_rss_bytes":        {},
	"memory_tracked_bytes":    {},
	"memory_total_bytes":      {},
	"cpu_user_percent":        {},
	"cpu_system_percent":      {},
	"load_average":            {"period"},
	// Queries (original)
	"queries_running":         {},
	"queries_failed_5m":       {},
	"queries_failed_total":    {}, // legacy alias kept for existing dashboards
	// Queries (new)
	"queries_p95_ms_current":       {},
	"queries_p95_ms_baseline":      {},
	"queries_zombie_count":         {},
	"queries_timeouts_5m":          {"exception_code", "name"},
	"queries_pattern_exec_count_5m": {"hash", "user"},
	// Parts & merges
	"parts_count":             {"database", "table"},
	"parts_oldest_hours":      {"database", "table"},
	"tables_detached_parts_count": {},
	"merges_active":           {},
	"mutations_stuck":         {},
	// TTL
	"ttl_stuck_mutations": {"database", "table"},
	"ttl_stale_table_days": {"database", "table"},
	// Async inserts
	"async_inserts_total_5m":  {},
	"async_inserts_errors_5m": {},
	"async_inserts_queue_depth": {},
	// Replication
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
	"errors_system_count":        {"error"},
	"errors_system_total_recent": {},
	// Keeper / ZooKeeper
	"keeper_connected_nodes":     {},
	"keeper_outstanding_requests": {},
	"keeper_max_avg_latency_ms":  {},
	// Storage / inserts / tables
	"table_size_bytes":        {"database", "table", "disk"},
	"disk_used_bytes":         {"disk"},
	"disk_total_bytes":        {"disk"},
	"insert_rows_total":       {"database", "table"},
	"s3_read_latency_seconds": {},
	// Health
	"health_score":    {},
	"active_alerts":   {"severity"},
	"uptime_seconds":  {},
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
