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
	ID          int64
	Instance    string
	Severity    string
	Category    string
	Title       string
	Message     string
	Resolved    bool
	ResolvedAt  *time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
	DedupKey    string
	FirstSeenAt time.Time // time the alert first fired (preserved across restarts)
	FireCount   int       // cumulative fire count (preserved across restarts)
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

// New creates a Store. Schema (including migrations) must already exist —
// see schema.sql. ch-analyzer no longer runs DDL at startup; operators are
// expected to run schema.sql whenever they upgrade to a release that added
// columns or changed TTLs.
func New(manager *chclient.Manager, database string) (*Store, error) {
	if database == "" {
		database = "ch_analyzer"
	}

	s := &Store{
		manager:  manager,
		database: database,
	}

	// One-shot data cleanup: collapse historical duplicate active alerts.
	// Prior bugs could leave multiple resolved=0 rows for the same dedup_key
	// across different created_at values. This is DML (not DDL) so it stays
	// in code — schema.sql only describes shape, not content repair.
	s.cleanupDuplicateActiveAlerts()

	slog.Info("store initialized", "backend", "clickhouse-distributed", "database", database, "instances", manager.Len())
	return s, nil
}

// cleanupDuplicateActiveAlerts collapses any dedup_key with multiple unresolved
// rows (across distinct created_at values) down to a single active row — the
// latest firing event. All older unresolved firings for that key get a new
// version with resolved=1, resolved_at=now().
//
// This addresses historical bugs where a re-fire path inserted a new row for
// the same alert without resolving the prior one, leading to ghost duplicates
// in GetAlertHistory and in any consumer counting unresolved events over time.
//
// Per-instance cleanup is capped at 10s so a slow CH can't block startup; on
// timeout we log and move on (the next restart retries). The logic is two-pass
// to stay compatible with CH versions that don't support OFFSET BY: first find
// the offending dedup_keys and the (per-key) latest created_at to keep, then
// resolve every other (dedup_key, created_at) firing for those keys.
func (s *Store) cleanupDuplicateActiveAlerts() {
	s.manager.ForEach(func(name string, client *chclient.Client) error {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		// Step 1: collapse each (dedup_key, created_at) to its latest version,
		// keep only unresolved rows. Count firings per dedup_key; offenders
		// have >1 distinct created_at firings still unresolved.
		offenderSQL := fmt.Sprintf(`
			SELECT dedup_key, max(created_at) AS keep_created_at, count() AS firings
			FROM (
				SELECT dedup_key, created_at, argMax(resolved, version) AS resolved
				FROM %s.alerts
				GROUP BY dedup_key, created_at
			)
			WHERE resolved = 0
			GROUP BY dedup_key
			HAVING firings > 1`,
			s.database)

		offenders, err := client.Query(ctx, offenderSQL)
		if err != nil {
			if ctx.Err() != nil {
				slog.Warn("alert cleanup: offender scan timed out",
					"instance", name, "err", err)
			} else {
				slog.Warn("alert cleanup: offender scan failed",
					"instance", name, "err", err)
			}
			return nil
		}
		if len(offenders) == 0 {
			return nil
		}

		// Build a map: dedup_key → keep_created_at. We resolve every other
		// (dedup_key, created_at) firing that is still unresolved.
		type keepRow struct {
			dedupKey      string
			keepCreatedAt string
		}
		keeps := make([]keepRow, 0, len(offenders))
		for _, row := range offenders {
			dk := getString(row, "dedup_key")
			ts := getString(row, "keep_created_at")
			if dk == "" || ts == "" {
				continue
			}
			keeps = append(keeps, keepRow{dedupKey: dk, keepCreatedAt: ts})
		}
		if len(keeps) == 0 {
			return nil
		}

		// Step 2: build a big WHERE (dedup_key, created_at) NOT IN (kept pairs)
		// filter and resolve the rest. We use an IN on dedup_key plus a <>
		// check on created_at per key by generating OR clauses in pairs.
		quotedKeys := make([]string, 0, len(keeps))
		notEqualClauses := make([]string, 0, len(keeps))
		for _, k := range keeps {
			quotedKeys = append(quotedKeys, "'"+escape(k.dedupKey)+"'")
			// "resolve this dedup_key's row when created_at != its keep value"
			notEqualClauses = append(notEqualClauses, fmt.Sprintf(
				"(dedup_key = '%s' AND created_at != '%s')",
				escape(k.dedupKey), escape(k.keepCreatedAt)))
		}
		inClause := strings.Join(quotedKeys, ", ")
		perKeyOr := strings.Join(notEqualClauses, " OR ")

		// Insert a resolved=1 new version for every (dedup_key, created_at)
		// row in the offender set that is NOT the kept firing and is still
		// unresolved. Uses LIMIT 1 BY (dedup_key, created_at) to pick the
		// latest version of each row, matching the pattern used elsewhere.
		resolveSQL := fmt.Sprintf(`INSERT INTO %s.alerts
			(id, instance, severity, category, title, message,
			 resolved, resolved_at, created_at, dedup_key, version, updated_at,
			 first_seen_at, fire_count)
			SELECT id, instance, severity, category, title, message,
				1 AS resolved, now() AS resolved_at, created_at, dedup_key,
				version+1 AS version, now() AS updated_at,
				first_seen_at, fire_count
			FROM (
				SELECT id, instance, severity, category, title, message,
					resolved, resolved_at, created_at, dedup_key, version,
					updated_at, first_seen_at, fire_count
				FROM %s.alerts
				WHERE dedup_key IN (%s)
				  AND (%s)
				ORDER BY dedup_key, created_at, version DESC
				LIMIT 1 BY (dedup_key, created_at)
			)
			WHERE resolved = 0`,
			s.database, s.database, inClause, perKeyOr)

		// Count rows we're about to resolve so we can log a useful summary.
		countSQL := fmt.Sprintf(`
			SELECT count() AS cnt FROM (
				SELECT id, resolved
				FROM %s.alerts
				WHERE dedup_key IN (%s)
				  AND (%s)
				ORDER BY dedup_key, created_at, version DESC
				LIMIT 1 BY (dedup_key, created_at)
			) WHERE resolved = 0`,
			s.database, inClause, perKeyOr)
		var rowsResolved int64
		if val, cerr := client.QuerySingleValue(ctx, countSQL); cerr == nil {
			fmt.Sscanf(val, "%d", &rowsResolved)
		}

		if _, err := client.QuerySingleValue(ctx, resolveSQL); err != nil {
			if ctx.Err() != nil {
				slog.Warn("alert cleanup: resolve duplicates timed out",
					"instance", name, "err", err)
			} else {
				slog.Warn("alert cleanup: resolve duplicates failed",
					"instance", name, "err", err)
			}
			return nil
		}

		slog.Info("alert cleanup: resolved duplicate active alerts",
			"instance", name,
			"dedup_keys_cleaned", len(keeps),
			"rows_resolved", rowsResolved)
		return nil
	})
}

// Close is a no-op for ClickHouse.
func (s *Store) Close() error { return nil }

// Database returns the configured database name.
func (s *Store) Database() string { return s.database }

// clientFor returns the CH client for the given instance name, or nil if the
// instance isn't registered. The previous fallback-to-first-client behavior
// was a silent foot-gun: an alert tagged with an unknown instance would land
// on an unrelated node's alerts table, making it invisible to the UI filter
// and triggering nonsense Slack routing. Callers must now handle nil.
func (s *Store) clientFor(instance string) *chclient.Client {
	return s.manager.Get(instance)
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
//
// Carry-forward semantics: if any prior row exists for the same dedup_key
// (resolved or not), the insertion preserves the earliest first_seen_at across
// all prior rows and advances fire_count to (max prior fire_count + 1). This
// ensures that when a condition resolves and re-fires, the UI shows cumulative
// lifetime stats rather than resetting each time.
//
// Explicit values on the incoming alert override carry-forward: this lets tests
// and specialized callers pin first_seen_at / fire_count without the DB lookup.
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

	firstSeenAt := alert.FirstSeenAt
	fireCount := alert.FireCount

	// Carry-forward from prior rows when caller didn't pin the values.
	if firstSeenAt.IsZero() || fireCount <= 0 {
		priorFS, priorFC := s.priorFireStats(ctx, client, alert.DedupKey)
		if firstSeenAt.IsZero() {
			if !priorFS.IsZero() {
				firstSeenAt = priorFS
			} else {
				firstSeenAt = alert.CreatedAt
			}
		}
		if fireCount <= 0 {
			fireCount = priorFC + 1
		}
	}

	firstSeenAtStr := firstSeenAt.Format("2006-01-02 15:04:05")

	sql := fmt.Sprintf(`INSERT INTO %s.alerts
		(id, instance, severity, category, title, message, resolved, resolved_at, created_at, dedup_key, version, updated_at, first_seen_at, fire_count)
		VALUES (%d, '%s', '%s', '%s', '%s', '%s', 0, NULL, '%s', '%s', 1, '%s', '%s', %d)`,
		s.database, id,
		escape(alert.Instance), escape(alert.Severity), escape(alert.Category),
		escape(alert.Title), msg, ts, escape(alert.DedupKey), ts, firstSeenAtStr, fireCount)

	if _, err := client.QuerySingleValue(ctx, sql); err != nil {
		return 0, fmt.Errorf("store: insert alert: %w", err)
	}

	slog.Info("alert inserted", "id", id, "instance", alert.Instance, "severity", alert.Severity, "title", alert.Title, "fire_count", fireCount)
	return id, nil
}

// priorFireStats returns the earliest first_seen_at and max fire_count across
// all historic rows for the given dedup_key. Returns zero values if no prior
// row exists or the lookup fails. Best-effort: errors are logged at debug level
// and swallowed — a missing prior is just "this alert has never fired before".
func (s *Store) priorFireStats(ctx context.Context, client *chclient.Client, dedupKey string) (time.Time, int) {
	sql := fmt.Sprintf(
		`SELECT
			min(first_seen_at) AS first_seen,
			max(fire_count)    AS fire_count
		FROM %s.alerts
		WHERE dedup_key = '%s'`,
		s.database, escape(dedupKey),
	)
	rows, err := client.Query(ctx, sql)
	if err != nil || len(rows) == 0 {
		if err != nil {
			slog.Debug("store: prior fire stats lookup failed", "dedup_key", dedupKey, "err", err)
		}
		return time.Time{}, 0
	}
	row := rows[0]
	fsStr := getString(row, "first_seen")
	fc := int(getFloat(row, "fire_count"))
	var firstSeen time.Time
	if fsStr != "" && fsStr != "\\N" && fsStr != "1970-01-01 00:00:00" {
		if t, perr := time.Parse("2006-01-02 15:04:05", fsStr); perr == nil {
			firstSeen = t
		}
	}
	return firstSeen, fc
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

	// Resolve ALL unresolved rows for this dedup_key. There may be more than one
	// if previous cycles failed and InsertAlert created rows with different created_at
	// values (different ORDER BY keys = separate CH entities).
	// Use LIMIT 1 BY (dedup_key, created_at) instead of FINAL: FINAL forces an
	// expensive in-memory merge of all unmerged parts; LIMIT 1 BY just picks the
	// highest version per key without forcing a merge.
	insertSQL := fmt.Sprintf(`INSERT INTO %s.alerts
		(id, instance, severity, category, title, message, resolved, resolved_at, created_at, dedup_key, version, updated_at)
		SELECT id, instance, severity, category, title, message, 1, '%s', created_at, dedup_key, version+1, updated_at
		FROM (
			SELECT id, instance, severity, category, title, message, resolved, resolved_at, created_at, dedup_key, version, updated_at
			FROM %s.alerts
			WHERE dedup_key = '%s'
			ORDER BY dedup_key, created_at, version DESC
			LIMIT 1 BY (dedup_key, created_at)
		)
		WHERE resolved = 0`,
		s.database, now,
		s.database, escape(dedupKey))

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
		sql := fmt.Sprintf(`SELECT count() as cnt FROM (
				SELECT resolved FROM %s.alerts
				WHERE dedup_key = '%s'
				ORDER BY dedup_key, created_at, version DESC
				LIMIT 1 BY (dedup_key, created_at)
			) WHERE resolved = 0`,
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

	// Avoid FINAL: BulkTouchAlerts inserts a new version every poll cycle, so
	// unmerged parts accumulate faster than CH can background-merge them.
	// FINAL forces an expensive in-memory merge that can exceed the 10s timeout,
	// returning nil → UI shows 0 active alerts for several minutes.
	//
	// Dedup by dedup_key (not by the (dedup_key, created_at) tuple): an alert
	// may have multiple rows across different created_at values when prior bugs
	// inserted re-fire rows without resolving the earlier one. We want the
	// *latest* firing event per alert — picked via created_at DESC, version
	// DESC — then filter WHERE resolved = 0. That way ghost duplicates don't
	// inflate counts across UI views.
	sql := fmt.Sprintf(`SELECT id, instance, severity, category, title, message,
			resolved, resolved_at, created_at, dedup_key, updated_at
		FROM (
			SELECT id, instance, severity, category, title, message,
				resolved, resolved_at, created_at, dedup_key, updated_at
			FROM %s.alerts
			WHERE instance = '%s'
			ORDER BY dedup_key, created_at DESC, version DESC
			LIMIT 1 BY dedup_key
		)
		WHERE resolved = 0
		ORDER BY created_at DESC`,
		s.database, escape(instance))

	rows, err := client.Query(ctx, sql)
	if err != nil {
		return nil, fmt.Errorf("store: get active alerts: %w", err)
	}
	return parseAlertRows(rows), nil
}

// GetAllActiveAlerts returns unresolved alerts across every registered instance,
// unioned and tagged by instance. Per-instance failures are logged and skipped
// so one unhealthy node can't block reconciliation for the rest.
func (s *Store) GetAllActiveAlerts() []Alert {
	var all []Alert
	s.manager.ForEach(func(name string, _ *chclient.Client) error {
		alerts, err := s.GetActiveAlerts(name)
		if err != nil {
			slog.Warn("GetAllActiveAlerts: per-instance query failed",
				"instance", name, "err", err)
			return nil // continue iteration
		}
		all = append(all, alerts...)
		return nil
	})
	return all
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
			resolved, resolved_at, created_at, dedup_key, updated_at
		FROM (
			SELECT id, instance, severity, category, title, message,
				resolved, resolved_at, created_at, dedup_key, updated_at
			FROM %s.alerts
			WHERE instance = '%s'
			AND created_at >= '%s' AND created_at <= '%s'
			ORDER BY dedup_key, created_at, version DESC
			LIMIT 1 BY (dedup_key, created_at)
		)
		ORDER BY created_at DESC LIMIT %d`,
		s.database, escape(instance),
		from.Format("2006-01-02 15:04:05"), to.Format("2006-01-02 15:04:05"), limit)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		return nil, fmt.Errorf("store: get alert history: %w", err)
	}
	return parseAlertRows(rows), nil
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
// Health Snapshots
// ---------------------------------------------------------------------------

// HealthSnapshot is a single health-score data point returned by GetHealthTrend.
type HealthSnapshot struct {
	Timestamp time.Time `json:"ts"`
	Score     float32   `json:"score"`
	Criticals int       `json:"criticals"`
	Warns     int       `json:"warns"`
}

// RecordHealthSnapshot stores a score snapshot for the given instance.
// score = max(0, 100 - criticals*15 - warns*5).
func (s *Store) RecordHealthSnapshot(ctx context.Context, instance string, score float32, criticals, warns, infos int) error {
	client := s.clientFor(instance)
	if client == nil {
		return fmt.Errorf("no client for instance %s", instance)
	}

	sql := fmt.Sprintf(`INSERT INTO %s.health_snapshots (instance, score, criticals, warns, infos) VALUES ('%s', %f, %d, %d, %d)`,
		s.database, escape(instance), score, criticals, warns, infos)

	if _, err := client.QuerySingleValue(ctx, sql); err != nil {
		return fmt.Errorf("store: record health snapshot: %w", err)
	}
	return nil
}

// GetHealthTrend returns bucketed (ts, score, criticals, warns) pairs for the given instance and time range.
// Returns up to ~200 points, bucketed based on range width.
func (s *Store) GetHealthTrend(ctx context.Context, instance string, from, to time.Time) ([]HealthSnapshot, error) {
	client := s.clientFor(instance)
	if client == nil {
		return nil, fmt.Errorf("no client for instance %s", instance)
	}

	rangeSeconds := to.Unix() - from.Unix()
	if rangeSeconds <= 0 {
		return nil, nil
	}

	// Choose bucket size: ~200 points, min 5 minutes, max 4 hours.
	bucketSize := rangeSeconds / 200
	if bucketSize < 300 {
		bucketSize = 300 // minimum 5 minutes
	}
	if bucketSize > 14400 {
		bucketSize = 14400 // maximum 4 hours
	}

	sql := fmt.Sprintf(`SELECT
		toDateTime(intDiv(toUInt32(ts), %d) * %d) AS bucket_ts,
		avg(score) AS avg_score,
		sum(criticals) AS sum_criticals,
		sum(warns) AS sum_warns
	FROM %s.health_snapshots
	WHERE instance = '%s'
	AND ts >= '%s' AND ts <= '%s'
	GROUP BY bucket_ts
	ORDER BY bucket_ts ASC
	LIMIT 200`,
		bucketSize, bucketSize,
		s.database, escape(instance),
		from.Format("2006-01-02 15:04:05"), to.Format("2006-01-02 15:04:05"))

	rows, err := client.Query(ctx, sql)
	if err != nil {
		return nil, fmt.Errorf("store: get health trend: %w", err)
	}

	var result []HealthSnapshot
	for _, row := range rows {
		tsStr := getString(row, "bucket_ts")
		t, _ := time.Parse("2006-01-02 15:04:05", tsStr)
		result = append(result, HealthSnapshot{
			Timestamp: t,
			Score:     float32(getFloat(row, "avg_score")),
			Criticals: int(getFloat(row, "sum_criticals")),
			Warns:     int(getFloat(row, "sum_warns")),
		})
	}
	return result, nil
}

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
			ID:        int64(getFloat(row, "id")),
			Instance:  getString(row, "instance"),
			Severity:  getString(row, "severity"),
			Category:  getString(row, "category"),
			Title:     getString(row, "title"),
			Message:   getString(row, "message"),
			DedupKey:  getString(row, "dedup_key"),
			FireCount: int(getFloat(row, "fire_count")),
		}
		a.Resolved = getFloat(row, "resolved") > 0
		a.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", getString(row, "created_at"))
		updatedStr := getString(row, "updated_at")
		if updatedStr != "" && updatedStr != "\\N" && updatedStr != "1970-01-01 00:00:00" {
			if t, err := time.Parse("2006-01-02 15:04:05", updatedStr); err == nil {
				a.UpdatedAt = t
			}
		}
		if a.UpdatedAt.IsZero() {
			a.UpdatedAt = a.CreatedAt
		}
		resolvedStr := getString(row, "resolved_at")
		if resolvedStr != "" && resolvedStr != "\\N" && resolvedStr != "1970-01-01 00:00:00" {
			if t, err := time.Parse("2006-01-02 15:04:05", resolvedStr); err == nil {
				a.ResolvedAt = &t
			}
		}
		firstSeenStr := getString(row, "first_seen_at")
		if firstSeenStr != "" && firstSeenStr != "\\N" && firstSeenStr != "1970-01-01 00:00:00" {
			if t, err := time.Parse("2006-01-02 15:04:05", firstSeenStr); err == nil {
				a.FirstSeenAt = t
			}
		}
		if a.FirstSeenAt.IsZero() {
			a.FirstSeenAt = a.CreatedAt
		}
		alerts = append(alerts, a)
	}
	return alerts
}

// BulkTouchAlerts updates updated_at = now() for all active alerts with the given dedup keys.
// Called after each poll cycle to keep staleness timestamps fresh.
func (s *Store) BulkTouchAlerts(dedupKeys []string) error {
	if len(dedupKeys) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Build IN clause.
	quoted := make([]string, len(dedupKeys))
	for i, k := range dedupKeys {
		quoted[i] = "'" + escape(k) + "'"
	}
	inClause := strings.Join(quoted, ", ")

	// Touch the LATEST unresolved firing per dedup_key only. Prior code used
	// LIMIT 1 BY (dedup_key, created_at) which would touch every historical
	// unresolved ghost row (shouldn't exist post-cleanupDuplicateActiveAlerts,
	// but defend in depth so a race can't keep a ghost "fresh" forever).
	sql := fmt.Sprintf(`INSERT INTO %s.alerts
		(id, instance, severity, category, title, message, resolved, resolved_at, created_at, dedup_key, version, updated_at)
		SELECT id, instance, severity, category, title, message, resolved, resolved_at, created_at, dedup_key, version+1, now()
		FROM (
			SELECT id, instance, severity, category, title, message, resolved, resolved_at, created_at, dedup_key, version, updated_at
			FROM %s.alerts
			WHERE dedup_key IN (%s)
			ORDER BY dedup_key, created_at DESC, version DESC
			LIMIT 1 BY dedup_key
		)
		WHERE resolved = 0`,
		s.database, s.database, inClause)

	s.manager.ForEach(func(_ string, client *chclient.Client) error {
		if _, err := client.QuerySingleValue(ctx, sql); err != nil {
			slog.Debug("bulk touch alerts failed", "err", err)
		}
		return nil
	})
	return nil
}

// AutoResolveStale marks any resolved=0 alert whose updated_at is older than
// olderThan as resolved. Thin wrapper around BulkResolveStale that accepts a
// Duration so callers don't need to reason about whole-hour rounding.
// Durations less than an hour are clamped to 1 hour.
func (s *Store) AutoResolveStale(olderThan time.Duration) (int64, error) {
	hours := int(olderThan / time.Hour)
	if hours < 1 {
		hours = 1
	}
	return s.BulkResolveStale(hours)
}

// BulkResolveStale marks all unresolved alerts whose updated_at is older than
// the given number of hours as resolved. Returns the number of alerts resolved.
func (s *Store) BulkResolveStale(hours int) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var total int64
	s.manager.ForEach(func(_ string, client *chclient.Client) error {
		// Count first.
		countSQL := fmt.Sprintf(
			`SELECT count() as cnt FROM %s.alerts FINAL WHERE resolved = 0 AND updated_at < now() - INTERVAL %d HOUR`,
			s.database, hours)
		if val, err := client.QuerySingleValue(ctx, countSQL); err == nil {
			var n int64
			fmt.Sscanf(val, "%d", &n)
			total += n
		}

		resolveSQL := fmt.Sprintf(`INSERT INTO %s.alerts
			(id, instance, severity, category, title, message, resolved, resolved_at, created_at, dedup_key, version, updated_at)
			SELECT id, instance, severity, category, title, message, 1, now(), created_at, dedup_key, version+1, updated_at
			FROM %s.alerts FINAL
			WHERE resolved = 0 AND updated_at < now() - INTERVAL %d HOUR`,
			s.database, s.database, hours)
		if _, err := client.QuerySingleValue(ctx, resolveSQL); err != nil {
			slog.Warn("bulk resolve stale failed", "err", err)
		}
		return nil
	})
	return total, nil
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
	case json.Number:
		f, _ := val.Float64()
		return f
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
	case json.Number:
		return val.String()
	case float64:
		if val == float64(int64(val)) {
			return fmt.Sprintf("%d", int64(val))
		}
		return fmt.Sprintf("%f", val)
	default:
		return fmt.Sprintf("%v", v)
	}
}
