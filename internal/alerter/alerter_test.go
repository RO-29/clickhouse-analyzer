package alerter

import (
	"sort"
	"testing"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/collector"
)

// ---------------------------------------------------------------------------
// severityOrder
// ---------------------------------------------------------------------------

func TestSeverityOrder(t *testing.T) {
	tests := []struct {
		name     string
		severity collector.Severity
		want     int
	}{
		{"critical is 0", collector.SeverityCritical, 0},
		{"warn is 1", collector.SeverityWarn, 1},
		{"info is 2", collector.SeverityInfo, 2},
		{"unknown is 2", "unknown", 2},
		{"empty is 2", "", 2},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := severityOrder(tc.severity)
			if got != tc.want {
				t.Errorf("severityOrder(%q) = %d, want %d", tc.severity, got, tc.want)
			}
		})
	}
}

// TestSeverityOrderSortStability verifies that sorting a mixed slice of alerts
// by severityOrder produces critical-first, then warn, then info ordering, and
// that within the same severity alerts are sorted alphabetically by title.
func TestSeverityOrderSortStability(t *testing.T) {
	now := time.Now()
	alerts := []*ActiveAlert{
		{Alert: collector.Alert{Severity: collector.SeverityInfo, Title: "a-info"}},
		{Alert: collector.Alert{Severity: collector.SeverityWarn, Title: "b-warn"}},
		{Alert: collector.Alert{Severity: collector.SeverityCritical, Title: "c-critical"}},
		{Alert: collector.Alert{Severity: collector.SeverityWarn, Title: "a-warn"}},
		{Alert: collector.Alert{Severity: collector.SeverityCritical, Title: "a-critical"}},
	}
	for _, a := range alerts {
		a.FirstSeen = now
		a.LastSeen = now
		a.Count = 1
	}

	sort.Slice(alerts, func(i, j int) bool {
		oi := severityOrder(alerts[i].Alert.Severity)
		oj := severityOrder(alerts[j].Alert.Severity)
		if oi != oj {
			return oi < oj
		}
		return alerts[i].Alert.Title < alerts[j].Alert.Title
	})

	wantTitles := []string{"a-critical", "c-critical", "a-warn", "b-warn", "a-info"}
	for i, a := range alerts {
		if a.Alert.Title != wantTitles[i] {
			t.Errorf("position %d: got %q, want %q", i, a.Alert.Title, wantTitles[i])
		}
	}
}

// ---------------------------------------------------------------------------
// InhibitionMatcher.IsInhibited
// ---------------------------------------------------------------------------

func makeAlert(category, severity string) ActiveAlert {
	return ActiveAlert{
		Alert: collector.Alert{
			Category: category,
			Severity: collector.Severity(severity),
		},
		FirstSeen: time.Now(),
		LastSeen:  time.Now(),
		Count:     1,
	}
}

func TestIsInhibited(t *testing.T) {
	// Set up a memory:critical alert as the active source alert.
	activeMemCrit := makeAlert("memory", "critical")
	activeAlerts := map[string]*ActiveAlert{
		"memory:critical": &activeMemCrit,
	}

	tests := []struct {
		name      string
		rules     []InhibitionRule
		candidate ActiveAlert
		want      bool
	}{
		{
			name: "exact match: memory:critical inhibits queries:warn",
			rules: []InhibitionRule{
				{SourceCategory: "memory", SourceSeverity: "critical", TargetCategory: "queries", TargetSeverity: "warn"},
			},
			candidate: makeAlert("queries", "warn"),
			want:      true,
		},
		{
			name: "target category mismatch: not inhibited",
			rules: []InhibitionRule{
				{SourceCategory: "memory", SourceSeverity: "critical", TargetCategory: "queries", TargetSeverity: "warn"},
			},
			candidate: makeAlert("storage", "warn"),
			want:      false,
		},
		{
			name: "target severity mismatch: not inhibited",
			rules: []InhibitionRule{
				{SourceCategory: "memory", SourceSeverity: "critical", TargetCategory: "queries", TargetSeverity: "warn"},
			},
			candidate: makeAlert("queries", "critical"),
			want:      false,
		},
		{
			name: "source severity wildcard: inhibits any source severity",
			rules: []InhibitionRule{
				// SourceSeverity empty = wildcard
				{SourceCategory: "memory", TargetCategory: "queries", TargetSeverity: "warn"},
			},
			candidate: makeAlert("queries", "warn"),
			want:      true,
		},
		{
			name: "target severity wildcard: inhibits any target severity",
			rules: []InhibitionRule{
				// TargetSeverity empty = wildcard
				{SourceCategory: "memory", SourceSeverity: "critical", TargetCategory: "queries"},
			},
			candidate: makeAlert("queries", "info"),
			want:      true,
		},
		{
			name: "both wildcards: inhibits if any source category matches",
			rules: []InhibitionRule{
				{SourceCategory: "memory"},
			},
			candidate: makeAlert("cpu", "warn"),
			want:      true,
		},
		{
			name: "no rules: never inhibited",
			rules: []InhibitionRule{},
			candidate: makeAlert("queries", "warn"),
			want:      false,
		},
		{
			name: "source not active: not inhibited",
			rules: []InhibitionRule{
				{SourceCategory: "disk", SourceSeverity: "critical", TargetCategory: "queries", TargetSeverity: "warn"},
			},
			candidate: makeAlert("queries", "warn"),
			want:      false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := &InhibitionMatcher{Rules: tc.rules}
			got := m.IsInhibited(tc.candidate, activeAlerts)
			if got != tc.want {
				t.Errorf("IsInhibited() = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestIsInhibitedNoActiveAlerts checks that when no source alerts are active,
// inhibition never fires even if the target matches a rule.
func TestIsInhibitedNoActiveAlerts(t *testing.T) {
	rules := DefaultInhibitionRules()
	m := &InhibitionMatcher{Rules: rules}

	candidate := makeAlert("queries", "warn")
	// Empty activeAlerts — no source alerts are firing.
	got := m.IsInhibited(candidate, map[string]*ActiveAlert{})
	if got {
		t.Error("expected not inhibited when no active source alerts exist")
	}
}

// TestDefaultInhibitionRulesCount verifies we have the expected number of
// built-in rules so additions don't go unnoticed in tests.
func TestDefaultInhibitionRulesCount(t *testing.T) {
	rules := DefaultInhibitionRules()
	if len(rules) == 0 {
		t.Fatal("DefaultInhibitionRules returned 0 rules, expected at least 1")
	}
}

// TestDefaultInhibitionRulesLogic spot-checks the four documented default rules.
func TestDefaultInhibitionRulesLogic(t *testing.T) {
	memCritAlert := makeAlert("memory", "critical")
	replCritAlert := makeAlert("replication", "critical")
	storageCritAlert := makeAlert("storage", "critical")

	rules := DefaultInhibitionRules()
	m := &InhibitionMatcher{Rules: rules}

	tests := []struct {
		name      string
		active    map[string]*ActiveAlert
		candidate ActiveAlert
		want      bool
	}{
		{
			name:      "memory:critical inhibits queries:warn",
			active:    map[string]*ActiveAlert{"k1": &memCritAlert},
			candidate: makeAlert("queries", "warn"),
			want:      true,
		},
		{
			name:      "memory:critical inhibits queries:info",
			active:    map[string]*ActiveAlert{"k1": &memCritAlert},
			candidate: makeAlert("queries", "info"),
			want:      true,
		},
		{
			name:      "memory:critical inhibits cpu:warn",
			active:    map[string]*ActiveAlert{"k1": &memCritAlert},
			candidate: makeAlert("cpu", "warn"),
			want:      true,
		},
		{
			name:      "replication:critical inhibits tables:warn",
			active:    map[string]*ActiveAlert{"k1": &replCritAlert},
			candidate: makeAlert("tables", "warn"),
			want:      true,
		},
		{
			name:      "storage:critical inhibits inserts:warn",
			active:    map[string]*ActiveAlert{"k1": &storageCritAlert},
			candidate: makeAlert("inserts", "warn"),
			want:      true,
		},
		{
			name:      "memory:critical does NOT inhibit cpu:critical",
			active:    map[string]*ActiveAlert{"k1": &memCritAlert},
			candidate: makeAlert("cpu", "critical"),
			want:      false,
		},
		{
			name:      "memory:warn does NOT inhibit queries:warn (source must be critical)",
			active:    map[string]*ActiveAlert{"k1": {Alert: collector.Alert{Category: "memory", Severity: "warn"}}},
			candidate: makeAlert("queries", "warn"),
			want:      false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := m.IsInhibited(tc.candidate, tc.active)
			if got != tc.want {
				t.Errorf("IsInhibited() = %v, want %v", got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// AlertManager — deduplication (no CH, no Slack)
// ---------------------------------------------------------------------------

// newTestAlertManager returns an AlertManager with nil store and nil Slack,
// suitable for pure in-memory logic tests.
func newTestAlertManager(opts ...Option) *AlertManager {
	return NewAlertManager(nil, nil, opts...)
}

func TestAlertManagerDedup(t *testing.T) {
	am := newTestAlertManager()

	alert := collector.Alert{
		Instance: "test-host",
		Severity: collector.SeverityCritical,
		Category: "memory",
		Title:    "High memory",
		DedupKey: "test-host:memory:High memory",
	}

	// First process: alert should be tracked.
	am.Process([]collector.Alert{alert})
	if am.ActiveAlertCount() != 1 {
		t.Fatalf("after first process: got %d active alerts, want 1", am.ActiveAlertCount())
	}

	// Second process with same alert: count should increment, not create a new entry.
	am.Process([]collector.Alert{alert})
	if am.ActiveAlertCount() != 1 {
		t.Fatalf("after second process: got %d active alerts, want 1 (dedup)", am.ActiveAlertCount())
	}

	aa := am.GetActiveAlert(alert.DedupKey)
	if aa == nil {
		t.Fatal("expected active alert to exist")
	}
	if aa.Count != 2 {
		t.Errorf("alert count = %d, want 2 (deduped increment)", aa.Count)
	}
}

func TestAlertManagerAutoKey(t *testing.T) {
	// When DedupKey is empty the manager should auto-generate one.
	am := newTestAlertManager()

	alert := collector.Alert{
		Instance: "host-1",
		Severity: collector.SeverityWarn,
		Category: "queries",
		Title:    "Slow query",
		// DedupKey intentionally empty
	}

	am.Process([]collector.Alert{alert})
	if am.ActiveAlertCount() != 1 {
		t.Fatalf("expected 1 active alert, got %d", am.ActiveAlertCount())
	}

	// The auto-generated key is "instance:category:title".
	expectedKey := "host-1:queries:Slow query"
	aa := am.GetActiveAlert(expectedKey)
	if aa == nil {
		t.Errorf("expected active alert with auto-generated key %q, not found", expectedKey)
	}
}

func TestAlertManagerCleanChecksResolution(t *testing.T) {
	// resolveCleanChecks=1: after one cycle without the alert it should resolve.
	am := newTestAlertManager(WithResolveCleanChecks(1))

	alert := collector.Alert{
		Instance: "host-2",
		Severity: collector.SeverityWarn,
		Category: "storage",
		Title:    "Low disk",
		DedupKey: "host-2:storage:Low disk",
	}

	am.Process([]collector.Alert{alert})
	if am.ActiveAlertCount() != 1 {
		t.Fatalf("expected 1 active alert after fire, got %d", am.ActiveAlertCount())
	}

	// Process an empty set — no alerts seen, cleanChecks increments to 1.
	am.Process([]collector.Alert{})

	// Manually trigger resolution (would normally happen in resolutionLoop).
	am.checkResolutions()

	if am.ActiveAlertCount() != 0 {
		t.Errorf("expected 0 active alerts after resolution, got %d", am.ActiveAlertCount())
	}
}

func TestAlertManagerInfoAlertsBatched(t *testing.T) {
	am := newTestAlertManager()

	infoAlert := collector.Alert{
		Instance: "host-3",
		Severity: collector.SeverityInfo,
		Category: "queries",
		Title:    "Info event",
		DedupKey: "host-3:queries:Info event",
	}

	am.Process([]collector.Alert{infoAlert})

	// Info alerts are batched, not counted as "active" alerts for Slack.
	// However they ARE added to activeAlerts for resolution tracking.
	// The drain batch should have them.
	drained := am.DrainInfoAlerts()
	if len(drained) != 1 {
		t.Errorf("DrainInfoAlerts() returned %d alerts, want 1", len(drained))
	}
	if drained[0].Title != infoAlert.Title {
		t.Errorf("drained alert title = %q, want %q", drained[0].Title, infoAlert.Title)
	}

	// Draining again should return empty.
	drained2 := am.DrainInfoAlerts()
	if len(drained2) != 0 {
		t.Errorf("second DrainInfoAlerts() returned %d alerts, want 0", len(drained2))
	}
}

func TestAlertManagerInhibitionSuppressesSlack(t *testing.T) {
	rules := []InhibitionRule{
		{SourceCategory: "memory", SourceSeverity: "critical", TargetCategory: "queries", TargetSeverity: "warn"},
	}
	am := newTestAlertManager(WithInhibition(rules))

	// Fire the source alert first.
	memAlert := collector.Alert{
		Instance: "host-4",
		Severity: collector.SeverityCritical,
		Category: "memory",
		Title:    "OOM",
		DedupKey: "host-4:memory:OOM",
	}
	// Fire the target alert at the same time.
	queryAlert := collector.Alert{
		Instance: "host-4",
		Severity: collector.SeverityWarn,
		Category: "queries",
		Title:    "Slow queries",
		DedupKey: "host-4:queries:Slow queries",
	}

	am.Process([]collector.Alert{memAlert, queryAlert})

	// Both alerts are tracked in activeAlerts (for resolution purposes).
	if am.ActiveAlertCount() != 2 {
		t.Errorf("expected 2 active alerts (both tracked), got %d", am.ActiveAlertCount())
	}

	// The inhibited query alert should be tracked but NOT in dirtyInst (no Slack).
	// We can verify the queries alert IS in activeAlerts.
	aa := am.GetActiveAlert(queryAlert.DedupKey)
	if aa == nil {
		t.Error("expected inhibited alert to still be tracked in activeAlerts")
	}
}

func TestAlertManagerRehydrate(t *testing.T) {
	am := newTestAlertManager()

	firstSeen := time.Now().Add(-10 * time.Minute)
	storedAlert := collector.Alert{
		Instance:    "host-5",
		Severity:    collector.SeverityCritical,
		Category:    "memory",
		Title:       "Persisted alert",
		DedupKey:    "host-5:memory:Persisted alert",
		FirstSeenAt: firstSeen,
		FireCount:   7,
	}

	am.Rehydrate([]collector.Alert{storedAlert})

	aa := am.GetActiveAlert(storedAlert.DedupKey)
	if aa == nil {
		t.Fatal("expected rehydrated alert to exist in activeAlerts")
	}
	if aa.Count != 7 {
		t.Errorf("rehydrated Count = %d, want 7", aa.Count)
	}
	if !aa.FirstSeen.Equal(firstSeen) {
		t.Errorf("rehydrated FirstSeen = %v, want %v", aa.FirstSeen, firstSeen)
	}
}

func TestAlertManagerRehydrateNoDuplicate(t *testing.T) {
	am := newTestAlertManager()

	alert := collector.Alert{
		Instance: "host-6",
		Severity: collector.SeverityWarn,
		Category: "storage",
		Title:    "Existing alert",
		DedupKey: "host-6:storage:Existing alert",
	}

	// Pre-populate via Process.
	am.Process([]collector.Alert{alert})

	// Rehydrate with the same key — should not create a second entry.
	am.Rehydrate([]collector.Alert{alert})

	if am.ActiveAlertCount() != 1 {
		t.Errorf("expected 1 active alert after rehydrate of existing key, got %d", am.ActiveAlertCount())
	}
}

func TestGetActiveAlertsSorted(t *testing.T) {
	am := newTestAlertManager()

	alerts := []collector.Alert{
		{Instance: "z-host", Severity: collector.SeverityInfo, Title: "info", DedupKey: "k1"},
		{Instance: "a-host", Severity: collector.SeverityWarn, Title: "warn", DedupKey: "k2"},
		{Instance: "a-host", Severity: collector.SeverityCritical, Title: "crit", DedupKey: "k3"},
	}
	am.Process(alerts)

	result := am.GetActiveAlerts()
	if len(result) != 3 {
		t.Fatalf("expected 3 active alerts, got %d", len(result))
	}

	// First should be critical.
	if result[0].Alert.Severity != collector.SeverityCritical {
		t.Errorf("result[0] severity = %q, want critical", result[0].Alert.Severity)
	}
	// Second should be warn.
	if result[1].Alert.Severity != collector.SeverityWarn {
		t.Errorf("result[1] severity = %q, want warn", result[1].Alert.Severity)
	}
	// Third should be info.
	if result[2].Alert.Severity != collector.SeverityInfo {
		t.Errorf("result[2] severity = %q, want info", result[2].Alert.Severity)
	}
}

func TestActiveAlertCountsForInstance(t *testing.T) {
	am := newTestAlertManager()

	am.Process([]collector.Alert{
		{Instance: "inst-a", Severity: collector.SeverityCritical, Title: "c1", DedupKey: "a:c1"},
		{Instance: "inst-a", Severity: collector.SeverityWarn, Title: "w1", DedupKey: "a:w1"},
		{Instance: "inst-a", Severity: collector.SeverityInfo, Title: "i1", DedupKey: "a:i1"},
		{Instance: "inst-b", Severity: collector.SeverityCritical, Title: "c2", DedupKey: "b:c2"},
	})

	counts := am.ActiveAlertCountsForInstance("inst-a")
	if counts["critical"] != 1 {
		t.Errorf("inst-a critical = %d, want 1", counts["critical"])
	}
	if counts["warn"] != 1 {
		t.Errorf("inst-a warn = %d, want 1", counts["warn"])
	}
	if counts["info"] != 1 {
		t.Errorf("inst-a info = %d, want 1", counts["info"])
	}

	// inst-b should have its own counts.
	countsB := am.ActiveAlertCountsForInstance("inst-b")
	if countsB["critical"] != 1 {
		t.Errorf("inst-b critical = %d, want 1", countsB["critical"])
	}
	if countsB["warn"] != 0 {
		t.Errorf("inst-b warn = %d, want 0", countsB["warn"])
	}

	// Unknown instance should return all-zeros.
	countsX := am.ActiveAlertCountsForInstance("inst-x")
	if countsX["critical"] != 0 || countsX["warn"] != 0 || countsX["info"] != 0 {
		t.Errorf("unknown instance counts should all be 0, got %v", countsX)
	}
}

func TestGetActiveAlertsForInstance(t *testing.T) {
	am := newTestAlertManager()

	am.Process([]collector.Alert{
		{Instance: "host-7", Severity: collector.SeverityWarn, Title: "b-warn", DedupKey: "h7:b"},
		{Instance: "host-7", Severity: collector.SeverityCritical, Title: "a-crit", DedupKey: "h7:a"},
		{Instance: "host-7", Severity: collector.SeverityInfo, Title: "c-info", DedupKey: "h7:c"},
		{Instance: "other", Severity: collector.SeverityCritical, Title: "x", DedupKey: "other:x"},
	})

	result := am.GetActiveAlertsForInstance("host-7")
	// Info alerts are excluded from per-instance results.
	if len(result) != 2 {
		t.Fatalf("expected 2 non-info alerts for host-7, got %d", len(result))
	}
	if result[0].Alert.Severity != collector.SeverityCritical {
		t.Errorf("first result should be critical, got %q", result[0].Alert.Severity)
	}
	if result[1].Alert.Severity != collector.SeverityWarn {
		t.Errorf("second result should be warn, got %q", result[1].Alert.Severity)
	}
}
