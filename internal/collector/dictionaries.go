package collector

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/config"
)

// DictionaryCollector monitors external dictionary health from
// system.dictionaries: status, load times, and reload failures.
type DictionaryCollector struct {
	Thresholds config.DictionariesThresholds
	Logger     *slog.Logger
}

func (c *DictionaryCollector) Name() string { return "dictionaries" }

func (c *DictionaryCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	c.collectDictionaries(ctx, client, result)

	result.Duration = time.Since(start)
	return result, nil
}

// collectDictionaries queries system.dictionaries for status, element counts,
// loading durations, and error information.
func (c *DictionaryCollector) collectDictionaries(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT
			database,
			name,
			status,
			origin,
			type,
			element_count,
			loading_duration,
			last_successful_update_time,
			last_exception,
			bytes_allocated,
			loading_start_time
		FROM system.dictionaries`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		c.logger().Warn("failed to query system.dictionaries", slog.String("error", err.Error()))
		return
	}

	result.AddMetric(client.Name(), "dictionaries.total_count", float64(len(rows)), nil)

	var notLoaded int
	for _, row := range rows {
		db := getString(row, "database")
		name := getString(row, "name")
		status := getString(row, "status")
		elementCount := getFloat(row, "element_count")
		loadingDuration := getFloat(row, "loading_duration")
		lastException := getString(row, "last_exception")
		bytesAllocated := getFloat(row, "bytes_allocated")

		fqn := db + "." + name
		labels := map[string]string{
			"database":   db,
			"dictionary": name,
			"status":     status,
		}

		result.AddMetric(client.Name(), "dictionaries.element_count", elementCount, labels)
		result.AddMetric(client.Name(), "dictionaries.loading_duration_sec", loadingDuration, labels)
		result.AddMetric(client.Name(), "dictionaries.bytes_allocated", bytesAllocated, labels)

		// Status check: LOADED is healthy; anything else is problematic.
		isLoaded := status == "LOADED"
		if isLoaded {
			result.AddMetric(client.Name(), "dictionaries.loaded", 1, labels)
		} else {
			result.AddMetric(client.Name(), "dictionaries.loaded", 0, labels)
			notLoaded++

			sev := SeverityWarn
			msg := fmt.Sprintf("Dictionary %s status is %s", fqn, status)
			if lastException != "" {
				sev = SeverityCritical
				if len(lastException) > 200 {
					lastException = lastException[:200] + "..."
				}
				msg += fmt.Sprintf(", last_exception: %s", lastException)
			}

			result.AddAlert(client.Name(), sev, "dictionaries",
				"Dictionary not loaded",
				msg,
				fmt.Sprintf("%s:dictionaries:status:%s", client.Name(), fqn))
		}

		// Flag if element_count is 0 for a LOADED dictionary (possibly
		// misconfigured source).
		if isLoaded && elementCount == 0 {
			result.AddAlert(client.Name(), SeverityWarn, "dictionaries",
				"Dictionary loaded but empty",
				fmt.Sprintf("Dictionary %s is LOADED but has 0 elements. Source may be misconfigured.", fqn),
				fmt.Sprintf("%s:dictionaries:empty:%s", client.Name(), fqn))
		}
	}

	result.AddMetric(client.Name(), "dictionaries.not_loaded_count", float64(notLoaded), nil)

	// Detect consecutive reload failures via last_exception being set on
	// multiple dictionaries. If more than the threshold have errors, escalate.
	if notLoaded >= c.Thresholds.ReloadFailThreshold {
		result.AddAlert(client.Name(), SeverityCritical, "dictionaries",
			"Multiple dictionaries failing to load",
			fmt.Sprintf("%d dictionaries are not in LOADED status (threshold: %d)",
				notLoaded, c.Thresholds.ReloadFailThreshold),
			fmt.Sprintf("%s:dictionaries:multi_fail", client.Name()))
	}
}

func (c *DictionaryCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}
