package alerter

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/collector"
)

// StoreInterface abstracts the persistence layer so the alerter can record and
// query alert state without depending on a concrete store implementation.
type StoreInterface interface {
	// InsertAlert persists a new alert and returns its auto-generated ID.
	InsertAlert(alert collector.Alert) (int64, error)
	// ResolveAlert marks the alert identified by dedupKey as resolved.
	ResolveAlert(dedupKey string) error
	// IsAlertActive reports whether an alert with the given dedupKey is
	// currently in a firing (unresolved) state.
	IsAlertActive(dedupKey string) (bool, error)
}

// ActiveAlert tracks the lifecycle of a currently-firing alert.
type ActiveAlert struct {
	Alert     collector.Alert
	FirstSeen time.Time
	LastSeen  time.Time
	Count     int
	Notified  bool
	SlackTS   string // Slack message timestamp for in-place updates
	// cleanChecks counts consecutive polling cycles where this alert was NOT
	// present. After 2 clean checks the alert is considered resolved.
	cleanChecks int
}

// AlertManager provides deduplication, severity-based routing, and automatic
// resolution tracking for alerts produced by collectors.
type AlertManager struct {
	slack        *SlackNotifier
	store        StoreInterface
	dedupWindow  time.Duration
	activeAlerts map[string]*ActiveAlert // dedupKey -> alert
	slackTSMap   map[string]string       // dedupKey -> Slack message TS (persists across resolve cycles)
	mu           sync.RWMutex

	// warnBatch accumulates warn-level alerts for periodic flushing.
	warnBatch   []collector.Alert
	warnBatchTS string // Slack TS for the warn batch message (update in place)
	warnMu      sync.Mutex

	// infoBatch accumulates info-level alerts for digest-only delivery.
	infoBatch []collector.Alert
	infoMu    sync.Mutex

	// batchInterval controls how often warn-level alerts are flushed.
	batchInterval time.Duration
	// resolveCleanChecks is the number of consecutive clean cycles before an
	// alert is marked resolved. Default: 2.
	resolveCleanChecks int

	cancel context.CancelFunc
	wg     sync.WaitGroup
	logger *slog.Logger
}

// Option configures an AlertManager.
type Option func(*AlertManager)

// WithDedupWindow overrides the default 15-minute deduplication window.
func WithDedupWindow(d time.Duration) Option {
	return func(am *AlertManager) { am.dedupWindow = d }
}

// WithBatchInterval overrides the default 5-minute warn-batch interval.
func WithBatchInterval(d time.Duration) Option {
	return func(am *AlertManager) { am.batchInterval = d }
}

// WithResolveCleanChecks overrides how many consecutive clean polls are needed
// to resolve an alert (default 2).
func WithResolveCleanChecks(n int) Option {
	return func(am *AlertManager) { am.resolveCleanChecks = n }
}

// NewAlertManager creates a ready-to-use AlertManager. Call Start to begin
// background goroutines and Stop to shut them down.
func NewAlertManager(slackNotifier *SlackNotifier, store StoreInterface, opts ...Option) *AlertManager {
	am := &AlertManager{
		slack:              slackNotifier,
		store:              store,
		dedupWindow:        15 * time.Minute,
		batchInterval:      5 * time.Minute,
		resolveCleanChecks: 2,
		activeAlerts:       make(map[string]*ActiveAlert),
		slackTSMap:         make(map[string]string),
		logger: slog.Default().With(
			slog.String("component", "alert-manager"),
		),
	}
	for _, o := range opts {
		o(am)
	}
	return am
}

// Start launches background goroutines for batch flushing and resolution
// checking. It is safe to call Process before Start — alerts will simply
// queue until the background loops begin.
func (am *AlertManager) Start(ctx context.Context) {
	ctx, am.cancel = context.WithCancel(ctx)

	am.wg.Add(1)
	go am.batchLoop(ctx)

	am.wg.Add(1)
	go am.resolutionLoop(ctx)

	am.logger.Info("alert manager started",
		slog.Duration("dedup_window", am.dedupWindow),
		slog.Duration("batch_interval", am.batchInterval),
	)
}

// Stop gracefully shuts down background goroutines and flushes any remaining
// warn batch. It blocks until everything is drained.
func (am *AlertManager) Stop() {
	if am.cancel != nil {
		am.cancel()
	}
	am.wg.Wait()

	// Flush any remaining warn alerts.
	am.flushWarnBatch()

	am.logger.Info("alert manager stopped")
}

// ---------------------------------------------------------------------------
// Process — main entry point called each polling cycle
// ---------------------------------------------------------------------------

// Process evaluates a set of alerts produced by the current poll cycle. It
// applies deduplication, routes by severity, and tracks which alerts have gone
// quiet for resolution detection.
func (am *AlertManager) Process(alerts []collector.Alert) {
	now := time.Now()
	seen := make(map[string]bool, len(alerts))

	for i := range alerts {
		alert := alerts[i]
		key := alert.DedupKey
		if key == "" {
			key = fmt.Sprintf("%s:%s:%s", alert.Instance, alert.Category, alert.Title)
		}
		seen[key] = true

		am.mu.Lock()
		active, exists := am.activeAlerts[key]

		if exists {
			// Already tracking this alert — update and check dedup window.
			active.LastSeen = now
			active.Count++
			active.cleanChecks = 0 // reset resolution counter
			active.Alert = alert   // keep the latest payload
			am.mu.Unlock()

			am.logger.Debug("alert deduplicated",
				slog.String("dedup_key", key),
				slog.Int("count", active.Count),
			)
			continue
		}

		// New alert — register it.
		active = &ActiveAlert{
			Alert:     alert,
			FirstSeen: now,
			LastSeen:  now,
			Count:     1,
		}
		am.activeAlerts[key] = active
		am.mu.Unlock()

		// Persist to store.
		if am.store != nil {
			if id, err := am.store.InsertAlert(alert); err != nil {
				am.logger.Error("failed to persist alert",
					slog.String("dedup_key", key),
					slog.String("error", err.Error()),
				)
			} else {
				am.logger.Debug("alert persisted", slog.Int64("id", id), slog.String("dedup_key", key))
			}
		}

		// Route by severity.
		am.routeAlert(active)
	}

	// Mark unseen active alerts with a clean check increment.
	am.mu.Lock()
	for key, active := range am.activeAlerts {
		if !seen[key] {
			active.cleanChecks++
		}
	}
	am.mu.Unlock()
}

// ---------------------------------------------------------------------------
// Severity routing
// ---------------------------------------------------------------------------

func (am *AlertManager) routeAlert(active *ActiveAlert) {
	switch active.Alert.Severity {
	case collector.SeverityCritical:
		am.sendCritical(active)
	case collector.SeverityWarn:
		am.enqueueWarn(active.Alert)
	case collector.SeverityInfo:
		am.enqueueInfo(active.Alert)
	default:
		am.logger.Warn("unknown severity, treating as info",
			slog.String("severity", string(active.Alert.Severity)),
			slog.String("dedup_key", active.Alert.DedupKey),
		)
		am.enqueueInfo(active.Alert)
	}
}

func (am *AlertManager) sendCritical(active *ActiveAlert) {
	if am.slack == nil {
		return
	}

	key := active.Alert.DedupKey

	// Reuse existing Slack message if we've posted for this key before.
	am.mu.RLock()
	existingTS := am.slackTSMap[key]
	am.mu.RUnlock()

	ts, err := am.slack.UpdateOrPostAlert(active.Alert, existingTS, false, active.Count)
	if err != nil {
		am.logger.Error("failed to send critical alert",
			slog.String("dedup_key", key), slog.String("error", err.Error()))
		return
	}

	am.mu.Lock()
	active.Notified = true
	am.slackTSMap[key] = ts
	am.mu.Unlock()

	am.logger.Info("critical alert sent",
		slog.String("dedup_key", key), slog.String("slack_ts", ts))
}

func (am *AlertManager) enqueueWarn(alert collector.Alert) {
	am.warnMu.Lock()
	am.warnBatch = append(am.warnBatch, alert)
	am.warnMu.Unlock()
}

func (am *AlertManager) enqueueInfo(alert collector.Alert) {
	am.infoMu.Lock()
	am.infoBatch = append(am.infoBatch, alert)
	am.infoMu.Unlock()
}

// ---------------------------------------------------------------------------
// Background loops
// ---------------------------------------------------------------------------

// batchLoop flushes accumulated warn-level alerts every batchInterval.
func (am *AlertManager) batchLoop(ctx context.Context) {
	defer am.wg.Done()

	ticker := time.NewTicker(am.batchInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			am.flushWarnBatch()
		}
	}
}

func (am *AlertManager) flushWarnBatch() {
	am.warnMu.Lock()
	batch := am.warnBatch
	am.warnBatch = nil
	prevTS := am.warnBatchTS
	am.warnMu.Unlock()

	if len(batch) == 0 {
		return
	}

	if am.slack == nil {
		am.logger.Warn("slack not configured, dropping warn batch",
			slog.Int("count", len(batch)),
		)
		return
	}

	ts, err := am.slack.SendOrUpdateBatch(batch, prevTS)
	if err != nil {
		am.logger.Error("failed to send warn batch to slack",
			slog.Int("count", len(batch)),
			slog.String("error", err.Error()),
		)
		return
	}

	am.warnMu.Lock()
	am.warnBatchTS = ts
	am.warnMu.Unlock()

	// Mark all batched alerts as notified.
	am.mu.Lock()
	for _, a := range batch {
		key := a.DedupKey
		if key == "" {
			key = fmt.Sprintf("%s:%s:%s", a.Instance, a.Category, a.Title)
		}
		if active, ok := am.activeAlerts[key]; ok {
			active.Notified = true
		}
	}
	am.mu.Unlock()

	am.logger.Info("warn batch sent", slog.Int("count", len(batch)), slog.String("slack_ts", ts))
}

// resolutionLoop checks for alerts that have been absent for the required
// number of consecutive clean polls and resolves them.
func (am *AlertManager) resolutionLoop(ctx context.Context) {
	defer am.wg.Done()

	// Check slightly more often than the batch interval so resolutions don't
	// lag unnecessarily.
	ticker := time.NewTicker(am.batchInterval / 2)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			am.checkResolutions()
		}
	}
}

func (am *AlertManager) checkResolutions() {
	now := time.Now()

	am.mu.Lock()
	var resolved []*ActiveAlert
	var resolvedKeys []string

	for key, active := range am.activeAlerts {
		if active.cleanChecks >= am.resolveCleanChecks {
			resolved = append(resolved, active)
			resolvedKeys = append(resolvedKeys, key)
		}
	}

	// Remove resolved alerts from the active map while still holding the lock.
	for _, key := range resolvedKeys {
		delete(am.activeAlerts, key)
	}
	am.mu.Unlock()

	// Process resolutions outside the lock.
	for i, active := range resolved {
		key := resolvedKeys[i]
		duration := now.Sub(active.FirstSeen)

		// Persist resolution.
		if am.store != nil {
			if err := am.store.ResolveAlert(key); err != nil {
				am.logger.Error("failed to persist alert resolution",
					slog.String("dedup_key", key),
					slog.String("error", err.Error()),
				)
			}
		}

		// Update existing Slack message to show RESOLVED (same message, no new post).
		if active.Notified && am.slack != nil {
			am.mu.RLock()
			slackTS := am.slackTSMap[key]
			am.mu.RUnlock()

			if slackTS != "" {
				_, err := am.slack.UpdateOrPostAlert(active.Alert, slackTS, true, active.Count)
				if err != nil {
					am.logger.Error("failed to update slack to resolved",
						slog.String("dedup_key", key), slog.String("error", err.Error()))
				} else {
					am.logger.Info("alert resolved (updated in-place)",
						slog.String("dedup_key", key), slog.Duration("duration", duration))
				}
				// Keep slackTSMap entry — if it re-fires, we reuse the same message.
			} else {
				if err := am.slack.SendResolution(key, active.Alert.Title, active.Alert.Instance, duration); err != nil {
					am.logger.Error("failed to send resolution",
						slog.String("dedup_key", key), slog.String("error", err.Error()))
				} else {
					am.logger.Info("alert resolved",
						slog.String("dedup_key", key), slog.Duration("duration", duration))
				}
			}
		} else {
			am.logger.Debug("alert resolved (not notified)",
				slog.String("dedup_key", key))
		}
	}
}

// ---------------------------------------------------------------------------
// Info digest access
// ---------------------------------------------------------------------------

// DrainInfoAlerts returns and clears all accumulated info-level alerts. This is
// intended for use by a digest scheduler that periodically calls SendDigest.
func (am *AlertManager) DrainInfoAlerts() []collector.Alert {
	am.infoMu.Lock()
	alerts := am.infoBatch
	am.infoBatch = nil
	am.infoMu.Unlock()
	return alerts
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

// ActiveAlertCount returns the number of currently-firing alerts.
func (am *AlertManager) ActiveAlertCount() int {
	am.mu.RLock()
	defer am.mu.RUnlock()
	return len(am.activeAlerts)
}

// ActiveAlertKeys returns the dedup keys of all currently-firing alerts.
func (am *AlertManager) ActiveAlertKeys() []string {
	am.mu.RLock()
	defer am.mu.RUnlock()
	keys := make([]string, 0, len(am.activeAlerts))
	for k := range am.activeAlerts {
		keys = append(keys, k)
	}
	return keys
}

// GetActiveAlert returns a copy of the ActiveAlert for the given dedupKey, or
// nil if no such alert is currently firing.
func (am *AlertManager) GetActiveAlert(dedupKey string) *ActiveAlert {
	am.mu.RLock()
	defer am.mu.RUnlock()
	a, ok := am.activeAlerts[dedupKey]
	if !ok {
		return nil
	}
	// Return a copy to avoid data races.
	cp := *a
	return &cp
}
