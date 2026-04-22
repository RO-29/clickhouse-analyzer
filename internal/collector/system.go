package collector

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/config"
)

// SystemCollector gathers OS-level and ClickHouse process metrics from
// system.asynchronous_metrics, system.metrics, and uptime().
type SystemCollector struct {
	MemoryThresholds config.MemoryThresholds
	CPUThresholds    config.CPUThresholds
	Logger           *slog.Logger
}

func (c *SystemCollector) Name() string { return "system" }

func (c *SystemCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	c.collectAsyncMetrics(ctx, client, result)
	c.collectMetrics(ctx, client, result)
	c.collectUptime(ctx, client, result)

	result.Duration = time.Since(start)
	return result, nil
}

func (c *SystemCollector) collectAsyncMetrics(ctx context.Context, client *chclient.Client, result *CollectResult) {
	// Query ALL async metrics we might need — covers both OSS and Altinity builds.
	asyncMetrics := []string{
		// Memory (works on all builds)
		"OSMemoryTotal",
		"OSMemoryAvailable",
		"OSMemoryBuffers",
		"OSMemoryCached",
		// RSS — different names on different builds
		"OSProcessRSSMemory",  // OSS CH
		"MemoryResident",      // Altinity/newer builds
		// Load average (works everywhere)
		"LoadAverage1",
		"LoadAverage5",
		"LoadAverage15",
		// CPU — OSS CH names
		"OSUserTimeCPU",
		"OSSystemTimeCPU",
		"OSIdleTimeCPU",
		// CPU — Altinity/newer builds
		"CGroupMaxCPU",
		"OSCPUOverload",
		// CGroup memory
		"CGroupMemoryTotal",
		"CGroupMemoryUsed",
	}

	inClause := "("
	for i, m := range asyncMetrics {
		if i > 0 {
			inClause += ", "
		}
		inClause += "'" + m + "'"
	}
	inClause += ")"

	sql := fmt.Sprintf(`
		SELECT metric, value
		FROM system.asynchronous_metrics
		WHERE metric IN %s`, inClause)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query system.asynchronous_metrics", slog.String("error", err.Error()))
		return
	}

	values := make(map[string]float64, len(rows))
	for _, row := range rows {
		name := getString(row, "metric")
		val := getFloat(row, "value")
		values[name] = val
		result.AddMetric(client.Name(), "system.async."+name, val, nil)
	}

	// --- Memory ---
	// Prefer OS-level totals (standard CH). Fall back to CGroup values on
	// Altinity/cloud builds where OSMemoryTotal is absent.
	memTotal := values["OSMemoryTotal"]
	memAvail := values["OSMemoryAvailable"]

	// RSS: try MemoryResident first (Altinity), fall back to OSProcessRSSMemory (OSS)
	rss := values["MemoryResident"]
	if rss == 0 {
		rss = values["OSProcessRSSMemory"]
	}

	if memTotal == 0 && values["CGroupMemoryTotal"] > 0 {
		memTotal = values["CGroupMemoryTotal"]
		// CGroupMemoryUsed includes page cache and is nearly equal to CGroupMemoryTotal
		// on Linux — using it directly as "used" gives a false ~100% reading.
		// Instead, derive available from CGroup limit minus ClickHouse RSS (actual
		// working set). If RSS is unavailable fall back to the raw CGroup difference.
		if rss > 0 {
			used := rss
			if used > memTotal {
				used = memTotal
			}
			memAvail = memTotal - used
		} else {
			memAvail = values["CGroupMemoryTotal"] - values["CGroupMemoryUsed"]
		}
	}

	if memTotal > 0 {
		usedPct := (1.0 - memAvail/memTotal) * 100.0
		result.AddMetric(client.Name(), "system.memory.used_percent", usedPct, nil)
		result.AddMetric(client.Name(), "system.memory.total_bytes", memTotal, nil)
		result.AddMetric(client.Name(), "system.memory.available_bytes", memAvail, nil)
		result.AddMetric(client.Name(), "system.memory.rss_bytes", rss, nil)

		if usedPct >= c.MemoryThresholds.CriticalPercent {
			result.AddAlert(client.Name(), SeverityCritical, "memory",
				"OS memory critically high",
				fmt.Sprintf("OS memory usage at %.1f%% (available: %s / total: %s)\n\n%s",
					usedPct, humanBytes(memAvail), humanBytes(memTotal), memoryConsumersPlaybook),
				fmt.Sprintf("%s:memory:os_used", client.Name()))
		} else if usedPct >= c.MemoryThresholds.WarnPercent {
			result.AddAlert(client.Name(), SeverityWarn, "memory",
				"OS memory usage elevated",
				fmt.Sprintf("OS memory usage at %.1f%% (available: %s / total: %s)\n\n%s",
					usedPct, humanBytes(memAvail), humanBytes(memTotal), memoryConsumersPlaybook),
				fmt.Sprintf("%s:memory:os_used", client.Name()))
		}

		if rss > 0 {
			rssPct := (rss / memTotal) * 100.0
			result.AddMetric(client.Name(), "system.memory.rss_percent", rssPct, nil)

			if rssPct >= c.MemoryThresholds.RSSCriticalPercent {
				result.AddAlert(client.Name(), SeverityCritical, "memory",
					"ClickHouse RSS critically high",
					fmt.Sprintf("RSS is %.1f%% of total memory (%s / %s)\n\n%s",
						rssPct, humanBytes(rss), humanBytes(memTotal), memoryConsumersPlaybook),
					fmt.Sprintf("%s:memory:rss", client.Name()))
			} else if rssPct >= c.MemoryThresholds.RSSWarnPercent {
				result.AddAlert(client.Name(), SeverityWarn, "memory",
					"ClickHouse RSS elevated",
					fmt.Sprintf("RSS is %.1f%% of total memory (%s / %s)\n\n%s",
						rssPct, humanBytes(rss), humanBytes(memTotal), memoryConsumersPlaybook),
					fmt.Sprintf("%s:memory:rss", client.Name()))
			}
		}
	}

	// --- CPU ---
	// Strategy 1: OSS CH has OSUserTimeCPU/OSSystemTimeCPU/OSIdleTimeCPU
	user := values["OSUserTimeCPU"]
	system := values["OSSystemTimeCPU"]
	idle := values["OSIdleTimeCPU"]
	total := user + system + idle

	// Only use OSS CPU metrics if they return meaningful values (>1.0).
	// On Altinity builds these exist but return near-zero cumulative counters.
	if total > 1.0 && idle > 0 {
		busyPct := ((user + system) / total) * 100.0
		result.AddMetric(client.Name(), "system.cpu.busy_percent", busyPct, nil)
		c.checkCPUAlert(client.Name(), busyPct, result)
	} else {
		// Strategy 2: Altinity build — use LoadAverage / CGroupMaxCPU
		maxCPU := values["CGroupMaxCPU"]
		load1 := values["LoadAverage1"]
		if maxCPU > 0 && load1 > 0 {
			busyPct := (load1 / maxCPU) * 100.0
			if busyPct > 100 {
				busyPct = 100
			}
			result.AddMetric(client.Name(), "system.cpu.busy_percent", busyPct, nil)
			result.AddMetric(client.Name(), "system.cpu.max_cores", maxCPU, nil)
			c.checkCPUAlert(client.Name(), busyPct, result)
		}
	}
}

func (c *SystemCollector) checkCPUAlert(instance string, busyPct float64, result *CollectResult) {
	if busyPct >= c.CPUThresholds.CriticalPercent {
		result.AddAlert(instance, SeverityCritical, "cpu",
			"CPU critically high",
			fmt.Sprintf("CPU busy at %.1f%%\n\n%s", busyPct, cpuConsumersPlaybook),
			fmt.Sprintf("%s:cpu:busy", instance))
	} else if busyPct >= c.CPUThresholds.WarnPercent {
		result.AddAlert(instance, SeverityWarn, "cpu",
			"CPU usage elevated",
			fmt.Sprintf("CPU busy at %.1f%%\n\n%s", busyPct, cpuConsumersPlaybook),
			fmt.Sprintf("%s:cpu:busy", instance))
	}
}

func (c *SystemCollector) collectMetrics(ctx context.Context, client *chclient.Client, result *CollectResult) {
	metrics := []string{
		"MemoryTracking",
		"Query",
		"Merge",
		"PartMutation",
		"TCPConnection",
		"HTTPConnection",
	}

	inClause := "("
	for i, m := range metrics {
		if i > 0 {
			inClause += ", "
		}
		inClause += "'" + m + "'"
	}
	inClause += ")"

	sql := fmt.Sprintf(`
		SELECT metric, value
		FROM system.metrics
		WHERE metric IN %s`, inClause)

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query system.metrics", slog.String("error", err.Error()))
		return
	}

	for _, row := range rows {
		name := getString(row, "metric")
		val := getFloat(row, "value")
		result.AddMetric(client.Name(), "system.metrics."+name, val, nil)
	}
}

func (c *SystemCollector) collectUptime(ctx context.Context, client *chclient.Client, result *CollectResult) {
	val, err := client.QuerySingleValue(ctx, "SELECT uptime()")
	if err != nil {
		c.logger().Warn("failed to query uptime", slog.String("error", err.Error()))
		return
	}

	uptime, err := toFloat64(val)
	if err != nil {
		c.logger().Warn("failed to parse uptime", slog.String("raw", val), slog.String("error", err.Error()))
		return
	}
	result.AddMetric(client.Name(), "system.uptime_seconds", uptime, nil)
}

func (c *SystemCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func humanBytes(b float64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%.0f B", b)
	}
	div, exp := float64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", b/div, "KMGTPE"[exp])
}
