# ch-analyzer

A lightweight, self-hosted ClickHouse monitoring and alerting tool. Polls multiple CH instances every minute, stores metrics back into ClickHouse itself, sends Slack alerts, and serves a React dashboard — all in a single Go binary.

## Features

**Collectors** — parallel collection from all instances every poll cycle:

| Collector | What it watches |
|-----------|----------------|
| System | Memory (RSS + CH tracking), CPU, OS load, concurrent queries |
| Queries | Long-running queries (>1m), failed queries, query storms, full-table scans |
| Tables | Active parts per table/partition, merge throughput, stuck/slow mutations |
| Storage | Disk usage per tier, S3 read latency, S3 concurrency contention, tier movement |
| Inserts | Insert throughput drops, small-insert anti-pattern detection |
| MVs | Materialized view lag, failures, bloat, chained MV breakage |
| Dictionaries | Reload failures, stale dictionaries |
| K8s | OOMKills, pod restarts, resource limits vs actual (optional, in-cluster only) |

**Analyzer** — cross-collector signal correlation:
- Anomaly detection via standard-deviation baseline (auto-learned per metric)
- Sustained-elevation detection across consecutive poll cycles
- Cross-collector rules: OOM risk (high memory + many queries), merge overload, S3 contention

**Alerting**:
- Slack bot with configurable severity routing: critical → immediate, warn → batched 5m, info → digest only
- 15-minute dedup window, "all clear" resolution messages
- Daily and weekly Slack digests with per-instance health scores

**Dashboard** (React + Tailwind, no auth required):
- Overview with per-node health score cards and triage view
- Per-instance detail: metrics history charts, running queries, top tables
- Alerts page with active/resolved history
- Query Analyzer: normalized query patterns ranked by impact
- Advisor: remediation suggestions per alert category (customizable via YAML)
- Schema Explorer and Compare views
- Live app logs and terminal passthrough

**Storage**: metrics stored back into `ch_analyzer` database on every monitored instance — no external TSDB needed. 1-year TTL enforced via ClickHouse TTL rules.

**Optional**: Prometheus `/metrics` endpoint.

---

## Quick Start

### 1. Create monitoring user on each CH instance

Run `setup.sh` (edit credentials at the top first), or manually:

```sql
CREATE USER IF NOT EXISTS monitoring IDENTIFIED BY 'your_password';
GRANT SELECT ON system.* TO monitoring;
GRANT SELECT ON your_database.* TO monitoring;
GRANT SELECT, INSERT ON ch_analyzer.* TO monitoring;
```

The `ch_analyzer` database and tables are created automatically on first run.

### 2. Configure

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

### 3. Run

**Binary + systemd (recommended):**

```bash
make build-linux
sudo ./setup.sh            # creates user, tables, installs binary + service
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
    max_concurrent: 100             # Critical
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

## Schema

Three tables created automatically in the `ch_analyzer` database on every monitored instance:

| Table | Engine | Purpose |
|-------|--------|---------|
| `metrics` | MergeTree | All collected metric values, 1-year TTL |
| `alerts` | ReplacingMergeTree | Alert history with dedup and resolution tracking |
| `digest_snapshots` | MergeTree | Daily/weekly digest state |

Each instance stores only its own data — no single bottleneck, no cross-instance writes.

---

## Grafana

`deploy/grafana-dashboard.json` is an importable Grafana dashboard that reads from the `ch_analyzer` tables if you want to overlay ch-analyzer metrics alongside your existing Grafana setup.

---

## Requirements

- Go 1.23+
- Node 22+ (for frontend builds)
- ClickHouse 22.x+ on monitored instances
- `clickhouse-client` in PATH (for `setup.sh` and audit script only)
