package alerter

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/collector"
)

// StoreInterface abstracts the persistence layer. The alerter reads *and* writes
// active alert state through this interface; the DB is the single source of
// truth for "what is currently firing".
type StoreInterface interface {
	// InsertAlert persists a new firing event (resolved=0). Implementations
	// should carry forward first_seen_at / fire_count across re-firings of the
	// same dedup_key.
	InsertAlert(alert collector.Alert) (int64, error)
	// ResolveAlert marks the alert identified by dedupKey as resolved.
	ResolveAlert(dedupKey string) error
	// TouchAlerts bumps updated_at = now() for the given dedup keys. Used to
	// keep staleness detection accurate; rate-limited by the alerter.
	TouchAlerts(dedupKeys []string) error
	// AutoResolveStale marks any resolved=0 alert with updated_at older than
	// olderThan as resolved. Called from the heartbeat loop as a safety net
	// against ghost alerts that escaped the clean-check resolution path
	// (process restarts, flapping conditions). Returns count resolved.
	AutoResolveStale(olderThan time.Duration) (int64, error)
	// GetAllActiveAlerts returns every unresolved alert across every instance.
	// Used once per reconcile cycle to compute diffs against current collector
	// output.
	GetAllActiveAlerts() []collector.Alert
	// GetActiveAlertsForInstance returns unresolved alerts for a single
	// instance. Used by public getters that drive Slack and UI.
	GetActiveAlertsForInstance(instance string) []collector.Alert
}

// ActiveAlert is a lightweight projection of an alert's lifecycle state,
// returned by the public getters that Slack and the dashboard consume.
type ActiveAlert struct {
	Alert     collector.Alert
	FirstSeen time.Time
	LastSeen  time.Time
	Count     int
	Notified  bool
}

// AlertManager owns the reconcile loop that keeps the DB alerts table in sync
// with what collectors observe each poll cycle.
//
// Design principle: the DB is the source of truth. In-memory state holds only
// derived caches (clean-check counters, Slack TS map, rate-limit clocks). That
// means UI resolves, bulk resolves, and failed inserts all self-heal on the
// next reconcile — there is no second map to keep in sync.
type AlertManager struct {
	slack *SlackNotifier
	store StoreInterface

	// cleanChecks counts consecutive reconcile cycles where a dedup_key was
	// absent from collectors but still present in the DB. When it reaches
	// resolveCleanChecks, the alert is marked resolved.
	cleanChecks map[string]int

	// instanceTS maps instance → Slack message TS so in-place updates don't
	// create a new message each poll. Persisted across restarts by SlackApp.
	instanceTS         map[string]string
	lastInstanceUpdate map[string]time.Time

	// instanceFirstFired / lastEscalated drive the escalation notice.
	instanceFirstFired map[string]time.Time
	lastEscalated      map[string]time.Time

	// infoBatch accumulates info-severity alerts for the daily digest.
	infoBatch []collector.Alert
	infoMu    sync.Mutex

	mu sync.Mutex

	dedupWindow        time.Duration
	heartbeatInterval  time.Duration
	resolveCleanChecks int

	// Filters applied to newly-firing alerts before notify.
	inhibition  *InhibitionMatcher
	maintenance *MaintenanceStore
	snooze      *SnoozeStore
	ack         *AckStore

	// External notifiers.
	pagerduty *PagerDutyNotifier
	webhook   *WebhookNotifier

	// lastTouched rate-limits BulkTouch. Each touch inserts a new version row
	// into the ReplacingMergeTree; doing it every poll floods parts.
	lastTouched time.Time

	// staleResolveAfter is the age threshold for the heartbeat stale-sweep.
	// Zero disables the sweep. Default 24h via WithStaleResolveAfter.
	staleResolveAfter time.Duration

	escalation EscalationConfig

	onStateChange func()

	cancel context.CancelFunc
	wg     sync.WaitGroup
	logger *slog.Logger
}

// Option configures an AlertManager.
type Option func(*AlertManager)

// WithDedupWindow overrides the default 15-minute deduplication window.
// (Kept for API compatibility; reconcile uses store state directly, so this
// only affects downstream notifier timing.)
func WithDedupWindow(d time.Duration) Option {
	return func(am *AlertManager) { am.dedupWindow = d }
}

// WithBatchInterval overrides the heartbeat interval.
func WithBatchInterval(d time.Duration) Option {
	return func(am *AlertManager) { am.heartbeatInterval = d }
}

// WithResolveCleanChecks overrides how many consecutive clean polls are needed
// to resolve an alert (default 4).
func WithResolveCleanChecks(n int) Option {
	return func(am *AlertManager) { am.resolveCleanChecks = n }
}

// WithInhibition installs an InhibitionMatcher that suppresses noisy symptom
// alerts when a same-instance root-cause alert is already firing.
func WithInhibition(rules []InhibitionRule) Option {
	return func(am *AlertManager) {
		am.inhibition = &InhibitionMatcher{Rules: rules}
	}
}

// WithMaintenance installs a MaintenanceStore. Alerts for instances in a
// maintenance window are dropped entirely — no DB row, no Slack.
func WithMaintenance(store *MaintenanceStore) Option {
	return func(am *AlertManager) { am.maintenance = store }
}

// WithSnooze installs a SnoozeStore. Snoozed alerts still persist to DB (so
// the UI sees them) but skip Slack/PD/webhook notification.
func WithSnooze(store *SnoozeStore) Option {
	return func(am *AlertManager) { am.snooze = store }
}

// WithAck installs an AckStore. Cleared automatically when alerts resolve.
func WithAck(store *AckStore) Option {
	return func(am *AlertManager) { am.ack = store }
}

// WithPagerDuty installs a PagerDutyNotifier for critical alert escalation.
func WithPagerDuty(notifier *PagerDutyNotifier) Option {
	return func(am *AlertManager) { am.pagerduty = notifier }
}

// WithWebhook installs a WebhookNotifier for generic event delivery.
func WithWebhook(notifier *WebhookNotifier) Option {
	return func(am *AlertManager) { am.webhook = notifier }
}

// WithEscalation overrides the default escalation configuration.
func WithEscalation(cfg EscalationConfig) Option {
	return func(am *AlertManager) { am.escalation = cfg }
}

// WithStaleResolveAfter enables the heartbeat-driven stale-alert sweep.
// Any alert whose updated_at is older than d gets resolved on each heartbeat
// tick. Zero disables the sweep. Covers the gap where cleanChecks can't
// resolve an alert (in-memory counter lost on restart, or condition flaps
// enough to reset the counter).
func WithStaleResolveAfter(d time.Duration) Option {
	return func(am *AlertManager) { am.staleResolveAfter = d }
}

// NewAlertManager creates a ready-to-use AlertManager. Call Start to begin
// the heartbeat goroutine and Stop to shut it down.
func NewAlertManager(slackNotifier *SlackNotifier, store StoreInterface, opts ...Option) *AlertManager {
	am := &AlertManager{
		slack:              slackNotifier,
		store:              store,
		dedupWindow:        15 * time.Minute,
		heartbeatInterval:  5 * time.Minute,
		resolveCleanChecks: 4,
		staleResolveAfter:  24 * time.Hour,
		escalation:         DefaultEscalationConfig(),
		cleanChecks:        make(map[string]int),
		instanceTS:         make(map[string]string),
		lastInstanceUpdate: make(map[string]time.Time),
		instanceFirstFired: make(map[string]time.Time),
		lastEscalated:      make(map[string]time.Time),
		logger: slog.Default().With(
			slog.String("component", "alert-manager"),
		),
	}
	for _, o := range opts {
		o(am)
	}
	return am
}

// Start launches the heartbeat goroutine. Safe to call Reconcile without Start
// (tests do this).
func (am *AlertManager) Start(ctx context.Context) {
	ctx, am.cancel = context.WithCancel(ctx)

	am.wg.Add(1)
	go am.heartbeatLoop(ctx)

	am.logger.Info("alert manager started",
		slog.Duration("heartbeat_interval", am.heartbeatInterval),
		slog.Int("resolve_clean_checks", am.resolveCleanChecks),
	)
}

// Stop gracefully shuts down background goroutines.
func (am *AlertManager) Stop() {
	if am.cancel != nil {
		am.cancel()
	}
	am.wg.Wait()
	am.logger.Info("alert manager stopped")
}

// ClearCleanChecks removes any pending clean-check count for the given
// dedup_key. Called from the UI resolve handlers so a user-initiated resolve
// doesn't race with in-flight clean-check accounting.
func (am *AlertManager) ClearCleanChecks(dedupKey string) {
	am.mu.Lock()
	delete(am.cleanChecks, dedupKey)
	am.mu.Unlock()
}

// ---------------------------------------------------------------------------
// Reconcile — the main entry point called each poll cycle
// ---------------------------------------------------------------------------

// Reconcile makes the DB alerts table match ground truth.
//
// Given the full set of alerts that collectors observed this cycle, Reconcile:
//  1. Reads current DB state (unresolved alerts across all instances).
//  2. Computes the diff: what's firing now but not in DB (insert), what's still
//     firing (touch updated_at), what was in DB but no longer observed
//     (increment clean-check counter; resolve after N cycles).
//  3. Applies filters — maintenance (drop), inhibition (persist but no notify),
//     snooze (persist but no notify), info severity (persist + digest only).
//  4. Writes to store. Failed inserts are logged but don't mutate memory — the
//     next reconcile naturally retries because the alert is still firing and
//     still missing from the DB.
//  5. Fires Slack updates for dirty instances, webhooks for fire/resolve, and
//     PagerDuty triggers/resolves.
//
// Reconcile is idempotent: calling it twice with the same currentAlerts does
// nothing on the second call beyond maybe one rate-limited touch.
func (am *AlertManager) Reconcile(ctx context.Context, currentAlerts []collector.Alert) error {
	if am.store == nil {
		return fmt.Errorf("reconcile: store not configured")
	}

	now := time.Now()

	// ── Build the "current" set, canonicalizing dedup keys ──────────────────
	currentByKey := make(map[string]collector.Alert, len(currentAlerts))
	for i := range currentAlerts {
		a := currentAlerts[i]
		if a.DedupKey == "" {
			a.DedupKey = fmt.Sprintf("%s:%s:%s", a.Instance, a.Category, a.Title)
		}
		// Last occurrence wins on duplicates within one batch.
		currentByKey[a.DedupKey] = a
	}

	// ── Snapshot DB active state ────────────────────────────────────────────
	dbActive := am.store.GetAllActiveAlerts()
	dbByKey := make(map[string]collector.Alert, len(dbActive))
	for _, a := range dbActive {
		dbByKey[a.DedupKey] = a
	}

	// ── Compute diff ────────────────────────────────────────────────────────
	var (
		toInsert []collector.Alert // firing now, no open DB row
		toTouch  []string          // firing now, open DB row
		missing  []collector.Alert // open DB row, not firing now
	)
	for key, a := range currentByKey {
		if _, ok := dbByKey[key]; ok {
			toTouch = append(toTouch, key)
		} else {
			toInsert = append(toInsert, a)
		}
	}
	for key, a := range dbByKey {
		if _, ok := currentByKey[key]; !ok {
			missing = append(missing, a)
		}
	}

	// ── Apply filters to toInsert; decide what to persist and what to notify ──
	// Inhibition sees everything currently firing (existing DB rows + new
	// inserts) so a new queries:warn can be inhibited by an existing
	// memory:critical on the same instance.
	inhibActive := make(map[string]*ActiveAlert, len(dbByKey)+len(toInsert))
	for key, a := range dbByKey {
		cp := a
		inhibActive[key] = &ActiveAlert{Alert: cp}
	}
	for i := range toInsert {
		cp := toInsert[i]
		inhibActive[cp.DedupKey] = &ActiveAlert{Alert: cp}
	}

	var (
		toPersist []collector.Alert
		toNotify  []collector.Alert
		infoBatch []collector.Alert
	)
	dirtyInstances := make(map[string]bool)

	for _, a := range toInsert {
		// Maintenance: drop entirely.
		if am.maintenance != nil && am.maintenance.IsInMaintenance(a.Instance) {
			am.logger.Debug("alert suppressed (maintenance)",
				slog.String("instance", a.Instance),
				slog.String("dedup_key", a.DedupKey))
			continue
		}

		// Info severity: always persist (UI needs to see it) + digest queue.
		if a.Severity == collector.SeverityInfo {
			toPersist = append(toPersist, a)
			infoBatch = append(infoBatch, a)
			continue
		}

		// Inhibition: persist (UI visibility) but don't notify Slack/PD/webhook.
		if am.inhibition != nil {
			if am.inhibition.IsInhibited(ActiveAlert{Alert: a}, inhibActive) {
				am.logger.Debug("alert inhibited",
					slog.String("dedup_key", a.DedupKey),
					slog.String("instance", a.Instance))
				toPersist = append(toPersist, a)
				continue
			}
		}

		// Snooze: persist but don't notify.
		if am.snooze != nil && am.snooze.IsSnoozed(a.DedupKey) {
			am.logger.Debug("alert snoozed",
				slog.String("dedup_key", a.DedupKey),
				slog.String("instance", a.Instance))
			toPersist = append(toPersist, a)
			continue
		}

		toPersist = append(toPersist, a)
		toNotify = append(toNotify, a)
		dirtyInstances[a.Instance] = true
	}

	// ── Clean-check accounting + resolve candidates ─────────────────────────
	var toResolve []collector.Alert
	am.mu.Lock()
	for _, a := range missing {
		am.cleanChecks[a.DedupKey]++
		if am.cleanChecks[a.DedupKey] >= am.resolveCleanChecks {
			toResolve = append(toResolve, a)
			delete(am.cleanChecks, a.DedupKey)
			dirtyInstances[a.Instance] = true
		}
	}
	// Any alert observed this cycle resets its counter.
	for key := range currentByKey {
		delete(am.cleanChecks, key)
	}
	am.mu.Unlock()

	// ── Writes: insert new firings ──────────────────────────────────────────
	for _, a := range toPersist {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := am.store.InsertAlert(a); err != nil {
			am.logger.Error("failed to persist alert",
				slog.String("dedup_key", a.DedupKey),
				slog.String("instance", a.Instance),
				slog.String("err", err.Error()))
			// Intentional: do not mutate any in-memory state. Next reconcile
			// will observe the alert still firing and still missing from the
			// DB, and retry the insert.
		}
	}

	// ── Writes: touch still-firing alerts (rate-limited) ────────────────────
	am.mu.Lock()
	shouldTouch := len(toTouch) > 0 && time.Since(am.lastTouched) >= 5*time.Minute
	if shouldTouch {
		am.lastTouched = now
	}
	am.mu.Unlock()
	if shouldTouch {
		if err := am.store.TouchAlerts(toTouch); err != nil {
			am.logger.Debug("touch alerts failed", slog.String("err", err.Error()))
		}
	}

	// ── Writes: resolve ─────────────────────────────────────────────────────
	for _, a := range toResolve {
		if err := am.store.ResolveAlert(a.DedupKey); err != nil {
			am.logger.Error("failed to persist resolution",
				slog.String("dedup_key", a.DedupKey),
				slog.String("err", err.Error()))
			continue
		}
		if am.ack != nil {
			am.ack.ClearForDedupKey(a.DedupKey)
		}
		if am.pagerduty != nil {
			if perr := am.pagerduty.ResolveAlert(a.DedupKey); perr != nil {
				am.logger.Warn("pagerduty resolve failed",
					slog.String("dedup_key", a.DedupKey),
					slog.String("err", perr.Error()))
			}
		}
		if am.webhook != nil {
			wp := WebhookPayload{
				Event:     "alert_resolved",
				Instance:  a.Instance,
				Severity:  string(a.Severity),
				Category:  a.Category,
				Title:     a.Title,
				Message:   a.Message,
				DedupKey:  a.DedupKey,
				FiredAt:   a.FirstSeenAt,
				FireCount: a.FireCount,
			}
			if werr := am.webhook.Send(wp); werr != nil {
				am.logger.Warn("webhook send (resolve) failed",
					slog.String("dedup_key", a.DedupKey),
					slog.String("err", werr.Error()))
			}
		}
		am.logger.Info("alert resolved",
			slog.String("dedup_key", a.DedupKey),
			slog.String("instance", a.Instance))
	}

	// ── Info batch ──────────────────────────────────────────────────────────
	if len(infoBatch) > 0 {
		am.infoMu.Lock()
		am.infoBatch = append(am.infoBatch, infoBatch...)
		am.infoMu.Unlock()
	}

	// ── Notify: PagerDuty triggers (critical fires only) ────────────────────
	if am.pagerduty != nil {
		for _, a := range toNotify {
			if a.Severity != collector.SeverityCritical {
				continue
			}
			if perr := am.pagerduty.TriggerAlert(a, a.DedupKey); perr != nil {
				am.logger.Warn("pagerduty trigger failed",
					slog.String("dedup_key", a.DedupKey),
					slog.String("err", perr.Error()))
			}
		}
	}

	// ── Notify: webhook (per-fire) ──────────────────────────────────────────
	if am.webhook != nil {
		for _, a := range toNotify {
			firstSeen := a.FirstSeenAt
			if firstSeen.IsZero() {
				firstSeen = now
			}
			fireCount := a.FireCount
			if fireCount <= 0 {
				fireCount = 1
			}
			wp := WebhookPayload{
				Event:     "alert_firing",
				Instance:  a.Instance,
				Severity:  string(a.Severity),
				Category:  a.Category,
				Title:     a.Title,
				Message:   a.Message,
				DedupKey:  a.DedupKey,
				FiredAt:   firstSeen,
				FireCount: fireCount,
			}
			if werr := am.webhook.Send(wp); werr != nil {
				am.logger.Warn("webhook send failed",
					slog.String("dedup_key", a.DedupKey),
					slog.String("err", werr.Error()))
			}
		}
	}

	// ── Notify: Slack per-instance message ──────────────────────────────────
	for inst := range dirtyInstances {
		am.updateInstanceMessage(inst)
	}

	// ── onStateChange hook (pinned dashboard refresh, etc.) ─────────────────
	if len(toPersist) > 0 || len(toResolve) > 0 {
		am.mu.Lock()
		cb := am.onStateChange
		am.mu.Unlock()
		if cb != nil {
			am.wg.Add(1)
			go func() {
				defer am.wg.Done()
				cb()
			}()
		}
	}

	return nil
}

// ---------------------------------------------------------------------------
// Slack — per-instance grouped message
// ---------------------------------------------------------------------------

// updateInstanceMessage composes the current Slack message for an instance and
// posts or updates it in-place. Reads state fresh from the store every call.
func (am *AlertManager) updateInstanceMessage(instance string) {
	if am.slack == nil {
		return
	}

	am.mu.Lock()
	if last, ok := am.lastInstanceUpdate[instance]; ok && time.Since(last) < time.Minute {
		am.mu.Unlock()
		return
	}
	ts := am.instanceTS[instance]
	am.mu.Unlock()

	instanceAlerts := am.GetActiveAlertsForInstance(instance)

	var (
		newTS string
		err   error
	)
	if len(instanceAlerts) == 0 {
		newTS, err = am.slack.PostInstanceAllClear(instance, ts)
		if err != nil {
			am.logger.Error("failed to post all-clear for instance",
				slog.String("instance", instance), slog.String("error", err.Error()))
			return
		}
		am.logger.Info("instance all-clear posted", slog.String("instance", instance))
	} else {
		newTS, err = am.slack.UpdateOrPostInstanceMessage(instance, ts, instanceAlerts)
		if err != nil {
			am.logger.Error("failed to update instance Slack message",
				slog.String("instance", instance), slog.String("error", err.Error()))
			return
		}
		am.logger.Info("instance Slack message updated",
			slog.String("instance", instance),
			slog.Int("active_alerts", len(instanceAlerts)),
			slog.String("slack_ts", newTS),
		)
	}

	am.mu.Lock()
	if newTS != "" {
		am.instanceTS[instance] = newTS
	}
	am.lastInstanceUpdate[instance] = time.Now()

	if len(instanceAlerts) == 0 {
		delete(am.instanceFirstFired, instance)
		delete(am.lastEscalated, instance)
	} else {
		if _, ok := am.instanceFirstFired[instance]; !ok {
			am.instanceFirstFired[instance] = time.Now()
		}
	}
	am.mu.Unlock()
}

// ---------------------------------------------------------------------------
// Heartbeat — keeps Slack "Updated:" timestamps fresh when nothing changes
// ---------------------------------------------------------------------------

func (am *AlertManager) heartbeatLoop(ctx context.Context) {
	defer am.wg.Done()

	ticker := time.NewTicker(am.heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			am.heartbeatTick()
		}
	}
}

func (am *AlertManager) heartbeatTick() {
	if am.store == nil {
		return
	}

	// Safety sweep: resolve any ghost alerts whose updated_at is older than
	// the configured stale threshold. This handles the case where cleanChecks
	// can't resolve (process restarted, counter lost) or flapping conditions
	// keep resetting the counter but the underlying condition is actually gone.
	if am.staleResolveAfter > 0 {
		if n, err := am.store.AutoResolveStale(am.staleResolveAfter); err != nil {
			am.logger.Warn("stale sweep failed", slog.String("err", err.Error()))
		} else if n > 0 {
			am.logger.Info("stale sweep resolved alerts",
				slog.Int64("count", n),
				slog.Duration("threshold", am.staleResolveAfter))
		}
	}

	dbActive := am.store.GetAllActiveAlerts()
	instances := make(map[string]bool)
	for _, a := range dbActive {
		if a.Severity != collector.SeverityInfo {
			instances[a.Instance] = true
		}
	}

	// Clear rate-limit so heartbeat always lands.
	am.mu.Lock()
	for inst := range instances {
		delete(am.lastInstanceUpdate, inst)
	}
	am.mu.Unlock()

	for inst := range instances {
		am.updateInstanceMessage(inst)

		// Escalation: if the instance has been firing for longer than
		// escalation.NoticeAfter without a response, post an escalation
		// notice at most once per escalation.RepeatEvery.
		if !am.escalation.Enabled {
			continue
		}
		am.mu.Lock()
		first, hasFired := am.instanceFirstFired[inst]
		last, hasEscalated := am.lastEscalated[inst]
		am.mu.Unlock()

		if !hasFired || time.Since(first) <= am.escalation.NoticeAfter {
			continue
		}
		if hasEscalated && time.Since(last) <= am.escalation.RepeatEvery {
			continue
		}
		firingMinutes := int(time.Since(first).Minutes())
		if am.slack != nil {
			am.mu.Lock()
			threadTS := am.instanceTS[inst]
			am.mu.Unlock()
			_ = am.slack.PostEscalationNotice(inst, firingMinutes, threadTS)
		}
		am.mu.Lock()
		am.lastEscalated[inst] = time.Now()
		am.mu.Unlock()
	}
}

// ---------------------------------------------------------------------------
// Info digest
// ---------------------------------------------------------------------------

// DrainInfoAlerts returns and clears all accumulated info-level alerts.
func (am *AlertManager) DrainInfoAlerts() []collector.Alert {
	am.infoMu.Lock()
	alerts := am.infoBatch
	am.infoBatch = nil
	am.infoMu.Unlock()
	return alerts
}

// ---------------------------------------------------------------------------
// Public getters — DB-backed
// ---------------------------------------------------------------------------

// ActiveAlertCount returns the number of currently-firing alerts across all
// instances and severities.
func (am *AlertManager) ActiveAlertCount() int {
	if am.store == nil {
		return 0
	}
	return len(am.store.GetAllActiveAlerts())
}

// ActiveAlertCountsForInstance returns severity → count for the given instance.
// Always returns keys for "critical", "warn", and "info" (zero-filled) so
// Prometheus gauges reset to 0 when alerts clear.
func (am *AlertManager) ActiveAlertCountsForInstance(instance string) map[string]int {
	counts := map[string]int{"critical": 0, "warn": 0, "info": 0}
	if am.store == nil {
		return counts
	}
	for _, a := range am.store.GetActiveAlertsForInstance(instance) {
		sev := string(a.Severity)
		if _, ok := counts[sev]; ok {
			counts[sev]++
		}
	}
	return counts
}

// ActiveAlertKeys returns dedup keys of all currently-firing alerts.
func (am *AlertManager) ActiveAlertKeys() []string {
	if am.store == nil {
		return nil
	}
	dbActive := am.store.GetAllActiveAlerts()
	keys := make([]string, 0, len(dbActive))
	for _, a := range dbActive {
		keys = append(keys, a.DedupKey)
	}
	return keys
}

// GetActiveAlert returns an ActiveAlert projection for the given dedup_key, or
// nil if no unresolved alert exists with that key.
func (am *AlertManager) GetActiveAlert(dedupKey string) *ActiveAlert {
	if am.store == nil {
		return nil
	}
	for _, a := range am.store.GetAllActiveAlerts() {
		if a.DedupKey == dedupKey {
			return projectActiveAlert(a)
		}
	}
	return nil
}

// GetActiveAlerts returns projections of all currently-firing alerts across all
// instances, sorted critical → warn → info, then alphabetically by instance
// and title.
func (am *AlertManager) GetActiveAlerts() []*ActiveAlert {
	if am.store == nil {
		return nil
	}
	dbActive := am.store.GetAllActiveAlerts()
	result := make([]*ActiveAlert, 0, len(dbActive))
	for _, a := range dbActive {
		result = append(result, projectActiveAlert(a))
	}
	sort.Slice(result, func(i, j int) bool {
		oi := severityOrder(result[i].Alert.Severity)
		oj := severityOrder(result[j].Alert.Severity)
		if oi != oj {
			return oi < oj
		}
		if result[i].Alert.Instance != result[j].Alert.Instance {
			return result[i].Alert.Instance < result[j].Alert.Instance
		}
		return result[i].Alert.Title < result[j].Alert.Title
	})
	return result
}

// GetActiveAlertsForInstance returns non-info active alerts for the given
// instance, sorted critical-first.
func (am *AlertManager) GetActiveAlertsForInstance(instance string) []*ActiveAlert {
	if am.store == nil {
		return nil
	}
	var result []*ActiveAlert
	for _, a := range am.store.GetActiveAlertsForInstance(instance) {
		if a.Severity == collector.SeverityInfo {
			continue
		}
		result = append(result, projectActiveAlert(a))
	}
	sort.Slice(result, func(i, j int) bool {
		oi := severityOrder(result[i].Alert.Severity)
		oj := severityOrder(result[j].Alert.Severity)
		if oi != oj {
			return oi < oj
		}
		return result[i].Alert.Title < result[j].Alert.Title
	})
	return result
}

// projectActiveAlert converts a store-shaped collector.Alert into an
// ActiveAlert with sane FirstSeen / LastSeen / Count fallbacks.
func projectActiveAlert(a collector.Alert) *ActiveAlert {
	firstSeen := a.FirstSeenAt
	if firstSeen.IsZero() {
		firstSeen = a.Timestamp
	}
	count := a.FireCount
	if count <= 0 {
		count = 1
	}
	return &ActiveAlert{
		Alert:     a,
		FirstSeen: firstSeen,
		LastSeen:  a.Timestamp,
		Count:     count,
		Notified:  true,
	}
}

// ---------------------------------------------------------------------------
// State-change hook and Slack TS persistence (used by SlackApp)
// ---------------------------------------------------------------------------

// SetOnStateChange registers a callback invoked after each reconcile that
// mutated state. Used by SlackApp to refresh the pinned dashboard.
func (am *AlertManager) SetOnStateChange(fn func()) {
	am.mu.Lock()
	am.onStateChange = fn
	am.mu.Unlock()
}

// GetInstanceTSMap returns a copy of the instance → SlackTS map for persistence.
func (am *AlertManager) GetInstanceTSMap() map[string]string {
	am.mu.Lock()
	defer am.mu.Unlock()
	out := make(map[string]string, len(am.instanceTS))
	for k, v := range am.instanceTS {
		out[k] = v
	}
	return out
}

// LoadInstanceTSMap restores instance → SlackTS entries from a persisted
// snapshot. Only fills in entries currently empty.
func (am *AlertManager) LoadInstanceTSMap(m map[string]string) {
	am.mu.Lock()
	defer am.mu.Unlock()
	for k, v := range m {
		if am.instanceTS[k] == "" && v != "" {
			am.instanceTS[k] = v
		}
	}
}

// ---------------------------------------------------------------------------
// Sort helper
// ---------------------------------------------------------------------------

func severityOrder(s collector.Severity) int {
	switch s {
	case collector.SeverityCritical:
		return 0
	case collector.SeverityWarn:
		return 1
	default:
		return 2
	}
}
