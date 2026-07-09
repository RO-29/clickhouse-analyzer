package chclient

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Version / edition model
// ---------------------------------------------------------------------------

// Edition identifies the ClickHouse deployment flavour. Capabilities and query
// shapes differ between self-hosted (OSS) and ClickHouse Cloud.
type Edition string

const (
	EditionOSS     Edition = "oss"
	EditionCloud   Edition = "cloud"
	EditionUnknown Edition = "unknown"
)

// Version is a parsed ClickHouse server version. Patch/build beyond minor are
// captured but comparisons only use major.minor (feature gates never hinge on a
// patch release).
type Version struct {
	Major, Minor, Patch int
	Raw                 string
}

// AtLeast reports whether v >= major.minor.
func (v Version) AtLeast(major, minor int) bool {
	if v.Major != major {
		return v.Major > major
	}
	return v.Minor >= minor
}

func (v Version) String() string {
	if v.Raw != "" {
		return v.Raw
	}
	return fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch)
}

// parseVersion parses "24.8.4.13" / "23.3.1.2823" style strings. Missing parts
// default to 0; a fully unparseable string yields a zero Version (which
// AtLeast() treats as "older than everything", the conservative choice).
func parseVersion(raw string) Version {
	v := Version{Raw: strings.TrimSpace(raw)}
	fields := strings.Split(v.Raw, ".")
	get := func(i int) int {
		if i >= len(fields) {
			return 0
		}
		n, _ := strconv.Atoi(strings.TrimSpace(fields[i]))
		return n
	}
	v.Major, v.Minor, v.Patch = get(0), get(1), get(2)
	return v
}

// ---------------------------------------------------------------------------
// Feature registry
// ---------------------------------------------------------------------------

// Feature is a stable identifier for a version/edition-sensitive capability.
type Feature string

const (
	FeatureDroppedTables    Feature = "system.dropped_tables"
	FeatureAsyncInsertLog   Feature = "system.asynchronous_insert_log"
	FeatureAsyncInsertions  Feature = "system.asynchronous_inserts"
	FeatureZookeeper        Feature = "system.zookeeper"
	FeatureRemoteDataPaths  Feature = "system.remote_data_paths"
	FeatureTextLog          Feature = "system.text_log"
	FeatureQueryViewsLog    Feature = "system.query_views_log"
	FeatureCrashLog         Feature = "system.crash_log"
	FeatureProjections      Feature = "system.projections"
	FeatureSessionLog       Feature = "system.session_log"
	FeatureBackupLog        Feature = "system.backup_log"
	FeatureObjectStorageTyp Feature = "system.disks.object_storage_type"
	FeatureDiskIsRemote     Feature = "system.disks.is_remote"
	FeatureClusterAllRepl   Feature = "clusterAllReplicas"
	FeatureClusterLogs      Feature = "cluster_wide_logs" // multi-node Cloud: wrap *_log reads
)

// FeatureStatus is the resolved availability of a Feature on an instance, with a
// human reason suitable for the UI ("requires ClickHouse 23.7+", "access denied
// on ClickHouse Cloud", "table disabled").
type FeatureStatus struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason"`
}

// Capabilities is the per-instance, cached result of capability detection.
type Capabilities struct {
	Version    Version                   `json:"version"`
	Edition    Edition                   `json:"edition"`
	Replicas   int                       `json:"replicas"` // from clusterAllReplicas probe; 1 if single/unknown
	Cluster    string                    `json:"cluster"`  // cluster name used for cluster-wide reads
	Features   map[Feature]FeatureStatus `json:"features"`
	DetectedAt time.Time                 `json:"detected_at"`
}

// Has reports whether a feature is available on this instance.
func (c *Capabilities) Has(f Feature) bool {
	if c == nil {
		return false
	}
	s, ok := c.Features[f]
	return ok && s.Available
}

// LogTable returns the correct FROM target for a per-node *_log system table.
// On a multi-node cluster (typically a scaled-out ClickHouse Cloud service)
// each replica keeps its own query_log/part_log/etc., so a plain read only sees
// one node's slice. When cluster-wide reads are warranted this returns
// clusterAllReplicas('<cluster>', system.<name>); otherwise the plain
// system.<name>. Pass the bare table name, e.g. "query_log".
func (c *Capabilities) LogTable(name string) string {
	if c != nil && c.Has(FeatureClusterLogs) {
		cluster := c.Cluster
		if cluster == "" {
			cluster = "default"
		}
		return fmt.Sprintf("clusterAllReplicas('%s', system.%s)", cluster, name)
	}
	return "system." + name
}

// PickSQL returns modern when the feature is available, else legacy. Use for the
// two-schema forks (e.g. array databases[]/tables[] vs scalar columns).
func (c *Capabilities) PickSQL(f Feature, modern, legacy string) string {
	if c.Has(f) {
		return modern
	}
	return legacy
}

// Reason returns the human explanation for a feature's (un)availability.
func (c *Capabilities) Reason(f Feature) string {
	if c == nil {
		return "capabilities not detected"
	}
	if s, ok := c.Features[f]; ok {
		return s.Reason
	}
	return "unknown feature"
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const capsTTL = 6 * time.Hour

// Caps returns the instance's capabilities, detecting and caching them on first
// use and refreshing after capsTTL (versions change on upgrade). It never
// returns nil: on total detection failure it returns a conservative set with
// EditionUnknown and no features, so callers degrade rather than crash.
func (c *Client) Caps(ctx context.Context) *Capabilities {
	c.capsMu.RLock()
	if c.caps != nil && time.Since(c.capsTime) < capsTTL {
		caps := c.caps
		c.capsMu.RUnlock()
		return caps
	}
	c.capsMu.RUnlock()

	caps := c.detectCapabilities(ctx)

	c.capsMu.Lock()
	c.caps = caps
	c.capsTime = time.Now()
	c.capsMu.Unlock()
	return caps
}

// RefreshCaps forces re-detection on the next Caps() call.
func (c *Client) RefreshCaps() {
	c.capsMu.Lock()
	c.caps = nil
	c.capsMu.Unlock()
}

// detectCapabilities runs the (small, fixed) set of detection queries. Every
// query is best-effort: a failure marks the dependent feature unavailable with a
// reason but never aborts detection.
func (c *Client) detectCapabilities(ctx context.Context) *Capabilities {
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	caps := &Capabilities{
		Edition:    EditionUnknown,
		Replicas:   1,
		Cluster:    "default",
		Features:   make(map[Feature]FeatureStatus),
		DetectedAt: time.Now(),
	}

	// ── version() ──────────────────────────────────────────────────────────
	if v, err := c.QuerySingleValue(dctx, "SELECT version()"); err == nil {
		caps.Version = parseVersion(v)
	} else {
		c.logger.Warn("capability detect: version() failed", "err", err)
	}

	// ── edition ────────────────────────────────────────────────────────────
	caps.Edition = c.detectEdition(dctx)

	// ── system table inventory (one query resolves most existence features) ──
	sysTables := c.systemTableSet(dctx)

	// ── system.columns inventory for column-level gates ──────────────────────
	sysColumns := c.systemColumnSet(dctx, "disks")

	// ── cluster / multi-node probe ───────────────────────────────────────────
	replicas, clusterOK, clusterName, clusterReason := c.probeClusterReplicas(dctx)
	caps.Replicas = replicas
	if clusterName != "" {
		caps.Cluster = clusterName
	}

	// ── resolve features ─────────────────────────────────────────────────────
	tableFeature := func(f Feature, table string, sinceNote string) {
		if sysTables[table] {
			caps.Features[f] = FeatureStatus{Available: true, Reason: "present"}
		} else {
			caps.Features[f] = FeatureStatus{Available: false, Reason: sinceNote}
		}
	}
	tableFeature(FeatureDroppedTables, "dropped_tables", "system.dropped_tables not present (needs CH 22.3+)")
	tableFeature(FeatureAsyncInsertLog, "asynchronous_insert_log", "system.asynchronous_insert_log not present or disabled (needs CH 22.4+)")
	tableFeature(FeatureAsyncInsertions, "asynchronous_inserts", "system.asynchronous_inserts not present (needs CH 22.4+)")
	tableFeature(FeatureRemoteDataPaths, "remote_data_paths", "system.remote_data_paths not present (needs CH 22.6+)")
	tableFeature(FeatureTextLog, "text_log", "system.text_log not present or disabled")
	tableFeature(FeatureQueryViewsLog, "query_views_log", "system.query_views_log not present or disabled")
	tableFeature(FeatureCrashLog, "crash_log", "system.crash_log not present or disabled")
	tableFeature(FeatureProjections, "projections", "system.projections not present (needs CH 23.3+)")
	tableFeature(FeatureSessionLog, "session_log", "system.session_log not present or disabled")
	tableFeature(FeatureBackupLog, "backup_log", "system.backup_log not present or disabled")

	// Column gates on system.disks.
	if sysColumns["object_storage_type"] {
		caps.Features[FeatureObjectStorageTyp] = FeatureStatus{Available: true, Reason: "present"}
	} else {
		caps.Features[FeatureObjectStorageTyp] = FeatureStatus{Available: false, Reason: "system.disks.object_storage_type not present (needs CH 23.7+)"}
	}
	if sysColumns["is_remote"] {
		caps.Features[FeatureDiskIsRemote] = FeatureStatus{Available: true, Reason: "present"}
	} else {
		caps.Features[FeatureDiskIsRemote] = FeatureStatus{Available: false, Reason: "system.disks.is_remote not present (needs CH 22.6+)"}
	}

	// system.zookeeper needs a live SELECT probe: the table always exists but is
	// denied on Cloud (ACCESS_DENIED) and empty when Keeper isn't configured.
	caps.Features[FeatureZookeeper] = c.probeZookeeper(dctx)

	// clusterAllReplicas availability + whether cluster-wide log reads are
	// warranted (multi-node only; single-node adds overhead for nothing).
	if clusterOK {
		caps.Features[FeatureClusterAllRepl] = FeatureStatus{Available: true, Reason: clusterReason}
		if replicas > 1 {
			caps.Features[FeatureClusterLogs] = FeatureStatus{Available: true, Reason: fmt.Sprintf("%d replicas — reading *_log cluster-wide", replicas)}
		} else {
			caps.Features[FeatureClusterLogs] = FeatureStatus{Available: false, Reason: "single node — per-node *_log is complete"}
		}
	} else {
		caps.Features[FeatureClusterAllRepl] = FeatureStatus{Available: false, Reason: clusterReason}
		caps.Features[FeatureClusterLogs] = FeatureStatus{Available: false, Reason: "no usable cluster for cluster-wide reads"}
	}

	c.logger.Info("capabilities detected",
		"version", caps.Version.String(),
		"edition", string(caps.Edition),
		"replicas", caps.Replicas)
	return caps
}

// detectEdition honours the config override, else infers from the cloud_mode
// setting (ClickHouse Cloud sets it to 1). Falls back to OSS when the setting is
// absent (older/self-hosted) — the conservative default that enables the most
// features.
func (c *Client) detectEdition(ctx context.Context) Edition {
	switch c.modeHint {
	case "cloud":
		return EditionCloud
	case "oss":
		return EditionOSS
	}
	v, err := c.QuerySingleValue(ctx, "SELECT value FROM system.settings WHERE name = 'cloud_mode'")
	if err == nil && strings.TrimSpace(v) == "1" {
		return EditionCloud
	}
	return EditionOSS
}

// systemTableSet returns the set of table names present in the system database.
func (c *Client) systemTableSet(ctx context.Context) map[string]bool {
	set := make(map[string]bool)
	rows, err := c.Query(ctx, "SELECT name FROM system.tables WHERE database = 'system'")
	if err != nil {
		c.logger.Warn("capability detect: system.tables inventory failed", "err", err)
		return set
	}
	for _, r := range rows {
		set[toStr(r["name"])] = true
	}
	return set
}

// systemColumnSet returns the set of column names present on system.<table>.
func (c *Client) systemColumnSet(ctx context.Context, table string) map[string]bool {
	set := make(map[string]bool)
	sql := fmt.Sprintf("SELECT name FROM system.columns WHERE database = 'system' AND table = '%s'", table)
	rows, err := c.Query(ctx, sql)
	if err != nil {
		c.logger.Warn("capability detect: system.columns inventory failed", "table", table, "err", err)
		return set
	}
	for _, r := range rows {
		set[toStr(r["name"])] = true
	}
	return set
}

// probeClusterReplicas returns the replica count of the "default" cluster and
// whether clusterAllReplicas is usable. Returns (1, false) on any failure.
// probeClusterReplicas checks whether clusterAllReplicas(...) is usable for
// cluster-wide *_log reads and how many replicas it fans out to. On ClickHouse
// Cloud this is normally available (the cluster is named 'default' and each
// replica writes its own query_log), but a locked-down monitoring user may lack
// the REMOTE privilege — so we discover the real cluster name and surface a
// specific reason instead of a blanket "not available".
func (c *Client) probeClusterReplicas(ctx context.Context) (replicas int, ok bool, cluster, reason string) {
	// Discover the widest cluster. Cloud exposes 'default'; OSS/BYOC may name it
	// differently, so don't hardcode. Fall back to 'default' if the catalog is
	// empty or unreadable.
	cluster = "default"
	if rows, err := c.Query(ctx, "SELECT cluster, count() AS n FROM system.clusters GROUP BY cluster ORDER BY n DESC, cluster LIMIT 20"); err == nil {
		best := ""
		for _, r := range rows {
			name := fmt.Sprint(r["cluster"])
			if name == "" {
				continue
			}
			if name == "default" { // prefer the conventional Cloud cluster
				best = "default"
				break
			}
			if best == "" {
				best = name
			}
		}
		if best != "" {
			cluster = best
		}
	}

	v, err := c.QuerySingleValue(ctx, fmt.Sprintf("SELECT count() FROM clusterAllReplicas('%s', system.one)", cluster))
	if err != nil {
		msg := err.Error()
		low := strings.ToLower(msg)
		switch {
		case strings.Contains(low, "access_denied") || strings.Contains(low, "not enough privileges") || strings.Contains(msg, "Code: 497"):
			return 1, false, cluster, fmt.Sprintf("clusterAllReplicas('%s', …) denied for this user — needs the REMOTE privilege (common on locked-down Cloud monitoring users)", cluster)
		case strings.Contains(low, "unknown cluster") || strings.Contains(low, "requested cluster"):
			return 1, false, cluster, fmt.Sprintf("no cluster named '%s' — this deployment has no cluster for cluster-wide reads", cluster)
		default:
			return 1, false, cluster, fmt.Sprintf("clusterAllReplicas('%s', …) not available: %s", cluster, truncErr(msg))
		}
	}
	n, perr := strconv.Atoi(strings.TrimSpace(v))
	if perr != nil || n < 1 {
		return 1, true, cluster, fmt.Sprintf("cluster '%s' reachable", cluster)
	}
	return n, true, cluster, fmt.Sprintf("cluster '%s' — %d replica(s)", cluster, n)
}

// truncErr shortens a ClickHouse error to its first line / 120 chars for reasons.
func truncErr(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 120 {
		s = s[:120] + "…"
	}
	return s
}

// probeZookeeper checks whether system.zookeeper is actually SELECT-able. On
// Cloud it returns ACCESS_DENIED; when Keeper is absent it errors differently.
func (c *Client) probeZookeeper(ctx context.Context) FeatureStatus {
	_, err := c.Query(ctx, "SELECT name FROM system.zookeeper WHERE path = '/' LIMIT 1")
	if err == nil {
		return FeatureStatus{Available: true, Reason: "present"}
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "ACCESS_DENIED") || strings.Contains(msg, "Not enough privileges"):
		return FeatureStatus{Available: false, Reason: "access denied (managed Keeper — not exposed on ClickHouse Cloud)"}
	case strings.Contains(msg, "NO_ZOOKEEPER") || strings.Contains(msg, "ZooKeeper is not configured") || strings.Contains(msg, "Coordination is disabled"):
		return FeatureStatus{Available: false, Reason: "Keeper/ZooKeeper not configured (non-replicated deployment)"}
	default:
		return FeatureStatus{Available: false, Reason: "system.zookeeper not readable"}
	}
}

// toStr is a tiny local stringifier (chclient must not import the collector
// package, which owns the richer row helpers).
func toStr(v interface{}) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", v)
}
