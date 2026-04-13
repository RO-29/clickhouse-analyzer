package store

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// Metric represents a single metric data point.
type Metric struct {
	Instance  string
	Name      string
	Labels    map[string]string
	Value     float64
	Timestamp time.Time
}

// DataPoint is a timestamp-value pair for time-series queries.
type DataPoint struct {
	Timestamp time.Time
	Value     float64
}

// Alert represents an alert event.
type Alert struct {
	ID         int64
	Instance   string
	Severity   string
	Category   string
	Title      string
	Message    string
	Resolved   bool
	ResolvedAt *time.Time
	CreatedAt  time.Time
	DedupKey   string
}

// DigestSnapshot stores a JSON snapshot of instance state.
type DigestSnapshot struct {
	Instance  string
	Data      map[string]interface{}
	Timestamp time.Time
}

// Store provides ClickHouse-backed storage where each node stores its own data.
type Store struct {
	manager  *chclient.Manager
	database string
	alertSeq atomic.Int64
}

// New creates a Store. Creates tables on every CH instance.
func New(manager *chclient.Manager, database string) (*Store, error) {
	if database == "" {
		database = "ch_analyzer"
	}

	s := &Store{
		manager:  manager,
		database: database,
	}

	slog.Info("store initialized", "backend", "clickhouse-distributed", "database", database, "instances", manager.Len())
	return s, nil
}

// Close is a no-op for ClickHouse.
func (s *Store) Close() error { return nil }

// clientFor returns the CH client for the given instance name.
// Falls back to first available client if not found.
func (s *Store) clientFor(instance string) *chclient.Client {
	c := s.manager.Get(instance)
	if c != nil {
		return c
	}
	// Fallback: use first available.
	names := s.manager.Names()
	if len(names) > 0 {
		return s.manager.Get(names[0])
	}
	return nil
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

// InsertMetrics inserts metrics — each metric goes to its own instance's CH.
func (s *Store) InsertMetrics(metrics []Metric) error {
	if len(metrics) == 0 {
		return nil
	}

	// Group by instance.
	byInstance := make(map[string][]Metric)
	for _, m := range metrics {
		byInstance[m.Instance] = append(byInstance[m.Instance], m)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	for instance, batch := range byInstance {
		client := s.clientFor(instance)
		if client == nil {
			slog.Warn("no client for instance, skipping metrics", "instance", instance)
			continue
		}

		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("INSERT INTO %s.metrics (instance, name, labels, value, ts) VALUES ", s.database))
		for i, m := range batch {
			if i > 0 {
				sb.WriteString(", ")
			}
			ts := m.Timestamp.Format("2006-01-02 15:04:05")
			sb.WriteString(fmt.Sprintf("('%s', '%s', '%s', %f, '%s')",
				escape(m.Instance), escape(m.Name), escape(labelsToJSON(m.Labels)), m.Value, ts))
		}

		if _, err := client.QuerySingleValue(ctx, sb.String()); err != nil {
			slog.Warn("failed to insert metrics", "instance", instance, "count", len(batch), "error", err)
		}
	}

	slog.Debug("inserted metrics", "count", len(metrics))
	return nil
}

// QueryMetrics returns metrics from the instance's own CH.
func (s *Store) QueryMetrics(instance, name string, from, to time.Time, labels map[string]string) ([]DataPoint, error) {
	client := s.clientFor(instance)
	if client == nil {
		return nil, fmt.Errorf("no client for instance %s", instance)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`SELECT value, ts FROM %s.metrics
		WHERE instance = '%s' AND name = '%s'
		AND ts >= '%s' AND ts <= '%s'
		ORDER BY ts ASC`,
		s.database, escape(instance), escape(name),
		from.Format("2006-01-02 15:04:05"), to.Format("2006-01-02 15:04:05"))

	rows, err := client.Query(ctx, sql)
	if err != nil {
		return nil, fmt.Errorf("store: query metrics: %w", err)
	}

	var points []DataPoint
	for _, row := range rows {
		val := getFloat(row, "value")
		tsStr := getString(row, "ts")
		t, _ := time.Parse("2006-01-02 15:04:05", tsStr)
		points = append(points, DataPoint{Timestamp: t, Value: val})
	}
	return points, nil
}

// QueryLatestMetrics returns the most recent metrics from an instance's own CH.
func (s *Store) QueryLatestMetrics(instance string) ([]Metric, error) {
	client := s.clientFor(instance)
	if client == nil {
		return nil, fmt.Errorf("no client for instance %s", instance)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`SELECT instance, name, labels, value, ts
		FROM %s.metrics
		WHERE instance = '%s' AND ts >= now() - INTERVAL 10 MINUTE
		ORDER BY name ASC, ts DESC
		LIMIT 1 BY name`,
		s.database, escape(instance))

	rows, err := client.Query(ctx, sql)
	if err != nil {
		return nil, fmt.Errorf("store: query latest: %w", err)
	}

	var metrics []Metric
	for _, row := range rows {
		m := Metric{
			Instance: getString(row, "instance"),
			Name:     getString(row, "name"),
			Value:    getFloat(row, "value"),
		}
		tsStr := getString(row, "ts")
		m.Timestamp, _ = time.Parse("2006-01-02 15:04:05", tsStr)
		labelsJSON := getString(row, "labels")
		if err := json.Unmarshal([]byte(labelsJSON), &m.Labels); err != nil {
			m.Labels = map[string]string{}
		}
		metrics = append(metrics, m)
	}
	return metrics, nil
}

// QueryMetricsSeries returns downsampled time-series from an instance's own CH.
func (s *Store) QueryMetricsSeries(instance, name string, from, to time.Time, points int) ([]DataPoint, error) {
	if points <= 0 {
		points = 100
	}
	client := s.clientFor(instance)
	if client == nil {
		return nil, fmt.Errorf("no client for instance %s", instance)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	totalRange := to.Unix() - from.Unix()
	if totalRange <= 0 {
		return nil, nil
	}
	bucketSize := totalRange / int64(points)
	if bucketSize < 1 {
		bucketSize = 1
	}

	sql := fmt.Sprintf(`SELECT
			toDateTime(intDiv(toUInt32(ts), %d) * %d) AS bucket_ts,
			avg(value) AS avg_value
		FROM %s.metrics
		WHERE instance = '%s' AND name = '%s'
		AND ts >= '%s' AND ts <= '%s'
		GROUP BY bucket_ts
		ORDER BY bucket_ts ASC`,
		bucketSize, bucketSize,
		s.database, escape(instance), escape(name),
		from.Format("2006-01-02 15:04:05"), to.Format("2006-01-02 15:04:05"))

	rows, err := client.Query(ctx, sql)
	if err != nil {
		return nil, fmt.Errorf("store: query series: %w", err)
	}

	var result []DataPoint
	for _, row := range rows {
		tsStr := getString(row, "bucket_ts")
		t, _ := time.Parse("2006-01-02 15:04:05", tsStr)
		result = append(result, DataPoint{Timestamp: t, Value: getFloat(row, "avg_value")})
	}
	return result, nil
}

// ---------------------------------------------------------------------------
// Alerts — stored on the instance they belong to
// ---------------------------------------------------------------------------

// InsertAlert inserts an alert on the instance's own CH.
func (s *Store) InsertAlert(alert Alert) (int64, error) {
	client := s.clientFor(alert.Instance)
	if client == nil {
		return 0, fmt.Errorf("no client for instance %s", alert.Instance)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	id := s.alertSeq.Add(1)
	ts := alert.CreatedAt.Format("2006-01-02 15:04:05")
	msg := escape(alert.Message)
	if len(msg) > 4000 {
		msg = msg[:4000]
	}

	sql := fmt.Sprintf(`INSERT INTO %s.alerts
		(id, instance, severity, category, title, message, resolved, resolved_at, created_at, dedup_key, version)
		VALUES (%d, '%s', '%s', '%s', '%s', '%s', 0, NULL, '%s', '%s', 1)`,
		s.database, id,
		escape(alert.Instance), escape(alert.Severity), escape(alert.Category),
		escape(alert.Title), msg, ts, escape(alert.DedupKey))

	if _, err := client.QuerySingleValue(ctx, sql); err != nil {
		return 0, fmt.Errorf("store: insert alert: %w", err)
	}

	slog.Info("alert inserted", "id", id, "instance", alert.Instance, "severity", alert.Severity, "title", alert.Title)
	return id, nil
}

// ResolveAlert resolves an alert on the instance's CH by inserting a new version.
func (s *Store) ResolveAlert(dedupKey string) error {
	// dedupKey format: "instance:category:..." — extract instance name.
	instance := extractInstance(dedupKey)
	client := s.clientFor(instance)
	if client == nil {
		// Try all instances.
		return s.resolveAlertAllInstances(dedupKey)
	}
	return s.resolveAlertOnClient(client, dedupKey)
}

func (s *Store) resolveAlertOnClient(client *chclient.Client, dedupKey string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	now := time.Now().Format("2006-01-02 15:04:05")

	sql := fmt.Sprintf(`SELECT id, instance, severity, category, title, message, created_at
		FROM %s.alerts FINAL
		WHERE dedup_key = '%s' AND resolved = 0
		ORDER BY created_at DESC LIMIT 1`,
		s.database, escape(dedupKey))

	rows, err := client.Query(ctx, sql)
	if err != nil || len(rows) == 0 {
		return nil
	}

	row := rows[0]
	id := getFloat(row, "id")
	createdAt := getString(row, "created_at")

	insertSQL := fmt.Sprintf(`INSERT INTO %s.alerts
		(id, instance, severity, category, title, message, resolved, resolved_at, created_at, dedup_key, version)
		VALUES (%d, '%s', '%s', '%s', '%s', '%s', 1, '%s', '%s', '%s', 2)`,
		s.database, int64(id),
		escape(getString(row, "instance")),
		escape(getString(row, "severity")),
		escape(getString(row, "category")),
		escape(getString(row, "title")),
		escape(getString(row, "message")),
		now, createdAt, escape(dedupKey))

	if _, err := client.QuerySingleValue(ctx, insertSQL); err != nil {
		return fmt.Errorf("store: resolve alert: %w", err)
	}

	slog.Info("alert resolved", "dedup_key", dedupKey)
	return nil
}

func (s *Store) resolveAlertAllInstances(dedupKey string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var resolved bool
	s.manager.ForEach(func(name string, client *chclient.Client) error {
		if resolved {
			return nil
		}
		sql := fmt.Sprintf(`SELECT count() as cnt FROM %s.alerts FINAL WHERE dedup_key = '%s' AND resolved = 0`,
			s.database, escape(dedupKey))
		val, err := client.QuerySingleValue(ctx, sql)
		if err != nil || val == "0" || val == "" {
			return nil
		}
		if err := s.resolveAlertOnClient(client, dedupKey); err == nil {
			resolved = true
		}
		return nil
	})
	return nil
}

// GetActiveAlerts returns unresolved alerts from an instance's own CH.
func (s *Store) GetActiveAlerts(instance string) ([]Alert, error) {
	client := s.clientFor(instance)
	if client == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`SELECT id, instance, severity, category, title, message,
			resolved, resolved_at, created_at, dedup_key
		FROM %s.alerts FINAL
		WHERE instance = '%s' AND resolved = 0
		ORDER BY created_at DESC`,
		s.database, escape(instance))

	rows, err := client.Query(ctx, sql)
	if err != nil {
		return nil, fmt.Errorf("store: get active alerts: %w", err)
	}
	return parseAlertRows(rows), nil
}

// GetAlertHistory returns all alerts from an instance's own CH.
func (s *Store) GetAlertHistory(instance string, from, to time.Time, limit int) ([]Alert, error) {
	if limit <= 0 {
		limit = 100
	}
	client := s.clientFor(instance)
	if client == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`SELECT id, instance, severity, category, title, message,
			resolved, resolved_at, created_at, dedup_key
		FROM %s.alerts FINAL
		WHERE instance = '%s'
		AND created_at >= '%s' AND created_at <= '%s'
		ORDER BY created_at DESC LIMIT %d`,
		s.database, escape(instance),
		from.Format("2006-01-02 15:04:05"), to.Format("2006-01-02 15:04:05"), limit)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		return nil, fmt.Errorf("store: get alert history: %w", err)
	}
	return parseAlertRows(rows), nil
}

// IsAlertActive checks if an unresolved alert exists on the relevant instance.
func (s *Store) IsAlertActive(dedupKey string) (bool, error) {
	instance := extractInstance(dedupKey)
	client := s.clientFor(instance)
	if client == nil {
		return false, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`SELECT count() AS cnt FROM %s.alerts FINAL
		WHERE dedup_key = '%s' AND resolved = 0`,
		s.database, escape(dedupKey))

	val, err := client.QuerySingleValue(ctx, sql)
	if err != nil {
		return false, fmt.Errorf("store: check active: %w", err)
	}
	return val != "0" && val != "", nil
}

// ---------------------------------------------------------------------------
// Digest — stored on the instance it belongs to
// ---------------------------------------------------------------------------

func (s *Store) SaveDigestSnapshot(instance string, snapshot map[string]interface{}) error {
	client := s.clientFor(instance)
	if client == nil {
		return fmt.Errorf("no client for instance %s", instance)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	data, err := json.Marshal(snapshot)
	if err != nil {
		return fmt.Errorf("store: marshal digest: %w", err)
	}

	now := time.Now().Format("2006-01-02 15:04:05")
	sql := fmt.Sprintf(`INSERT INTO %s.digest_snapshots (instance, snapshot, ts) VALUES ('%s', '%s', '%s')`,
		s.database, escape(instance), escape(string(data)), now)

	if _, err := client.QuerySingleValue(ctx, sql); err != nil {
		return fmt.Errorf("store: insert digest: %w", err)
	}
	return nil
}

func (s *Store) GetDigestSnapshots(instance string, from, to time.Time) ([]DigestSnapshot, error) {
	client := s.clientFor(instance)
	if client == nil {
		return nil, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`SELECT instance, snapshot, ts FROM %s.digest_snapshots
		WHERE instance = '%s' AND ts >= '%s' AND ts <= '%s' ORDER BY ts ASC`,
		s.database, escape(instance),
		from.Format("2006-01-02 15:04:05"), to.Format("2006-01-02 15:04:05"))

	rows, err := client.Query(ctx, sql)
	if err != nil {
		return nil, fmt.Errorf("store: query digest: %w", err)
	}

	var snapshots []DigestSnapshot
	for _, row := range rows {
		ds := DigestSnapshot{Instance: getString(row, "instance")}
		tsStr := getString(row, "ts")
		ds.Timestamp, _ = time.Parse("2006-01-02 15:04:05", tsStr)
		dataJSON := getString(row, "snapshot")
		if err := json.Unmarshal([]byte(dataJSON), &ds.Data); err != nil {
			ds.Data = map[string]interface{}{}
		}
		snapshots = append(snapshots, ds)
	}
	return snapshots, nil
}

// Prune is a no-op — ClickHouse TTL handles retention.
func (s *Store) Prune(retention time.Duration) error { return nil }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// extractInstance gets the instance name from a dedupKey like "single-node-a:tables:parts:critical".
func extractInstance(dedupKey string) string {
	if i := strings.Index(dedupKey, ":"); i > 0 {
		return dedupKey[:i]
	}
	return dedupKey
}

func parseAlertRows(rows []map[string]interface{}) []Alert {
	var alerts []Alert
	for _, row := range rows {
		a := Alert{
			ID:       int64(getFloat(row, "id")),
			Instance: getString(row, "instance"),
			Severity: getString(row, "severity"),
			Category: getString(row, "category"),
			Title:    getString(row, "title"),
			Message:  getString(row, "message"),
			DedupKey: getString(row, "dedup_key"),
		}
		a.Resolved = getFloat(row, "resolved") > 0
		a.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", getString(row, "created_at"))
		resolvedStr := getString(row, "resolved_at")
		if resolvedStr != "" && resolvedStr != "\\N" && resolvedStr != "1970-01-01 00:00:00" {
			if t, err := time.Parse("2006-01-02 15:04:05", resolvedStr); err == nil {
				a.ResolvedAt = &t
			}
		}
		alerts = append(alerts, a)
	}
	return alerts
}

func escape(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `'`, `\'`)
}

func labelsToJSON(labels map[string]string) string {
	if len(labels) == 0 {
		return "{}"
	}
	data, _ := json.Marshal(labels)
	return string(data)
}

func getFloat(row map[string]interface{}, key string) float64 {
	v, ok := row[key]
	if !ok || v == nil {
		return 0
	}
	switch val := v.(type) {
	case float64:
		return val
	case string:
		var f float64
		fmt.Sscanf(val, "%f", &f)
		return f
	default:
		return 0
	}
}

func getString(row map[string]interface{}, key string) string {
	v, ok := row[key]
	if !ok || v == nil {
		return ""
	}
	switch val := v.(type) {
	case string:
		return val
	case float64:
		if val == float64(int64(val)) {
			return fmt.Sprintf("%d", int64(val))
		}
		return fmt.Sprintf("%f", val)
	default:
		return fmt.Sprintf("%v", v)
	}
}
