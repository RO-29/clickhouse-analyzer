package collector

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// CacheHealthCollector monitors mark cache and uncompressed cache hit rates.
// A hit rate below 50% means queries are doing full disk reads instead of
// using cache — a silent major performance regression.
type CacheHealthCollector struct {
	Logger *slog.Logger
}

func (c *CacheHealthCollector) Name() string { return "cache_health" }

func (c *CacheHealthCollector) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

func (c *CacheHealthCollector) Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error) {
	start := time.Now()
	result := &CollectResult{}

	c.collectMarkCacheHitRate(ctx, client, result)
	c.collectCacheSizes(ctx, client, result)

	result.Duration = time.Since(start)
	return result, nil
}

func (c *CacheHealthCollector) collectMarkCacheHitRate(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT
			sum(ProfileEvents['MarkCacheHits']) AS hits,
			sum(ProfileEvents['MarkCacheMisses']) AS misses
		FROM system.query_log
		WHERE type = 'QueryFinish'
		  AND event_time > now() - INTERVAL 10 MINUTE
		  AND is_initial_query = 1`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") {
			return
		}
		c.logger().Warn("failed to query mark cache hit rate", slog.String("error", err.Error()))
		return
	}

	if len(rows) == 0 {
		return
	}

	hits := getFloat(rows[0], "hits")
	misses := getFloat(rows[0], "misses")
	total := hits + misses

	result.AddMetric(client.Name(), "system.cache.mark_hits", hits, nil)
	result.AddMetric(client.Name(), "system.cache.mark_misses", misses, nil)

	if total <= 0 {
		return
	}

	hitRate := (hits / total) * 100.0
	result.AddMetric(client.Name(), "system.cache.mark_hit_rate", hitRate, nil)

	// Only alert if there's meaningful traffic to avoid noise on idle instances.
	if total < 100 {
		return
	}

	dedupKey := fmt.Sprintf("%s:cache:mark_hit_rate", client.Name())
	msg := fmt.Sprintf("Mark cache hit rate low: %.1f%% (%.0f hits, %.0f misses in 10 min). "+
		"Queries are doing full disk reads instead of cache.", hitRate, hits, misses)

	if hitRate < 30 {
		result.AddAlert(client.Name(), SeverityCritical, "system",
			fmt.Sprintf("Mark cache hit rate low: %.1f%% (%.0f hits, %.0f misses in 10 min)", hitRate, hits, misses),
			msg,
			dedupKey)
	} else if hitRate < 50 {
		result.AddAlert(client.Name(), SeverityWarn, "system",
			fmt.Sprintf("Mark cache hit rate low: %.1f%% (%.0f hits, %.0f misses in 10 min)", hitRate, hits, misses),
			msg,
			dedupKey)
	}
}

func (c *CacheHealthCollector) collectCacheSizes(ctx context.Context, client *chclient.Client, result *CollectResult) {
	sql := `
		SELECT metric, value FROM system.metrics
		WHERE metric IN ('MarkCacheBytes', 'UncompressedCacheBytes', 'MarkCacheFiles')`

	rows, err := client.Query(ctx, sql)
	if err != nil {
		if strings.Contains(err.Error(), "UNKNOWN_TABLE") {
			return
		}
		c.logger().Warn("failed to query cache size metrics", slog.String("error", err.Error()))
		return
	}

	for _, row := range rows {
		metric := getString(row, "metric")
		val := getFloat(row, "value")
		result.AddMetric(client.Name(), "system.cache."+strings.ToLower(metric), val, nil)
	}
}
