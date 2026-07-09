# ch-analyzer Architecture

> Source of truth for this document is the code in this repo, not memory or any prior docs.
> Last regenerated 2026-05-02 by walking the source tree.

A Go + React monitoring tool for ClickHouse clusters. One binary that:

1. Polls every registered CH instance every minute, runs N collectors in parallel,
2. Stores its own metrics + alerts on each CH node it monitors (each node owns its `ch_analyzer.*` schema),
3. Reconciles alerts in DB (single-writer, dedup by key, snooze/ack/maintenance/inhibition layered on top),
4. Surfaces everything via a single embedded React SPA + a Slack socket-mode app + Prometheus exporter + PagerDuty + webhook.

There is no central control plane. Each CH node is the source of truth for its own observability data.

---

## Table of contents

- [Top-level architecture](#top-level-architecture)
- [Data flow per poll cycle](#data-flow-per-poll-cycle)
- [Layer 1 — Collectors](#layer-1--collectors)
- [Layer 2 — Reconcile loop & alerter](#layer-2--reconcile-loop--alerter)
- [Layer 3 — Persistence](#layer-3--persistence)
- [Layer 4 — HTTP API](#layer-4--http-api)
- [Layer 5 — Frontend](#layer-5--frontend)
- [Layer 6 — Integrations](#layer-6--integrations)
- [Cross-cutting concerns](#cross-cutting-concerns)
- [Reference appendices](#reference-appendices)

---

## Top-level architecture

```
                                ┌─────────────────────────────────────────────┐
                                │              ch-analyzer (one Go binary)    │
                                │                                             │
   ┌────────────────────┐       │  ┌───────────────┐    ┌──────────────────┐  │
   │  CH instance A     │◀──────┼──┤  collectors   │───▶│  alerter         │  │
   │   system.* tables  │       │  │  (~24, run in │    │ (reconcile loop) │  │
   │   ch_analyzer.*    │◀──┐   │  │   parallel    │    └────────┬─────────┘  │
   └────────────────────┘   │   │  │   per cycle)  │             │            │
                            │   │  └──────┬────────┘             │            │
   ┌────────────────────┐   │   │         │ metrics + alerts     │ writes      │
   │  CH instance B     │◀──┤   │         ▼                      ▼            │
   │   system.*         │   │   │  ┌────────────┐         ┌──────────────┐    │
   │   ch_analyzer.*    │◀──┤   │  │   store    │◀────────│ ch_analyzer  │    │
   └────────────────────┘   │   │  │ (per-node) │         │  .alerts     │    │
                            │   │  └────────────┘         │  .metrics    │    │
   ┌────────────────────┐   │   │                          │  .health     │    │
   │  CH instance C     │◀──┘   │  ┌──────────────┐        │  .audit_log  │    │
   │  ...               │       │  │   web srv    │        │  .digest     │    │
   └────────────────────┘       │  │ (REST + SSE) │        │  .query_smpl │    │
                                │  └──────┬───────┘        └──────────────┘    │
                                │         │                                    │
                                │  ┌──────┴────────┬──────┬──────┬─────────┐   │
                                │  │   React SPA   │Slack │  PD  │ Webhook │   │
                                │  │ (embedded)    │socket│      │         │   │
                                │  └───────────────┴──────┴──────┴─────────┘   │
                                │                                              │
                                │  ┌──────────────┐                            │
                                │  │ Prometheus   │  /metrics endpoint        │
                                │  │  exporter    │                            │
                                │  └──────────────┘                            │
                                └──────────────────────────────────────────────┘
```

Two kinds of data flow:

- **Collectors → CH**: `system.*` reads to detect conditions, write metrics/alerts to `ch_analyzer.*` on the same node (each node hosts its own monitoring schema).
- **HTTP API → CH**: dashboard queries hit either `ch_analyzer.*` (our own state) or live `system.*` (real-time queries / processes / logs). Mix per endpoint — see [Layer 4](#layer-4--http-api).

---

## Data flow per poll cycle

`cmd/ch-analyzer/main.go:runReconcile` runs every `cfg.Polling.Interval` (default 1 min) **or** when the API receives `POST /api/force-poll`:

```
runReconcile(ctx)
  │
  ├── ForEachParallel(instances) ───────────────────────────────┐
  │                                                              │
  │   per instance:                                              │
  │     - circuit-breaker check (instanceFailures ≥ 5 → skip 5m) │
  │     - sync.WaitGroup over all collectors (parallel)          │
  │     - errorCount tracks per-collector failures               │
  │     - fullyObserved = (errorCount == 0)                      │
  │     - analyzer.Analyze(allResults) → adds cross-alerts +     │
  │       healthScore                                            │
  │     - metricStore.InsertMetrics(rawMetrics)                  │
  │     - addSnap(instanceSnapshot{ alerts, fullyObserved, …})   │
  │                                                              │
  │   AFTER all instances done ────────────────────────────────◀─┘
  │
  ├── currentAlerts = union of per-snap alerts
  ├── trustedInstances = { name : true } for fullyObserved snaps
  │
  ├── alertMgr.ReconcileWithObservation(ctx, currentAlerts, trustedInstances)
  │     │
  │     ├── snapshot DB active state via store.GetAllActiveAlerts()
  │     ├── diff: toInsert / toTouch / missing
  │     ├── filter toInsert: maintenance ▶ drop entirely
  │     │                   info       ▶ persist + queue digest, no notify
  │     │                   inhibited  ▶ persist, no notify
  │     │                   snoozed    ▶ persist, no notify
  │     │                   else       ▶ persist + notify
  │     ├── clean-check accounting on `missing`: skip if !trusted[instance]
  │     ├── store.InsertAlert(toPersist)
  │     ├── store.TouchAlerts(toTouch)         (rate-limited to once per 5m)
  │     ├── store.ResolveAlert(toResolve)     (after N consecutive clean cycles)
  │     ├── notify Slack / PD / webhook
  │     └── onStateChange() → SlackApp refreshes pinned dashboard
  │
  ├── for each snap:
  │     - alertMgr.ActiveAlertCountsForInstance(name)
  │     - promExporter.Update() with metrics + alert counts
  │     - store.RecordHealthSnapshot()
  │
  └── lastPoll.Store(now)   ← used by /health
```

Background loops running outside `runReconcile`:

- **Heartbeat** (`alerter.heartbeat`, every 5 min): `AutoResolveStale` sweep (resolves alerts with `updated_at` older than 24 h), refresh Slack message timestamps, escalation notices.
- **Digest scheduler** (`main.go`, every 1 min check): if current time matches `slack.digest.daily_time` / `weekly_day`, drain `infoBatch` + post Slack digest.
- **Schedules** (`internal/web/runs.go`): user-defined run-checks fire on cron and post results.

---

## Layer 1 — Collectors

Every collector implements `Collector` (`internal/collector/types.go`):

```go
type Collector interface {
    Name() string
    Collect(ctx context.Context, client *chclient.Client) (*CollectResult, error)
}
type CollectResult struct {
    Metrics  []Metric
    Alerts   []Alert
    Duration time.Duration
}
```

A collector is independent and stateless except where noted. It queries CH `system.*`, returns metrics + alerts, never writes anywhere directly. `runReconcile` drains the result and forwards both to the store and the alerter.

### Collector roster

| Collector | What it queries | Key metrics emitted (prefixes) | Alert categories | Notable fallbacks |
|-----------|-----------------|---------------------------------|------------------|-------------------|
| `SystemCollector` | `system.asynchronous_metrics`, `system.metrics`, `uptime()` | `system.memory.*`, `system.cpu.busy_percent`, `system.metrics.*`, `system.uptime_seconds` | `memory`, `cpu` | RSS: `MemoryResident` → `OSProcessRSSMemory` → `MemoryTracking`. CPU: `OSUserTimeCPU+OSSystemTimeCPU` (gated `>1.0` to ignore Altinity zero-counters) → `LoadAverage1 / CGroupMaxCPU`. Mem total: `OSMemoryTotal` → `CGroupMemoryTotal - RSS`. |
| `QueryCollector` | `system.processes`, `system.query_log` | `queries.running_count`, `queries.failed_5m`, `queries.timeouts_5m`, `queries.zombie_count`, `queries.repeated_pattern.count` | `queries` | Falls back to `SELECT count() FROM system.processes` when full processes query fails. Excludes timeout exception codes (159, 160, 394) from `failures_5m` to dedupe with `timeouts_5m`. |
| `TableCollector` | `system.parts`, `system.merges`, `system.mutations` | `tables.parts.{count, active, cluster_total, max_in_partition}`, `tables.partitions.{count, max}`, `tables.merges.active_count`, `tables.mutations.stuck_count`, `tables.disk_balance.*` | `tables` | `collectParts` returns cluster total to `collectMerges` so the merges-stalled alert only fires when there's actual backlog. |
| `StorageCollector` | `system.disks`, `system.parts`, `system.query_log` (S3 ProfileEvents) | `storage.disk.*`, `storage.distribution.*`, `storage.s3_latency_ms`, `storage.tier_movement_bytes` | `storage`, `s3` | Object-storage disks report `total_space=0`; capacity checks skipped for them. |
| `InsertCollector` | `system.query_log` (`query_kind='Insert'`), `system.metrics` (DelayedInserts), `system.events` (RejectedInserts) | `inserts.table.*`, `inserts.delayed.current`, `inserts.async.pending`, `inserts.rejected.total` | `inserts` | Uses `databases[1]/tables[1]` instead of `ARRAY JOIN` because MV adds extra entries to `tables[]` in CH 25.x. |
| `MVCollector` | `system.tables` (engine='MaterializedView'), `system.query_views_log` | `mvs.total_count`, `mvs.exists` | `mvs` | Per-MV failure detection only when `system.query_views_log` is populated. |
| `DictionaryCollector` | `system.dictionaries` | `dictionaries.{element_count, loading_duration_sec, bytes_allocated, loaded}` | `dictionaries` | — |
| `ReplicationCollector` | `system.replicas` | replication lag, queue, readonly, session expiry | `replication` | Silently empty on non-replicated instances. |
| `ErrorsCollector` | `system.errors`, `system.text_log`, `system.detached_parts` | per-error counters | `errors` | `system.errors.value` (CH 22+) → `times` (pre-22). `system.crash_log` may be missing → "no crash evidence". |
| `BackgroundPoolCollector` | `system.metrics` | `system.bg_pool.*_used_pct` | `bg_pool` | — |
| `CacheHealthCollector` | `system.query_log` ProfileEvents | `system.cache.{mark_hit_rate, uncompressed_hit_rate}` | `cache` | Gated on ≥100 samples in last 10 min to avoid false alerts on idle clusters. |
| `ConnectionsCollector` | `system.metrics` | `connections.{tcp, http, mysql, postgresql, interserver, total}` | — | Emits zeros for missing interfaces so charts don't drop. |
| `QueryLatencyCollector` | `system.query_log` | `queries.p{50,95,99}_ms` | `query_latency` | — |
| `FreshnessCollector` | `system.query_log` per-table last insert time | `tables.freshness.last_insert_ago_minutes` | `freshness` | CH 22+ array form (`databases[]/tables[]`) → pre-22 scalar columns. |
| `SchemaDriftCollector` | `system.columns` schema hash | drift indicators | `schema` | — |
| `ProjectionCollector` | `system.projection_parts` | projection staleness | `tables` | — |
| `TTLCollector` | `system.tables`, TTL clauses | TTL-enabled table count | `tables` | — |
| `AsyncInsertsCollector` | `system.asynchronous_inserts` (CH 22.3+) | async queue depth, age | `inserts` | Skipped on older CH that lacks the table. |
| `PartsAgeCollector` | `system.parts` min_block_number | oldest part age per table | `tables` | — |
| `SlowQueryFingerprintCollector` | `system.query_log` normalized hash | top slow query fingerprints | `queries` | — |
| `KeeperCollector` | `system.zookeeper`, `system.zookeeper_connection` | Keeper connection stats | `keeper` | Treat `NO_ZOOKEEPER`/`UNKNOWN_TABLE` as "not configured" (silent). `system.zookeeper_connection` missing on some versions. |
| `QuerySamplesCollector` | `system.query_log` | sampled queries → written to `ch_analyzer.query_samples` | — | This is the only collector that writes a separate table for downstream dashboards (Query Patterns, Tables tab, etc.). |
| `RestartCollector` | `uptime()`, **and reads back our own `ch_analyzer.metrics`** | `system.restart_detected=1` on detection | `system` | Compares current `uptime()` to last persisted `system.uptime_seconds` value — survives ch-analyzer process restarts. First-ever poll baseline-only (no alert). `system.crash_log` presence within ±10 min upgrades `restart` → `crashed`. |
| `K8sCollector` | Kubernetes API (not CH tables) | pod restarts, OOM, node pressure | `k8s` | Optional, gated by `cfg.K8s.Enabled`. |

### Why each collector is independent

Inside one instance's goroutine (`main.go`), all collectors fan out via a `sync.WaitGroup`. Each returns to its own slot in `allResults`; one collector's failure increments `errorCount` but doesn't block the others.

If `errorCount > 0` for an instance, `fullyObserved=false` for that snapshot. That single bool propagates to `trustedInstances`, which gates the alerter's clean-check accounting. **One flaky collector cannot auto-resolve real alerts on the rest of the system** — see [Reconcile loop](#layer-2--reconcile-loop--alerter).

### Thresholds

`internal/config/config.ThresholdsConfig` carries every numeric threshold. Defaults are in `config.go:DefaultConfig`. Operators override by:
- editing `config.yml`, or
- the dashboard's Threshold Editor → `POST /api/thresholds` writes `thresholds.json` and reloads the in-memory config.

---

## Layer 2 — Reconcile loop & alerter

`internal/alerter/alerter.go`. The alerter is the **only writer** to `ch_analyzer.alerts`.

### Reconcile algorithm (`ReconcileWithObservation`)

```
1. canonicalize dedup keys: if missing, derive {instance}:{category}:{title}.
2. dbActive = store.GetAllActiveAlerts()      ← fans out to every node
3. diff:
     toInsert = currentByKey \ dbByKey
     toTouch  = currentByKey ∩ dbByKey
     missing  = dbByKey \ currentByKey

4. for a in toInsert:
     if maintenance.IsInMaintenance(a.Instance) → drop entirely
     elif a.Severity == info → toPersist + infoBatch (no notify)
     elif inhibition.IsInhibited(a, ...)        → toPersist (no notify)
     elif snooze.IsSnoozed(a.DedupKey)          → toPersist (no notify)
     else                                       → toPersist + toNotify

5. for a in missing:
     if !trustedInstances[a.Instance] → skip (we can't tell if the alert
                                          really cleared or just wasn't observed)
     else cleanChecks[a.DedupKey]++
          if ≥ resolveCleanChecks (default 4): toResolve

6. for any key in currentByKey: cleanChecks[key] = 0  (reset)

7. writes:
     for a in toPersist: store.InsertAlert(a)   ← preserves first_seen_at and
                                                  bumps fire_count via priorFireStats
     if (now - lastTouched) >= 5m and toTouch:
        store.BulkTouchAlerts(toTouch); lastTouched = now
     for a in toResolve: store.ResolveAlert(a)
                         ack.ClearForDedupKey(a)
                         pagerduty.ResolveAlert(a)
                         webhook.Send(event="alert_resolved", a)

8. notifications (toNotify only):
     pagerduty.TriggerAlert(a) if a.Severity == critical
     webhook.Send(event="alert_firing", a)
     slack.UpdateInstanceMessage(a.Instance)   ← grouped per instance

9. if persists or resolves happened → onStateChange() → SlackApp pin refresh
```

### Key invariants enforced by code

1. **DB is single source of truth.** `cleanChecks` is in-memory and lossy on restart — alerts stay in DB across crashes. Re-fires after restart preserve `first_seen_at` and `fire_count` via `priorFireStats` (`store.go:478`).
2. **Reconcile is idempotent.** Re-running with the same `currentAlerts` does nothing (or one rate-limited touch).
3. **One row per dedup key per firing.** `dedup_key + created_at` define a single firing event. `BulkTouchAlerts` only touches the latest firing's latest version (`store.go:900-911`).
4. **Untrusted instances never auto-resolve.** A flaky collector emitting empty results does not vacuously resolve real alerts (`alerter.go:391-401`).
5. **Maintenance is total.** Instance in maintenance window → no DB row, no notify. Takes precedence over snooze, ack, inhibition.
6. **Info severity never notifies inline.** Goes to `infoBatch` only; drained by daily digest (`alerter.go:706`).
7. **Snooze persists; suppression only blocks notification.** Alert still visible in UI for audit trail.
8. **Ack auto-clears on resolve.** `ack.ClearForDedupKey(a)` runs at resolve time (`alerter.go:446`).

### Snooze / Ack / Maintenance / Inhibition

| Feature | Scope | Effect | Persistence |
|---------|-------|--------|-------------|
| **Maintenance** | Per-instance window (or `*` = all). Time-bounded. | Drops alert entirely (no DB, no notify). Auto-prunes on expiry lookup. | JSON file `/var/lib/ch-analyzer/maintenance.json`. |
| **Snooze** | Per-DedupKey, time-bounded. | Persist to DB (UI sees it) + skip Slack/PD/webhook. | JSON file `/var/lib/ch-analyzer/snoozes.json`. Auto-prunes on `IsSnoozed` check. |
| **Ack** | Per-DedupKey. | Persist + cleared automatically when alert resolves. | JSON file `/var/lib/ch-analyzer/acks.json`. |
| **Inhibition** | Rule-based (source → target on same instance). | Persist + skip notify. | Config only — no state. |

### Heartbeat (every 5 min)

- `AutoResolveStale`: resolve alerts with `updated_at < now - 24h` (covers restart-lost cleanChecks counters and stuck flapping conditions).
- Slack pin/instance message refresh (so "Updated:" stays current).
- Escalation: if a critical alert has been firing ≥ `escalation.NoticeAfter` without ack, post escalation thread; rate-limited to once per `RepeatEvery`.

### Circuit breaker (per instance)

`main.go:617-647`. After 5 consecutive cycles where every collector failed, enter 5-min backoff. While in backoff, skip all collectors but still emit `connectivityAlert` so the alerter doesn't auto-resolve real existing alerts on that instance. Counter resets on any successful collection.

---

## Layer 3 — Persistence

`internal/store/store.go` + `schema.sql`. Each registered CH instance hosts its own copy of the `ch_analyzer` schema. The Go store iterates per-instance via `Manager.ForEach` / `Manager.ForEachParallel`.

### Schema

`schema.sql` is the single source of truth for DDL. The Go code no longer runs DDL at startup — operators run `schema.sql` themselves on upgrade. The file ends with an idempotent migrations block (`ADD COLUMN IF NOT EXISTS` + `MODIFY TTL`).

| Table | Engine | Order / Partition | TTL | Owner of writes | Owner of reads |
|-------|--------|-------------------|-----|-----------------|----------------|
| `metrics` | MergeTree | `ORDER BY (instance, name, ts)` `PARTITION BY toYYYYMM(ts)` | **365 d** | `Store.InsertMetrics` ← all collectors via `runReconcile` | `Store.QueryMetrics{,Latest,Series}` ← `/api/instances/*/metrics`, `/api/overview` |
| `alerts` | ReplacingMergeTree(version) | `ORDER BY (dedup_key, created_at)` `PARTITION BY toYYYYMM(created_at)` | **none** (kept indefinitely) | `Store.InsertAlert`, `BulkTouchAlerts`, `ResolveAlert`, `BulkResolveStale`, `cleanupDuplicateActiveAlerts` ← only the alerter | `GetActiveAlerts`, `GetAllActiveAlerts`, `GetAlertHistory`, `priorFireStats` |
| `query_samples` | MergeTree | `ORDER BY (event_time, normalized_query_hash)` `PARTITION BY toYYYYMM(event_time)` | **365 d** | `QuerySamplesCollector` (direct `INSERT INTO ... SELECT FROM system.query_log`) | `/api/instances/*/query-{patterns,patterns-v2,samples,users,tables}`, advisor endpoints, Connections tab |
| `digest_snapshots` | MergeTree | `ORDER BY (instance, ts)` `PARTITION BY toYYYYMM(ts)` | 365 d | `Store.SaveDigestSnapshot` (after digest cycle) | `Store.GetDigestSnapshots` |
| `health_snapshots` | MergeTree | `ORDER BY (instance, ts)` | **30 d** | `Store.RecordHealthSnapshot` ← `runReconcile` after each cycle | `/api/instances/*/health-trend`, `/api/instances/*/slo` |
| `audit_log` | MergeTree | `ORDER BY (ts, instance, action)` | **90 d** | `Store.LogAction` ← `/api/maintenance/*`, `/api/alerts/{snooze,ack}/*`, alert resolve | `/api/audit` via `Store.GetAuditLog` (fans out across instances) |

### Dedup queries (the load-bearing ones)

**Active alerts — `GetActiveAlerts`** (`store.go:601-613`):

```sql
SELECT id, instance, severity, category, title, message,
       resolved, resolved_at, created_at, dedup_key, updated_at
FROM (
    SELECT id, instance, severity, category, title, message,
           resolved, resolved_at, created_at, dedup_key, updated_at
    FROM ch_analyzer.alerts
    WHERE instance = '<inst>'
    ORDER BY dedup_key, created_at DESC, version DESC
    LIMIT 1 BY dedup_key
)
WHERE resolved = 0
ORDER BY created_at DESC;
```

For each `dedup_key`, pick the latest firing event then filter unresolved. **No `FINAL`** because `BulkTouchAlerts` inserts a new version every cycle and unmerged parts pile up; `FINAL` would force a sync merge that can exceed the 10 s timeout, returning empty and showing 0 alerts in the UI for minutes.

**Alert history — `GetAlertHistory`** (`store.go:653-664`): same shape but `LIMIT 1 BY (dedup_key, created_at)` so distinct firings stay separate.

**Touch — `BulkTouchAlerts`** (`store.go:900-911`): `LIMIT 1 BY dedup_key` (not `(dedup_key, created_at)`) so we touch only the latest firing's row, not every historical ghost.

**One-shot data repair — `cleanupDuplicateActiveAlerts`** (`store.go:99-226`, runs on `Store.New`): finds dedup_keys with >1 unresolved firing across distinct `created_at` values (caused by old bugs that re-fired without resolving the prior row), inserts `resolved=1` versions for all but the latest. Idempotent.

### In-memory state lost on restart

| State | Where | What happens on restart |
|-------|-------|-------------------------|
| `cleanChecks[dedup_key]` | `alerter.go:80` | Reset to 0. `AutoResolveStale` sweep covers stuck alerts via 24 h `updated_at` cutoff. |
| `instanceTS[instance]` | `alerter.go:90` | Slack thread mapping reset; next alert posts a new message. SlackApp tries to recover from `slack-state.json`. |
| `lastTouched` | `alerter.go:88` | Reset → next reconcile touches all firing alerts at once (one-shot write spike). |
| `instanceFailures`, `instanceBackoff` | `main.go:417` | Circuit breaker resets, retries previously broken instances. |
| `infoBatch` | `alerter.go:97` | If app crashes mid-cycle, that day's digest is incomplete. |

Snooze / ack / maintenance survive restart **iff** the JSON state files exist; otherwise active suppressions are lost and alerts fire again.

---

## Layer 4 — HTTP API

`internal/web/`. The web server registers ~70 routes and serves an embedded React SPA.

### Anatomy of a route

| Class | Reads from | Examples |
|-------|------------|----------|
| **Our store** (DB-of-record for monitoring) | `ch_analyzer.*` | `/api/alerts/active`, `/api/alerts/history`, `/api/alerts/stats`, `/api/overview`, `/api/instances/*/metrics`, `/api/instances/*/health-trend`, `/api/audit`, `/api/instances/*/slo` |
| **Our query_samples copy** | `ch_analyzer.query_samples` | `/api/instances/*/query-patterns*`, `/api/instances/*/query-samples`, `/api/instances/*/query-users`, `/api/instances/*/query-tables`, advisor regression/unused/anti-pattern endpoints |
| **Live CH** | target instance `system.*` | `/api/instances/*/queries` (system.processes), `/api/instances/*/tables`, `/api/instances/*/disks`, `/api/instances/*/replication`, `/api/instances/*/parts-age`, `/api/instances/*/cache-stats`, `/api/instances/*/s3-stats`, advisor compression/schema/cardinality, all `/history/*` endpoints (system.query_log / part_log / metric_log), `/ch-logs` (system.text_log), `/api/query` (terminal) |
| **In-memory** | process state | `/health`, `/api/logs` (LogBuffer), `/api/maintenance`, `/api/alerts/snoozes`, `/api/alerts/acks`, `/api/notify/status`, `/api/collectors`, `/api/auth/*` |
| **Subprocess** | spawned `claude` CLI | `/api/auth/{status,login,callback,refresh}`, `/api/instances/*/{analyze,chat}` (Mode B fallback) |

### Route table (selected)

Full route table is in `server.go:217-360`. Highlights:

| Method | Path | Returns | Notes |
|--------|------|---------|-------|
| `GET` | `/api/overview` | `[{name, health_score, alert_counts, top_alerts, key_metrics, area_status, in_maintenance}]` | Reads `?stale_hours=N` (default 24, clamp [1,720]); filters alerts by `(now - updated_at) ≤ stale_hours`. |
| `GET` | `/api/alerts/active` | `[Alert]` | Optional `?instance=X`. Calls `Store.GetActiveAlerts` (`LIMIT 1 BY dedup_key`). |
| `GET` | `/api/alerts/history` | `[Alert]` | `?from`, `?to`, `?instance`, `?severity`, `?category`, `?limit`. Calls `Store.GetAlertHistory`. |
| `GET` | `/api/alerts/stats` | `{period_hours, total_fired, currently_firing, currently_firing_stale, resolved, critical, warn, avg_duration_secs, top_categories}` | `?stale_hours` honored end-to-end so the badge in the Activity Strip matches NodeCard counts. |
| `POST` | `/api/alerts/resolve` | `{status:"ok"}` | Body: `{dedup_key}`. Logs `audit_log`. |
| `POST` | `/api/alerts/resolve-stale` | `{resolved: N}` | Body: `{hours}`. Bulk resolve. |
| `POST` | `/api/force-poll` | `{status:"triggered"\|"already_queued"}` | Buffered chan capacity 1 → coalesces rapid clicks. Wakes the main poll loop immediately. |
| `GET` | `/health` | `{status, version, last_poll}` | `last_poll` from atomic `*time.Time` updated at end of `runReconcile`. |
| `GET` | `/api/instances/{name}/metrics` | `{points: [{ts,value}]}` | `?name`, `?from`, `?to`, `?points`. Time-series from `ch_analyzer.metrics`. |
| `GET` | `/api/instances/{name}/queries` | running queries from `system.processes` | Probes column availability per instance (`processesCols` map cached). |
| `GET` | `/api/instances/{name}/connections/sessions` | active sessions from `system.session_log` | Lazily probes table existence on first call (some operators don't enable session_log). |
| `GET` | `/api/instances/{name}/s3-stats` | `{volume_by_table, latency_by_table, latency_by_query, s3_disks, remote_tracked_*, inactive_bytes, detached_*, recent_removals, dropped_tables}` | Detects S3 disks via `system.disks` (`type IN ('s3','S3','ObjectStorage','object_storage') OR is_remote=1 OR object_storage_type≠'none'`). Surfaces orphan-bucket diagnostics. |
| `POST` | `/api/query` | `[{rows, elapsed, ...}]` per statement | Read-only validator (only `SELECT/SHOW/DESCRIBE/EXPLAIN/WITH/EXISTS`). 30s ctx, max 10k rows. Logs to query history. |
| `POST` | `/api/instances/{name}/analyze` | SSE stream | AI analysis (Claude API or CLI). |
| `POST` | `/api/instances/{name}/chat` | SSE stream | Agentic chat with 7 tools (see [Layer 6](#layer-6--integrations)). |
| `GET/POST` | `/api/thresholds` | `ThresholdsJSON` | Persists overrides to `thresholds.json` and reloads in-memory config. |

### Time conventions

- All `from/to` query params are Unix epoch seconds. `parseTimeRange` (default `now-1h`/`now`).
- `parseFromTo` formats them as `"2006-01-02 15:04:05"` for direct interpolation into CH SQL.
- `parseStaleHours` clamps `[1, 720]`, default 24 hours.

### Force-poll path

```
POST /api/force-poll
  └── handleForcePoll
        select case s.forcePollCh <- struct{}{}: "triggered"
              default                          : "already_queued"
                                                  ← chan capacity is 1
       
main loop:
  for {
    select {
      case <-ticker.C        : poll()
      case <-forcePollCh     : poll()
    }
  }
poll() = runReconcile() + lastPoll.Store(now)
```

### Stale-hours plumbing end-to-end

1. Browser localStorage `ch-stale-hours` (default 24).
2. `api.ts:staleHoursParam()` appends `stale_hours=N` to `/api/overview` and `/api/alerts/stats`.
3. Server `parseStaleHours(r)` reads + clamps it.
4. `handleOverview` filters alerts with `time.Since(updated_at) ≤ staleThreshold`.
5. `handleAlertStats` returns `currently_firing` (fresh) and `currently_firing_stale` separately.

Frontend isStale matches: `(now - updated_at) > staleHours * 3600`, with a guard that treats zero-time `updated_at` as fresh (matches Overview's fallback) so post-migration alerts don't disappear.

### Auth

OAuth via the bundled `claude` CLI (subprocess). `~/.claude/.credentials.json` (or `${CLAUDE_HOME}/...`) holds the token. Endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/auth/status` | Runs `claude auth status`, returns `{logged_in, email, raw}`. |
| `POST /api/auth/login` | SSE stream. Spawns `claude auth login` with `BROWSER=/usr/bin/echo`; emits the OAuth URL as `event: url`. PID stored in `s.authPid`. |
| `POST /api/auth/callback` | Browser pastes the localhost callback URL; the handler discovers the listening port via `ss`/`lsof` for the stored PID and proxies the GET. |
| `POST /api/auth/refresh` | If token within 5 min of expiry, calls Anthropic refresh endpoint and rewrites credentials.json. |
| `POST /api/auth/set-tokens` | Manual paste path. Accepts bare token (sets 24 h expiry) or full credentials JSON. Writes mode 0600. |

The frontend listens for the `ch:auth-expired` event (fired by `api.ts` on any 401) and opens a re-auth modal.

---

## Layer 5 — Frontend

`web/frontend/src/`. React + TypeScript + Tailwind + Recharts + CodeMirror 6, embedded into the Go binary via `go:embed`.

### App shell

`App.tsx`:

- `<StoreProvider>` → global state (zustand-style React context).
- Layout: fixed `Sidebar` (left), fixed `TopBar` (top), `<main>`, fixed `AIAnalysisPanel` (bottom-right unless on Analyzer/Terminal views), `CommandPalette` overlay, re-auth modal, toasts.
- Route resolution: `?view=` from URL → `viewRouting.resolveView` → renders `views[view]`.
- Keyboard: `Cmd/Ctrl+K` toggles palette, `?` navigates to `/guide`.
- Auto-refresh: `setInterval(_, refreshInterval*1000)`, only ticks when `document.visibilityState === 'visible'`. On visibility-restore, immediate tick.
- ChatAnalyzer is mounted once on first visit and kept alive (hidden when inactive) so chat sessions don't get reset by route changes.

### Store (`hooks/useStore.tsx`)

Persisted to `localStorage`:

| Key | Used by |
|-----|---------|
| `ch-theme` (dark/light) | TopBar, all views |
| `ch-dense` | Tables (compact mode) |
| `ch-stale-hours` | Overview, Alerts, Detail (and api.ts adds `?stale_hours=`) |
| `ch-chat-sessions`, `ch-active-chat` | ChatAnalyzer (cross-tab sync via `storage` event) |
| `ch-dashboard-layout` | Overview widgets |
| `ch-alerts-filter`, `ch-alert-saved-views` | Alerts |

URL-synced via `pushState`: `?view`, `?instance`, `?from`, `?to`, `?tab` (Explore only).

`view` history stack (up to 20 entries) backs `goBack()`. `setView` always pushes state; navigating from Overview → Detail → Detail (different instance) is two distinct history entries.

### Each view at a glance

| View | Purpose | Key API calls | Notable behavior |
|------|---------|---------------|------------------|
| **Overview** | Health-at-a-glance + alert summary + widgets | `api.overview()`, `api.alerts.{active,stats}`, `api.health()`, `api.slo()` | NodeCards use `instance.active_alerts` (server-filtered by `?stale_hours`). Alert Activity Strip uses `api.alerts.stats(24)` — same filter. |
| **Detail** | Per-instance deep dive: 5 tabs (Summary, Queries, Storage, Replication, History) | `api.alerts.active(instance)`, `api.alerts.history(instance)`, `api.queries`, `api.tables`, `api.disks`, `api.mvs`, `api.s3Stats`, `api.cacheStats`, `api.tableMemory`, `api.replication`, `api.maintenance.list`, history endpoints (lazy on tab open) | On instance change, all per-instance state slices are cleared **before** the new fetch (`useEffect [instance]` reset; loading skeleton renders during fetch). Restart chip shows `N restarts in 7d` from alert history. |
| **Alerts** | Triage queue (firing/stale/resolved) | `api.alerts.history({instance,severity,category,from,to})`, `api.alerts.{snoozes,acks}` | Stat cards read `allAlerts` (unfiltered) so numbers don't flip with filter changes. Firing list includes snoozed (with badge) so stat-card count matches list. |
| **AlertHistory** | Timeline of past firings | `api.alerts.history(time-range)` | — |
| **Explore** | 16-tab query analytics: Anti-patterns, Patterns, Samples, Query Log, Live, Connections, Users, Tables, Failures, Merges, Parts, MVs, S3 Latency, Insert Throughput, System Metrics, Disk I/O | `api.history.*`, `api.queries`, `api.advisor.*` | Empty-state fallbacks for old CH (e.g. `inferTablesFromQuery` regex when `tables[]` column missing). |
| **Compare** | Cross-instance diff | `api.compare.{tables,settings,metrics,timeline,queryStats,queryPatterns}` | Per-element AI button calls `/api/instances/X/analyze-element`. |
| **Advisor** | Recommendations (compression, regressions, unused tables, schema, cardinality, storage policy, anti-patterns) | `api.advisor.*` | Sections collapsed by default; lazy fetch on expand. |
| **Terminal** | Read-only SQL with charts | `api.terminal.execute(instance,query,limit,signal)`, `api.terminal.history()` | AbortController for cancellation. CodeMirror SQL mode + autocomplete. |
| **ChatAnalyzer** | Conversational AI per instance | `POST /api/instances/X/analyze-element` (SSE) | Mounted-once-kept-alive. Sessions in localStorage cross-tab sync. |
| **TableScanner** | Per-table inventory + partition pie | `api.tableScan`, `api.tablePartitions` | TableDetail modal on row click. |
| **CostExplorer** | Cost estimate per table | `api.cost(inst)`, `api.costOverview()` | — |
| **Maintenance** | CRUD on maintenance windows | `api.maintenance.*` | — |
| **RunCheck** | Manual collector dispatch | `api.runCheck(...)` | — |
| **AuditLog** | Audit trail viewer | `api.audit({from,to,instance,action})` | — |
| **ThresholdEditor** | Dashboard-side threshold tuning | `api.thresholds.{get,save}` | Posts updated config back to server which writes `thresholds.json`. |
| **AppLogs / CHLogs** | Stream app + CH text_log | `api.logs`, `api.chLogs(inst,...)` | Level + search filters. |
| **FeatureGuide** | What's-new + feature map + shortcuts | (no API) | `?` keyboard shortcut and TopBar `HelpCircle` icon both navigate here. |

### Stale handling on Detail

Local `detailStaleHours` (same key as Overview) splits unresolved alerts into Active (fresh) + Stale subsections. Restart-counter pulls from `alertHistory.filter(category='system' AND title startsWith 'ClickHouse restarted|crashed')` over the last 7 days.

### MetricChart

`components/MetricChart.tsx`. Drops series with empty or all-zero data so flatlined dummy zeros (e.g. RSS on managed CH builds that hide it) don't render. Optional `subtitle` + `seriesHelp` props provide hover tooltips per series — used on the Memory chart to explain Host Total / OS Available / CH RSS / CH Tracked.

### Auth re-flow

`api.ts` dispatches `ch:auth-expired` on any 401. `App.tsx` listener sets `authExpired=true`, opens re-auth modal in TopBar with two paths: paste callback URL or trigger new OAuth. Periodic `api.auth.status()` every 5 min catches expiry while idle.

---

## Layer 6 — Integrations

### Slack

`internal/slackapp/`. **Socket Mode** app — long-lived WebSocket so we don't need a public HTTPS endpoint for interactivity.

- **Bot token**: posts/updates messages, slash commands.
- **App-level token (`xapp-`)**: socket-mode handshake.
- **Pinned dashboard message**: built by `pinned.go`. One per channel. Updated in place on alert state-change. PinnedTS persisted to `.slack-state.json` so restarts don't double-pin.
- **Per-instance message**: one Slack message per instance, updated in place as alerts fire/clear/age. `instanceTS[instance]` map persisted alongside `pinnedTS`.
- **Slash commands** (`commands.go`): `/ch status`, `/ch alerts`, `/ch snooze`, `/ch unsnooze`, `/ch snoozed`, `/ch maintenance`, `/ch analyze`, `/ch refresh`, `/ch help`.
- **Interactive buttons** (`actions.go`): Snooze, Analyze, Acknowledge. Action debounce map prevents duplicate processing of the same click.
- **Severity routing**: critical → `immediate`, warn → `batched_5m`, info → `digest_only`. Implemented at notification dispatch (`alerter.go:529`).
- **Resolve message** (when all alerts on an instance clear): green ✅ all-clear post.
- **Daily digest** (`main.go`): info-severity drained from `infoBatch` once per day at `slack.digest.daily_time`.

### PagerDuty

`internal/alerter/pagerduty.go`. Critical-only.

- **Trigger**: only `SeverityCritical` from `toNotify`. Rate-limited to 1 fire / 5 min / `dedup_key`.
- **Payload**: `event_action: "trigger" | "resolve"`, `dedup_key`, `payload.{summary, source, severity, custom_details}`.
- **Resolve**: fires automatically when reconcile resolves the alert.

### Webhook

`internal/alerter/webhook.go`. Generic JSON to a configurable endpoint.

- **Auth**: `X-Webhook-Secret` header if `secret` configured.
- **Rate limit**: 5 min / `dedup_key`.
- **Payload**: `{event: "alert_firing"|"alert_resolved", instance, severity, category, title, message, dedup_key, fired_at, fire_count}`.
- **All severities** notify, including warn (PagerDuty is critical-only; webhook is the catch-all).

### Prometheus exporter

`internal/prometheus/exporter.go`. Prefix `ch_analyzer_`. Pre-registers known metrics (`knownMetrics` map) so `/metrics` is non-empty even before first poll. Names sanitized: `queries.running_count` → `queries_running_count`. Labels include `instance` plus per-metric extras (database, table, disk, severity, hash, user). Gauge values updated each cycle, snapshots cached per instance so concurrent updates don't tear.

### AI: analyze + chat

Two endpoints, two execution modes (direct API vs subprocess fallback).

**`POST /api/instances/{name}/analyze`** (`internal/web/analyze.go`)

1. `collectAnalysisContext` runs 8 CH queries in parallel (cluster status, disk, slow queries by duration / memory, inserts, merges, parts, errors). Mode-specific filtering (`full`, `slow-queries`, `parts-merges`, `inserts`, `errors`).
2. `buildAnalysisPrompt` formats context as JSON blocks; capped at 1 MB.
3. **Mode A** if `ANTHROPIC_API_KEY` set: direct Anthropic API streaming. **Mode B** otherwise: spawns `claude -p -` with prompt on stdin.
4. SSE response phases: `collecting` → `sending` → `streaming` → `done`. `auth_error` and rate-limit (429) detection cancels early.

**`POST /api/instances/{name}/chat`** (`internal/web/chat.go`) — agentic, tool-calling.

Mode A (direct API) loop:

```
loop:
  resp = anthropic.Messages.Create(history + tools)
  if resp.stop_reason != "tool_use": break
  for tool_use in resp:
    parallel: result = executeTool(tool_use.name, tool_use.input)
    history += {role:"user", tool_result: result}
final_stream = anthropic.Messages.Stream(history without tools)
```

Tools (`chatTools`):

| Tool | What it queries |
|------|-----------------|
| `execute_sql` | Read-only validator → CH live |
| `get_cluster_health` | system.metrics + system.replicas + uptime |
| `get_slow_queries` | system.query_log ordered by duration / memory |
| `get_error_patterns` | system.query_log type=Exception |
| `get_merge_stats` | system.merges |
| `get_parts_health` | system.parts |
| `get_insert_patterns` | system.query_log query_kind=Insert |

Mode B (CLI fallback): two-pass. Pass 1 asks Claude to produce a JSON query plan, Pass 1.5 executes, Pass 2 asks Claude for streaming analysis with results in context.

Mode B + MCP: ch-analyzer can serve as an MCP stdio server (`internal/web/mcp_server.go`). When configured, Claude CLI is launched with `--mcp-config` pointing at our binary, which then handles tool calls over JSON-RPC. Same 7 tools.

### OAuth

See [Layer 4 — Auth](#auth). Tokens in `~/.claude/.credentials.json`. Manual paste fallback for headless servers (set `CLAUDE_OAUTH_TOKEN` env or POST to `/api/auth/set-tokens`).

---

## Cross-cutting concerns

### Concurrency model

- One goroutine per instance per poll (via `Manager.ForEachParallel`).
- Inside that goroutine, one goroutine per collector (via `sync.WaitGroup`).
- Reconcile is serialized: only one `runReconcile` runs at a time (driven by ticker + force-poll chan).
- Store writes are independent per instance (no cross-node locking).
- `cleanChecks` map is guarded by `am.mu`.

### Time

- All wall-clock timestamps are local time on the ch-analyzer host (CH's `now()`).
- Frontend converts epoch seconds for display via `Date()`.
- `parseTimeRange` and `parseFromTo` handle epoch-seconds query params; default `now-1h`/`now`.
- `parseStaleHours` clamps `[1, 720]`, default 24.
- Auto-resolve cutoff: 24 hours since last `updated_at`.
- Touch rate limit: 5 minutes.
- Heartbeat: 5 minutes.

### Failure handling

| Failure | Effect |
|---------|--------|
| Single collector errors | Log warn, increment per-instance `errorCount`, `fullyObserved=false`, no auto-resolve for that instance this cycle. |
| All collectors fail for an instance | `instanceFailures[name]++`. After 5 → 5 min backoff. Emits `connectivityAlert` so existing alerts don't auto-resolve while we're blind. |
| `InsertAlert` fails | Log error, no in-memory mutation. Next cycle re-fires the same alert and retries the insert. |
| `TouchAlerts` fails | Debug log. `updated_at` not bumped → eventually picked up by `AutoResolveStale`; next touch retries. |
| `system.X` table missing on a CH version | Specific collector returns silently (dictionaries / replicas / async_inserts / session_log / remote_data_paths). Other collectors continue. |
| Web 401 | api.ts dispatches `ch:auth-expired` → re-auth modal. |

### Dedup invariants

- One row per (`dedup_key`, `created_at`, `version`). `ReplacingMergeTree(version)` collapses on merge.
- `LIMIT 1 BY dedup_key` (active) and `LIMIT 1 BY (dedup_key, created_at)` (history) are the canonical read shapes.
- `BulkTouchAlerts` only touches the latest firing's row.
- `cleanupDuplicateActiveAlerts` runs on startup to repair any historical ghosts from prior bug versions.

### What's NOT persisted

| Lost on restart | Recovery |
|----------------|----------|
| `cleanChecks` counters | `AutoResolveStale` 24 h sweep covers this. |
| Slack message timestamps | New messages posted (no in-place update) until SlackApp reloads from `.slack-state.json`. |
| Snooze / Ack / Maintenance | Optional JSON files (`/var/lib/ch-analyzer/{snoozes,acks,maintenance}.json`). If files don't exist, suppressions are lost and alerts fire again. |
| `lastTouched` rate-limit | Next reconcile touches all firing alerts at once. |
| In-flight chat sessions | Frontend persists to localStorage. |

---

## Reference appendices

### A. Collector → metric prefix

```
SystemCollector            system.async.*, system.memory.*, system.cpu.*,
                           system.metrics.*, system.uptime_seconds
QueryCollector             queries.*
TableCollector             tables.parts.*, tables.partitions.*, tables.merges.*,
                           tables.mutations.*, tables.disk_balance.*
StorageCollector           storage.disk.*, storage.distribution.*, storage.s3_*
InsertCollector            inserts.table.*, inserts.delayed.*, inserts.async.*,
                           inserts.rejected.*, inserts.small_insert_ratio,
                           inserts.pipeline_stalls
MVCollector                mvs.*
DictionaryCollector        dictionaries.*
ReplicationCollector       replication.*
ErrorsCollector            (per-error counters)
BackgroundPoolCollector    system.bg_pool.*
CacheHealthCollector       system.cache.*
ConnectionsCollector       connections.*
QueryLatencyCollector      queries.p50_ms, queries.p95_ms, queries.p99_ms
FreshnessCollector         tables.freshness.*
RestartCollector           system.restart_detected
QuerySamplesCollector      (writes ch_analyzer.query_samples directly)
```

### B. Alert categories used in dedup keys

`memory`, `cpu`, `queries`, `tables`, `storage`, `s3`, `inserts`, `mvs`, `dictionaries`, `replication`, `keeper`, `errors`, `bg_pool`, `cache`, `query_latency`, `freshness`, `schema`, `system` (restart), `k8s`.

Dedup-key shape: `{instance}:{category}:{specific_id}` (e.g. `prod:replication:lag:db.tbl`, `prod:tables:max_parts_per_partition`, `prod:system:restart:1714389600`).

### C. Schema retention

| Table | TTL | Approx volume |
|-------|-----|---------------|
| `metrics` | 365 d | ~1k rows/day (one point per metric per instance) |
| `alerts` | none | a few hundred to ~10k rows total |
| `query_samples` | 365 d | 10k–1M rows/day on busy nodes |
| `digest_snapshots` | 365 d | ~5 rows/day |
| `health_snapshots` | 30 d | ~300 rows/day |
| `audit_log` | 90 d | 10–100 rows/day |

### D. Useful files

| Concern | File |
|---------|------|
| Main poll loop / orchestration | `cmd/ch-analyzer/main.go` |
| Collector interface + helpers | `internal/collector/types.go` |
| Reconcile loop / alerter | `internal/alerter/alerter.go` |
| Snooze / Ack / Maintenance state | `internal/alerter/{snooze,ack,maintenance}.go` |
| Schema (single source of truth for DDL) | `schema.sql` |
| Persistence (alerts, metrics, audit) | `internal/store/store.go`, `internal/store/audit.go` |
| HTTP routes | `internal/web/server.go` |
| HTTP handlers (per concern) | `internal/web/{terminal,history,advisor,analyze,chat,cost,…}.go` |
| OAuth / auth | `internal/web/auth.go` |
| Frontend entry / routing | `web/frontend/src/App.tsx`, `web/frontend/src/hooks/{useStore,viewRouting}.ts` |
| API client | `web/frontend/src/lib/api.ts` |
| Slack app | `internal/slackapp/{app,commands,actions,pinned}.go` |
| PagerDuty | `internal/alerter/pagerduty.go` |
| Webhook | `internal/alerter/webhook.go` |
| Prometheus | `internal/prometheus/exporter.go` |
| MCP server | `internal/web/mcp_server.go` |

### E. End-to-end alert lifecycle (worked example)

Memory goes critical, then clears, with an ack and a process restart:

```
Cycle 1   SystemCollector emits dedup_key=prod:memory:os_used severity=critical
          Reconcile: not in DB → InsertAlert (first_seen_at=now, fire_count=1)
          Slack: post per-instance message; PagerDuty: trigger
          Webhook: event=alert_firing

Cycle 2   Same alert still firing → toTouch. lastTouched <5m ago → no touch.
          (Slack already updated; nothing to do.)

Cycle 6   lastTouched ≥ 5m → BulkTouchAlerts (updated_at bumped)

User acks alert via Alerts page → POST /api/alerts/ack
          AckStore.Add(dedup_key, "rohit"). Persisted to acks.json.
          On next reconcile, ack just suppresses re-notification (already
          fired); UI shows the green "Acked by rohit" badge.

Cycle 12  Memory drops to 70%; SystemCollector emits NO memory alert.
          Reconcile: missing. trustedInstances[prod]=true → cleanChecks++ (=1)

Cycle 16  cleanChecks==4 → toResolve → ResolveAlert
          ack.ClearForDedupKey, pagerduty.ResolveAlert, webhook event=resolved
          Slack: per-instance message updated showing all-clear

ch-analyzer crashes. Restarts.
          cleanChecks empty in memory. acks.json reloaded → ack store rehydrated.
          Reconcile reads DB → no active alert (resolved=1) → nothing to do.

Memory critical again.
          New row inserted. priorFireStats finds prior dedup_key with
          first_seen_at = original time, fire_count = 1.
          New row carries forward first_seen_at; fire_count = 2.
```

---

## Version & edition compatibility layer

`internal/chclient/capabilities.go` fingerprints each instance and caches the
result (6h TTL) on the per-instance `Client`:

- **Version** — parsed `version()` (`major.minor` used for gates).
- **Edition** — `cloud_mode` setting → OSS/Cloud, overridable via `mode:` in config.
- **Replicas / clusterAllReplicas** — probed; drives multi-node Cloud log reads.
- **Feature registry** — probe-based (not just version numbers): system-table
  inventory (`system.tables`), column inventory (`system.columns`), and live
  access probes (`system.zookeeper` is denied on Cloud, disabled when Keeper
  isn't configured). Probes are more robust than version gates because a table
  can be disabled or restricted independent of version.

Accessors: `client.Caps(ctx).Has(feature)`, `.LogTable("query_log")` (wraps in
`clusterAllReplicas('<cluster>', …)` only on multi-node), `.PickSQL(feature,
modern, legacy)`, `.Reason(feature)`.

Design rules:
- **Never hard-fail on a missing capability.** Gate, then skip + one-time log, or
  render a "not supported on ClickHouse X (edition)" state in the UI.
- **Detect once, reuse.** Collectors that hit version/edition-sensitive tables
  check `Caps()` instead of issuing a guaranteed-to-fail query every poll (e.g.
  the keeper collector short-circuits when `FeatureZookeeper` is unavailable).
- **Surface it.** `GET /api/instances/{name}/capabilities` + the Explore
  compatibility chip show detected version/edition and per-feature availability.

Testing: `--compat-check` (detect caps + run every collector, non-zero exit on any
hard error) is driven across the OSS version matrix by `scripts/compat-test.sh` /
`make compat-test` / `.github/workflows/compat.yml`, with golden capability
snapshots under `test/compat/golden/`.
