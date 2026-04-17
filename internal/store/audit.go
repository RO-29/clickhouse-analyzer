package store

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// AuditEvent represents a tracked action.
type AuditEvent struct {
	ID       string `json:"id"`
	Instance string `json:"instance"` // empty string = system-wide action
	Action   string `json:"action"`   // e.g. "alert_resolve", "alert_snooze", "maintenance_create"
	Actor    string `json:"actor"`    // who did it (IP, user, "system")
	Details  string `json:"details"`  // free-form JSON string or description
	Ts       int64  `json:"ts"`       // unix epoch seconds
}

// AuditLogQuery holds optional filters for GetAuditLog.
type AuditLogQuery struct {
	Instance string
	Action   string
	From     time.Time
	To       time.Time
	Limit    int // default 200
}

// InitAuditLog creates the audit_log table on every CH instance.
// Safe to call multiple times — CREATE TABLE IF NOT EXISTS is idempotent.
func (s *Store) InitAuditLog() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	sql := fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s.audit_log (
		id       String,
		instance LowCardinality(String) DEFAULT '',
		action   LowCardinality(String),
		actor    String DEFAULT '',
		details  String DEFAULT '',
		ts       DateTime DEFAULT now()
	) ENGINE = MergeTree()
	ORDER BY (ts, instance, action)
	TTL ts + INTERVAL 90 DAY`, s.database)

	s.manager.ForEach(func(name string, client *chclient.Client) error {
		if _, err := client.QuerySingleValue(ctx, sql); err != nil {
			slog.Warn("audit_log: create table failed", "instance", name, "err", err)
		}
		return nil
	})
}

// LogAction inserts one audit event into the relevant instance's CH.
// If instance is empty, writes to the first available instance.
func (s *Store) LogAction(ctx context.Context, instance, action, actor, details string) error {
	client := s.clientFor(instance)
	if client == nil {
		return fmt.Errorf("store: LogAction: no client available for instance %q", instance)
	}

	id := fmt.Sprintf("%d", time.Now().UnixNano())
	ts := time.Now().Format("2006-01-02 15:04:05")

	sql := fmt.Sprintf(`INSERT INTO %s.audit_log (id, instance, action, actor, details, ts) VALUES ('%s', '%s', '%s', '%s', '%s', '%s')`,
		s.database,
		escape(id),
		escape(instance),
		escape(action),
		escape(actor),
		escape(details),
		ts,
	)

	if _, err := client.QuerySingleValue(ctx, sql); err != nil {
		return fmt.Errorf("store: LogAction: %w", err)
	}

	slog.Info("audit event logged", "instance", instance, "action", action, "actor", actor)
	return nil
}

// GetAuditLog returns recent audit events sorted by ts DESC.
// Supports optional filters: instance, action, from/to timestamps, limit.
// When opts.Instance is empty, fans out across all registered instances and merges results.
func (s *Store) GetAuditLog(ctx context.Context, opts AuditLogQuery) ([]AuditEvent, error) {
	if opts.Limit <= 0 {
		opts.Limit = 200
	}

	// Build WHERE clauses (instance filter only applied when a specific instance is requested).
	buildWhere := func(includeInstance bool) string {
		var whereClauses []string
		if includeInstance && opts.Instance != "" {
			whereClauses = append(whereClauses, fmt.Sprintf("instance = '%s'", escape(opts.Instance)))
		}
		if opts.Action != "" {
			whereClauses = append(whereClauses, fmt.Sprintf("action = '%s'", escape(opts.Action)))
		}
		if !opts.From.IsZero() {
			whereClauses = append(whereClauses, fmt.Sprintf("ts >= '%s'", opts.From.Format("2006-01-02 15:04:05")))
		}
		if !opts.To.IsZero() {
			whereClauses = append(whereClauses, fmt.Sprintf("ts <= '%s'", opts.To.Format("2006-01-02 15:04:05")))
		}
		if len(whereClauses) > 0 {
			return "WHERE " + strings.Join(whereClauses, " AND ")
		}
		return ""
	}

	parseRows := func(rows []map[string]interface{}) []AuditEvent {
		var events []AuditEvent
		for _, row := range rows {
			tsStr := getString(row, "ts")
			t, _ := time.Parse("2006-01-02 15:04:05", tsStr)
			events = append(events, AuditEvent{
				ID:       getString(row, "id"),
				Instance: getString(row, "instance"),
				Action:   getString(row, "action"),
				Actor:    getString(row, "actor"),
				Details:  getString(row, "details"),
				Ts:       t.Unix(),
			})
		}
		return events
	}

	// If a specific instance is requested, query only that instance.
	if opts.Instance != "" {
		client := s.clientFor(opts.Instance)
		if client == nil {
			return nil, fmt.Errorf("store: GetAuditLog: no client available for instance %q", opts.Instance)
		}
		whereSQL := buildWhere(true)
		sql := fmt.Sprintf(`SELECT id, instance, action, actor, details, ts
			FROM %s.audit_log
			%s
			ORDER BY ts DESC
			LIMIT %d`,
			s.database, whereSQL, opts.Limit)
		rows, err := client.Query(ctx, sql)
		if err != nil {
			return nil, fmt.Errorf("store: GetAuditLog: %w", err)
		}
		return parseRows(rows), nil
	}

	// No instance filter — fan out across all instances and merge.
	names := s.manager.Names()
	if len(names) == 0 {
		return nil, fmt.Errorf("store: GetAuditLog: no clients available")
	}

	whereSQL := buildWhere(false)
	var merged []AuditEvent
	seen := make(map[string]bool)

	for _, name := range names {
		client := s.manager.Get(name)
		if client == nil {
			continue
		}
		sql := fmt.Sprintf(`SELECT id, instance, action, actor, details, ts
			FROM %s.audit_log
			%s
			ORDER BY ts DESC
			LIMIT %d`,
			s.database, whereSQL, opts.Limit)
		rows, err := client.Query(ctx, sql)
		if err != nil {
			slog.Debug("store: GetAuditLog: query failed", "instance", name, "err", err)
			continue
		}
		for _, ev := range parseRows(rows) {
			if !seen[ev.ID] {
				seen[ev.ID] = true
				merged = append(merged, ev)
			}
		}
	}

	// Sort merged results by ts DESC and cap at limit.
	sort.Slice(merged, func(i, j int) bool { return merged[i].Ts > merged[j].Ts })
	if len(merged) > opts.Limit {
		merged = merged[:opts.Limit]
	}
	return merged, nil
}
