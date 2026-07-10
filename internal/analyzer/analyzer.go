package analyzer

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/collector"
)

// AnalyzerThresholds controls anomaly and sustained-issue detection.
type AnalyzerThresholds struct {
	AnomalyStdDevMultiplier float64
	SustainedIssueCount     int
}

// HealthScore summarises the health of a single instance.
type HealthScore struct {
	Instance string
	Score    int
	Issues   []string
}

// QueryPattern tracks normalised query statistics.
type QueryPattern struct {
	NormalizedQuery string
	Count           int
	AvgDuration     float64
	MaxDuration     float64
	AvgMemory       float64
	AvgRowsRead     float64
	Failures        int
	LastSeen        time.Time
	Users           []string
}

// AnalysisResult is what Analyze returns each cycle.
type AnalysisResult struct {
	Alerts      []collector.Alert
	Metrics     []collector.Metric
	HealthScore HealthScore
	CrossAlerts []collector.Alert
}

// Analyzer processes collector results, detects anomalies, correlates cross-
// collector signals, and computes health scores.
type Analyzer struct {
	thresholds   AnalyzerThresholds
	history      map[string]*RingBuffer   // "instance:metric" -> recent values
	patterns     map[string]*QueryPattern // "instance:normalised_sql" -> stats
	healthScores map[string]HealthScore
	mu           sync.RWMutex
}

// New creates an Analyzer with the given thresholds.
func New(thresholds AnalyzerThresholds) *Analyzer {
	if thresholds.AnomalyStdDevMultiplier <= 0 {
		thresholds.AnomalyStdDevMultiplier = 2.0
	}
	if thresholds.SustainedIssueCount <= 0 {
		thresholds.SustainedIssueCount = 3
	}
	return &Analyzer{
		thresholds:   thresholds,
		history:      make(map[string]*RingBuffer),
		patterns:     make(map[string]*QueryPattern),
		healthScores: make(map[string]HealthScore),
	}
}

// Analyze processes all collector results for a single instance.
func (a *Analyzer) Analyze(instance string, results []*collector.CollectResult) (*AnalysisResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	ar := &AnalysisResult{}

	// Aggregate metrics and alerts from all collectors.
	metricsByName := make(map[string]float64)
	for _, r := range results {
		if r == nil {
			continue
		}
		ar.Alerts = append(ar.Alerts, r.Alerts...)
		for _, m := range r.Metrics {
			metricsByName[m.Name] = m.Value
		}
	}

	// Update history and detect anomalies.
	a.updateHistory(instance, metricsByName, ar)

	// Cross-collector correlation.
	a.crossCollectorAnalysis(instance, metricsByName, ar)

	// Compute health score.
	hs := a.computeHealthScore(instance, ar.Alerts, ar.CrossAlerts)
	ar.HealthScore = hs
	a.healthScores[instance] = hs

	// Emit health score as a metric.
	ar.Metrics = append(ar.Metrics, collector.Metric{
		Instance:  instance,
		Name:      "health_score",
		Value:     float64(hs.Score),
		Timestamp: time.Now(),
	})

	return ar, nil
}

// GetHealthScore returns the last computed health score for an instance.
func (a *Analyzer) GetHealthScore(instance string) HealthScore {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if hs, ok := a.healthScores[instance]; ok {
		return hs
	}
	return HealthScore{Instance: instance, Score: 100}
}

// GetQueryPatterns returns patterns for an instance sorted by impact.
func (a *Analyzer) GetQueryPatterns(instance string) []QueryPattern {
	a.mu.RLock()
	defer a.mu.RUnlock()

	var result []QueryPattern
	prefix := instance + ":"
	for key, p := range a.patterns {
		if strings.HasPrefix(key, prefix) {
			result = append(result, *p)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		return float64(result[i].Count)*result[i].AvgDuration > float64(result[j].Count)*result[j].AvgDuration
	})
	return result
}

// GetMetricHistory returns recent values for a metric.
func (a *Analyzer) GetMetricHistory(instance, metric string) []float64 {
	a.mu.RLock()
	defer a.mu.RUnlock()
	key := instance + ":" + metric
	if rb, ok := a.history[key]; ok {
		return rb.All()
	}
	return nil
}

func (a *Analyzer) updateHistory(instance string, metrics map[string]float64, ar *AnalysisResult) {
	now := time.Now()
	for name, val := range metrics {
		key := instance + ":" + name
		rb, ok := a.history[key]
		if !ok {
			rb = NewRingBuffer(30)
			a.history[key] = rb
		}
		rb.Add(val)

		// Need at least 10 data points for anomaly detection.
		if rb.Count() < 10 {
			continue
		}

		vals := rb.All()
		m := mean(vals)
		sd := stddev(vals, m)
		if sd == 0 {
			continue
		}

		threshold := m + a.thresholds.AnomalyStdDevMultiplier*sd
		if val > threshold && anomalySignificant(val, m) {
			label, _, _ := metricMeta(name)
			ar.CrossAlerts = append(ar.CrossAlerts, collector.Alert{
				Instance:  instance,
				Severity:  collector.SeverityWarn,
				Category:  "anomaly",
				Title:     "Anomaly detected: " + label,
				Message:   formatAnomaly(name, val, m, sd),
				DedupKey:  instance + ":anomaly:" + name,
				Timestamp: now,
			})
		}

		// Sustained issue: last N values all above mean + 1*stddev.
		if a.checkSustained(vals, m, sd) {
			label, _, _ := metricMeta(name)
			ar.CrossAlerts = append(ar.CrossAlerts, collector.Alert{
				Instance:  instance,
				Severity:  collector.SeverityWarn,
				Category:  "sustained",
				Title:     "Sustained elevated: " + label,
				Message: formatSustained(name, val, m,
					a.thresholds.SustainedIssueCount),
				DedupKey:  instance + ":sustained:" + name,
				Timestamp: now,
			})
		}
	}
}

func (a *Analyzer) checkSustained(vals []float64, m, sd float64) bool {
	n := a.thresholds.SustainedIssueCount
	if len(vals) < n {
		return false
	}
	threshold := m + sd
	for i := len(vals) - n; i < len(vals); i++ {
		if vals[i] <= threshold {
			return false
		}
	}
	return true
}

func (a *Analyzer) crossCollectorAnalysis(instance string, m map[string]float64, ar *AnalysisResult) {
	now := time.Now()

	memUsedPct := m["system.memory.used_percent"]
	runningQueries := m["system.metrics.Query"]

	// High memory + many concurrent queries = elevated OOM-kill risk. This is a
	// genuine multi-signal correlation not covered by any single collector: each
	// signal alone is benign, together they mean the next heavy query may tip the
	// server over.
	//
	// The three other cross-alerts that used to live here (merges-behind,
	// s3-contention, system-overloaded) were removed: each read a metric name no
	// collector ever emits (tables.total_parts, storage.s3.avg_latency,
	// inserts.rows_per_sec) so none could fire, and each duplicated a dedicated
	// collector alert (tables merges-stalled, storage S3 latency, inserts
	// backpressure). Resurrecting them would only add redundant noise.
	if memUsedPct > 85 && runningQueries > 20 {
		ar.CrossAlerts = append(ar.CrossAlerts, collector.Alert{
			Instance: instance,
			Severity: collector.SeverityCritical,
			Category: "cross",
			Title:    "OOM risk: high memory with many queries",
			Message: formatf("Memory at %.1f%% with %d running queries. "+
				"Risk of OOM kill.", memUsedPct, int(runningQueries)),
			DedupKey:  instance + ":cross:oom_risk",
			Timestamp: now,
		})
	}
}

func (a *Analyzer) computeHealthScore(instance string, alerts, crossAlerts []collector.Alert) HealthScore {
	score := 100

	// Deduplicate by category+severity so per-table/per-query alerts (which embed
	// table names in their title) don't each deduct separately. For example, 10
	// tables with cold parts all share the "tables" category and count as one
	// critical deduction rather than 10.
	type dedupKey struct{ category, severity string }
	seen := make(map[dedupKey]bool)
	issueSet := make(map[string]bool)

	var totalDeduct int
	allAlerts := append(alerts, crossAlerts...)
	for _, alert := range allAlerts {
		if alert.Instance != instance && alert.Instance != "" {
			continue
		}
		issueSet[alert.Title] = true
		k := dedupKey{alert.Category, string(alert.Severity)}
		if seen[k] {
			continue
		}
		seen[k] = true
		switch alert.Severity {
		case collector.SeverityCritical:
			totalDeduct += 30
		case collector.SeverityWarn:
			totalDeduct += 8
		case collector.SeverityInfo:
			totalDeduct += 2
		}
	}

	// Deductions are per distinct (category, severity), so scores map to the UI
	// bands (critical <50, warning <80, else healthy) as:
	//   0 issues            -> 100  healthy
	//   1 critical category ->  70  warning
	//   2 critical categories-> 40  critical
	//   3 warn categories   ->  76  warning
	// The old code capped deductions at 50, so the score floored at 50 and the
	// "critical" band (<50) — and any SLO metric counting score<50 — was
	// literally unreachable. Allow the score to fall to 0.
	if totalDeduct > 100 {
		totalDeduct = 100
	}
	score -= totalDeduct

	if score < 0 {
		score = 0
	}

	issues := make([]string, 0, len(issueSet))
	for issue := range issueSet {
		issues = append(issues, issue)
	}
	sort.Strings(issues)

	return HealthScore{
		Instance: instance,
		Score:    score,
		Issues:   issues,
	}
}

// ---------------------------------------------------------------------------
// Query normalisation
// ---------------------------------------------------------------------------

var (
	reStringLiteral = regexp.MustCompile(`'[^']*'`)
	reNumberLiteral = regexp.MustCompile(`\b\d+\.?\d*\b`)
	reInList        = regexp.MustCompile(`IN\s*\([^)]+\)`)
	reWhitespace    = regexp.MustCompile(`\s+`)
)

// NormalizeQuery replaces literals in SQL with placeholders for grouping.
func NormalizeQuery(sql string) string {
	s := reStringLiteral.ReplaceAllString(sql, "'?'")
	s = reInList.ReplaceAllString(s, "IN (?)")
	s = reNumberLiteral.ReplaceAllString(s, "?")
	s = reWhitespace.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// ---------------------------------------------------------------------------
// RingBuffer
// ---------------------------------------------------------------------------

// RingBuffer is a fixed-size circular buffer of float64 values.
type RingBuffer struct {
	values []float64
	size   int
	pos    int
	count  int
}

// NewRingBuffer creates a ring buffer that holds up to size values.
func NewRingBuffer(size int) *RingBuffer {
	return &RingBuffer{
		values: make([]float64, size),
		size:   size,
	}
}

// Add appends a value, overwriting the oldest if full.
func (rb *RingBuffer) Add(v float64) {
	rb.values[rb.pos] = v
	rb.pos = (rb.pos + 1) % rb.size
	if rb.count < rb.size {
		rb.count++
	}
}

// All returns all stored values in insertion order.
func (rb *RingBuffer) All() []float64 {
	if rb.count < rb.size {
		return append([]float64(nil), rb.values[:rb.count]...)
	}
	out := make([]float64, rb.size)
	copy(out, rb.values[rb.pos:])
	copy(out[rb.size-rb.pos:], rb.values[:rb.pos])
	return out
}

// Count returns how many values are stored.
func (rb *RingBuffer) Count() int { return rb.count }

// Last returns the most recently added value.
func (rb *RingBuffer) Last() float64 {
	if rb.count == 0 {
		return 0
	}
	idx := (rb.pos - 1 + rb.size) % rb.size
	return rb.values[idx]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func mean(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range vals {
		sum += v
	}
	return sum / float64(len(vals))
}

func stddev(vals []float64, m float64) float64 {
	if len(vals) < 2 {
		return 0
	}
	sum := 0.0
	for _, v := range vals {
		d := v - m
		sum += d * d
	}
	return math.Sqrt(sum / float64(len(vals)-1))
}

// anomalySignificant filters out statistically-significant-but-practically-
// meaningless anomalies. Low-cardinality integer metrics (e.g. "number of
// tables receiving inserts") sit near-constant, so a ±1 wiggle is many sigmas
// even though 1→2 means nothing. We additionally require a real movement:
//   - a minimum absolute delta when the baseline itself is tiny, and
//   - at least a 20% jump over baseline on top of the z-score gate.
func anomalySignificant(val, m float64) bool {
	delta := val - m
	if m < 10 && delta < 3 {
		return false
	}
	if m > 0 && delta < 0.20*m {
		return false
	}
	return true
}

type metricUnit int

const (
	unitPlain metricUnit = iota
	unitBytes
	unitRows
	unitCount
	unitSeconds
	unitMs
	unitPercent
)

// metricMeta turns a raw metric key like "queries.running.read_rows" into a
// human label, a display unit, and a one-line hint about what a spike means.
// Anomaly detection runs over arbitrary collector metrics, so we match known
// keys explicitly and fall back to keyword inference — no metric is ever left
// shown as a raw dotted key.
func metricMeta(name string) (label string, unit metricUnit, hint string) {
	switch name {
	case "queries.running.read_rows":
		return "rows read by in-flight queries", unitRows, "Usually a heavy new query or a full-table scan — check Live Queries."
	case "queries.running.read_bytes":
		return "bytes read by in-flight queries", unitBytes, "Usually a heavy new query or a full-table scan — check Live Queries."
	case "inserts.table.count":
		return "tables receiving inserts", unitCount, "More tables than usual are being written to — often a new pipeline or backfill."
	case "inserts.table.rows":
		return "rows inserted per table", unitRows, "A spike is usually a bulk load; a drop can mean a stalled producer."
	case "inserts.seconds_since_last":
		return "seconds since the last insert", unitSeconds, "A rising value means inserts have slowed or stopped — possible pipeline stall."
	case "mvs.timing.executions":
		return "materialized-view executions", unitCount, "MVs are firing more often than usual — normally tracks insert volume."
	case "system.async.OSCPUOverload":
		return "OS CPU overload indicator", unitPlain, "The host CPU is oversubscribed — queries and merges may slow down."
	case "tables.disk_balance.bytes":
		return "table storage imbalance", unitBytes, "Data is spread unevenly across disks or tables."
	case "storage.distribution.rows":
		return "row distribution across storage", unitRows, "The spread of rows across parts/tables shifted."
	case "storage.distribution.bytes":
		return "byte distribution across storage", unitBytes, "The spread of bytes across parts/tables shifted."
	}
	switch {
	case strings.Contains(name, "bytes"):
		unit = unitBytes
	case strings.Contains(name, "rows"):
		unit = unitRows
	case strings.Contains(name, "seconds") || strings.HasSuffix(name, "_secs"):
		unit = unitSeconds
	case strings.HasSuffix(name, "_ms") || strings.Contains(name, "millis"):
		unit = unitMs
	case strings.Contains(name, "pct") || strings.Contains(name, "percent") || strings.Contains(name, "ratio"):
		unit = unitPercent
	case strings.Contains(name, "count") || strings.Contains(name, "executions") || strings.Contains(name, "num_"):
		unit = unitCount
	default:
		unit = unitPlain
	}
	label = strings.NewReplacer(".", " ", "_", " ").Replace(name)
	return label, unit, ""
}

func fmtMetricValue(unit metricUnit, v float64) string {
	switch unit {
	case unitBytes:
		return humanBytes(v)
	case unitSeconds:
		return fmt.Sprintf("%.0fs", v)
	case unitMs:
		return fmt.Sprintf("%.0fms", v)
	case unitPercent:
		return fmt.Sprintf("%.1f%%", v)
	case unitRows, unitCount:
		return humanCount(v)
	default:
		if v == math.Trunc(v) && math.Abs(v) < 1e15 {
			return humanCount(v)
		}
		return fmt.Sprintf("%.2f", v)
	}
}

func humanCount(v float64) string {
	a := math.Abs(v)
	switch {
	case a >= 1e9:
		return fmt.Sprintf("%.1fB", v/1e9)
	case a >= 1e6:
		return fmt.Sprintf("%.1fM", v/1e6)
	case a >= 1e3:
		return fmt.Sprintf("%.1fK", v/1e3)
	default:
		return fmt.Sprintf("%.0f", v)
	}
}

func humanBytes(v float64) string {
	a := math.Abs(v)
	const k = 1024.0
	switch {
	case a >= k*k*k*k:
		return fmt.Sprintf("%.1f TB", v/(k*k*k*k))
	case a >= k*k*k:
		return fmt.Sprintf("%.1f GB", v/(k*k*k))
	case a >= k*k:
		return fmt.Sprintf("%.1f MB", v/(k*k))
	case a >= k:
		return fmt.Sprintf("%.1f KB", v/k)
	default:
		return fmt.Sprintf("%.0f B", v)
	}
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// formatAnomaly renders a plain-English anomaly description: what the metric is,
// what it jumped to vs its baseline, how big the jump is, and what it usually
// means. Ends with "(metric: <key>)" for traceability. Keeps the word
// "baseline" so the frontend still recognises it as an anomaly alert.
func formatAnomaly(name string, val, m, sd float64) string {
	label, unit, hint := metricMeta(name)
	z := (val - m) / sd
	ratio := ""
	if m > 0 {
		ratio = fmt.Sprintf(" (~%.1f× normal)", val/m)
	}
	msg := fmt.Sprintf("%s jumped to %s, vs a typical %s%s — %.1fσ above the recent baseline.",
		capitalize(label), fmtMetricValue(unit, val), fmtMetricValue(unit, m), ratio, z)
	if hint != "" {
		msg += " " + hint
	}
	return msg + fmt.Sprintf(" (metric: %s)", name)
}

func formatSustained(name string, val, m float64, n int) string {
	label, unit, hint := metricMeta(name)
	msg := fmt.Sprintf("%s has stayed elevated for %d consecutive checks — now %s, vs a typical %s. This is a persistent shift, not a one-off spike.",
		capitalize(label), n, fmtMetricValue(unit, val), fmtMetricValue(unit, m))
	if hint != "" {
		msg += " " + hint
	}
	return msg + fmt.Sprintf(" (metric: %s)", name)
}

func formatf(format string, args ...interface{}) string {
	return fmt.Sprintf(format, args...)
}
