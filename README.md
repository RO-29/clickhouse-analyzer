# ch-analyzer

<h2 align="center">
  🌐 &nbsp;<a href="https://ch-analyzer.pages.dev"><b>Live&nbsp;demo&nbsp;&amp;&nbsp;docs&nbsp;→&nbsp;ch-analyzer.pages.dev</b></a>&nbsp; 🌐
</h2>

<p align="center"><b><a href="https://ch-analyzer.pages.dev">https://ch-analyzer.pages.dev</a></b></p>

A self-hosted ClickHouse monitoring and alerting tool. Polls multiple CH instances every minute, stores metrics back into ClickHouse itself, sends Slack alerts, and serves a React dashboard — all in a single Go binary.

## Features

**Collectors** — parallel collection from all instances every poll cycle:

| Collector | What it watches |
|-----------|----------------|
| System | Memory (RSS + CH tracking), CPU, OS load, concurrent queries |
| Queries | Long-running queries (>1m), failed queries, query storms, full-table scans |
| Tables | Active parts per table/partition, merge throughput, stuck/slow mutations |
| Storage | Disk usage per tier, S3 read latency, S3 concurrency contention, tier movement |
| Inserts | Insert throughput drops, small-insert anti-pattern, insert exception tracking |
| Async Inserts | Async insert queue depth, error rate, flush failures |
| Errors | Exception rates by code, fatal errors from system.crash_log |
| Replication | Per-table replica status, absolute delay, readonly replicas, queue backlog |
| Background Pool | Background merge/fetch pool utilization, saturation warnings |
| Cache Health | Mark cache, uncompressed cache, query cache hit rates |
| MVs | Materialized view lag, failures, bloat, chained MV breakage |
| Dictionaries | Reload failures, stale dictionaries |
| Projections | Projection part counts, coverage analysis |
| TTL | Tables with TTL enabled but not deleting, TTL reclaim rates |
| Parts Age | Oldest part age per table, age distribution anomalies |
| Keeper | ClickHouse Keeper health, latency, leader election, session timeouts |
| Freshness | Data freshness gaps — tables that stopped receiving inserts |
| Schema Drift | Schema differences between replicas on the same table |
| Slow Query Fingerprint | Fingerprint-based slow query detection with regression factor |
| K8s | OOMKills, pod restarts, resource limits vs actual (optional, in-cluster only) |

**Analyzer** — cross-collector signal correlation:
- Anomaly detection via standard-deviation baseline (auto-learned per metric)
- Sustained-elevation detection across consecutive poll cycles
- Cross-collector rules: OOM risk (high memory + many queries), merge overload, S3 contention

**Alert System**:
- 20+ alert categories with `fire_count` tracking and `first_seen_at`
- Every alert type ships with a plain-English playbook: what it means, why it fires, and named SQL investigation queries pre-populated with the alert's time window
- Snooze with expiry (default 24h), acknowledge with reason
- Alert inhibition: CPU spike suppresses query slowdown alerts; disk critical suppresses disk warn
- Escalation: sustained warn → critical after configurable consecutive polls
- Maintenance windows: suppress all alerts for a specific instance or globally
- Slack notifications: immediate (critical), batched 5m (warn), digest only (info)

**Dashboard** (React + Tailwind):
- Overview with per-node health score cards and triage NodeCard view
- Per-instance detail: metrics history charts, running queries, top tables
- Alerts page: active/resolved history, snooze and acknowledge actions, playbook drawer
- Query Analyzer: patterns, samples, live queries, users, anti-patterns, failures, S3 latency, merges, disk I/O
- Table Scanner: multi-instance table search by pattern, engine, or size
- Cost Explorer: storage breakdown by table/tier with monthly cost estimates
- Compare: DDL, settings, metrics, and query patterns across instances
- AI Analyzer (Chat): conversational analysis, context-aware per view, agentic tool use
- Feature Guide (formerly Discover): onboarding reference for all views
- Advisor: remediation suggestions per alert category (customizable via YAML)
- Run Checks: on-demand collector execution for spot diagnostics

**Slack App** (Socket Mode — no public HTTP endpoint required):
- Pinned dashboard message with live health scores updated every poll
- Alert notifications with inline Resolve / Snooze / Details buttons
- Slash commands: `/status`, `/alerts`, `/runcheck <collector> <instance>`
- Per-instance channel routing: route critical alerts from prod to a dedicated channel

**Storage**: metrics stored back into `ch_analyzer` database on every monitored instance — no external TSDB needed.

**Optional**: Prometheus `/metrics` endpoint.

---

## Quick Start

### 1. Create monitoring user on each CH instance

```sql
CREATE USER IF NOT EXISTS monitoring IDENTIFIED BY 'your_password';
GRANT SELECT ON system.* TO monitoring;
GRANT SELECT ON *.* TO monitoring;
GRANT SELECT, INSERT ON ch_analyzer.* TO monitoring;

-- Optional, multi-replica ClickHouse Cloud only: enables cluster-wide *_log
-- reads via clusterAllReplicas(). See "Migrations & grants" below for why.
-- GRANT READ ON *.* TO monitoring;
```

### 2. Run the schema

The `ch_analyzer` database and tables are **not** created automatically. Run the schema first:

```bash
clickhouse-client --host your-host --port 8443 --secure \
  --user admin --password your_password \
  --multiquery < schema.sql
```

Or just run `./setup.sh` (edit the credentials at the top first) — it handles the user, schema, binary install, and systemd service in one shot.

### Migrations & grants (SQL changes in this release)

Fresh installs get everything below from `schema.sql` / `setup.sh` automatically.
For an **existing** install, apply the migration once; the grant is optional.

**1. `query_samples.exception` column** — captures the exception *message* (not
just the code) so error-sample drilldowns and failure views show *why* a query
failed. Idempotent; existing rows default to `''`.

```sql
ALTER TABLE ch_analyzer.query_samples
  ADD COLUMN IF NOT EXISTS exception String DEFAULT '';
```

**2. `READ ON REMOTE` grant (optional — multi-replica ClickHouse Cloud only).**
Each replica writes its own `query_log`/`part_log`/etc. Without this grant, on a
multi-replica service the log-backed tabs (Query Log, Failures, Merges & Parts,
MV Performance, …) and the compatibility chip's `clusterAllReplicas` /
`cluster_wide_logs` features see **only the replica the connection lands on** —
incomplete. Granting it lets ch-analyzer fan reads across all replicas with
`clusterAllReplicas()`. Run as an admin user (`monitoring` can't self-grant):

```sql
GRANT READ ON *.* TO monitoring;   -- CH 24.x+; the ACCESS_DENIED error names "READ ON REMOTE"
```

Leaving it ungranted is safe — those tabs simply reflect one replica, and the
chip explains the gap. No action is needed for the Users/CPU tab: it reads the
existing `cpu_user_us` / `cpu_system_us` columns (captured from `ProfileEvents`),
already covered by the standard `SELECT` grant.

### 3. Configure

```bash
cp configs/ch-analyzer.yaml /etc/ch-analyzer/config.yaml
vi /etc/ch-analyzer/config.yaml
```

At minimum, fill in your instances and Slack credentials:

```yaml
instances:
  - name: "node-a"
    host: "your-host.altinity.cloud"
    port: 8443
    username: "monitoring"
    password: "your_password"
    secure: true
    database: "your_database"

slack:
  bot_token: "xoxb-your-token"
  channel_id: "C0XXXXXXXXX"
```

### 4. Run

**Binary + systemd (recommended):**

```bash
make build-linux
sudo ./setup.sh            # creates user, schema, installs binary + service
sudo systemctl enable --now ch-analyzer
sudo journalctl -u ch-analyzer -f
```

**Docker:**

```bash
docker run -d \
  -v /etc/ch-analyzer/config.yaml:/etc/ch-analyzer/config.yaml:ro \
  -p 8080:8080 \
  ch-analyzer:latest
```

**Local dev:**

```bash
# Terminal 1 — frontend hot reload
cd web/frontend && npm run dev

# Terminal 2 — Go backend
make build-go && ./bin/ch-analyzer -config configs/ch-analyzer.yaml
```

Dashboard: `http://localhost:8080` (or `:5173` in dev mode)

---

## Configuration Reference

All duration values use Go syntax: `"30s"`, `"5m"`, `"1h"`.

```yaml
polling:
  interval: "1m"                    # Collection frequency

thresholds:
  memory:
    warn_percent: 80                # % of max_memory_usage
    critical_percent: 90
    rss_warn_percent: 85
    rss_critical_percent: 95

  cpu:
    warn_percent: 80
    critical_percent: 95

  queries:
    long_running_threshold: "1m"
    max_concurrent: 100
    warn_concurrent: 50

  parts:
    warn_count: 1000                # Active parts per table
    critical_count: 3000
    warn_per_partition: 300

  merges:
    max_active: 20
    warn_active: 10

  mutations:
    stuck_threshold: "30m"

  inserts:
    throughput_drop_percent: 50
    small_insert_threshold: 100     # Rows
    small_insert_warn_count: 10     # Per minute

  disk:
    warn_percent: 80
    critical_percent: 90

  s3:
    latency_warn: "5s"
    latency_critical: "15s"
    max_concurrent_reads: 50

  mv:
    lag_warn: "5m"
    bloat_ratio_warn: 10.0

  dictionaries:
    reload_fail_threshold: 3

  replication:
    lag_warn: "30s"
    lag_critical: "2m"

  background_pool:
    warn_percent: 80
    critical_percent: 95

  cache_health:
    mark_hit_rate_warn_percent: 70
    mark_hit_rate_critical_percent: 50
    min_queries_for_alert: 100

  query_latency:
    spike_warn_multiplier: 2.0
    spike_critical_multiplier: 5.0
    min_baseline_ms: 100
    min_query_count: 10

  freshness:
    gap_minutes: 60
    min_daily_inserts: 10

slack:
  bot_token: "xoxb-..."
  channel_id: "C0XXXXXXXXX"
  dedup_window: "15m"
  resolve_messages: true
  digest:
    enabled: true
    daily_time: "09:00"             # UTC, 24h
    weekly_day: "monday"
  severity_routing:
    critical: "immediate"
    warn: "batched_5m"
    info: "digest_only"

web:
  listen_addr: ":8080"
  enabled: true
  suggestions_path: ""              # Path to custom suggestions.yaml

storage:
  database: "ch_analyzer"
  retention: "8760h"                # 1 year

prometheus:
  enabled: false
  listen_addr: ":9090"

k8s:
  enabled: false                    # Only if running inside K8s as a pod
```

### Custom advisor suggestions

Copy `configs/suggestions.yaml`, edit it, and point `suggestions_path` at it. Categories defined in the file override built-in defaults; omitted categories keep their defaults.

```yaml
# configs/my-suggestions.yaml
memory:
  - "Check max_memory_usage: SELECT name, value FROM system.settings WHERE name = 'max_memory_usage'"
  - "Your custom tip here"
```

---

## Schema

Six tables in the `ch_analyzer` database. **These must be created before starting ch-analyzer** — run `schema.sql` manually or via `setup.sh`.

| Table | Engine | Purpose |
|-------|--------|---------|
| `metrics` | MergeTree | All collected metric values, 1-year TTL |
| `alerts` | ReplacingMergeTree | Alert history with dedup, snooze, ack, fire_count |
| `digest_snapshots` | MergeTree | Daily/weekly digest state |
| `health_snapshots` | MergeTree | Per-poll instance health summaries, 30-day TTL |
| `audit_log` | MergeTree | All mutations: alert resolutions, snooze, maintenance, 90-day TTL |
| `query_samples` | MergeTree | Per-query samples with full SQL and execution stats, 30-day TTL |

Each instance stores only its own data — no single bottleneck, no cross-instance writes.

All alert resolutions, snoozes, acknowledges, and maintenance window changes are recorded in `ch_analyzer.audit_log`.

---

## Building

```bash
make build           # frontend + Go binary (current OS)
make build-linux     # frontend + Go binary (linux/amd64)
make build-go        # Go only, skip frontend rebuild
make docker          # Docker image
make test            # go test ./... -race
make lint            # golangci-lint
```

Output binary: `bin/ch-analyzer` / `bin/ch-analyzer-linux-amd64`

---

## Kubernetes

```bash
# Edit credentials first
vi deploy/k8s.yaml

kubectl apply -f deploy/k8s.yaml
kubectl -n ch-analyzer port-forward svc/ch-analyzer 8080:8080
```

Set `k8s.enabled: true` in config only when the binary runs inside the cluster (enables pod-level OOMKill and restart tracking).

---

## Grafana

`deploy/grafana-dashboard.json` is an importable Grafana dashboard that reads from the `ch_analyzer` tables if you want to overlay ch-analyzer metrics alongside your existing Grafana setup.

---

## Version compatibility

ch-analyzer runs against a wide range of ClickHouse deployments and adapts per
instance — a single fleet can mix OSS and Cloud, and different versions, freely.

| Deployment | Supported |
|------------|-----------|
| ClickHouse OSS (self-hosted) | **23.x → latest** |
| ClickHouse Cloud | **25.3 → latest** |

**How it works.** On first use (and every 6h) each instance is fingerprinted:
`version()`, edition (`cloud_mode` setting, or a config override), replica count,
and a probe-based feature registry (which `system.*` tables/columns exist, whether
`system.zookeeper` is readable, whether `clusterAllReplicas` works). Every
collector and query gates on these capabilities, so a feature missing on an older
version or restricted on Cloud is **skipped gracefully or shown as "not
supported"** — never a hard error or a silently-empty panel. The detected version,
edition, and per-feature availability are shown in the **compatibility chip** in
the Explore header and via `GET /api/instances/{name}/capabilities`.

**Edition override.** Detection is automatic, but you can pin it per instance:

```yaml
instances:
  - name: "prod-cloud"
    host: "xxx.clickhouse.cloud"
    mode: "cloud"        # auto (default) | oss | cloud
```

**Testing.** `make compat-test` spins up each OSS version in Docker, applies the
schema, and runs `--compat-check` (detect capabilities + run every collector,
failing on any hard error). The same matrix runs in CI (`.github/workflows/compat.yml`).
Cloud is covered by a live smoke test since it can't run in a container.

## Requirements

- Go 1.23+
- Node 22+ (for frontend builds)
- ClickHouse **OSS 23.x+ or Cloud 25.3+** on monitored instances (older OSS mostly
  works too — unsupported features degrade gracefully)
- `clickhouse-client` in PATH (for `setup.sh` only)
- Docker (only for `make compat-test`)
