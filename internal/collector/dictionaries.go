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

	var failed int
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

		isLoaded := status == "LOADED"
		if isLoaded {
			result.AddMetric(client.Name(), "dictionaries.loaded", 1, labels)
		} else {
			result.AddMetric(client.Name(), "dictionaries.loaded", 0, labels)
		}

		// Only a dictionary with a real load exception is an actionable failure.
		// A bare non-LOADED status is NOT: dictionaries created with LAYOUT
		// lifetime / lazy loading sit in NOT_LOADED until first use by design,
		// and FAILED_AND_RELOADING is a transient state that self-heals. Alerting
		// on status alone flagged those permanently. FAILED with an exception is
		// the real signal.
		if lastException != "" {
			failed++
			if len(lastException) > 200 {
				lastException = lastException[:200] + "..."
			}
			result.AddAlert(client.Name(), SeverityCritical, "dictionaries",
				"Dictionary failed to load",
				fmt.Sprintf("Dictionary %s status is %s with a load error.\n\nlast_exception: %s\n\n%s",
					fqn, status, lastException, dictionariesStatusPlaybook),
				fmt.Sprintf("%s:dictionaries:status:%s", client.Name(), fqn))
		}
		// element_count == 0 on a LOADED dictionary is intentionally NOT alerted:
		// dictionaries backed by a legitimately-empty source are common and this
		// produced permanent warn noise. The element_count metric is emitted for
		// anyone who wants to chart it.
	}

	result.AddMetric(client.Name(), "dictionaries.failed_count", float64(failed), nil)

	// Escalate when several dictionaries are failing with load errors at once —
	// usually a shared upstream source or credential problem.
	if failed >= c.Thresholds.ReloadFailThreshold {
		result.AddAlert(client.Name(), SeverityCritical, "dictionaries",
			"Multiple dictionaries failing to load",
			fmt.Sprintf("%d dictionaries have load errors (threshold: %d) — check their shared source.\n\n%s",
				failed, c.Thresholds.ReloadFailThreshold, dictionariesStatusPlaybook),
			fmt.Sprintf("%s:dictionaries:multi_fail", client.Name()))
	}
}

func (c *DictionaryCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}
