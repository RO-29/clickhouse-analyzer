package alerter

import (
	"context"
	"sort"
	"sync"
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

func makeAlert(instance, category, severity string) ActiveAlert {
	return ActiveAlert{
		Alert: collector.Alert{
			Instance: instance,
			Category: category,
			Severity: collector.Severity(severity),
		},
		FirstSeen: time.Now(),
		LastSeen:  time.Now(),
		Count:     1,
	}
}

func TestIsInhibited(t *testing.T) {
	// Source alert on host-a; candidates are also on host-a.
	activeMemCrit := makeAlert("host-a", "memory", "critical")
	activeAlerts := map[string]*ActiveAlert{
		"host-a:memory:critical": &activeMemCrit,
	}

	tests := []struct {
		name      string
		rules     []InhibitionRule
		candidate ActiveAlert
		want      bool
	}{
		{
			name: "exact match: memory:critical inhibits queries:warn on same instance",
			rules: []InhibitionRule{
				{SourceCategory: "memory", SourceSeverity: "critical", TargetCategory: "queries", TargetSeverity: "warn"},
			},
			candidate: makeAlert("host-a", "queries", "warn"),
			want:      true,
		},
		{
			name: "target category mismatch: not inhibited",
			rules: []InhibitionRule{
				{SourceCategory: "memory", SourceSeverity: "critical", TargetCategory: "queries", TargetSeverity: "warn"},
			},
			candidate: makeAlert("host-a", "storage", "warn"),
			want:      false,
		},
		{
			name: "target severity mismatch: not inhibited",
			rules: []InhibitionRule{
				{SourceCategory: "memory", SourceSeverity: "critical", TargetCategory: "queries", TargetSeverity: "warn"},
			},
			candidate: makeAlert("host-a", "queries", "critical"),
			want:      false,
		},
		{
			name: "source severity wildcard: inhibits any source severity",
			rules: []InhibitionRule{
				{SourceCategory: "memory", TargetCategory: "queries", TargetSeverity: "warn"},
			},
			candidate: makeAlert("host-a", "queries", "warn"),
			want:      true,
		},
		{
			name: "target severity wildcard: inhibits any target severity",
			rules: []InhibitionRule{
				{SourceCategory: "memory", SourceSeverity: "critical", TargetCategory: "queries"},
			},
			candidate: makeAlert("host-a", "queries", "info"),
			want:      true,
		},
		{
			name: "both wildcards: inhibits if any source category matches",
			rules: []InhibitionRule{
				{SourceCategory: "memory"},
			},
			candidate: makeAlert("host-a", "cpu", "warn"),
			want:      true,
		},
		{
			name:      "no rules: never inhibited",
			rules:     []InhibitionRule{},
			candidate: makeAlert("host-a", "queries", "warn"),
			want:      false,
		},
		{
			name: "source not active: not inhibited",
			rules: []InhibitionRule{
				{SourceCategory: "disk", SourceSeverity: "critical", TargetCategory: "queries", TargetSeverity: "warn"},
			},
			candidate: makeAlert("host-a", "queries", "warn"),
			want:      false,
		},
		{
			name: "cross-instance: memory:critical on host-a does NOT inhibit queries:warn on host-b",
			rules: []InhibitionRule{
				{SourceCategory: "memory", SourceSeverity: "critical", TargetCategory: "queries", TargetSeverity: "warn"},
			},
			candidate: makeAlert("host-b", "queries", "warn"),
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

	candidate := makeAlert("host", "queries", "warn")
	got := m.IsInhibited(candidate, map[string]*ActiveAlert{})
	if got {
		t.Error("expected not inhibited when no active source alerts exist")
	}
}

// TestDefaultInhibitionRulesCount verifies the default set is populated.
func TestDefaultInhibitionRulesCount(t *testing.T) {
	rules := DefaultInhibitionRules()
	if len(rules) == 0 {
		t.Fatal("DefaultInhibitionRules returned 0 rules, expected at least 1")
	}
}

// TestDefaultInhibitionRulesLogic spot-checks the documented default rules.
func TestDefaultInhibitionRulesLogic(t *testing.T) {
	memCrit := makeAlert("h1", "memory", "critical")
	replCrit := makeAlert("h1", "replication", "critical")
	storageCrit := makeAlert("h1", "storage", "critical")

	rules := DefaultInhibitionRules()
	m := &InhibitionMatcher{Rules: rules}

	tests := []struct {
		name      string
		active    map[string]*ActiveAlert
		candidate ActiveAlert
		want      bool
	}{
		{
			name:      "memory:critical inhibits queries:warn on same instance",
			active:    map[string]*ActiveAlert{"k1": &memCrit},
			candidate: makeAlert("h1", "queries", "warn"),
			want:      true,
		},
		{
			name:      "memory:critical inhibits queries:info on same instance",
			active:    map[string]*ActiveAlert{"k1": &memCrit},
			candidate: makeAlert("h1", "queries", "info"),
			want:      true,
		},
		{
			name:      "memory:critical inhibits cpu:warn on same instance",
			active:    map[string]*ActiveAlert{"k1": &memCrit},
			candidate: makeAlert("h1", "cpu", "warn"),
			want:      true,
		},
		{
			name:      "replication:critical inhibits tables:warn on same instance",
			active:    map[string]*ActiveAlert{"k1": &replCrit},
			candidate: makeAlert("h1", "tables", "warn"),
			want:      true,
		},
		{
			name:      "storage:critical inhibits inserts:warn on same instance",
			active:    map[string]*ActiveAlert{"k1": &storageCrit},
			candidate: makeAlert("h1", "inserts", "warn"),
			want:      true,
		},
		{
			name:      "memory:critical does NOT inhibit cpu:critical on same instance",
			active:    map[string]*ActiveAlert{"k1": &memCrit},
			candidate: makeAlert("h1", "cpu", "critical"),
			want:      false,
		},
		{
			name:      "memory:warn does NOT inhibit queries:warn (source must be critical)",
			active:    map[string]*ActiveAlert{"k1": {Alert: collector.Alert{Instance: "h1", Category: "memory", Severity: "warn"}}},
			candidate: makeAlert("h1", "queries", "warn"),
			want:      false,
		},
		{
			name:      "memory:critical on h1 does NOT inhibit queries:warn on h2 (different instance)",
			active:    map[string]*ActiveAlert{"k1": &memCrit},
			candidate: makeAlert("h2", "queries", "warn"),
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
// fakeStore — a concurrency-safe in-memory StoreInterface for reconcile tests
// ---------------------------------------------------------------------------

type fakeStore struct {
	mu         sync.Mutex
	rows       []collector.Alert // append-only log of inserts
	resolved   map[string]bool
	firstSeen  map[string]time.Time // carry-forward across firings
	fireCount  map[string]int       // carry-forward across firings
	insertErr  error                // if non-nil, InsertAlert returns this
	insertOnce error                // if set, returned on the next InsertAlert then cleared
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		resolved:  make(map[string]bool),
		firstSeen: make(map[string]time.Time),
		fireCount: make(map[string]int),
	}
}

func (f *fakeStore) InsertAlert(a collector.Alert) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.insertOnce != nil {
		err := f.insertOnce
		f.insertOnce = nil
		return 0, err
	}
	if f.insertErr != nil {
		return 0, f.insertErr
	}
	// Apply carry-forward semantics (mirroring store.InsertAlert).
	fs, ok := f.firstSeen[a.DedupKey]
	if !ok {
		fs = a.Timestamp
	}
	fc := f.fireCount[a.DedupKey] + 1
	f.firstSeen[a.DedupKey] = fs
	f.fireCount[a.DedupKey] = fc
	a.FirstSeenAt = fs
	a.FireCount = fc
	f.rows = append(f.rows, a)
	f.resolved[a.DedupKey] = false
	return int64(len(f.rows)), nil
}

func (f *fakeStore) ResolveAlert(dedupKey string) error {
	f.mu.Lock()
	f.resolved[dedupKey] = true
	f.mu.Unlock()
	return nil
}

func (f *fakeStore) RefreshAlerts(_ []collector.Alert) error { return nil }

func (f *fakeStore) AutoResolveStale(_ time.Duration) (int64, error) { return 0, nil }

func (f *fakeStore) GetAllActiveAlerts() []collector.Alert {
	f.mu.Lock()
	defer f.mu.Unlock()
	// Latest row per dedup_key; include only if not resolved.
	latest := make(map[string]collector.Alert)
	for _, r := range f.rows {
		latest[r.DedupKey] = r
	}
	var out []collector.Alert
	for k, r := range latest {
		if f.resolved[k] {
			continue
		}
		out = append(out, r)
	}
	return out
}

func (f *fakeStore) GetActiveAlertsForInstance(instance string) []collector.Alert {
	var out []collector.Alert
	for _, a := range f.GetAllActiveAlerts() {
		if a.Instance == instance {
			out = append(out, a)
		}
	}
	return out
}

// seedResolvedRow appends a resolved row so priorFireStats-style carry-forward
// has something to observe. Useful for "re-fire preserves lifetime stats" tests.
func (f *fakeStore) seedResolvedRow(a collector.Alert) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.firstSeen[a.DedupKey] = a.FirstSeenAt
	f.fireCount[a.DedupKey] = a.FireCount
	f.rows = append(f.rows, a)
	f.resolved[a.DedupKey] = true
}

// ---------------------------------------------------------------------------
// Reconcile — the core new behavior
// ---------------------------------------------------------------------------

func newTestAlertManager(store StoreInterface, opts ...Option) *AlertManager {
	return NewAlertManager(nil, store, opts...)
}

func TestReconcile_NewAlertIsInserted(t *testing.T) {
	fs := newFakeStore()
	am := newTestAlertManager(fs)

	alert := collector.Alert{
		Instance: "host-1",
		Severity: collector.SeverityCritical,
		Category: "memory",
		Title:    "OOM",
		DedupKey: "host-1:memory:OOM",
	}

	if err := am.Reconcile(context.Background(), []collector.Alert{alert}); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	active := fs.GetAllActiveAlerts()
	if len(active) != 1 {
		t.Fatalf("expected 1 active alert after first reconcile, got %d", len(active))
	}
	if active[0].DedupKey != alert.DedupKey {
		t.Errorf("dedup_key = %q, want %q", active[0].DedupKey, alert.DedupKey)
	}
	if active[0].FireCount != 1 {
		t.Errorf("fire_count = %d, want 1 on first fire", active[0].FireCount)
	}
}

func TestReconcile_Idempotent(t *testing.T) {
	fs := newFakeStore()
	am := newTestAlertManager(fs)

	alert := collector.Alert{
		Instance: "host-1",
		Severity: collector.SeverityCritical,
		Category: "memory",
		Title:    "OOM",
		DedupKey: "host-1:memory:OOM",
	}

	for i := 0; i < 3; i++ {
		if err := am.Reconcile(context.Background(), []collector.Alert{alert}); err != nil {
			t.Fatalf("Reconcile (cycle %d): %v", i, err)
		}
	}

	if n := len(fs.rows); n != 1 {
		t.Errorf("expected exactly 1 insert after 3 reconciles with same alert, got %d (touch-only on dedup)", n)
	}
}

// The zombie-alert bug from the old design: a failed InsertAlert silently
// stranded the alert in memory with no DB row and no retry path. In the new
// design the condition is still firing next cycle and still missing from the
// DB, so reconcile retries the insert.
func TestReconcile_FailedInsertRetriesNextCycle(t *testing.T) {
	fs := newFakeStore()
	am := newTestAlertManager(fs)

	alert := collector.Alert{
		Instance: "host-1",
		Severity: collector.SeverityCritical,
		Category: "memory",
		Title:    "OOM",
		DedupKey: "host-1:memory:OOM",
	}

	// First reconcile: store rejects the insert.
	fs.insertOnce = errBoom
	if err := am.Reconcile(context.Background(), []collector.Alert{alert}); err != nil {
		t.Fatalf("Reconcile (cycle 1): %v", err)
	}
	if len(fs.GetAllActiveAlerts()) != 0 {
		t.Fatalf("expected 0 active alerts after failed insert, got %d", len(fs.GetAllActiveAlerts()))
	}

	// Second reconcile (condition still firing): insert succeeds this time.
	if err := am.Reconcile(context.Background(), []collector.Alert{alert}); err != nil {
		t.Fatalf("Reconcile (cycle 2): %v", err)
	}
	active := fs.GetAllActiveAlerts()
	if len(active) != 1 {
		t.Fatalf("expected 1 active alert after retry, got %d", len(active))
	}
}

// The UI-resolve disconnect from the old design: user resolves alert → DB
// says resolved=1, memory still has it, next poll dedups → DB stays resolved
// even though condition still fires. In the new design, reconcile diffs DB
// state vs. collector output — a resolved DB row looks "not active", so the
// still-firing alert gets re-inserted as a fresh row.
func TestReconcile_UIResolveReFiresIfStillFiring(t *testing.T) {
	fs := newFakeStore()
	am := newTestAlertManager(fs)

	alert := collector.Alert{
		Instance: "host-1",
		Severity: collector.SeverityCritical,
		Category: "queries",
		Title:    "Slow query",
		DedupKey: "host-1:queries:Slow",
	}

	// Seed: condition fired an hour ago, user resolved it via UI.
	earlier := time.Now().Add(-time.Hour)
	fs.seedResolvedRow(collector.Alert{
		Instance:    alert.Instance,
		Severity:    alert.Severity,
		Category:    alert.Category,
		Title:       alert.Title,
		DedupKey:    alert.DedupKey,
		Timestamp:   earlier,
		FirstSeenAt: earlier,
		FireCount:   3,
	})

	// Condition is still firing now — reconcile sees it missing from DB.
	if err := am.Reconcile(context.Background(), []collector.Alert{alert}); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	active := fs.GetAllActiveAlerts()
	if len(active) != 1 {
		t.Fatalf("expected 1 active alert after re-fire, got %d", len(active))
	}
	got := active[0]
	if got.FireCount != 4 {
		t.Errorf("fire_count = %d, want 4 (carry-forward: 3 prior + 1 new)", got.FireCount)
	}
	if !got.FirstSeenAt.Equal(earlier) {
		t.Errorf("first_seen_at = %v, want original %v (preserved across re-firings)", got.FirstSeenAt, earlier)
	}
}

// Maintenance drops alerts entirely. When the window ends, the next reconcile
// observes them in currentAlerts and re-inserts naturally.
func TestReconcile_MaintenanceDropsAndRecovers(t *testing.T) {
	fs := newFakeStore()
	maint := NewMaintenanceStore()
	maint.Add("host-1", "scheduled work", "test", time.Hour)

	am := newTestAlertManager(fs, WithMaintenance(maint))

	alert := collector.Alert{
		Instance: "host-1",
		Severity: collector.SeverityCritical,
		Category: "memory",
		Title:    "OOM",
		DedupKey: "host-1:memory:OOM",
	}

	// Reconcile under maintenance: alert is dropped.
	if err := am.Reconcile(context.Background(), []collector.Alert{alert}); err != nil {
		t.Fatalf("Reconcile under maintenance: %v", err)
	}
	if n := len(fs.GetAllActiveAlerts()); n != 0 {
		t.Fatalf("maintenance: expected 0 active alerts in DB, got %d", n)
	}

	// End maintenance; reconcile again — alert fires now.
	for _, w := range maint.List() {
		maint.Delete(w.ID)
	}
	if err := am.Reconcile(context.Background(), []collector.Alert{alert}); err != nil {
		t.Fatalf("Reconcile after maintenance: %v", err)
	}
	if n := len(fs.GetAllActiveAlerts()); n != 1 {
		t.Fatalf("after maintenance: expected 1 active alert, got %d", n)
	}
}

func TestReconcile_AutoResolveAfterCleanChecks(t *testing.T) {
	fs := newFakeStore()
	// resolveCleanChecks=1: one cycle of absence resolves the alert.
	am := newTestAlertManager(fs, WithResolveCleanChecks(1))

	alert := collector.Alert{
		Instance: "host-1",
		Severity: collector.SeverityWarn,
		Category: "storage",
		Title:    "Low disk",
		DedupKey: "host-1:storage:Low",
	}

	// Fire it.
	if err := am.Reconcile(context.Background(), []collector.Alert{alert}); err != nil {
		t.Fatalf("Reconcile fire: %v", err)
	}
	if n := len(fs.GetAllActiveAlerts()); n != 1 {
		t.Fatalf("expected 1 active after fire, got %d", n)
	}

	// Condition clears.
	if err := am.Reconcile(context.Background(), nil); err != nil {
		t.Fatalf("Reconcile clear: %v", err)
	}
	if !fs.resolved[alert.DedupKey] {
		t.Fatalf("expected alert to be resolved after 1 clean check, but DB says unresolved")
	}
	if n := len(fs.GetAllActiveAlerts()); n != 0 {
		t.Errorf("expected 0 active alerts after auto-resolve, got %d", n)
	}
}

func TestReconcile_InhibitedAlertStillPersists(t *testing.T) {
	fs := newFakeStore()
	rules := []InhibitionRule{
		{SourceCategory: "memory", SourceSeverity: "critical", TargetCategory: "queries", TargetSeverity: "warn"},
	}
	am := newTestAlertManager(fs, WithInhibition(rules))

	memAlert := collector.Alert{
		Instance: "host-1", Severity: collector.SeverityCritical, Category: "memory",
		Title: "OOM", DedupKey: "host-1:memory:OOM",
	}
	queryAlert := collector.Alert{
		Instance: "host-1", Severity: collector.SeverityWarn, Category: "queries",
		Title: "Slow", DedupKey: "host-1:queries:Slow",
	}

	if err := am.Reconcile(context.Background(), []collector.Alert{memAlert, queryAlert}); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	// Both alerts persist — UI should see the inhibited one. Inhibition only
	// affects Slack/PD/webhook notification.
	if n := len(fs.GetAllActiveAlerts()); n != 2 {
		t.Errorf("expected 2 active alerts (both persisted), got %d", n)
	}
}

func TestReconcile_InfoAlertsGoToDigest(t *testing.T) {
	fs := newFakeStore()
	am := newTestAlertManager(fs)

	info := collector.Alert{
		Instance: "host-1", Severity: collector.SeverityInfo, Category: "queries",
		Title: "Info event", DedupKey: "host-1:queries:Info",
	}

	if err := am.Reconcile(context.Background(), []collector.Alert{info}); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	// Info alerts are persisted so UI shows them…
	if n := len(fs.GetAllActiveAlerts()); n != 1 {
		t.Errorf("info alert should persist to DB, got %d rows", n)
	}
	// …and enqueued for the digest.
	drained := am.DrainInfoAlerts()
	if len(drained) != 1 {
		t.Errorf("info digest: got %d, want 1", len(drained))
	}
	if len(am.DrainInfoAlerts()) != 0 {
		t.Error("second drain should be empty")
	}
}

func TestReconcile_AutoGeneratesDedupKey(t *testing.T) {
	fs := newFakeStore()
	am := newTestAlertManager(fs)

	alert := collector.Alert{
		Instance: "host-1",
		Severity: collector.SeverityWarn,
		Category: "queries",
		Title:    "Slow query",
		// DedupKey intentionally empty
	}

	if err := am.Reconcile(context.Background(), []collector.Alert{alert}); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}

	active := fs.GetAllActiveAlerts()
	if len(active) != 1 {
		t.Fatalf("expected 1 active alert, got %d", len(active))
	}
	want := "host-1:queries:Slow query"
	if active[0].DedupKey != want {
		t.Errorf("auto-generated dedup_key = %q, want %q", active[0].DedupKey, want)
	}
}

// ---------------------------------------------------------------------------
// Public getters
// ---------------------------------------------------------------------------

func TestGetActiveAlertsSorted(t *testing.T) {
	fs := newFakeStore()
	am := newTestAlertManager(fs)

	_ = am.Reconcile(context.Background(), []collector.Alert{
		{Instance: "z-host", Severity: collector.SeverityInfo, Title: "info", DedupKey: "k1"},
		{Instance: "a-host", Severity: collector.SeverityWarn, Title: "warn", DedupKey: "k2"},
		{Instance: "a-host", Severity: collector.SeverityCritical, Title: "crit", DedupKey: "k3"},
	})

	result := am.GetActiveAlerts()
	if len(result) != 3 {
		t.Fatalf("expected 3 active alerts, got %d", len(result))
	}
	if result[0].Alert.Severity != collector.SeverityCritical {
		t.Errorf("result[0] severity = %q, want critical", result[0].Alert.Severity)
	}
	if result[1].Alert.Severity != collector.SeverityWarn {
		t.Errorf("result[1] severity = %q, want warn", result[1].Alert.Severity)
	}
	if result[2].Alert.Severity != collector.SeverityInfo {
		t.Errorf("result[2] severity = %q, want info", result[2].Alert.Severity)
	}
}

func TestActiveAlertCountsForInstance(t *testing.T) {
	fs := newFakeStore()
	am := newTestAlertManager(fs)

	_ = am.Reconcile(context.Background(), []collector.Alert{
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

	countsB := am.ActiveAlertCountsForInstance("inst-b")
	if countsB["critical"] != 1 || countsB["warn"] != 0 {
		t.Errorf("inst-b counts unexpected: %v", countsB)
	}

	countsX := am.ActiveAlertCountsForInstance("inst-x")
	if countsX["critical"] != 0 || countsX["warn"] != 0 || countsX["info"] != 0 {
		t.Errorf("unknown instance counts should all be 0, got %v", countsX)
	}
}

func TestGetActiveAlertsForInstance_ExcludesInfo(t *testing.T) {
	fs := newFakeStore()
	am := newTestAlertManager(fs)

	_ = am.Reconcile(context.Background(), []collector.Alert{
		{Instance: "host-7", Severity: collector.SeverityWarn, Title: "b-warn", DedupKey: "h7:b"},
		{Instance: "host-7", Severity: collector.SeverityCritical, Title: "a-crit", DedupKey: "h7:a"},
		{Instance: "host-7", Severity: collector.SeverityInfo, Title: "c-info", DedupKey: "h7:c"},
		{Instance: "other", Severity: collector.SeverityCritical, Title: "x", DedupKey: "other:x"},
	})

	result := am.GetActiveAlertsForInstance("host-7")
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

// errBoom is a sentinel error used by the fakeStore to simulate insert failures.
var errBoom = &boomErr{}

type boomErr struct{}

func (*boomErr) Error() string { return "boom" }
