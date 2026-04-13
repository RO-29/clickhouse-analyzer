// Package collector defines the shared types used by all ClickHouse metric
// collectors and consumed by the analyzer and alerter.
package collector

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

// Severity represents the urgency level of an alert.
type Severity string

const (
	SeverityInfo     Severity = "info"
	SeverityWarn     Severity = "warn"
	SeverityCritical Severity = "critical"
)

// ---------------------------------------------------------------------------
// Alert
// ---------------------------------------------------------------------------

// Alert is a single actionable finding produced by a collector or the analyzer.
type Alert struct {
	Instance  string
	Severity  Severity
	Category  string // memory, cpu, queries, storage, tables, inserts, mvs, dictionaries, k8s
	Title     string
	Message   string
	DedupKey  string // unique key for dedup (e.g., "instance:category:specific_id")
	Timestamp time.Time
}

// ---------------------------------------------------------------------------
// Metric
// ---------------------------------------------------------------------------

// Metric is a single numeric observation.
type Metric struct {
	Instance  string
	Name      string
	Labels    map[string]string
	Value     float64
	Timestamp time.Time
}

// ---------------------------------------------------------------------------
// CollectResult
// ---------------------------------------------------------------------------

// CollectResult aggregates all metrics and alerts produced by a single
// collector during one polling cycle.
type CollectResult struct {
	Metrics  []Metric
	Alerts   []Alert
	Duration time.Duration
}

// AddMetric appends a metric with the current timestamp.
func (r *CollectResult) AddMetric(instance, name string, value float64, labels map[string]string) {
	r.Metrics = append(r.Metrics, Metric{
		Instance:  instance,
		Name:      name,
		Value:     value,
		Labels:    labels,
		Timestamp: time.Now(),
	})
}

// AddAlert appends an alert with the current timestamp.
func (r *CollectResult) AddAlert(instance string, severity Severity, category, title, message, dedupKey string) {
	r.Alerts = append(r.Alerts, Alert{
		Instance:  instance,
		Severity:  severity,
		Category:  category,
		Title:     title,
		Message:   message,
		DedupKey:  dedupKey,
		Timestamp: time.Now(),
	})
}

// ---------------------------------------------------------------------------
// Collector interface
// ---------------------------------------------------------------------------

// Collector is the common contract that every metric gatherer implements.
type Collector interface {
	// Name returns a short, human-readable identifier (e.g. "system", "queries").
	Name() string
	// Collect gathers metrics and alerts from ClickHouse system tables.
	Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error)
}

// ---------------------------------------------------------------------------
// Value-extraction helpers
// ---------------------------------------------------------------------------

// toFloat64 extracts a numeric value from an interface{} returned by the CH
// JSON response. ClickHouse FORMAT JSON represents numbers as JSON numbers
// (float64 after Go's json.Unmarshal) or sometimes as strings for large values.
func toFloat64(v interface{}) (float64, error) {
	switch val := v.(type) {
	case float64:
		return val, nil
	case json.Number:
		return val.Float64()
	case string:
		return strconv.ParseFloat(val, 64)
	case int:
		return float64(val), nil
	case int64:
		return float64(val), nil
	case nil:
		return 0, nil
	default:
		return 0, fmt.Errorf("cannot convert %T to float64", v)
	}
}

// mustFloat64 is like toFloat64 but returns 0 on error.
func mustFloat64(v interface{}) float64 {
	f, _ := toFloat64(v)
	return f
}

// toString extracts a string value from an interface{}.
func toString(v interface{}) string {
	if v == nil {
		return ""
	}
	switch val := v.(type) {
	case string:
		return val
	case float64:
		if val == float64(int64(val)) {
			return strconv.FormatInt(int64(val), 10)
		}
		return strconv.FormatFloat(val, 'f', -1, 64)
	case json.Number:
		return val.String()
	default:
		return fmt.Sprintf("%v", v)
	}
}

// getFloat extracts a named column from a row as float64.
func getFloat(row map[string]interface{}, key string) float64 {
	v, ok := row[key]
	if !ok {
		return 0
	}
	return mustFloat64(v)
}

// getString extracts a named column from a row as string.
func getString(row map[string]interface{}, key string) string {
	v, ok := row[key]
	if !ok {
		return ""
	}
	return toString(v)
}
