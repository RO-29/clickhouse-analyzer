package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/alerter"
	"github.com/rohitjain/ch-analyzer/internal/analyzer"
	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/collector"
	"github.com/rohitjain/ch-analyzer/internal/config"
	"github.com/rohitjain/ch-analyzer/internal/prometheus"
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

	// Setup structured logging with capture buffer for dashboard
	logBuffer := web.NewLogBuffer(5000)
	jsonHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
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
		slackNotifier = alerter.NewSlackNotifier(cfg.Slack.BotToken, cfg.Slack.ChannelID)
		slog.Info("slack notifier initialized", "channel", cfg.Slack.ChannelID)
	} else {
		slog.Warn("slack not configured, alerts will only be stored locally")
	}

	storeAdapter := &alertStoreAdapter{store: metricStore}
	alertMgr := alerter.NewAlertManager(
		slackNotifier,
		storeAdapter,
		alerter.WithDedupWindow(cfg.Slack.DedupWindow.Duration),
	)
	alertMgr.Start(ctx)

	// Rehydrate alerter with active alerts persisted in ClickHouse. Without
	// this, a server restart orphans any alerts that were firing before the
	// restart: the clean-check loop never counts them as absent, so they stay
	// "active" forever even after conditions clear.
	{
		var storeAlerts []collector.Alert
		for _, name := range clientMgr.Names() {
			active, err := metricStore.GetActiveAlerts(name)
			if err != nil {
				slog.Warn("rehydrate: failed to load active alerts", "instance", name, "err", err)
				continue
			}
			for _, a := range active {
				storeAlerts = append(storeAlerts, collector.Alert{
					Instance:  a.Instance,
					Severity:  collector.Severity(a.Severity),
					Category:  a.Category,
					Title:     a.Title,
					Message:   a.Message,
					DedupKey:  a.DedupKey,
					Timestamp: a.CreatedAt,
				})
			}
		}
		alertMgr.Rehydrate(storeAlerts)
	}

	// Initialize collectors
	collectors := buildCollectors(cfg)

	// Start web server
	// Load custom suggestions if configured.
	web.LoadSuggestions(cfg.Web.SuggestionsPath)

	var webServer *web.Server
	if cfg.Web.Enabled {
		webServer = web.New(cfg.Web.ListenAddr, metricStore, az, clientMgr, logBuffer)
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
		go runDigestScheduler(ctx, cfg, az, slackNotifier, clientMgr)
	}

	// Note: no pruner needed — ClickHouse TTL handles retention automatically.

	// Main polling loop
	slog.Info("starting main polling loop", "interval", cfg.Polling.Interval.String())
	ticker := time.NewTicker(cfg.Polling.Interval.Duration)
	defer ticker.Stop()

	// Run immediately on startup
	runCollection(ctx, clientMgr, collectors, az, alertMgr, metricStore, promExporter)

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
			runCollection(ctx, clientMgr, collectors, az, alertMgr, metricStore, promExporter)
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

	if cfg.K8s.Enabled {
		result = append(result, &collector.K8sCollector{
			Config: cfg.K8s,
		})
	}

	return result
}

func runCollection(
	ctx context.Context,
	clientMgr *chclient.Manager,
	collectors []collector.Collector,
	az *analyzer.Analyzer,
	alertMgr *alerter.AlertManager,
	metricStore *store.Store,
	promExporter *prometheus.Exporter,
) {
	start := time.Now()

	clientMgr.ForEachParallel(ctx, func(_ context.Context, instanceName string, client *chclient.Client) error {
		instanceStart := time.Now()

		// Run all collectors for this instance
		var allResults []*collector.CollectResult
		var mu sync.Mutex

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
					return
				}
				mu.Lock()
				allResults = append(allResults, result)
				mu.Unlock()
			}(c)
		}
		wg.Wait()

		// Analyze results
		analysisResult, err := az.Analyze(instanceName, allResults)
		if err != nil {
			slog.Error("analysis failed", "instance", instanceName, "error", err)
			return nil
		}

		// Store metrics
		var allMetrics []store.Metric
		for _, r := range allResults {
			for _, m := range r.Metrics {
				allMetrics = append(allMetrics, store.Metric{
					Instance:  instanceName,
					Name:      m.Name,
					Labels:    m.Labels,
					Value:     m.Value,
					Timestamp: m.Timestamp,
				})
			}
		}
		for _, m := range analysisResult.Metrics {
			allMetrics = append(allMetrics, store.Metric{
				Instance:  instanceName,
				Name:      m.Name,
				Labels:    m.Labels,
				Value:     m.Value,
				Timestamp: m.Timestamp,
			})
		}

		if len(allMetrics) > 0 {
			if err := metricStore.InsertMetrics(allMetrics); err != nil {
				slog.Error("failed to store metrics", "instance", instanceName, "error", err)
			}
		}

		// Update prometheus
		if promExporter != nil {
			var collectorMetrics []collector.Metric
			for _, r := range allResults {
				collectorMetrics = append(collectorMetrics, r.Metrics...)
			}
			collectorMetrics = append(collectorMetrics, analysisResult.Metrics...)
			promExporter.Update(collectorMetrics)
		}

		// Process alerts
		var allAlerts []collector.Alert
		for _, r := range allResults {
			allAlerts = append(allAlerts, r.Alerts...)
		}
		allAlerts = append(allAlerts, analysisResult.Alerts...)
		allAlerts = append(allAlerts, analysisResult.CrossAlerts...)

		alertMgr.Process(allAlerts)

		slog.Debug("collection complete",
			"instance", instanceName,
			"metrics", len(allMetrics),
			"alerts", len(allAlerts),
			"duration", time.Since(instanceStart),
		)

		return nil
	})

	slog.Info("poll cycle complete",
		"duration", time.Since(start),
		"instances", clientMgr.Len(),
	)
}

func runDigestScheduler(
	ctx context.Context,
	cfg *config.Config,
	az *analyzer.Analyzer,
	slack *alerter.SlackNotifier,
	clientMgr *chclient.Manager,
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
				sendDigest(ctx, "daily", az, slack, clientMgr, cfg)
			}

			// Weekly digest
			if timeStr == cfg.Slack.Digest.DailyTime &&
				equalsIgnoreCase(dayName, cfg.Slack.Digest.WeeklyDay) &&
				dateStr != lastWeeklyDate {
				lastWeeklyDate = dateStr
				sendDigest(ctx, "weekly", az, slack, clientMgr, cfg)
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
) {
	healthScores := make(map[string]int)
	clientMgr.ForEach(func(name string, _ *chclient.Client) error {
		hs := az.GetHealthScore(name)
		healthScores[name] = hs.Score
		return nil
	})

	dashboardURL := fmt.Sprintf("http://localhost%s", cfg.Web.ListenAddr)
	digest := alerter.DigestMessage{
		Period:       period,
		HealthScores: healthScores,
		TopIssues:    []string{},
		Stats:        map[string]string{},
		DashboardURL: dashboardURL,
	}

	if err := slack.SendDigest(digest); err != nil {
		slog.Error("failed to send digest", "period", period, "error", err)
	} else {
		slog.Info("digest sent", "period", period)
	}
}

// alertStoreAdapter bridges the store.Store (which uses store.Alert) with the
// alerter.StoreInterface (which uses collector.Alert).
type alertStoreAdapter struct {
	store *store.Store
}

func (a *alertStoreAdapter) InsertAlert(alert collector.Alert) (int64, error) {
	return a.store.InsertAlert(store.Alert{
		Instance:  alert.Instance,
		Severity:  string(alert.Severity),
		Category:  alert.Category,
		Title:     alert.Title,
		Message:   alert.Message,
		CreatedAt: alert.Timestamp,
		DedupKey:  alert.DedupKey,
	})
}

func (a *alertStoreAdapter) ResolveAlert(dedupKey string) error {
	return a.store.ResolveAlert(dedupKey)
}

func (a *alertStoreAdapter) IsAlertActive(dedupKey string) (bool, error) {
	return a.store.IsAlertActive(dedupKey)
}

func (a *alertStoreAdapter) TouchAlerts(dedupKeys []string) error {
	return a.store.BulkTouchAlerts(dedupKeys)
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
