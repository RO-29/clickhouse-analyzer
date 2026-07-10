package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/alerter"
	"github.com/rohitjain/ch-analyzer/internal/analyzer"
	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/collector"
	"github.com/rohitjain/ch-analyzer/internal/config"
	"github.com/rohitjain/ch-analyzer/internal/prometheus"
	"github.com/rohitjain/ch-analyzer/internal/slackapp"
	"github.com/rohitjain/ch-analyzer/internal/store"
	"github.com/rohitjain/ch-analyzer/internal/web"
)

var (
	version   = "dev"
	buildTime = "unknown"
)

func main() {
	configPath := flag.String("config", "configs/ch-analyzer.yaml", "Path to config file")
	showVersion := flag.Bool("version", false, "Show version and exit")
	mcpServer := flag.Bool("mcp-server", false, "Run as MCP stdio server (used by Claude CLI subprocess)")
	mcpInstance := flag.String("mcp-instance", "", "ClickHouse instance name for MCP server mode")
	dryRun := flag.Bool("dry-run", false, "Run all collectors once, print alerts that would fire, then exit")
	compatCheck := flag.Bool("compat-check", false, "Detect capabilities + run every collector once per instance; print a JSON report and exit non-zero on any hard error (version-compatibility CI)")
	flag.Parse()

	if *showVersion {
		fmt.Printf("ch-analyzer %s (built %s)\n", version, buildTime)
		os.Exit(0)
	}

	// ── MCP stdio server mode ─────────────────────────────────────────────────
	// Started as a subprocess by the Claude CLI via --mcp-config.
	// Connects to one CH instance and handles JSON-RPC tool calls on stdin/stdout.
	if *mcpServer {
		if *mcpInstance == "" {
			fmt.Fprintln(os.Stderr, "ch-analyzer --mcp-server requires --mcp-instance <name>")
			os.Exit(1)
		}
		cfg, err := config.Load(*configPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "mcp-server: failed to load config: %v\n", err)
			os.Exit(1)
		}
		var instCfg *chclient.InstanceConfig
		for _, ic := range cfg.Instances {
			if ic.Name == *mcpInstance {
				instCfg = &chclient.InstanceConfig{
					Name:     ic.Name,
					Host:     ic.Host,
					Port:     ic.Port,
					Username: ic.Username,
					Password: ic.Password,
					Secure:   ic.Secure,
					Database: ic.Database,
				}
				break
			}
		}
		if instCfg == nil {
			fmt.Fprintf(os.Stderr, "mcp-server: instance %q not found in config\n", *mcpInstance)
			os.Exit(1)
		}
		client := chclient.NewClient(*instCfg, chclient.ClientOptions{
			ConnectTimeout: 10 * time.Second,
			QueryTimeout:   30 * time.Second,
			InsecureSkipVerify: true,
		})
		ctx := context.Background()
		web.RunMCPServer(ctx, client)
		os.Exit(0)
	}

	// Expose config path so the web server can pass it to MCP subprocesses.
	os.Setenv("CH_ANALYZER_CONFIG", *configPath)

	// Setup structured logging with capture buffer for dashboard. In
	// --compat-check mode logs go to stderr so stdout carries only the JSON
	// report (the harness captures stdout).
	logBuffer := web.NewLogBuffer(5000)
	logDst := os.Stdout
	if *compatCheck {
		logDst = os.Stderr
	}
	jsonHandler := slog.NewJSONHandler(logDst, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})
	logHandler := web.NewLogBufferHandler(logBuffer, jsonHandler)
	logger := slog.New(logHandler)
	slog.SetDefault(logger)

	slog.Info("starting ch-analyzer", "version", version, "config", *configPath)

	// Load config
	cfg, err := config.Load(*configPath)
	if err != nil {
		slog.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	if err := cfg.Validate(); err != nil {
		slog.Error("invalid config", "error", err)
		os.Exit(1)
	}

	slog.Info("config loaded", "instances", len(cfg.Instances), "poll_interval", cfg.Polling.Interval.String())

	// Context with signal handling
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		slog.Info("received signal, shutting down", "signal", sig)
		cancel()
	}()

	// Initialize CH client manager
	instances := make([]chclient.InstanceConfig, len(cfg.Instances))
	for i, inst := range cfg.Instances {
		instances[i] = chclient.InstanceConfig{
			Name:     inst.Name,
			Host:     inst.Host,
			Port:     inst.Port,
			Username: inst.Username,
			Password: inst.Password,
			Secure:   inst.Secure,
			Database: inst.Database,
			Mode:     inst.Mode,
		}
	}
	clientMgr := chclient.NewManager(instances, chclient.ClientOptions{
		ConnectTimeout:    10 * time.Second,
		QueryTimeout:      30 * time.Second,
		InsecureSkipVerify: true,
	})

	// Ping all instances
	unhealthy := clientMgr.PingAll(ctx)
	for name, pingErr := range unhealthy {
		slog.Warn("instance unhealthy at startup", "instance", name, "error", pingErr)
	}
	slog.Info("instance health check complete",
		"total", clientMgr.Len(),
		"healthy", clientMgr.Len()-len(unhealthy),
		"unhealthy", len(unhealthy),
	)

	// Initialize storage — each node stores its own data
	metricStore, err := store.New(clientMgr, cfg.Storage.Database)
	if err != nil {
		slog.Error("failed to initialize store", "error", err)
		os.Exit(1)
	}
	defer metricStore.Close()

	// Initialize analyzer
	az := analyzer.New(analyzer.AnalyzerThresholds{
		AnomalyStdDevMultiplier: 2.0,
		SustainedIssueCount:     3,
	})

	// Initialize alert manager
	var slackNotifier *alerter.SlackNotifier
	if cfg.Slack.BotToken != "" && cfg.Slack.ChannelID != "" {
		slackNotifier = alerter.NewSlackNotifier(cfg.Slack.BotToken, cfg.Slack.ChannelID, cfg.Slack.DashboardURL)
		slog.Info("slack notifier initialized", "channel", cfg.Slack.ChannelID)
	} else {
		slog.Warn("slack not configured, alerts will only be stored locally")
	}

	storeAdapter := &alertStoreAdapter{store: metricStore}

	// Build inhibition rules from config, then append defaults.
	var inhibitionRules []alerter.InhibitionRule
	for _, r := range cfg.Inhibition {
		inhibitionRules = append(inhibitionRules, alerter.InhibitionRule{
			SourceCategory: r.SourceCategory,
			SourceSeverity: r.SourceSeverity,
			TargetCategory: r.TargetCategory,
			TargetSeverity: r.TargetSeverity,
		})
	}
	inhibitionRules = append(inhibitionRules, alerter.DefaultInhibitionRules()...)

	// Stale-sweep threshold. Default 24h when unset or zero.
	staleHours := cfg.Alerting.StaleResolveHours
	if staleHours <= 0 {
		staleHours = 24
	}

	alertMgrOpts := []alerter.Option{
		alerter.WithDedupWindow(cfg.Slack.DedupWindow.Duration),
		alerter.WithInhibition(inhibitionRules),
		alerter.WithEscalation(alerter.EscalationConfig{
			Enabled:     cfg.Escalation.Enabled,
			NoticeAfter: cfg.Escalation.NoticeAfter.Duration,
			RepeatEvery: cfg.Escalation.RepeatEvery.Duration,
		}),
		alerter.WithStaleResolveAfter(time.Duration(staleHours) * time.Hour),
	}

	// PagerDuty notifier.
	if cfg.Notify.PagerDuty.Enabled && cfg.Notify.PagerDuty.RoutingKey != "" {
		pdNotifier := alerter.NewPagerDutyNotifier(cfg.Notify.PagerDuty.RoutingKey)
		alertMgrOpts = append(alertMgrOpts, alerter.WithPagerDuty(pdNotifier))
		slog.Info("PagerDuty notifier enabled")
	}

	// Webhook notifier.
	if cfg.Notify.Webhook.Enabled && cfg.Notify.Webhook.URL != "" {
		whNotifier := alerter.NewWebhookNotifier(cfg.Notify.Webhook.URL, cfg.Notify.Webhook.Secret)
		alertMgrOpts = append(alertMgrOpts, alerter.WithWebhook(whNotifier))
		slog.Info("webhook notifier enabled", slog.String("url", cfg.Notify.Webhook.URL))
	}

	// Maintenance store (shared with web server).
	// Persist windows to /var/lib/ch-analyzer/ (writable runtime state dir).
	// Fall back to a path alongside the config if that dir isn't available.
	maintenanceStore := alerter.NewMaintenanceStore()
	maintFile := "/var/lib/ch-analyzer/maintenance.json"
	if err := os.MkdirAll("/var/lib/ch-analyzer", 0755); err != nil {
		// /var/lib not writable — fall back to OS temp dir
		maintFile = os.TempDir() + "/ch-analyzer-maintenance.json"
		slog.Warn("cannot create /var/lib/ch-analyzer, using temp dir for maintenance persistence", "path", maintFile)
	}
	maintenanceStore.SetPersistPath(maintFile)
	alertMgrOpts = append(alertMgrOpts, alerter.WithMaintenance(maintenanceStore))

	// Snooze store (shared with web server).
	snoozeFile := "/var/lib/ch-analyzer/snoozes.json"
	if err := os.MkdirAll("/var/lib/ch-analyzer", 0755); err != nil {
		snoozeFile = os.TempDir() + "/ch-analyzer-snoozes.json"
		slog.Warn("cannot create /var/lib/ch-analyzer, using temp dir for snooze persistence", "path", snoozeFile)
	}
	snoozeStore := alerter.NewSnoozeStore(snoozeFile)
	alertMgrOpts = append(alertMgrOpts, alerter.WithSnooze(snoozeStore))

	// Ack store (shared with web server).
	ackFile := "/var/lib/ch-analyzer/acks.json"
	if err := os.MkdirAll("/var/lib/ch-analyzer", 0755); err != nil {
		ackFile = os.TempDir() + "/ch-analyzer-acks.json"
		slog.Warn("cannot create /var/lib/ch-analyzer, using temp dir for ack persistence", "path", ackFile)
	}
	ackStore := alerter.NewAckStore(ackFile)
	alertMgrOpts = append(alertMgrOpts, alerter.WithAck(ackStore))

	// Schedule store (shared with web server).
	scheduleFile := "/var/lib/ch-analyzer/schedules.json"
	if err := os.MkdirAll("/var/lib/ch-analyzer", 0755); err != nil {
		scheduleFile = os.TempDir() + "/ch-analyzer-schedules.json"
		slog.Warn("cannot create /var/lib/ch-analyzer, using temp dir for schedule persistence", "path", scheduleFile)
	}
	scheduleStore := web.NewScheduleStore(scheduleFile)

	alertMgr := alerter.NewAlertManager(slackNotifier, storeAdapter, alertMgrOpts...)
	alertMgr.Start(ctx)

	// No rehydrate needed: Reconcile reads DB state every poll cycle, so
	// alerts that were firing before a restart naturally resume their
	// lifecycle on the first poll. The in-memory clean-check counter starts
	// fresh, which at worst adds one cycle's delay before a stale alert is
	// auto-resolved — an acceptable trade for the simpler state model.

	// Initialize collectors
	collectors := buildCollectors(cfg)

	// Dry-run mode: collect once, print alerts, exit.
	if *compatCheck {
		os.Exit(runCompatCheck(ctx, clientMgr, collectors))
	}

	if *dryRun {
		slog.Info("dry-run mode: running one collection cycle")
		var dryAlerts []collector.Alert
		var dryMu sync.Mutex
		clientMgr.ForEachParallel(ctx, func(_ context.Context, instanceName string, client *chclient.Client) error {
			for _, c := range collectors {
				result, err := c.Collect(ctx, client)
				if err != nil {
					slog.Warn("collector failed in dry-run", "collector", c.Name(), "instance", instanceName, "error", err)
					continue
				}
				dryMu.Lock()
				dryAlerts = append(dryAlerts, result.Alerts...)
				dryMu.Unlock()
			}
			return nil
		})
		for _, a := range dryAlerts {
			fmt.Printf("[%s] %s:%s — %s\n", strings.ToUpper(string(a.Severity)), a.Instance, a.Category, a.Title)
		}
		fmt.Printf("Dry run complete. %d alert(s) would fire.\n", len(dryAlerts))
		os.Exit(0)
	}

	// Start web server
	// Load custom suggestions if configured.
	web.LoadSuggestions(cfg.Web.SuggestionsPath)

	forcePollCh := make(chan struct{}, 1) // buffered: at most one pending force-poll

	var webServer *web.Server
	if cfg.Web.Enabled {
		webServer = web.New(cfg.Web.ListenAddr, cfg, metricStore, az, clientMgr, logBuffer)
		webServer.SetMaintenanceStore(maintenanceStore)
		webServer.SetSnoozeStore(snoozeStore)
		webServer.SetAckStore(ackStore)
		webServer.SetScheduleStore(scheduleStore)
		webServer.SetForcePollCh(forcePollCh)
		webServer.SetAlertMgr(alertMgr)
		webServer.SetVersion(version)
		// Threshold overrides — live-editable via the dashboard.
		thresholdsOverridePath := "/var/lib/ch-analyzer/thresholds.json"
		webServer.SetThresholdsOverridePath(thresholdsOverridePath)
		if data, err := os.ReadFile(thresholdsOverridePath); err == nil {
			var override config.ThresholdsConfig
			if err := json.Unmarshal(data, &override); err == nil {
				cfg.Thresholds = override
			}
		}
		go func() {
			if err := webServer.Start(ctx); err != nil {
				slog.Error("web server error", "error", err)
			}
		}()
		slog.Info("web dashboard started", "addr", cfg.Web.ListenAddr)
	}

	// Start prometheus exporter
	var promExporter *prometheus.Exporter
	if cfg.Prometheus.Enabled {
		promExporter = prometheus.New(cfg.Prometheus.ListenAddr)
		go func() {
			if err := promExporter.Start(ctx); err != nil {
				slog.Error("prometheus exporter error", "error", err)
			}
		}()
		slog.Info("prometheus exporter started", "addr", cfg.Prometheus.ListenAddr)
	}

	// Start digest scheduler
	if cfg.Slack.Digest.Enabled && slackNotifier != nil {
		go runDigestScheduler(ctx, cfg, az, slackNotifier, clientMgr, alertMgr)
	}

	// Start Slack Socket Mode app (slash commands + interactive buttons + pinned dashboard).
	if cfg.Slack.BotToken != "" && cfg.Slack.AppToken != "" {
		app := slackapp.New(cfg.Slack, cfg.Web.ListenAddr, alertMgr, maintenanceStore, snoozeStore, ackStore, clientMgr)
		go func() {
			slog.Info("slack socket mode app starting")
			app.Run(ctx)
		}()
	}

	// Schedule runner: every 30 s check if any schedule is due and run its collector.
	// inFlightSchedules tracks which schedule IDs are currently running so that a
	// slow collector (e.g. a 90-second CH query) does not get re-launched on the
	// next 30-second tick, preventing goroutine pile-up.
	var inFlightSchedules sync.Map
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				due := scheduleStore.Due()
				for _, sched := range due {
					sched := sched // capture
					// Skip if a previous run for this schedule is still in progress.
					if _, loaded := inFlightSchedules.LoadOrStore(sched.ID, struct{}{}); loaded {
						slog.Warn("schedule: previous run still in progress, skipping tick",
							"schedule", sched.ID,
							"collector", sched.CollectorName,
							"instance", sched.Instance)
						continue
					}
					go func() {
						defer inFlightSchedules.Delete(sched.ID)
						client := clientMgr.Get(sched.Instance)
						if client == nil {
							slog.Warn("schedule: instance not found, skipping", "schedule", sched.ID, "instance", sched.Instance)
							scheduleStore.UpdateLastRun(sched.ID)
							return
						}
						coll, ok := collector.BuildCollectorFromConfig(sched.CollectorName, cfg)
						if !ok {
							slog.Warn("schedule: unknown collector, skipping", "schedule", sched.ID, "collector", sched.CollectorName)
							scheduleStore.UpdateLastRun(sched.ID)
							return
						}
						runCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
						defer cancel()
						_, err := coll.Collect(runCtx, client)
						if err != nil {
							slog.Warn("schedule: collector run failed", "schedule", sched.ID, "collector", sched.CollectorName, "instance", sched.Instance, "error", err)
						} else {
							slog.Info("schedule: collector ran successfully", "schedule", sched.ID, "collector", sched.CollectorName, "instance", sched.Instance)
						}
						scheduleStore.UpdateLastRun(sched.ID)
					}()
				}
			}
		}
	}()

	// Note: no pruner needed — ClickHouse TTL handles retention automatically.

	// Circuit breaker state. Accessed concurrently from per-instance goroutines
	// inside runReconcile, so guarded by cbMu.
	var cbMu sync.Mutex
	instanceFailures := make(map[string]int)      // consecutive all-collector failure count
	instanceBackoff := make(map[string]time.Time) // when backoff expires

	// lastPoll is written by the poll closure after each reconcile returns and
	// read by the web server's /health handler via SetLastPollFn. Atomic so
	// concurrent access needs no lock.
	var lastPoll atomic.Pointer[time.Time]
	if webServer != nil {
		webServer.SetLastPollFn(func() time.Time {
			if p := lastPoll.Load(); p != nil {
				return *p
			}
			return time.Time{}
		})
	}

	// Main polling loop
	slog.Info("starting main polling loop", "interval", cfg.Polling.Interval.String())
	ticker := time.NewTicker(cfg.Polling.Interval.Duration)
	defer ticker.Stop()

	poll := func() {
		runReconcile(ctx, clientMgr, collectors, az, alertMgr, metricStore, promExporter,
			&cbMu, instanceFailures, instanceBackoff)
		now := time.Now()
		lastPoll.Store(&now)
	}

	// Run immediately on startup
	poll()

	for {
		select {
		case <-ctx.Done():
			slog.Info("shutting down")
			alertMgr.Stop()
			if webServer != nil {
				shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
				webServer.Stop(shutdownCtx)
				shutdownCancel()
			}
			if promExporter != nil {
				shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
				promExporter.Stop(shutdownCtx)
				shutdownCancel()
			}
			slog.Info("shutdown complete")
			return
		case <-ticker.C:
			poll()
		case <-forcePollCh:
			slog.Info("force poll triggered via API")
			poll()
		}
	}
}

func buildCollectors(cfg *config.Config) []collector.Collector {
	var result []collector.Collector

	result = append(result, &collector.SystemCollector{
		MemoryThresholds: cfg.Thresholds.Memory,
		CPUThresholds:    cfg.Thresholds.CPU,
	})

	result = append(result, &collector.QueryCollector{
		Thresholds: cfg.Thresholds.Queries,
	})

	result = append(result, &collector.TableCollector{
		PartsThresholds:     cfg.Thresholds.Parts,
		MergesThresholds:    cfg.Thresholds.Merges,
		MutationsThresholds: cfg.Thresholds.Mutations,
	})

	result = append(result, &collector.StorageCollector{
		DiskThresholds: cfg.Thresholds.Disk,
		S3Thresholds:   cfg.Thresholds.S3,
	})

	result = append(result, &collector.InsertCollector{
		Thresholds:      cfg.Thresholds.Inserts,
		PollingInterval: cfg.Polling.Interval.Duration,
	})

	result = append(result, &collector.MVCollector{
		Thresholds: cfg.Thresholds.MV,
	})

	result = append(result, &collector.DictionaryCollector{
		Thresholds: cfg.Thresholds.Dictionaries,
	})

	result = append(result, &collector.ReplicationCollector{
		Thresholds: cfg.Thresholds.Replication,
	})

	result = append(result, &collector.ErrorsCollector{})

	result = append(result, &collector.BackgroundPoolCollector{})
	result = append(result, &collector.CacheHealthCollector{})
	result = append(result, &collector.ConnectionsCollector{})
	result = append(result, &collector.QueryLatencyCollector{})
	result = append(result, &collector.FreshnessCollector{})
	result = append(result, &collector.SchemaDriftCollector{})
	result = append(result, &collector.ProjectionCollector{})
	result = append(result, &collector.TTLCollector{})
	result = append(result, &collector.AsyncInsertsCollector{})
	result = append(result, &collector.PartsAgeCollector{})
	result = append(result, &collector.SlowQueryFingerprintCollector{})
	result = append(result, &collector.KeeperCollector{})
	result = append(result, &collector.QuerySamplesCollector{})
	result = append(result, &collector.RestartCollector{Database: cfg.Storage.Database})

	if cfg.K8s.Enabled {
		result = append(result, &collector.K8sCollector{
			Config: cfg.K8s,
		})
	}

	return result
}

// instanceSnapshot is the per-instance output of a poll cycle before reconcile.
type instanceSnapshot struct {
	name          string
	alerts        []collector.Alert // collector + analyzer alerts (no reconcile yet)
	rawMetrics    []collector.Metric
	healthScore   int
	hadCollection bool // false if circuit-broken or total collector failure
	// fullyObserved is true only when *every* collector for this instance
	// succeeded. If even one failed, reconcile must NOT auto-resolve this
	// instance's alerts — we can't distinguish "condition cleared" from
	// "collector blew up".
	fullyObserved bool
}

// runReconcile executes one poll cycle across all instances:
//  1. In parallel, collect metrics/alerts per instance + run analyzer.
//  2. Union all alerts into a single set, add connectivity alerts for failing
//     instances, then call alertMgr.Reconcile once.
//  3. Per-instance: store metrics, update Prometheus gauges from the
//     reconciled DB state, record health snapshot.
//
// Reconcile is the single writer to the alerts table. Everything else in this
// function is metrics + health plumbing.
func runReconcile(
	ctx context.Context,
	clientMgr *chclient.Manager,
	collectors []collector.Collector,
	az *analyzer.Analyzer,
	alertMgr *alerter.AlertManager,
	metricStore *store.Store,
	promExporter *prometheus.Exporter,
	cbMu *sync.Mutex,
	instanceFailures map[string]int,
	instanceBackoff map[string]time.Time,
) {
	start := time.Now()

	var (
		snapsMu sync.Mutex
		snaps   []instanceSnapshot
	)
	addSnap := func(s instanceSnapshot) {
		snapsMu.Lock()
		snaps = append(snaps, s)
		snapsMu.Unlock()
	}

	clientMgr.ForEachParallel(ctx, func(_ context.Context, instanceName string, client *chclient.Client) error {
		// Circuit breaker: skip collection if in backoff, but keep the
		// connectivity alert alive in the currentAlerts set so reconcile does
		// not auto-resolve it.
		cbMu.Lock()
		backoffUntil, inBackoff := instanceBackoff[instanceName]
		cbMu.Unlock()
		if inBackoff && time.Now().Before(backoffUntil) {
			slog.Debug("instance in backoff, skipping", "instance", instanceName)
			addSnap(instanceSnapshot{
				name:   instanceName,
				alerts: []collector.Alert{connectivityAlert(instanceName)},
			})
			return nil
		}

		instanceStart := time.Now()

		var (
			resultsMu   sync.Mutex
			allResults  []*collector.CollectResult
			errorMu     sync.Mutex
			errorCount  int
		)

		var wg sync.WaitGroup
		for _, c := range collectors {
			wg.Add(1)
			go func(c collector.Collector) {
				defer wg.Done()
				result, err := c.Collect(ctx, client)
				if err != nil {
					slog.Error("collector failed",
						"collector", c.Name(),
						"instance", instanceName,
						"error", err,
					)
					errorMu.Lock()
					errorCount++
					errorMu.Unlock()
					return
				}
				resultsMu.Lock()
				allResults = append(allResults, result)
				resultsMu.Unlock()
			}(c)
		}
		wg.Wait()

		collectionFailed := len(allResults) == 0 && errorCount == len(collectors)
		if collectionFailed {
			cbMu.Lock()
			instanceFailures[instanceName]++
			tripped := instanceFailures[instanceName] >= 5
			if tripped {
				instanceBackoff[instanceName] = time.Now().Add(5 * time.Minute)
			}
			cbMu.Unlock()
			snap := instanceSnapshot{name: instanceName}
			if tripped {
				slog.Warn("instance entering backoff after 5 failures", "instance", instanceName)
				snap.alerts = []collector.Alert{connectivityAlert(instanceName)}
			}
			addSnap(snap)
			return nil
		}
		// Reset failure counter on any successful collection.
		cbMu.Lock()
		instanceFailures[instanceName] = 0
		delete(instanceBackoff, instanceName)
		cbMu.Unlock()

		analysisResult, err := az.Analyze(instanceName, allResults)
		if err != nil {
			slog.Error("analysis failed", "instance", instanceName, "error", err)
			addSnap(instanceSnapshot{name: instanceName, hadCollection: true})
			return nil
		}

		// Metrics: persist per-instance (the write is already async-safe).
		var storeMetrics []store.Metric
		var rawMetrics []collector.Metric
		for _, r := range allResults {
			rawMetrics = append(rawMetrics, r.Metrics...)
			for _, m := range r.Metrics {
				storeMetrics = append(storeMetrics, store.Metric{
					Instance:  instanceName,
					Name:      m.Name,
					Labels:    m.Labels,
					Value:     m.Value,
					Timestamp: m.Timestamp,
				})
			}
		}
		rawMetrics = append(rawMetrics, analysisResult.Metrics...)
		for _, m := range analysisResult.Metrics {
			storeMetrics = append(storeMetrics, store.Metric{
				Instance:  instanceName,
				Name:      m.Name,
				Labels:    m.Labels,
				Value:     m.Value,
				Timestamp: m.Timestamp,
			})
		}
		if len(storeMetrics) > 0 {
			if err := metricStore.InsertMetrics(storeMetrics); err != nil {
				slog.Error("failed to store metrics", "instance", instanceName, "error", err)
			}
		}

		// Alerts: collector + analyzer + cross-instance; passed to reconcile
		// after all instances have reported.
		var alerts []collector.Alert
		for _, r := range allResults {
			alerts = append(alerts, r.Alerts...)
		}
		alerts = append(alerts, analysisResult.Alerts...)
		alerts = append(alerts, analysisResult.CrossAlerts...)

		addSnap(instanceSnapshot{
			name:          instanceName,
			alerts:        alerts,
			rawMetrics:    rawMetrics,
			healthScore:   analysisResult.HealthScore.Score,
			hadCollection: true,
			fullyObserved: errorCount == 0,
		})

		slog.Debug("collection complete",
			"instance", instanceName,
			"metrics", len(storeMetrics),
			"alerts", len(alerts),
			"duration", time.Since(instanceStart),
		)
		return nil
	})

	// Union all instance alerts into a single reconcile input. Build the
	// "fully observed" set so reconcile knows which instances it can trust
	// when computing the missing-alert set for clean-check accounting.
	var currentAlerts []collector.Alert
	trustedInstances := make(map[string]bool, len(snaps))
	for _, s := range snaps {
		currentAlerts = append(currentAlerts, s.alerts...)
		if s.fullyObserved {
			trustedInstances[s.name] = true
		}
	}

	if err := alertMgr.ReconcileWithObservation(ctx, currentAlerts, trustedInstances); err != nil {
		slog.Error("reconcile failed", "error", err)
	}

	// Per-instance post-reconcile updates: Prometheus gauges + health snapshot.
	// ActiveAlertCountsForInstance now reads from the DB (post-reconcile state),
	// so it reflects exactly what the UI sees.
	now := time.Now()
	for _, s := range snaps {
		alertCounts := alertMgr.ActiveAlertCountsForInstance(s.name)

		if promExporter != nil {
			metrics := append([]collector.Metric(nil), s.rawMetrics...)
			for sev, count := range alertCounts {
				metrics = append(metrics, collector.Metric{
					Instance:  s.name,
					Name:      "active_alerts",
					Value:     float64(count),
					Labels:    map[string]string{"severity": sev},
					Timestamp: now,
				})
			}
			promExporter.Update(metrics)
		}

		if s.hadCollection {
			criticals := alertCounts["critical"]
			warns := alertCounts["warn"]
			infos := alertCounts["info"]
			snapCtx, snapCancel := context.WithTimeout(ctx, 5*time.Second)
			if err := metricStore.RecordHealthSnapshot(snapCtx, s.name, float32(s.healthScore), criticals, warns, infos); err != nil {
				slog.Debug("failed to record health snapshot", "instance", s.name, "err", err)
			}
			snapCancel()
		}
	}

	slog.Info("poll cycle complete",
		"duration", time.Since(start),
		"instances", clientMgr.Len(),
		"alerts", len(currentAlerts),
	)
}

// connectivityAlert builds the standard unreachable-instance alert. Used in
// two places: when an instance is already in backoff (kept firing), and when
// it first trips the 5-consecutive-failure threshold.
func connectivityAlert(instance string) collector.Alert {
	return collector.Alert{
		Instance:  instance,
		Severity:  collector.SeverityCritical,
		Category:  "connectivity",
		Title:     "Instance unreachable",
		Message:   fmt.Sprintf("ClickHouse instance %s has failed to respond for 5 consecutive polls. Skipping collection until it recovers.", instance),
		DedupKey:  instance + ":connectivity:unreachable",
		Timestamp: time.Now(),
	}
}

func runDigestScheduler(
	ctx context.Context,
	cfg *config.Config,
	az *analyzer.Analyzer,
	slack *alerter.SlackNotifier,
	clientMgr *chclient.Manager,
	alertMgr *alerter.AlertManager,
) {
	// Check every minute if it's time for a digest
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	var lastDailyDate string
	var lastWeeklyDate string

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			timeStr := now.Format("15:04")
			dateStr := now.Format("2006-01-02")
			dayName := now.Weekday().String()

			// Daily digest
			if timeStr == cfg.Slack.Digest.DailyTime && dateStr != lastDailyDate {
				lastDailyDate = dateStr
				sendDigest(ctx, "daily", az, slack, clientMgr, cfg, alertMgr)
			}

			// Weekly digest
			if timeStr == cfg.Slack.Digest.DailyTime &&
				equalsIgnoreCase(dayName, cfg.Slack.Digest.WeeklyDay) &&
				dateStr != lastWeeklyDate {
				lastWeeklyDate = dateStr
				sendDigest(ctx, "weekly", az, slack, clientMgr, cfg, alertMgr)
			}
		}
	}
}

func sendDigest(
	ctx context.Context,
	period string,
	az *analyzer.Analyzer,
	slack *alerter.SlackNotifier,
	clientMgr *chclient.Manager,
	cfg *config.Config,
	alertMgr *alerter.AlertManager,
) {
	healthScores := make(map[string]int)
	clientMgr.ForEach(func(name string, _ *chclient.Client) error {
		hs := az.GetHealthScore(name)
		healthScores[name] = hs.Score
		return nil
	})

	// Collect active alerts sorted by severity (critical first).
	activeAlerts := alertMgr.GetActiveAlerts()
	sort.Slice(activeAlerts, func(i, j int) bool {
		ri := digestSeverityRank(activeAlerts[i].Alert.Severity)
		rj := digestSeverityRank(activeAlerts[j].Alert.Severity)
		return ri > rj
	})

	var topIssues []string
	for i, a := range activeAlerts {
		if i >= 5 {
			break
		}
		topIssues = append(topIssues, fmt.Sprintf("[%s] %s — %s",
			strings.ToUpper(string(a.Alert.Severity)), a.Alert.Instance, a.Alert.Title))
	}

	stats := map[string]string{
		"Active Alerts": fmt.Sprintf("%d", len(activeAlerts)),
		"Critical":      fmt.Sprintf("%d", digestCountBySeverity(activeAlerts, "critical")),
		"Warning":       fmt.Sprintf("%d", digestCountBySeverity(activeAlerts, "warn")),
		"Instances":     fmt.Sprintf("%d", len(healthScores)),
	}

	dashboardURL := cfg.Slack.DashboardURL
	if dashboardURL == "" {
		dashboardURL = fmt.Sprintf("http://localhost%s", cfg.Web.ListenAddr)
	}

	digest := alerter.DigestMessage{
		Period:       period,
		HealthScores: healthScores,
		TopIssues:    topIssues,
		Stats:        stats,
		DashboardURL: dashboardURL,
	}

	if err := slack.SendDigest(digest); err != nil {
		slog.Error("failed to send digest", "period", period, "error", err)
	} else {
		slog.Info("digest sent", "period", period)
	}
}

// digestSeverityRank returns a numeric rank for sorting (higher = more severe).
func digestSeverityRank(s collector.Severity) int {
	switch s {
	case collector.SeverityCritical:
		return 2
	case collector.SeverityWarn:
		return 1
	default:
		return 0
	}
}

// digestCountBySeverity counts alerts matching the given severity string.
func digestCountBySeverity(alerts []*alerter.ActiveAlert, severity string) int {
	n := 0
	for _, a := range alerts {
		if string(a.Alert.Severity) == severity {
			n++
		}
	}
	return n
}

// alertStoreAdapter bridges the store.Store (which uses store.Alert) with the
// alerter.StoreInterface (which uses collector.Alert).
type alertStoreAdapter struct {
	store *store.Store
}

func (a *alertStoreAdapter) InsertAlert(alert collector.Alert) (int64, error) {
	return a.store.InsertAlert(store.Alert{
		Instance:    alert.Instance,
		Severity:    string(alert.Severity),
		Category:    alert.Category,
		Title:       alert.Title,
		Message:     alert.Message,
		CreatedAt:   alert.Timestamp,
		DedupKey:    alert.DedupKey,
		FirstSeenAt: alert.FirstSeenAt, // empty → store carries forward from prior rows
		FireCount:   alert.FireCount,   // 0 → store carries forward + increments
	})
}

func (a *alertStoreAdapter) ResolveAlert(dedupKey string) error {
	return a.store.ResolveAlert(dedupKey)
}

func (a *alertStoreAdapter) RefreshAlerts(alerts []collector.Alert) error {
	if len(alerts) == 0 {
		return nil
	}
	out := make([]store.Alert, 0, len(alerts))
	for _, al := range alerts {
		out = append(out, store.Alert{
			Instance: al.Instance,
			Severity: string(al.Severity),
			Category: al.Category,
			Title:    al.Title,
			Message:  al.Message,
			DedupKey: al.DedupKey,
		})
	}
	return a.store.BulkRefreshAlerts(out)
}

func (a *alertStoreAdapter) AutoResolveStale(olderThan time.Duration) (int64, error) {
	return a.store.AutoResolveStale(olderThan)
}

func (a *alertStoreAdapter) GetAllActiveAlerts() []collector.Alert {
	return storeAlertsToCollector(a.store.GetAllActiveAlerts())
}

func (a *alertStoreAdapter) GetActiveAlertsForInstance(instance string) []collector.Alert {
	alerts, err := a.store.GetActiveAlerts(instance)
	if err != nil {
		slog.Warn("GetActiveAlertsForInstance: query failed",
			"instance", instance, "err", err)
		return nil
	}
	return storeAlertsToCollector(alerts)
}

// storeAlertsToCollector translates persisted rows into the collector.Alert
// shape the alerter reasons about. FirstSeenAt / FireCount are preserved so
// downstream projections show correct lifetime stats.
func storeAlertsToCollector(alerts []store.Alert) []collector.Alert {
	out := make([]collector.Alert, 0, len(alerts))
	for _, a := range alerts {
		out = append(out, collector.Alert{
			Instance:    a.Instance,
			Severity:    collector.Severity(a.Severity),
			Category:    a.Category,
			Title:       a.Title,
			Message:     a.Message,
			DedupKey:    a.DedupKey,
			Timestamp:   a.CreatedAt,
			FirstSeenAt: a.FirstSeenAt,
			FireCount:   a.FireCount,
		})
	}
	return out
}

func equalsIgnoreCase(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if ca >= 'A' && ca <= 'Z' {
			ca += 32
		}
		if cb >= 'A' && cb <= 'Z' {
			cb += 32
		}
		if ca != cb {
			return false
		}
	}
	return true
}

// runCompatCheck detects capabilities and runs every collector once against each
// configured instance, printing a JSON report. It exits non-zero if any
// collector returns a hard error (collectors are expected to degrade gracefully
// on missing tables/columns/permissions, so a returned error is a real
// compatibility gap). Used by scripts/compat-test.sh across ClickHouse versions.
func runCompatCheck(ctx context.Context, mgr *chclient.Manager, collectors []collector.Collector) int {
	type collectorResult struct {
		Name  string `json:"name"`
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
	}
	type instanceReport struct {
		Instance     string                 `json:"instance"`
		Capabilities *chclient.Capabilities `json:"capabilities"`
		Collectors   []collectorResult      `json:"collectors"`
		HardErrors   int                    `json:"hard_errors"`
	}

	var reports []instanceReport
	hardErrors := 0

	for _, name := range mgr.Names() {
		client := mgr.Get(name)
		if client == nil {
			continue
		}
		rep := instanceReport{Instance: name, Capabilities: client.Caps(ctx)}
		for _, c := range collectors {
			cctx, cancel := context.WithTimeout(ctx, 45*time.Second)
			_, err := c.Collect(cctx, client)
			cancel()
			if err != nil {
				rep.Collectors = append(rep.Collectors, collectorResult{Name: c.Name(), OK: false, Error: err.Error()})
				rep.HardErrors++
				hardErrors++
			} else {
				rep.Collectors = append(rep.Collectors, collectorResult{Name: c.Name(), OK: true})
			}
		}
		reports = append(reports, rep)
	}

	out, _ := json.MarshalIndent(reports, "", "  ")
	fmt.Println(string(out)) // stdout: machine-readable report only
	fmt.Fprintf(os.Stderr, "compat-check: %d instance(s), %d hard error(s)\n", len(reports), hardErrors)
	if hardErrors > 0 {
		return 1
	}
	return 0
}
