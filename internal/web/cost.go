package web

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"log/slog"

	"github.com/rohitjain/ch-analyzer/internal/config"
)

// hoursPerMonth is the average number of hours in a calendar month (365*24/12).
const hoursPerMonth = 730.0

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

type costPricingModel struct {
	Model           string  `json:"model"`
	VCPUHourlyUSD   float64 `json:"vcpu_hourly_usd"`
	ServerHourlyUSD float64 `json:"server_hourly_usd"`
	EBSGBMonthlyUSD float64 `json:"ebs_gb_monthly_usd"`
	S3GBMonthlyUSD  float64 `json:"s3_gb_monthly_usd"`
}

type costStorage struct {
	LocalBytes      int64   `json:"local_bytes"`
	S3Bytes         int64   `json:"s3_bytes"`
	LocalGB         float64 `json:"local_gb"`
	S3GB            float64 `json:"s3_gb"`
	LocalMonthlyUSD float64 `json:"local_monthly_usd"`
	S3MonthlyUSD    float64 `json:"s3_monthly_usd"`
	TotalMonthlyUSD float64 `json:"total_monthly_usd"`
}

type costCompute struct {
	VCPULimit           float64 `json:"vcpu_limit"`
	MemoryGB            float64 `json:"memory_gb"`
	ServerCount         int     `json:"server_count"`
	MonthlyServerFeeUSD float64 `json:"monthly_server_fee_usd"`
	MonthlyVCPUUSD      float64 `json:"monthly_vcpu_usd"`
	MonthlyTotalUSD     float64 `json:"monthly_total_usd"`
	Source              string  `json:"source"` // "k8s_limits" | "config_override" | "unknown"
}

type costTableEntry struct {
	Database   string  `json:"database"`
	Table      string  `json:"table"`
	LocalBytes int64   `json:"local_bytes"`
	S3Bytes    int64   `json:"s3_bytes"`
	LocalGB    float64 `json:"local_gb"`
	S3GB       float64 `json:"s3_gb"`
	MonthlyUSD float64 `json:"monthly_usd"`
}

type costReport struct {
	Instance        string           `json:"instance"`
	GeneratedAt     time.Time        `json:"generated_at"`
	Storage         costStorage      `json:"storage"`
	Compute         costCompute      `json:"compute"`
	ByTable         []costTableEntry `json:"by_table"`
	Pricing         costPricingModel `json:"pricing"`
	TotalMonthlyUSD float64          `json:"total_monthly_usd"`
	Notes           []string         `json:"notes"`
}

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

func pricingFromConfig(cfg *config.Config) costPricingModel {
	pm := costPricingModel{
		Model:           cfg.Altinity.PricingModel,
		EBSGBMonthlyUSD: cfg.Altinity.EBSGBMonthlyUSD,
		S3GBMonthlyUSD:  cfg.Altinity.S3GBMonthlyUSD,
	}
	switch cfg.Altinity.PricingModel {
	case "byoc_hetzner":
		pm.VCPUHourlyUSD = 0.0347
		pm.ServerHourlyUSD = 0.347
	case "managed":
		// Managed rates vary by region; shown as 0 = not estimated
		pm.VCPUHourlyUSD = 0
		pm.ServerHourlyUSD = 0
	default: // byoc_aws, byoc_gcp, byoc_azure
		pm.VCPUHourlyUSD = 0.0625
		pm.ServerHourlyUSD = 0.347
	}
	return pm
}

func isS3Disk(name, diskType string) bool {
	t := strings.ToLower(diskType)
	n := strings.ToLower(name)
	return t == "s3" || t == "s3_plain" || t == "s3_plain_rewritable" ||
		strings.Contains(n, "s3") || strings.Contains(n, "object")
}

// ---------------------------------------------------------------------------
// GET /api/instances/{name}/cost
// ---------------------------------------------------------------------------

func (s *Server) handleCost(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	pricing := pricingFromConfig(s.cfg)
	report := costReport{
		Instance:    instance,
		GeneratedAt: time.Now().UTC(),
		Pricing:     pricing,
	}
	var notes []string

	// ── Disk types map ──────────────────────────────────────────────────────
	diskRows, err := client.Query(ctx, `SELECT name, type FROM system.disks ORDER BY name`)
	diskTypes := map[string]string{}
	if err != nil {
		slog.Warn("cost: disk type query failed", "instance", instance, "err", err)
		notes = append(notes, "Disk type detection skipped — falling back to name-based detection")
	} else {
		for _, dr := range diskRows {
			diskTypes[fmt.Sprintf("%v", dr["name"])] = fmt.Sprintf("%v", dr["type"])
		}
	}

	// ── Parts query: bytes per table per disk ───────────────────────────────
	type tableKey struct{ db, table string }
	tableLocal := map[tableKey]int64{}
	tableS3 := map[tableKey]int64{}
	var totalLocal, totalS3 int64

	partRows, err := client.Query(ctx, `
		SELECT database, table, disk_name, sum(bytes_on_disk) AS bytes
		FROM system.parts
		WHERE active
		GROUP BY database, table, disk_name
		ORDER BY bytes DESC
		LIMIT 1000
	`)
	if err != nil {
		slog.Warn("cost: parts query failed", "instance", instance, "err", err)
		notes = append(notes, "Storage data unavailable: "+err.Error())
	} else {
		for _, row := range partRows {
			db := fmt.Sprintf("%v", row["database"])
			tbl := fmt.Sprintf("%v", row["table"])
			diskName := fmt.Sprintf("%v", row["disk_name"])
			bytes := int64(toFloat64(row["bytes"]))

			dt := diskTypes[diskName]
			key := tableKey{db, tbl}
			if isS3Disk(diskName, dt) {
				tableS3[key] += bytes
				totalS3 += bytes
			} else {
				tableLocal[key] += bytes
				totalLocal += bytes
			}
		}
	}

	localGB := float64(totalLocal) / 1e9
	s3GB := float64(totalS3) / 1e9
	report.Storage = costStorage{
		LocalBytes:      totalLocal,
		S3Bytes:         totalS3,
		LocalGB:         localGB,
		S3GB:            s3GB,
		LocalMonthlyUSD: localGB * pricing.EBSGBMonthlyUSD,
		S3MonthlyUSD:    s3GB * pricing.S3GBMonthlyUSD,
		TotalMonthlyUSD: localGB*pricing.EBSGBMonthlyUSD + s3GB*pricing.S3GBMonthlyUSD,
	}

	// Top tables by cost
	allKeys := map[tableKey]bool{}
	for k := range tableLocal {
		allKeys[k] = true
	}
	for k := range tableS3 {
		allKeys[k] = true
	}
	for key := range allKeys {
		lb := tableLocal[key]
		sb := tableS3[key]
		lgb := float64(lb) / 1e9
		sgb := float64(sb) / 1e9
		report.ByTable = append(report.ByTable, costTableEntry{
			Database:   key.db,
			Table:      key.table,
			LocalBytes: lb,
			S3Bytes:    sb,
			LocalGB:    lgb,
			S3GB:       sgb,
			MonthlyUSD: lgb*pricing.EBSGBMonthlyUSD + sgb*pricing.S3GBMonthlyUSD,
		})
	}
	sort.Slice(report.ByTable, func(i, j int) bool {
		return report.ByTable[i].MonthlyUSD > report.ByTable[j].MonthlyUSD
	})
	if len(report.ByTable) > 50 {
		report.ByTable = report.ByTable[:50]
	}

	// ── Compute: K8s stored metrics or config override ──────────────────────
	var vcpuLimit, memGB float64
	serverCount := 1
	computeSource := "unknown"

	if s.cfg.Altinity.VCPUOverride > 0 {
		vcpuLimit = float64(s.cfg.Altinity.VCPUOverride)
		computeSource = "config_override"
	} else {
		metrics, merr := s.store.QueryLatestMetrics(instance)
		if merr == nil {
			var totalCPUMilli, totalMemBytes float64
			pods := map[string]bool{}
			for _, m := range metrics {
				switch m.Name {
				case "k8s.container.limit.cpu_millicores":
					totalCPUMilli += m.Value
					if pod := m.Labels["pod"]; pod != "" {
						pods[pod] = true
					}
				case "k8s.container.limit.memory_bytes":
					totalMemBytes += m.Value
				}
			}
			if totalCPUMilli > 0 {
				vcpuLimit = totalCPUMilli / 1000.0
				memGB = totalMemBytes / 1e9
				computeSource = "k8s_limits"
				if len(pods) > 0 {
					serverCount = len(pods)
				}
			}
		}
		if computeSource == "unknown" {
			notes = append(notes, "K8s metrics unavailable — set altinity.vcpu_override in config to estimate compute cost")
		}
	}

	monthlyServerFee := float64(serverCount) * pricing.ServerHourlyUSD * hoursPerMonth
	monthlyVCPU := vcpuLimit * pricing.VCPUHourlyUSD * hoursPerMonth
	report.Compute = costCompute{
		VCPULimit:           vcpuLimit,
		MemoryGB:            memGB,
		ServerCount:         serverCount,
		MonthlyServerFeeUSD: monthlyServerFee,
		MonthlyVCPUUSD:      monthlyVCPU,
		MonthlyTotalUSD:     monthlyServerFee + monthlyVCPU,
		Source:              computeSource,
	}

	if pricing.Model == "managed" {
		notes = append(notes, "Compute cost not estimated for 'managed' pricing — rates vary by region. Contact Altinity for actual rates.")
	}

	report.Notes = notes
	report.TotalMonthlyUSD = report.Storage.TotalMonthlyUSD + report.Compute.MonthlyTotalUSD

	writeJSON(w, http.StatusOK, report)
}

// ---------------------------------------------------------------------------
// GET /api/cost — aggregate across all instances
// ---------------------------------------------------------------------------

type costOverviewEntry struct {
	Instance        string  `json:"instance"`
	TotalMonthlyUSD float64 `json:"total_monthly_usd"`
	StorageUSD      float64 `json:"storage_usd"`
	ComputeUSD      float64 `json:"compute_usd"`
	LocalGB         float64 `json:"local_gb"`
	S3GB            float64 `json:"s3_gb"`
}

type costOverview struct {
	Instances       []costOverviewEntry `json:"instances"`
	TotalMonthlyUSD float64             `json:"total_monthly_usd"`
	Pricing         costPricingModel    `json:"pricing"`
}

func (s *Server) handleCostOverview(w http.ResponseWriter, r *http.Request) {
	names := s.manager.Names()
	pricing := pricingFromConfig(s.cfg)
	overview := costOverview{Pricing: pricing}

	for _, name := range names {
		// Re-use a fake request to the instance cost handler by calling the logic directly.
		// Simpler: just do a lightweight query per instance.
		client := s.manager.Get(name)
		if client == nil {
			continue
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)

		diskRows, _ := client.Query(ctx, `SELECT name, type FROM system.disks ORDER BY name`)
		diskTypes := map[string]string{}
		for _, dr := range diskRows {
			diskTypes[fmt.Sprintf("%v", dr["name"])] = fmt.Sprintf("%v", dr["type"])
		}

		partRows, err := client.Query(ctx, `
			SELECT disk_name, sum(bytes_on_disk) AS bytes
			FROM system.parts WHERE active
			GROUP BY disk_name
		`)
		cancel()

		var localBytes, s3Bytes int64
		if err == nil {
			for _, row := range partRows {
				dn := fmt.Sprintf("%v", row["disk_name"])
				b := int64(toFloat64(row["bytes"]))
				if isS3Disk(dn, diskTypes[dn]) {
					s3Bytes += b
				} else {
					localBytes += b
				}
			}
		}

		lgb := float64(localBytes) / 1e9
		sgb := float64(s3Bytes) / 1e9
		storageUSD := lgb*pricing.EBSGBMonthlyUSD + sgb*pricing.S3GBMonthlyUSD

		var computeUSD float64
		if s.cfg.Altinity.VCPUOverride > 0 {
			v := float64(s.cfg.Altinity.VCPUOverride)
			computeUSD = (v*pricing.VCPUHourlyUSD + pricing.ServerHourlyUSD) * hoursPerMonth
		} else {
			metrics, merr := s.store.QueryLatestMetrics(name)
			if merr == nil {
				var totalMilli float64
				pods := map[string]bool{}
				for _, m := range metrics {
					if m.Name == "k8s.container.limit.cpu_millicores" {
						totalMilli += m.Value
						if pod := m.Labels["pod"]; pod != "" {
							pods[pod] = true
						}
					}
				}
				if totalMilli > 0 {
					sc := maxInt(1, len(pods))
					computeUSD = (totalMilli/1000.0*pricing.VCPUHourlyUSD + float64(sc)*pricing.ServerHourlyUSD) * hoursPerMonth
				}
			}
		}

		entry := costOverviewEntry{
			Instance:        name,
			StorageUSD:      storageUSD,
			ComputeUSD:      computeUSD,
			TotalMonthlyUSD: storageUSD + computeUSD,
			LocalGB:         lgb,
			S3GB:            sgb,
		}
		overview.Instances = append(overview.Instances, entry)
		overview.TotalMonthlyUSD += entry.TotalMonthlyUSD
	}

	writeJSON(w, http.StatusOK, overview)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
