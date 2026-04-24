package config

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Duration wraps time.Duration to support human-readable YAML values like "5m", "1h".
type Duration struct {
	time.Duration
}

func (d *Duration) UnmarshalYAML(value *yaml.Node) error {
	var s string
	if err := value.Decode(&s); err != nil {
		return err
	}
	parsed, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", s, err)
	}
	d.Duration = parsed
	return nil
}

func (d Duration) MarshalYAML() (interface{}, error) {
	return d.Duration.String(), nil
}

// Config is the top-level configuration for ch-analyzer.
type Config struct {
	Instances   []Instance         `yaml:"instances"`
	Polling     PollingConfig      `yaml:"polling"`
	Thresholds  ThresholdsConfig   `yaml:"thresholds"`
	Slack       SlackConfig        `yaml:"slack"`
	Web         WebConfig          `yaml:"web"`
	Storage     StorageConfig      `yaml:"storage"`
	Prometheus  PrometheusConfig   `yaml:"prometheus"`
	K8s         K8sConfig          `yaml:"k8s"`
	Altinity    AltinityConfig     `yaml:"altinity"`
	Notify      NotifyConfig       `yaml:"notify"`
	Inhibition  []InhibitionConfig `yaml:"inhibition"`
	Maintenance MaintenanceConfig  `yaml:"maintenance"`
	Escalation  EscalationConfig   `yaml:"escalation"`
	Alerting    AlertingConfig     `yaml:"alerting"`
}

// AlertingConfig holds alerter-wide knobs that don't fit the per-threshold or
// per-notifier groups.
type AlertingConfig struct {
	// StaleResolveHours auto-resolves any alert whose updated_at is older than
	// this threshold on every heartbeat tick. Catches ghost alerts that
	// escaped the normal clean-check resolution path (process restarts,
	// flapping conditions). 0 disables the sweep. Default: 24.
	StaleResolveHours int `yaml:"stale_resolve_hours"`
}

// EscalationConfig controls when escalation notices are sent.
type EscalationConfig struct {
	// Enabled controls whether escalation notices are sent at all. Default: true.
	Enabled bool `yaml:"enabled"`
	// NoticeAfter is how long an alert must be continuously firing before
	// an escalation notice is sent. Default: 30 minutes.
	NoticeAfter Duration `yaml:"notice_after"`
	// RepeatEvery is how often to repeat the escalation notice. Default: 30 minutes.
	RepeatEvery Duration `yaml:"repeat_every"`
}

// AltinityConfig controls cost estimation for the Altinity Cloud Cost Explorer.
type AltinityConfig struct {
	// PricingModel selects the Altinity pricing tier:
	//   byoc_aws | byoc_gcp | byoc_azure | byoc_hetzner | managed
	PricingModel string `yaml:"pricing_model"`
	// VCPUOverride manually sets the vCPU count (0 = auto-detect from K8s metrics).
	VCPUOverride int `yaml:"vcpu_override"`
	// EBSGBMonthlyUSD is the cost per GB/month for block storage (default: $0.08 for AWS gp3).
	EBSGBMonthlyUSD float64 `yaml:"ebs_gb_monthly_usd"`
	// S3GBMonthlyUSD is the cost per GB/month for S3 object storage (default: $0.023 AWS standard).
	S3GBMonthlyUSD float64 `yaml:"s3_gb_monthly_usd"`
}

// Instance describes a single ClickHouse connection target.
type Instance struct {
	Name     string `yaml:"name"`
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	Username string `yaml:"username"`
	Password string `yaml:"password"`
	Secure   bool   `yaml:"secure"`
	Database string `yaml:"database"`
}

// PollingConfig controls how often metrics are collected.
type PollingConfig struct {
	Interval Duration `yaml:"interval"`
}

// ThresholdsConfig groups every category of threshold.
type ThresholdsConfig struct {
	Memory        MemoryThresholds        `yaml:"memory"`
	CPU           CPUThresholds           `yaml:"cpu"`
	Queries       QueriesThresholds       `yaml:"queries"`
	Parts         PartsThresholds         `yaml:"parts"`
	Merges        MergesThresholds        `yaml:"merges"`
	Mutations     MutationsThresholds     `yaml:"mutations"`
	Inserts       InsertsThresholds       `yaml:"inserts"`
	Disk          DiskThresholds          `yaml:"disk"`
	S3            S3Thresholds            `yaml:"s3"`
	Replication   ReplicationThresholds   `yaml:"replication"`
	Dictionaries  DictionariesThresholds  `yaml:"dictionaries"`
	MV            MVThresholds            `yaml:"mv"`
	BackgroundPool BackgroundPoolThresholds `yaml:"background_pool"`
	CacheHealth   CacheHealthThresholds   `yaml:"cache_health"`
	QueryLatency  QueryLatencyThresholds  `yaml:"query_latency"`
	Freshness     FreshnessThresholds     `yaml:"freshness"`
}

type MemoryThresholds struct {
	WarnPercent        float64 `yaml:"warn_percent"`
	CriticalPercent    float64 `yaml:"critical_percent"`
	RSSWarnPercent     float64 `yaml:"rss_warn_percent"`
	RSSCriticalPercent float64 `yaml:"rss_critical_percent"`
}

type CPUThresholds struct {
	WarnPercent     float64 `yaml:"warn_percent"`
	CriticalPercent float64 `yaml:"critical_percent"`
}

type QueriesThresholds struct {
	LongRunningThreshold     Duration `yaml:"long_running_threshold"`
	LongRunningWarnThreshold Duration `yaml:"long_running_warn_threshold"`
	MaxConcurrent            int      `yaml:"max_concurrent"`
	WarnConcurrent           int      `yaml:"warn_concurrent"`
}

type PartsThresholds struct {
	WarnCount             int `yaml:"warn_count"`
	CriticalCount         int `yaml:"critical_count"`
	WarnPerPartition      int `yaml:"warn_per_partition"`
	// MaxClusterParts: instance-wide active part count ceiling. Once you cross
	// this CH starts throttling new INSERTs (DelayedInserts / TooManyParts).
	// Default 30000 keeps headroom under CH's hard limit.
	MaxClusterParts       int `yaml:"max_cluster_parts"`
	// MaxPartitionsPerTable: per-table partition count. CH allows ~hundreds of
	// thousands but every partition costs metadata overhead and slows merges.
	MaxPartitionsPerTable int `yaml:"max_partitions_per_table"`
	// MaxPartsPerPartition: parts in a single partition. Default 1000 — CH's
	// internal `parts_to_throw_insert` lives near here; crossing it kills
	// inserts to that table.
	MaxPartsPerPartition  int `yaml:"max_parts_per_partition"`
}

type MergesThresholds struct {
	MaxActive  int `yaml:"max_active"`
	WarnActive int `yaml:"warn_active"`
	// MinActiveWhenBacklog: alert when active merges drop below this count
	// AND the cluster has more than `BacklogPartCount` active parts. Detects
	// "merge pool stalled while parts are piling up" — the prelude to a
	// TooManyParts incident. Set to 0 to disable.
	MinActiveWhenBacklog int `yaml:"min_active_when_backlog"`
	BacklogPartCount     int `yaml:"backlog_part_count"`
}

type MutationsThresholds struct {
	StuckThreshold Duration `yaml:"stuck_threshold"`
}

type InsertsThresholds struct {
	ThroughputDropPercent float64 `yaml:"throughput_drop_percent"`
	SmallInsertThreshold  int     `yaml:"small_insert_threshold"`
	SmallInsertWarnCount  int     `yaml:"small_insert_warn_count"`
	// Ingest-delay alerts driven from system.metrics + system.asynchronous_metrics.
	// DelayedInsertsWarn: current count of in-flight INSERTs being slept by CH
	//   (CH adds artificial sleep when parts pile up). >0 = throttling started.
	// PendingAsyncInsertsWarn: queued async inserts awaiting flush.
	// RejectedInsertsRateWarn: rate of TOO_MANY_PARTS rejections per minute.
	DelayedInsertsWarn          int     `yaml:"delayed_inserts_warn"`
	DelayedInsertsCritical      int     `yaml:"delayed_inserts_critical"`
	PendingAsyncInsertsWarn     int     `yaml:"pending_async_inserts_warn"`
	PendingAsyncInsertsCritical int     `yaml:"pending_async_inserts_critical"`
	RejectedInsertsRateWarn     float64 `yaml:"rejected_inserts_rate_warn"`
}

type DiskThresholds struct {
	WarnPercent     float64 `yaml:"warn_percent"`
	CriticalPercent float64 `yaml:"critical_percent"`
}

type S3Thresholds struct {
	LatencyWarn        Duration `yaml:"latency_warn"`
	LatencyCritical    Duration `yaml:"latency_critical"`
	MaxConcurrentReads int      `yaml:"max_concurrent_reads"`
}

type ReplicationThresholds struct {
	LagWarn     Duration `yaml:"lag_warn"`
	LagCritical Duration `yaml:"lag_critical"`
}

type DictionariesThresholds struct {
	ReloadFailThreshold int `yaml:"reload_fail_threshold"`
}

type MVThresholds struct {
	LagWarn        Duration `yaml:"lag_warn"`
	BloatRatioWarn float64  `yaml:"bloat_ratio_warn"`
}

type BackgroundPoolThresholds struct {
	WarnPercent     float64 `yaml:"warn_percent"`
	CriticalPercent float64 `yaml:"critical_percent"`
}

type CacheHealthThresholds struct {
	MarkHitRateWarnPercent     float64 `yaml:"mark_hit_rate_warn_percent"`
	MarkHitRateCriticalPercent float64 `yaml:"mark_hit_rate_critical_percent"`
	MinQueriesForAlert         int     `yaml:"min_queries_for_alert"`
}

type QueryLatencyThresholds struct {
	SpikeWarnMultiplier     float64 `yaml:"spike_warn_multiplier"`
	SpikeCriticalMultiplier float64 `yaml:"spike_critical_multiplier"`
	MinBaselineMs           float64 `yaml:"min_baseline_ms"`
	MinQueryCount           int     `yaml:"min_query_count"`
}

type FreshnessThresholds struct {
	GapMinutes      int `yaml:"gap_minutes"`
	MinDailyInserts int `yaml:"min_daily_inserts"`
}

// NotifyConfig groups non-Slack notification targets.
type NotifyConfig struct {
	PagerDuty PagerDutyConfig `yaml:"pagerduty"`
	Webhook   WebhookConfig   `yaml:"webhook"`
}

type PagerDutyConfig struct {
	Enabled    bool   `yaml:"enabled"`
	RoutingKey string `yaml:"routing_key"`
}

type WebhookConfig struct {
	Enabled bool   `yaml:"enabled"`
	URL     string `yaml:"url"`
	Secret  string `yaml:"secret"`
}

// InhibitionConfig maps to alerter.InhibitionRule.
type InhibitionConfig struct {
	SourceCategory string `yaml:"source_category"`
	SourceSeverity string `yaml:"source_severity"`
	TargetCategory string `yaml:"target_category"`
	TargetSeverity string `yaml:"target_severity"`
}

// MaintenanceConfig is reserved for future persistence config.
// Currently windows are in-memory.
type MaintenanceConfig struct{}

// SlackConfig controls Slack alerting behaviour.
type SlackConfig struct {
	BotToken        string          `yaml:"bot_token"`
	AppToken        string          `yaml:"app_token"`         // xapp-... for Socket Mode
	SigningSecret   string          `yaml:"signing_secret"`    // from Basic Information
	ChannelID       string          `yaml:"channel_id"`
	DashboardURL    string          `yaml:"dashboard_url"`     // public URL for "View in Dashboard" links
	StateFile       string          `yaml:"state_file"`        // path to persist pinnedTS + instanceTS across restarts
	DedupWindow     Duration        `yaml:"dedup_window"`
	ResolveMessages bool            `yaml:"resolve_messages"`
	Digest          DigestConfig    `yaml:"digest"`
	SeverityRouting SeverityRouting `yaml:"severity_routing"`
}

type DigestConfig struct {
	Enabled   bool   `yaml:"enabled"`
	DailyTime string `yaml:"daily_time"`
	WeeklyDay string `yaml:"weekly_day"`
}

type SeverityRouting struct {
	Critical string `yaml:"critical"`
	Warn     string `yaml:"warn"`
	Info     string `yaml:"info"`
}

// WebConfig controls the built-in web dashboard.
type WebConfig struct {
	ListenAddr      string `yaml:"listen_addr"`
	Enabled         bool   `yaml:"enabled"`
	SuggestionsPath string `yaml:"suggestions_path"`
}

// StorageConfig controls metric persistence. Each node stores its own data.
type StorageConfig struct {
	Database  string   `yaml:"database"`
	Retention Duration `yaml:"retention"`
}

// PrometheusConfig controls the optional Prometheus metrics endpoint.
type PrometheusConfig struct {
	Enabled    bool   `yaml:"enabled"`
	ListenAddr string `yaml:"listen_addr"`
}

// K8sConfig enables Kubernetes-based ClickHouse pod discovery.
type K8sConfig struct {
	Enabled       bool   `yaml:"enabled"`
	Namespace     string `yaml:"namespace"`
	LabelSelector string `yaml:"label_selector"`
}

// Defaults returns a Config populated with sensible default values.
func Defaults() *Config {
	return &Config{
		Polling: PollingConfig{
			Interval: Duration{time.Minute},
		},
		Thresholds: ThresholdsConfig{
			Memory: MemoryThresholds{
				WarnPercent:        80,
				CriticalPercent:    90,
				RSSWarnPercent:     85,
				RSSCriticalPercent: 95,
			},
			CPU: CPUThresholds{
				WarnPercent:     80,
				CriticalPercent: 95,
			},
			Queries: QueriesThresholds{
				LongRunningThreshold:     Duration{time.Minute},
				LongRunningWarnThreshold: Duration{30 * time.Second},
				MaxConcurrent:            100,
				WarnConcurrent:           50,
			},
			Parts: PartsThresholds{
				WarnCount:             1000,
				CriticalCount:         3000,
				WarnPerPartition:      300,
				MaxClusterParts:       30000,
				MaxPartitionsPerTable: 1200,
				MaxPartsPerPartition:  1000,
			},
			Merges: MergesThresholds{
				MaxActive:            20,
				WarnActive:           10,
				MinActiveWhenBacklog: 30,
				BacklogPartCount:     1000,
			},
			Mutations: MutationsThresholds{
				StuckThreshold: Duration{30 * time.Minute},
			},
			Inserts: InsertsThresholds{
				ThroughputDropPercent:       50,
				SmallInsertThreshold:        100,
				SmallInsertWarnCount:        10,
				DelayedInsertsWarn:          1,
				DelayedInsertsCritical:      50,
				PendingAsyncInsertsWarn:     100,
				PendingAsyncInsertsCritical: 1000,
				RejectedInsertsRateWarn:     1.0,
			},
			Disk: DiskThresholds{
				WarnPercent:     80,
				CriticalPercent: 90,
			},
			S3: S3Thresholds{
				LatencyWarn:        Duration{5 * time.Second},
				LatencyCritical:    Duration{15 * time.Second},
				MaxConcurrentReads: 50,
			},
			Replication: ReplicationThresholds{
				LagWarn:     Duration{30 * time.Second},
				LagCritical: Duration{5 * time.Minute},
			},
			Dictionaries: DictionariesThresholds{
				ReloadFailThreshold: 3,
			},
			MV: MVThresholds{
				LagWarn:        Duration{5 * time.Minute},
				BloatRatioWarn: 10.0,
			},
			BackgroundPool: BackgroundPoolThresholds{
				WarnPercent:     70,
				CriticalPercent: 90,
			},
			CacheHealth: CacheHealthThresholds{
				MarkHitRateWarnPercent:     50,
				MarkHitRateCriticalPercent: 30,
				MinQueriesForAlert:         100,
			},
			QueryLatency: QueryLatencyThresholds{
				SpikeWarnMultiplier:     2.0,
				SpikeCriticalMultiplier: 3.0,
				MinBaselineMs:           100,
				MinQueryCount:           10,
			},
			Freshness: FreshnessThresholds{
				GapMinutes:      20,
				MinDailyInserts: 5,
			},
		},
		Slack: SlackConfig{
			DedupWindow:     Duration{15 * time.Minute},
			ResolveMessages: true,
			StateFile:       "/var/lib/ch-analyzer/slack-state.json",
			Digest: DigestConfig{
				Enabled:   true,
				DailyTime: "09:00",
				WeeklyDay: "monday",
			},
			SeverityRouting: SeverityRouting{
				Critical: "immediate",
				Warn:     "batched_5m",
				Info:     "digest_only",
			},
		},
		Web: WebConfig{
			ListenAddr: ":8080",
			Enabled:    true,
		},
		Storage: StorageConfig{
			Database:  "ch_analyzer",
			Retention: Duration{8760 * time.Hour},
		},
		Prometheus: PrometheusConfig{
			Enabled:    false,
			ListenAddr: ":9090",
		},
		K8s: K8sConfig{
			Enabled: true,
		},
		Altinity: AltinityConfig{
			PricingModel:    "byoc_aws",
			EBSGBMonthlyUSD: 0.08,
			S3GBMonthlyUSD:  0.023,
		},
		Escalation: EscalationConfig{
			Enabled:     true,
			NoticeAfter: Duration{30 * time.Minute},
			RepeatEvery: Duration{30 * time.Minute},
		},
	}
}

// Load reads a YAML configuration file from path, applies defaults for any
// unset fields, and validates the result.
func Load(path string) (*Config, error) {
	cfg := Defaults()

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading config %s: %w", path, err)
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parsing config %s: %w", path, err)
	}

	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("validating config: %w", err)
	}

	return cfg, nil
}

// Validate checks the config for logical errors and missing required fields.
func (c *Config) Validate() error {
	var errs []string

	if len(c.Instances) == 0 {
		errs = append(errs, "at least one instance must be configured")
	}

	for i, inst := range c.Instances {
		if inst.Name == "" {
			errs = append(errs, fmt.Sprintf("instances[%d]: name is required", i))
		}
		if inst.Host == "" {
			errs = append(errs, fmt.Sprintf("instances[%d] (%s): host is required", i, inst.Name))
		}
		if inst.Port <= 0 || inst.Port > 65535 {
			errs = append(errs, fmt.Sprintf("instances[%d] (%s): port must be 1-65535, got %d", i, inst.Name, inst.Port))
		}
		if inst.Username == "" {
			errs = append(errs, fmt.Sprintf("instances[%d] (%s): username is required", i, inst.Name))
		}
	}

	if c.Polling.Interval.Duration < time.Second {
		errs = append(errs, "polling.interval must be at least 1s")
	}

	// Memory thresholds
	if c.Thresholds.Memory.WarnPercent >= c.Thresholds.Memory.CriticalPercent {
		errs = append(errs, "memory: warn_percent must be less than critical_percent")
	}
	if c.Thresholds.Memory.RSSWarnPercent >= c.Thresholds.Memory.RSSCriticalPercent {
		errs = append(errs, "memory: rss_warn_percent must be less than rss_critical_percent")
	}

	// CPU thresholds
	if c.Thresholds.CPU.WarnPercent >= c.Thresholds.CPU.CriticalPercent {
		errs = append(errs, "cpu: warn_percent must be less than critical_percent")
	}

	// Queries
	if c.Thresholds.Queries.WarnConcurrent >= c.Thresholds.Queries.MaxConcurrent {
		errs = append(errs, "queries: warn_concurrent must be less than max_concurrent")
	}

	// Parts
	if c.Thresholds.Parts.WarnCount >= c.Thresholds.Parts.CriticalCount {
		errs = append(errs, "parts: warn_count must be less than critical_count")
	}

	// Merges
	if c.Thresholds.Merges.WarnActive >= c.Thresholds.Merges.MaxActive {
		errs = append(errs, "merges: warn_active must be less than max_active")
	}

	// Disk
	if c.Thresholds.Disk.WarnPercent >= c.Thresholds.Disk.CriticalPercent {
		errs = append(errs, "disk: warn_percent must be less than critical_percent")
	}

	// S3
	if c.Thresholds.S3.LatencyWarn.Duration >= c.Thresholds.S3.LatencyCritical.Duration {
		errs = append(errs, "s3: latency_warn must be less than latency_critical")
	}

	// Replication
	if c.Thresholds.Replication.LagWarn.Duration >= c.Thresholds.Replication.LagCritical.Duration {
		errs = append(errs, "replication: lag_warn must be less than lag_critical")
	}

	// Slack token format validation — warn on obviously wrong token prefixes.
	if c.Slack.AppToken != "" && !strings.HasPrefix(c.Slack.AppToken, "xapp-") {
		slog.Warn("slack.app_token should start with 'xapp-' for Socket Mode; got different prefix — check your config")
	}

	// Slack digest validation
	if c.Slack.Digest.Enabled {
		if c.Slack.Digest.DailyTime != "" {
			_, err := time.Parse("15:04", c.Slack.Digest.DailyTime)
			if err != nil {
				errs = append(errs, fmt.Sprintf("slack.digest.daily_time must be HH:MM format, got %q", c.Slack.Digest.DailyTime))
			}
		}
		validDays := map[string]bool{
			"monday": true, "tuesday": true, "wednesday": true,
			"thursday": true, "friday": true, "saturday": true, "sunday": true,
		}
		if c.Slack.Digest.WeeklyDay != "" && !validDays[strings.ToLower(c.Slack.Digest.WeeklyDay)] {
			errs = append(errs, fmt.Sprintf("slack.digest.weekly_day must be a valid weekday, got %q", c.Slack.Digest.WeeklyDay))
		}
	}

	// Storage
	if c.Storage.Database == "" {
		errs = append(errs, "storage.database is required")
	}
	if c.Storage.Retention.Duration <= 0 {
		errs = append(errs, "storage.retention must be positive")
	}

	if len(errs) > 0 {
		return fmt.Errorf("config validation failed:\n  - %s", strings.Join(errs, "\n  - "))
	}

	return nil
}
