package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// BackgroundPoolCollector monitors system.metrics for background pool saturation.
// ClickHouse has fixed-size thread pools for background work. When full, merges
// stop and parts accumulate.
type BackgroundPoolCollector struct {
	Logger *slog.Logger
}

func (c *BackgroundPoolCollector) Name() string { return "background_pool" }

func (c *BackgroundPoolCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *BackgroundPoolCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	sql := `
		SELECT metric, value FROM system.metrics
		WHERE metric IN (
			'BackgroundMergesMutationsPoolTask',
			'BackgroundMergesMutationsPoolSize',
			'BackgroundFetchesPoolTask',
			'BackgroundFetchesPoolSize',
			'BackgroundProcessingPoolTask',
			'BackgroundProcessingPoolSize'
		)`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") {
			result.Duration = time.Since(start)
			return result, nil
		}
		c.logger().Warn("failed to query system.metrics for background pools", slog.String("error", err.Error()))
		result.Duration = time.Since(start)
		return result, nil
	}

	values := make(map[string]float64, len(rows))
	for _, row := range rows {
		metric := getString(row, "metric")
		val := getFloat(row, "value")
		values[metric] = val
	}

	type poolDef struct {
		name    string
		taskKey string
		sizeKey string
	}

	pools := []poolDef{
		{"merges_mutations", "BackgroundMergesMutationsPoolTask", "BackgroundMergesMutationsPoolSize"},
		{"fetches", "BackgroundFetchesPoolTask", "BackgroundFetchesPoolSize"},
		{"processing", "BackgroundProcessingPoolTask", "BackgroundProcessingPoolSize"},
	}

	for _, pool := range pools {
		used := values[pool.taskKey]
		size := values[pool.sizeKey]

		if size <= 0 {
			continue
		}

		usedPct := (used / size) * 100.0
		result.AddMetric(client.Name(), "system.bg_pool."+pool.name+"_used_pct", usedPct, nil)

		dedupKey := fmt.Sprintf("%s:bg_pool:%s", client.Name(), pool.name)
		if usedPct > 90 {
			result.AddAlert(client.Name(), SeverityCritical, "system",
				fmt.Sprintf("Background %s pool near full (%.0f/%.0f)", pool.name, used, size),
				fmt.Sprintf("Background pool `%s` is %.1f%% full: %.0f tasks / %.0f slots. "+
					"Merges may stop and parts accumulate.", pool.name, usedPct, used, size),
				dedupKey)
		} else if usedPct > 70 {
			result.AddAlert(client.Name(), SeverityWarn, "system",
				fmt.Sprintf("Background %s pool near full (%.0f/%.0f)", pool.name, used, size),
				fmt.Sprintf("Background pool `%s` is %.1f%% full: %.0f tasks / %.0f slots.",
					pool.name, usedPct, used, size),
				dedupKey)
		}
	}

	result.Duration = time.Since(start)
	return result, nil
}
