package web

// Threshold editor API.
//
// GET  /api/thresholds  — returns current ThresholdsConfig as JSON
// POST /api/thresholds  — accepts ThresholdsJSON, merges with current,
//                         writes to override file, updates in-memory config.
//
// Duration fields (time.Duration) are expressed as floating-point seconds
// in the JSON representation so the frontend can use plain <input type="number">.

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/config"
)

// ThresholdsJSON is the wire format for threshold data. Duration fields are
// stored as float64 seconds so the browser can use simple number inputs.
type ThresholdsJSON struct {
	Memory struct {
		WarnPercent        float64 `json:"warn_percent"`
		CriticalPercent    float64 `json:"critical_percent"`
		RSSWarnPercent     float64 `json:"rss_warn_percent"`
		RSSCriticalPercent float64 `json:"rss_critical_percent"`
	} `json:"memory"`
	CPU struct {
		WarnPercent     float64 `json:"warn_percent"`
		CriticalPercent float64 `json:"critical_percent"`
	} `json:"cpu"`
	Queries struct {
		LongRunningThresholdSecs     float64 `json:"long_running_threshold_secs"`
		LongRunningWarnThresholdSecs float64 `json:"long_running_warn_threshold_secs"`
		MaxConcurrent                int     `json:"max_concurrent"`
		WarnConcurrent               int     `json:"warn_concurrent"`
	} `json:"queries"`
	Parts struct {
		WarnCount        int `json:"warn_count"`
		CriticalCount    int `json:"critical_count"`
		WarnPerPartition int `json:"warn_per_partition"`
	} `json:"parts"`
	Merges struct {
		MaxActive  int `json:"max_active"`
		WarnActive int `json:"warn_active"`
	} `json:"merges"`
	Mutations struct {
		StuckThresholdSecs float64 `json:"stuck_threshold_secs"`
	} `json:"mutations"`
	Inserts struct {
		ThroughputDropPercent float64 `json:"throughput_drop_percent"`
		SmallInsertThreshold  int     `json:"small_insert_threshold"`
		SmallInsertWarnCount  int     `json:"small_insert_warn_count"`
	} `json:"inserts"`
	Disk struct {
		WarnPercent     float64 `json:"warn_percent"`
		CriticalPercent float64 `json:"critical_percent"`
	} `json:"disk"`
	S3 struct {
		LatencyWarnSecs        float64 `json:"latency_warn_secs"`
		LatencyCriticalSecs    float64 `json:"latency_critical_secs"`
		MaxConcurrentReads int     `json:"max_concurrent_reads"`
	} `json:"s3"`
	Replication struct {
		LagWarnSecs     float64 `json:"lag_warn_secs"`
		LagCriticalSecs float64 `json:"lag_critical_secs"`
	} `json:"replication"`
	Dictionaries struct {
		ReloadFailThreshold int `json:"reload_fail_threshold"`
	} `json:"dictionaries"`
	MV struct {
		LagWarnSecs    float64 `json:"lag_warn_secs"`
		BloatRatioWarn float64 `json:"bloat_ratio_warn"`
	} `json:"mv"`
	BackgroundPool struct {
		WarnPercent     float64 `json:"warn_percent"`
		CriticalPercent float64 `json:"critical_percent"`
	} `json:"background_pool"`
	CacheHealth struct {
		MarkHitRateWarnPercent     float64 `json:"mark_hit_rate_warn_percent"`
		MarkHitRateCriticalPercent float64 `json:"mark_hit_rate_critical_percent"`
		MinQueriesForAlert         int     `json:"min_queries_for_alert"`
	} `json:"cache_health"`
	QueryLatency struct {
		SpikeWarnMultiplier     float64 `json:"spike_warn_multiplier"`
		SpikeCriticalMultiplier float64 `json:"spike_critical_multiplier"`
		MinBaselineMs           float64 `json:"min_baseline_ms"`
		MinQueryCount           int     `json:"min_query_count"`
	} `json:"query_latency"`
	Freshness struct {
		GapMinutes      int `json:"gap_minutes"`
		MinDailyInserts int `json:"min_daily_inserts"`
	} `json:"freshness"`
}

// thresholdsToJSON converts the in-memory config struct to the wire format.
func thresholdsToJSON(t config.ThresholdsConfig) ThresholdsJSON {
	var j ThresholdsJSON
	j.Memory.WarnPercent = t.Memory.WarnPercent
	j.Memory.CriticalPercent = t.Memory.CriticalPercent
	j.Memory.RSSWarnPercent = t.Memory.RSSWarnPercent
	j.Memory.RSSCriticalPercent = t.Memory.RSSCriticalPercent

	j.CPU.WarnPercent = t.CPU.WarnPercent
	j.CPU.CriticalPercent = t.CPU.CriticalPercent

	j.Queries.LongRunningThresholdSecs = t.Queries.LongRunningThreshold.Seconds()
	j.Queries.LongRunningWarnThresholdSecs = t.Queries.LongRunningWarnThreshold.Seconds()
	j.Queries.MaxConcurrent = t.Queries.MaxConcurrent
	j.Queries.WarnConcurrent = t.Queries.WarnConcurrent

	j.Parts.WarnCount = t.Parts.WarnCount
	j.Parts.CriticalCount = t.Parts.CriticalCount
	j.Parts.WarnPerPartition = t.Parts.WarnPerPartition

	j.Merges.MaxActive = t.Merges.MaxActive
	j.Merges.WarnActive = t.Merges.WarnActive

	j.Mutations.StuckThresholdSecs = t.Mutations.StuckThreshold.Seconds()

	j.Inserts.ThroughputDropPercent = t.Inserts.ThroughputDropPercent
	j.Inserts.SmallInsertThreshold = t.Inserts.SmallInsertThreshold
	j.Inserts.SmallInsertWarnCount = t.Inserts.SmallInsertWarnCount

	j.Disk.WarnPercent = t.Disk.WarnPercent
	j.Disk.CriticalPercent = t.Disk.CriticalPercent

	j.S3.LatencyWarnSecs = t.S3.LatencyWarn.Seconds()
	j.S3.LatencyCriticalSecs = t.S3.LatencyCritical.Seconds()
	j.S3.MaxConcurrentReads = t.S3.MaxConcurrentReads

	j.Replication.LagWarnSecs = t.Replication.LagWarn.Seconds()
	j.Replication.LagCriticalSecs = t.Replication.LagCritical.Seconds()

	j.Dictionaries.ReloadFailThreshold = t.Dictionaries.ReloadFailThreshold

	j.MV.LagWarnSecs = t.MV.LagWarn.Seconds()
	j.MV.BloatRatioWarn = t.MV.BloatRatioWarn

	j.BackgroundPool.WarnPercent = t.BackgroundPool.WarnPercent
	j.BackgroundPool.CriticalPercent = t.BackgroundPool.CriticalPercent

	j.CacheHealth.MarkHitRateWarnPercent = t.CacheHealth.MarkHitRateWarnPercent
	j.CacheHealth.MarkHitRateCriticalPercent = t.CacheHealth.MarkHitRateCriticalPercent
	j.CacheHealth.MinQueriesForAlert = t.CacheHealth.MinQueriesForAlert

	j.QueryLatency.SpikeWarnMultiplier = t.QueryLatency.SpikeWarnMultiplier
	j.QueryLatency.SpikeCriticalMultiplier = t.QueryLatency.SpikeCriticalMultiplier
	j.QueryLatency.MinBaselineMs = t.QueryLatency.MinBaselineMs
	j.QueryLatency.MinQueryCount = t.QueryLatency.MinQueryCount

	j.Freshness.GapMinutes = t.Freshness.GapMinutes
	j.Freshness.MinDailyInserts = t.Freshness.MinDailyInserts

	return j
}

// jsonToThresholds converts the wire format back to the config struct.
func jsonToThresholds(j ThresholdsJSON) config.ThresholdsConfig {
	dur := func(secs float64) config.Duration {
		return config.Duration{Duration: time.Duration(secs * float64(time.Second))}
	}
	return config.ThresholdsConfig{
		Memory: config.MemoryThresholds{
			WarnPercent:        j.Memory.WarnPercent,
			CriticalPercent:    j.Memory.CriticalPercent,
			RSSWarnPercent:     j.Memory.RSSWarnPercent,
			RSSCriticalPercent: j.Memory.RSSCriticalPercent,
		},
		CPU: config.CPUThresholds{
			WarnPercent:     j.CPU.WarnPercent,
			CriticalPercent: j.CPU.CriticalPercent,
		},
		Queries: config.QueriesThresholds{
			LongRunningThreshold:     dur(j.Queries.LongRunningThresholdSecs),
			LongRunningWarnThreshold: dur(j.Queries.LongRunningWarnThresholdSecs),
			MaxConcurrent:            j.Queries.MaxConcurrent,
			WarnConcurrent:           j.Queries.WarnConcurrent,
		},
		Parts: config.PartsThresholds{
			WarnCount:        j.Parts.WarnCount,
			CriticalCount:    j.Parts.CriticalCount,
			WarnPerPartition: j.Parts.WarnPerPartition,
		},
		Merges: config.MergesThresholds{
			MaxActive:  j.Merges.MaxActive,
			WarnActive: j.Merges.WarnActive,
		},
		Mutations: config.MutationsThresholds{
			StuckThreshold: dur(j.Mutations.StuckThresholdSecs),
		},
		Inserts: config.InsertsThresholds{
			ThroughputDropPercent: j.Inserts.ThroughputDropPercent,
			SmallInsertThreshold:  j.Inserts.SmallInsertThreshold,
			SmallInsertWarnCount:  j.Inserts.SmallInsertWarnCount,
		},
		Disk: config.DiskThresholds{
			WarnPercent:     j.Disk.WarnPercent,
			CriticalPercent: j.Disk.CriticalPercent,
		},
		S3: config.S3Thresholds{
			LatencyWarn:        dur(j.S3.LatencyWarnSecs),
			LatencyCritical:    dur(j.S3.LatencyCriticalSecs),
			MaxConcurrentReads: j.S3.MaxConcurrentReads,
		},
		Replication: config.ReplicationThresholds{
			LagWarn:     dur(j.Replication.LagWarnSecs),
			LagCritical: dur(j.Replication.LagCriticalSecs),
		},
		Dictionaries: config.DictionariesThresholds{
			ReloadFailThreshold: j.Dictionaries.ReloadFailThreshold,
		},
		MV: config.MVThresholds{
			LagWarn:        dur(j.MV.LagWarnSecs),
			BloatRatioWarn: j.MV.BloatRatioWarn,
		},
		BackgroundPool: config.BackgroundPoolThresholds{
			WarnPercent:     j.BackgroundPool.WarnPercent,
			CriticalPercent: j.BackgroundPool.CriticalPercent,
		},
		CacheHealth: config.CacheHealthThresholds{
			MarkHitRateWarnPercent:     j.CacheHealth.MarkHitRateWarnPercent,
			MarkHitRateCriticalPercent: j.CacheHealth.MarkHitRateCriticalPercent,
			MinQueriesForAlert:         j.CacheHealth.MinQueriesForAlert,
		},
		QueryLatency: config.QueryLatencyThresholds{
			SpikeWarnMultiplier:     j.QueryLatency.SpikeWarnMultiplier,
			SpikeCriticalMultiplier: j.QueryLatency.SpikeCriticalMultiplier,
			MinBaselineMs:           j.QueryLatency.MinBaselineMs,
			MinQueryCount:           j.QueryLatency.MinQueryCount,
		},
		Freshness: config.FreshnessThresholds{
			GapMinutes:      j.Freshness.GapMinutes,
			MinDailyInserts: j.Freshness.MinDailyInserts,
		},
	}
}

// handleGetThresholds returns the current thresholds as JSON.
func (s *Server) handleGetThresholds(w http.ResponseWriter, r *http.Request) {
	s.thresholdsMu.RLock()
	t := s.cfg.Thresholds
	s.thresholdsMu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(thresholdsToJSON(t))
}

// validateThresholds returns an error if any threshold value is invalid.
func validateThresholds(j ThresholdsJSON) error {
	// Warn must be less than critical for all percent pairs.
	checks := []struct {
		name string
		warn float64
		crit float64
	}{
		{"memory", j.Memory.WarnPercent, j.Memory.CriticalPercent},
		{"memory.rss", j.Memory.RSSWarnPercent, j.Memory.RSSCriticalPercent},
		{"cpu", j.CPU.WarnPercent, j.CPU.CriticalPercent},
		{"disk", j.Disk.WarnPercent, j.Disk.CriticalPercent},
		{"background_pool", j.BackgroundPool.WarnPercent, j.BackgroundPool.CriticalPercent},
	}
	for _, c := range checks {
		if c.warn <= 0 || c.crit <= 0 {
			return fmt.Errorf("%s: percent values must be positive", c.name)
		}
		if c.warn >= c.crit {
			return fmt.Errorf("%s: warn_percent (%.1f) must be less than critical_percent (%.1f)", c.name, c.warn, c.crit)
		}
	}

	// Duration fields must be positive.
	durs := []struct {
		name string
		val  float64
	}{
		{"queries.long_running_threshold_secs", j.Queries.LongRunningThresholdSecs},
		{"queries.long_running_warn_threshold_secs", j.Queries.LongRunningWarnThresholdSecs},
		{"mutations.stuck_threshold_secs", j.Mutations.StuckThresholdSecs},
	}
	for _, d := range durs {
		if d.val <= 0 {
			return fmt.Errorf("%s must be positive", d.name)
		}
	}

	// Integer counts must be positive.
	if j.Queries.MaxConcurrent <= 0 {
		return fmt.Errorf("queries.max_concurrent must be positive")
	}
	if j.Queries.WarnConcurrent <= 0 {
		return fmt.Errorf("queries.warn_concurrent must be positive")
	}
	if j.Queries.WarnConcurrent >= j.Queries.MaxConcurrent {
		return fmt.Errorf("queries.warn_concurrent (%d) must be less than max_concurrent (%d)", j.Queries.WarnConcurrent, j.Queries.MaxConcurrent)
	}
	if j.Parts.WarnCount <= 0 || j.Parts.CriticalCount <= 0 {
		return fmt.Errorf("parts count thresholds must be positive")
	}
	if j.Parts.WarnCount >= j.Parts.CriticalCount {
		return fmt.Errorf("parts.warn_count (%d) must be less than critical_count (%d)", j.Parts.WarnCount, j.Parts.CriticalCount)
	}

	return nil
}

// handlePostThresholds accepts updated thresholds, persists them, and applies
// them in-memory so the next poll cycle picks them up.
func (s *Server) handlePostThresholds(w http.ResponseWriter, r *http.Request) {
	limitBody(w, r)
	var incoming ThresholdsJSON
	if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	if err := validateThresholds(incoming); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	updated := jsonToThresholds(incoming)

	// Persist to override file atomically.
	if s.thresholdsOverridePath != "" {
		data, _ := json.MarshalIndent(incoming, "", "  ")
		if err := atomicWriteFile(s.thresholdsOverridePath, data, 0644); err != nil {
			slog.Warn("thresholds: failed to persist override", "path", s.thresholdsOverridePath, "error", err)
		}
	}

	// Apply in-memory under the mutex.
	s.thresholdsMu.Lock()
	s.cfg.Thresholds = updated
	s.thresholdsMu.Unlock()

	_ = s.store.LogAction(r.Context(), "", "threshold_update", r.RemoteAddr, "thresholds updated")

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(thresholdsToJSON(updated))
}
