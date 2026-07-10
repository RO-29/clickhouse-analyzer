# Cloud correctness, alert readability & full version-compatibility layer

Fixes a batch of ClickHouse **Cloud** issues, makes alert detail human-readable, and
adds a first-class **version/edition compatibility system** so ch-analyzer runs
cleanly across **OSS 23.x → latest** and **Cloud 25.3 → latest** — a single fleet
can mix editions and versions freely.

Branch: `fix/cloud-fixes-alert-readability` · 4 commits · 42 files, +2,517 / −1,000

---

## Why

Running against a real ClickHouse Cloud service surfaced a chain of problems:
empty Explore tabs, a hung S3 tab, error-sample drills that showed nothing, alert
details that read like raw metric math, and no notion of *which* features a given
server actually supports. This PR fixes those and puts a durable compatibility
layer underneath so nothing breaks (or silently misleads) on any supported version.

---

## What changed

### 1. Cloud correctness
- **Timezone-correct queries** — `from`/`to` are formatted in **UTC** (Cloud stores
  `event_time` in UTC). The default 1h Explore window is no longer empty; a −5.5h
  local-vs-UTC skew previously emptied any window narrower than the offset.
- **Local-time display** — a `chToDate()` helper parses ClickHouse's naive
  timestamps as UTC and renders them in the viewer's timezone (charts, samples,
  connections, table activity). Query in UTC, display in local.
- **S3 tab no longer hangs** — `system.remote_data_paths` (an unindexable full scan,
  >30s on Cloud) now runs concurrently with its own tight budget instead of
  starving the other S3 queries. `s3-stats` went 20s-timeout → ~4s, all sections
  populate; degrades to “n/a” when it can’t finish.
- **Keeper** — `system.zookeeper` `ACCESS_DENIED` (managed Keeper on Cloud) is
  handled instead of logged every poll.

### 2. Samples / errors
- **Errors-only drill works on Cloud** — the samples read referenced a non-existent
  `exception` column, which hard-failed and silently dropped every request to the
  short-retention `system.query_log`. The read is now column-drift resilient, and
  the exception **message** is captured going forward (schema + collector).
- **Overview chart labels** show `kind + table` (e.g. `INSERT events`) instead of a
  raw `normalized_query_hash`.

### 3. Alert human-readability
- **Anomalies** are now plain-English (“Rows read by in-flight queries jumped to 478,
  vs a typical 16 (~30× normal) — 5.3σ above baseline. Usually a heavy new query or
  full scan — check Live Queries.”), with a **significance guard** that suppresses
  statistically-significant-but-trivial anomalies (e.g. a count going 1→2).
- **Errors collector** — fixed the `×0` count bug (wrong column key) and filters the
  benign `KEEPER_EXCEPTION "Bad version"` optimistic-concurrency retry.
- **Chained-MV** alert gets its own accurate, informational explanation.
- **Still-firing alerts refresh** their message/title/severity in place instead of
  freezing the text at first fire.

### 4. Version/edition compatibility system (new)
- **`internal/chclient/capabilities.go`** — per-instance detection cached (6h TTL):
  `version()`, edition (`cloud_mode` setting + config override), replica count /
  `clusterAllReplicas` probe, and a **probe-based feature registry** (system-table
  and system-column inventory + a live `system.zookeeper` access probe). Probing is
  more robust than version numbers — a table can be disabled or restricted
  independent of version.
- **Per-instance `mode: auto|oss|cloud`** config (default auto).
- **Helpers** — `Caps().Has(feature)`, `LogTable()` (wraps `*_log` reads in
  `clusterAllReplicas` only on multi-node), `PickSQL()`, `Reason()`.
- **Surfacing** — `GET /api/instances/{name}/capabilities` + a **compatibility chip**
  in the Explore header showing version / edition / replicas and each feature’s
  available/unavailable state with the reason. Unsupported features degrade
  gracefully instead of erroring or showing an empty panel.
- **Collectors gate on capabilities** (keeper migrated as the pattern:
  short-circuits when `system.zookeeper` isn’t usable rather than failing each poll).

### 5. Compatibility testing
- **`--compat-check`** — detects capabilities + runs every collector once, prints a
  JSON report, exits non-zero on any hard error.
- **`scripts/compat-test.sh` / `make compat-test`** — spins up each OSS version in
  Docker, applies `schema.sql`, runs `--compat-check`, and snapshots the capability
  set to `test/compat/golden/`.
- **`.github/workflows/compat.yml`** — the same matrix in CI.

### 6. Docs
- README compatibility table (OSS 23.x+, Cloud 25.3+) + `mode` config.
- ARCH.md capability-layer section.

---

## Test results

`make compat-test` — fresh container per version, schema applied, all 23 collectors
run:

| Version | Detected | Edition | Hard errors |
|---|---|---|---|
| 23.3 | 23.3.22.3 | oss | **0** ✅ |
| 23.8 | 23.8.16.16 | oss | **0** ✅ |
| 24.3 | 24.3.18.7 | oss | **0** ✅ |
| 24.8 | 24.8.14.39 | oss | **0** ✅ |
| 25.3 | 25.3.14.14 | oss | **0** ✅ |
| latest | 26.6.1.1193 | oss | **0** ✅ |
| Cloud (live) | 26.4.1.1960 | **cloud** (auto) | **0** ✅ |

`✅ compat-test passed for: 23.3 23.8 24.3 24.8 25.3 latest` (exit 0), plus a live
Cloud smoke test. Golden snapshots confirm probe-detection tracks real behavior
(`object_storage_type` from 24.3+, `projections` from 25.3+, `zookeeper`
unavailable/denied handled, disabled logs flagged per deployment).

---

## How to verify

```bash
make build                 # or: cd web/frontend && npm run build && make build-go
make compat-test           # full OSS matrix (needs Docker)
./bin/ch-analyzer --config <cfg> --compat-check   # single instance report
```

Then restart your instance and open **Explore** — the compatibility chip appears in
the header, and the default 1h window / S3 tab / error drills all work on Cloud.

---

## Not included (bounded follow-up — non-breaking)

Routing the *remaining* collectors/web handlers through `Caps()` / `LogTable()`.
This is consistency + multi-node-Cloud log correctness, **not breakage** — the matrix
proves 0 hard errors today, and `LogTable` is behavior-neutral on single-node
deployments (which both the OSS containers and the current Cloud service are).
