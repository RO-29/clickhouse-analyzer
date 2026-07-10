# CH-Analyzer Correctness Audit — Collectors, Analyzer, Client, Thresholds

Audited: 2026-07-10. Scope: `internal/collector/*` (28 files), `internal/analyzer/analyzer.go`,
`internal/chclient/{client,capabilities}.go`, `internal/web/thresholds.go`,
`configs/{ch-analyzer,suggestions}.yaml`, plus `internal/config/config.go` defaults (needed to judge
whether checks are live).

Verdict legend: **WRONG** = produces incorrect numbers or dead logic that silently never fires;
**MISLEADING** = right number, wrong interpretation/labeling; **HAND-WAVY** = arbitrary threshold with
no ClickHouse basis; **OK** = sound against real CH semantics.

---

## Summary table

| Collector / component | What it checks | Verdict | Key issue |
|---|---|---|---|
| system (system.go) | OS/CH memory, CPU, uptime | **WRONG** (CPU path) / MISLEADING (RSS) | `OSUserTimeCPU`/`OSSystemTimeCPU`/`OSIdleTimeCPU` don't exist as async-metric names (real: `OSUserTime`, per-core `OSUserTimeCPU0…`) → OSS CPU strategy is dead code; RSS falls back to `MemoryTracking` which is not RSS |
| queries (queries.go) | Long-runners, failures, timeouts, zombies, storms | MISLEADING | "Zombie" = any HTTP query >10 min, no disconnect evidence; failure counts miss `ExceptionBeforeStart`; concurrent count (initial-only) vs server `max_concurrent_queries` semantics |
| tables (tables.go) | Parts, partitions, merges, mutations, JBOD | **WRONG** (merges-stalled defaults) / MISLEADING | Default merges-stalled rule (expect ≥30 merges when ≥1000 parts) contradicts "critical at ≥20 merges" and false-fires on healthy clusters; per-table parts thresholds conflated with per-partition CH limits; "JBOD imbalance" uses raw bytes incl. S3/tiered disks |
| storage (storage.go) | Disk %, S3 latency, tier moves | MISLEADING / HAND-WAVY | S3 "avg latency" computed over only the 20 slowest queries; 5s/15s per-request S3 thresholds ~25–100× real S3 GET latency → never fires until meltdown |
| inserts (inserts.go) | Throughput, errors, small inserts, stalls, backpressure | **WRONG** (2 bugs) | 100% insert-stop can never fire the throughput-drop alert (`totalRows > 0` gate); `RejectedInserts` cumulative counter alerted as if instantaneous → permanent critical after any single lifetime rejection; rolling baseline divides 9 intervals of data by 10 |
| errors (errors.go) | system.errors, text_log, detached parts | MISLEADING | `value` is cumulative-since-restart but reported as "in the last hour"; count thresholds (≥5/≥10) applied to lifetime counters |
| replication (replication.go) | Lag, readonly, queue, parts_to_check | **OK** (best collector) | Correct use of `absolute_delay` vs `queue_size`; minor: metrics meaningless-but-harmless on Cloud SMT |
| mvs (mvs.go) | MV failures, timing, bloat, chains | **WRONG** (bloat) / MISLEADING (timing) | Bloat join `inner_t.uuid = mv.uuid` can never match (inner table has its own UUID) → dead; `BloatRatioWarn` config never used; "lag" threshold (5 min) applied to per-execution `view_duration_ms` p95 |
| async_inserts (async_inserts.go) | Flush failures, queue depth | **WRONG** | `status = 'ExceptionWhileFlushing'` / `'Flushed'` are not real enum values (real: `Ok`, `ParsingError`, `FlushError`) → error detection permanently returns 0 |
| background_pool (background_pool.go) | Pool saturation | **WRONG** | Queries `BackgroundMergesMutationsPoolTask/Size` (missing "And" — real name `BackgroundMergesAndMutationsPoolTask/Size`) and long-removed `BackgroundProcessingPool*` → merges-pool check dead on all modern CH |
| cache_health (cache_health.go) | Mark-cache hit rate, cache sizes | Half **WRONG** | Hit-rate math is correct (proper ProfileEvents-delta usage); but `MarkCacheBytes/Files`, `UncompressedCacheBytes` queried from `system.metrics` when they live in `system.asynchronous_metrics` → size metrics dead; config thresholds ignored |
| connections (connections.go) | Per-interface connection gauges | **OK** | Correct CurrentMetric names, correct gauge semantics |
| dictionaries (dictionaries.go) | Load status, empties | MISLEADING | `NOT_LOADED` is normal with lazy loading (`dictionaries_lazy_load=1` default) → false warns; "consecutive reload failures" config actually counts concurrently-unloaded dictionaries |
| freshness (freshness.go) | Insert gaps | HAND-WAVY + TZ hazard | 20-min gap flags any batch pipeline slower than 20 min; DateTime parsed as UTC regardless of server TZ |
| keeper (keeper.go) | ZK reachability, backlog, latency | Probe **OK**, stats **WRONG** | `system.zookeeper_connection` has no `outstanding_requests`/`avg_latency`/`max_latency` columns → backlog/latency checks silently dead |
| parts_age (parts_age.go) | Old unmerged parts | **WRONG** concept | Old active parts are the *normal end state* of merged, inactive partitions — not merge pressure; flags virtually every mature table (>5 parts, oldest >48 h) |
| projections (projections.go) | Parts missing projection data | OK-ish | Logic valid; noise-prone (legitimately unmaterialized history warns every poll) |
| query_latency (query_latency.go) | P95 vs yesterday baseline | OK / config-dead | Sound baseline design; `QueryLatencyThresholds` config exists but hardcoded 2×/3×/100ms/10 used instead |
| query_samples (query_samples.go) | query_log → local table ETL | OK | Correct watermarking, escaping, ProfileEvents access; TZ string round-trip self-consistent |
| restart (restart.go) | Uptime regression, crash detection | Restart **OK**, crash **WRONG** | `system.crash_log` has no `trace_str` column (real: `trace`, `trace_full`) → crash query errors → every crash reported as clean restart (warn, not critical) |
| schema_drift (schema_drift.go) | Column diffs between polls | **WRONG** (multi-instance) | Snapshot map keyed by `db.table` only, shared across instances → cross-instance overwrites produce false/missed drift on fleets; state lost on process restart |
| slow_query_fingerprint | Query storms | HAND-WAVY | Duplicates queries.go collectRepeatedPatterns with different arbitrary thresholds |
| ttl (ttl.go) | Stuck TTL mutations, stale TTL tables | HAND-WAVY + TZ | 14-day part age flagged without comparing to the actual TTL interval; DateTime parse assumes UTC |
| k8s (k8s.go) | Pod status/metrics | OK | Reasonable; restarts>5 arbitrary but harmless |
| analyzer (analyzer.go) | Anomalies, cross-alerts, health score | **WRONG** (2 majors) | Labeled metrics collapsed by name (last-write-wins) before anomaly detection → z-scores computed on interleaved per-table series; 3 of 4 cross-alerts reference metric names that don't exist → dead; query-pattern subsystem never populated |
| chclient/capabilities | Feature gating | OK design, **under-used** | `LogTable()`/`FeatureClusterLogs` (multi-replica cluster-wide log reads) implemented but no collector uses them → Cloud multi-replica data silently partial |
| web/thresholds.go | Threshold editor | MISLEADING | Exposes cache_health/query_latency/freshness/background_pool knobs that no collector reads — edits have no effect |
| configs | Defaults | Mixed | parts warn=1000 vs stated normal 500–1800 → constant warn; suggestions.yaml cites pre-23.6 defaults (150/300) while tables.go cites 3000 |

---

## 1. SystemCollector — `internal/collector/system.go`

**Claims:** memory/CPU utilization from `system.asynchronous_metrics` + `system.metrics`, uptime.

### 1.1 CPU "Strategy 1" queries non-existent metric names — WRONG (dead code)
`system.go:51-53` requests `OSUserTimeCPU`, `OSSystemTimeCPU`, `OSIdleTimeCPU`. Real ClickHouse
asynchronous metrics are `OSUserTime` / `OSSystemTime` / `OSIdleTime` (aggregate, ratio-per-interval)
and per-core variants suffixed with the core number (`OSUserTimeCPU0`, `OSUserTimeCPU1`, …). The
exact string `OSUserTimeCPU` matches nothing on any OSS build, so `total > 1.0` at `system.go:188`
is never true via this path and the collector always falls to Strategy 2. The comment at
`system.go:186-188` ("On Altinity builds these exist but return near-zero cumulative counters") is a
misdiagnosis — the names simply never matched. Additionally, `OSUserTime` et al. are *ratios
recomputed each async-metrics update*, not cumulative counters, so even the intended math
`(user+system)/(user+system+idle)` would only be valid because they share an interval — worth a
comment if fixed.

### 1.2 CPU "Strategy 2" (load1 / CGroupMaxCPU) — HAND-WAVY + version hazard
`system.go:193-204`. LoadAverage1 counts runnable **and** uninterruptible-IO tasks; dividing by CPU
limit is a coarse saturation proxy, not "CPU busy %", and it saturates at 100 (clipped) hiding
oversubscription depth. `CGroupMaxCPU` / `CGroupMemoryTotal` / `CGroupMemoryUsed` (`system.go:55-59`)
only exist on newer CH (24.x-era cgroup metrics); on 23.x these read 0 → on containerized 23.x with
no `OSMemoryTotal` you get **no CPU metric and no memory metric at all**, silently. The capability
layer does not gate any of this (it gates tables/columns, not async-metric names).

### 1.3 RSS fallback to MemoryTracking — MISLEADING
`system.go:102-113`: when `MemoryResident`/`OSProcessRSSMemory` are absent, `MemoryTracking`
(system.metrics) is stored as `system.memory.rss_bytes` and drives "ClickHouse RSS critically high"
alerts (`system.go:159-175`). MemoryTracking is CH's internal allocation accounting — it excludes
allocator slack/page cache, can drift, and is routinely 20–40% below true RSS. Alert text says "RSS"
regardless. Also `OSProcessRSSMemory` (`system.go:44`) is not a metric name I can find in any CH
release; the working name is `MemoryResident` on all modern OSS builds (attributing it to "Altinity"
at `system.go:45-46` is backwards but harmless).

### 1.4 CGroup memory derivation — OK reasoning, note
`system.go:115-130`: deriving available = limit − RSS is a defensible fix for
CGroupMemoryUsed-includes-page-cache; correctly guarded.

Thresholds (mem 80/90, RSS 85/95, CPU 80/95 — config.go:330-339) are sane production defaults.

---

## 2. QueryCollector — `internal/collector/queries.go`

**Claims:** long runners (system.processes), failures/timeouts (query_log), storms, zombies.

- `queries.go:41-55`: `is_cancelled = 0 AND is_initial_query = 1` — both columns exist. Fine.
- **Concurrency semantics** (`queries.go:72-84`): compares *initial, non-cancelled* query count to
  `MaxConcurrent` (default 100). CH's `max_concurrent_queries` counts all queries including
  secondary/distributed ones, so this undercounts relative to the server limit it name-drops.
  MISLEADING at the margin; fine as a heuristic.
- **Timeout codes** (`queries.go:250-323`): 159 TIMEOUT_EXCEEDED / 160 TOO_SLOW / 394
  QUERY_WAS_CANCELLED — correct codes, correct `type='ExceptionWhileProcessing'`. The exclusion of
  these codes from collectFailedQueries (`queries.go:208`) with the matching playbook is careful and
  correct. Good.
- **Missing event type — coverage gap**: every failure check in this repo filters
  `type='ExceptionWhileProcessing'` only. Queries rejected **before execution** — auth failures,
  syntax errors, UNKNOWN_TABLE (60), quota exceeded — log as `type='ExceptionBeforeStart'` and are
  invisible to `collectFailedQueries`, `collectTimeouts`, and `inserts.go collectInsertErrors`
  (inserts.go:276). An INSERT pipeline pointed at a dropped table produces zero alerts from the
  "insert failures" check. Significant blind spot.
- **Zombie queries** (`queries.go:328-391`): flags *any* HTTP-interface query with elapsed > 600 s as
  "client likely disconnected". There is no disconnect evidence available in system.processes; a
  legitimate 11-minute HTTP ETL query is called a zombie, and ≥3 of them are CRITICAL
  (`queries.go:383-385`). MISLEADING title/severity; the remediation text is good, the certainty is
  not warranted.
- **Query storm per user** (`queries.go:171-190`): threshold = WarnConcurrent/2 floor 5 — arbitrary
  but visible in the message. HAND-WAVY, acceptable.
- **Severity mapping**: >20 failures in 5 min → critical (`queries.go:222-224`) — arbitrary count,
  reasonable order of magnitude.
- **Timezone**: `EventTimeCond` (types.go:191-198) emits either server-side `now()` arithmetic or
  `toDateTime(<unix epoch>)` — both TZ-safe. Correct.
- **Perf note**: none of the query_log scans constrain `event_date`, so partition pruning of the
  monthly-partitioned query_log relies on event_time minmax indexes only; add
  `event_date >= today() - 1` for cheap wins on big logs.

---

## 3. TableCollector — `internal/collector/tables.go`

### 3.1 Parts thresholds vs CH limits — MISLEADING scope conflation
`collectParts` (tables.go:45-155) checks parts **per table** against warn 1000 / crit 3000
(config.go:347-348), while `parts_to_delay_insert` / `parts_to_throw_insert` are enforced **per
partition** (as the alert message at tables.go:104-106 itself says "default 3000 per partition").
A 12-month-partitioned table with 250 parts/partition (fine) trips "critical" at 3000 total. The
per-partition check that actually mirrors CH's limit exists separately
(`collectPartitionPressure`, tables.go:160-269, MaxPartsPerPartition=1000) and is correct — but the
per-table one fires with the same "parts_to_throw_insert" framing. Note also `countIf(active)` at
tables.go:54 is a no-op given `WHERE active` (always = count()).

Also: `configs/ch-analyzer.yaml:78` admits "your tables normally have 500-1800" parts — meaning warn
(1000) fires perpetually on this fleet's normal state. Alert fatigue by configuration.

`warn_per_partition: 300` (yaml:79, config `WarnPerPartition`) is parsed and exposed in the
thresholds API (thresholds.go:44) but **no collector reads it** — dead knob.

### 3.2 "Merges stalled" default thresholds are self-contradictory — WRONG defaults
tables.go:342-365 fires **CRITICAL** when `mergeCount < MinActiveWhenBacklog (30)` while
`clusterParts >= BacklogPartCount (1000)` (defaults config.go:357-358). But:
(a) `MaxActive = 20` makes ≥20 merges critical (tables.go:324) — so the "healthy" band demanded by
the stalled check (≥30 merges) is itself a critical condition. The two alerts cannot both be quiet
on a busy node.
(b) 1000 active parts instance-wide is a completely ordinary steady state (the yaml itself says
single tables run 500–1800 parts), and a healthy idle-ish node runs 0–5 merges. Result: this fires
critically on healthy clusters, permanently. The *idea* (low merges + growing backlog) is good;
the backlog signal must be part *growth* or per-partition pressure, not a static instance-wide
count, and MinActiveWhenBacklog must be ≪ MaxActive (e.g. 1–2).
(c) `validateThresholds` (thresholds.go:283-338) doesn't check any of this consistency.

### 3.3 Mutations "stuck" — HAND-WAVY
tables.go:369-421: any `is_done=0` mutation older than 30 min (config.go:361) alerts per-row.
`parts_to_do` progress is fetched but not used to distinguish "progressing slowly" (normal for a
multi-TB ALTER DELETE) from "stuck" (parts_to_do unchanged across polls). `latest_fail_reason != ''`
→ critical is the right signal; the time-only warn is noise on large tables. Also on
ReplicatedMergeTree, mutations appear on every replica — a fleet monitoring N replicas raises N
copies (dedup key includes instance, so N alerts).

### 3.4 "JBOD disk imbalance" — MISLEADING
tables.go:426-484: coefficient of variation over **raw bytes per disk_name** from system.parts.
(a) Comment claims "utilization percentages" (tables.go:464) but the math uses bytes — different-
sized disks legitimately hold different bytes.
(b) `disk_name` includes S3/object-storage disks: any hot/cold tiered setup (local + s3) trivially
exceeds 30% CoV and gets a bogus "JBOD imbalance" warn. Needs `system.disks.type`-based filtering to
local disks only. 30% CoV threshold is HAND-WAVY on top.

### 3.5 Cloud SharedMergeTree hazard
On Cloud SMT, every replica sees **all** parts of shared tables in system.parts. If a fleet config
registers multiple replicas of the same service as separate "instances",
`tables.parts.cluster_total` (tables.go:99) and all per-table counts are duplicated per instance —
"cluster total" is really "catalog total as seen from this node". Threshold interpretation also
flips: on OSS the count is per-replica; on SMT it's whole-table. Nothing gates this.

---

## 4. StorageCollector — `internal/collector/storage.go`

- Disk % math and the `total_space <= 0 → object storage` skip (storage.go:71-78) are fine;
  on versions where S3 disks report 16 EiB instead of 0 the used_pct rounds to ~0 — harmless.
  `free_space == 0 && total_space > 0` → "disk broken" (storage.go:95-101) also fires on a genuinely
  100%-full disk simultaneously with the disk-full critical — duplicate alerts for one condition.
- **S3 latency — sample-biased average, MISLEADING** (storage.go:140-203): the query takes the
  **top-20 queries by `S3ReadMicroseconds`** (`ORDER BY s3_read_us DESC LIMIT 20`, storage.go:155-156)
  and then reports "Avg S3 request latency across N requests" — that's the average over the *worst*
  20 queries, presented as an overall average. ProfileEvent names (`S3ReadMicroseconds`,
  `S3ReadRequestsCount`) are real. Note `S3ReadMicroseconds` sums wall time of possibly-concurrent
  requests, so per-request "latency" overstates under parallel reads.
- **S3 thresholds — HAND-WAVY**: warn 5 s / crit 15 s **per S3 request** (config.go:378-379,
  yaml:98-99 which mislabels it "p99"). Healthy S3 GETs are 20–200 ms; even a 10× S3 brownout
  (500 ms–2 s) never reaches warn. The check is effectively decorative.
- Tier movement via `system.part_log event_type='MovePart'` (storage.go:219) — valid enum value;
  graceful when part_log is disabled. `>50 moves in 10 min` info alert — arbitrary but info-only.

---

## 5. InsertCollector — `internal/collector/inserts.go`

### 5.1 Complete insert stop can never fire the drop alert — WRONG
inserts.go:126: `if avgRows > 0 && totalRows > 0` gates the throughput-drop computation. When
inserts stop entirely, `totalRows == 0` (a 100% drop — the worst case) and the alert is skipped.
Partial mitigation exists via collectPipelineStalls/Freshness, but the headline "Insert throughput
drop detected" alert cannot detect a full stop by construction.

### 5.2 Rolling baseline off by 10% — WRONG (minor)
inserts.go:102-114: window is `[now-10i, now-1i)` = **9 intervals** of data, divided by 10
(`count()/10`, `sum()/10`). Baseline systematically 10% low → drop% understated → less sensitive.

### 5.3 RejectedInserts: cumulative counter treated as current — WRONG (major)
inserts.go:421-450: reads `system.events WHERE event='RejectedInserts'` — a **cumulative
ProfileEvent since server start** — and raises **SeverityCritical whenever value > 0**. One
TOO_MANY_PARTS rejection at any point in the server's lifetime ⇒ a critical alert re-fired on every
poll (constant dedup key `...:inserts:rejected`, inserts.go:448) until the next CH restart. The code
comment (inserts.go:416-420, 426-428) acknowledges a rate is needed and claims the dedup key includes
"the rounded count so re-fires reset" — it doesn't. Needs previous-value delta (the collector already
persists metrics; RestartCollector shows the pattern) or query_log-based counting of code 252.
`inserts.rejected.total` as a raw metric is fine — it's the alert that's wrong.

### 5.4 DelayedInserts / PendingAsyncInsert — mostly OK, one label bug
inserts.go:367-414: `DelayedInserts` and `PendingAsyncInsert` are genuine CurrentMetrics (gauges) —
correct counter/gauge handling, and DelayedInsertsWarn=1 (config.go:367) is a defensible "any
throttling is notable" choice. But `PendingAsyncInsert` counts pending async insert *entries/queries*,
not rows — alert text "*N rows queued*" (inserts.go:403, 410) is MISLEADING, and the 100/1000
row-flavored thresholds were presumably sized for rows.

### 5.5 `databases[1]` / `tables[1]` attribution — MISLEADING
inserts.go:53-67 (and small-inserts, stalls, errors): `databases`/`tables` in query_log are **sorted
array sets**; `[1]` is the lexicographically first entry, not "the target table". An INSERT into
`zzz.events` that fans through MV target `aaa.agg` attributes everything to `aaa.agg`. The CH-25.x
array-length rationale in the comment is real, but first-element attribution mislabels per-table
metrics and alerts whenever MVs are involved.

### 5.6 Pipeline stall window — HAND-WAVY
inserts.go:202-258: "no inserts for 3× poll interval (=3 min default) though active in the last
hour" — any batch pipeline slower than one insert / 3 min warn-fires every cycle. Overlaps
freshness.go (20 min) with a noisier default. One of the two should own this signal.

### 5.7 PollingInterval hardcode
registry.go:388: `BuildCollectorFromConfig` pins `PollingInterval: 60s` regardless of
`cfg.Polling.Interval` — window math diverges from the actual cadence if operators change polling.

---

## 6. ErrorsCollector — `internal/collector/errors.go`

### 6.1 Lifetime counters presented as hourly — MISLEADING (the classic system.errors trap)
errors.go:47-58 + 120-127: `value` in system.errors is **cumulative since server start**;
`last_error_time > now() - 1h` only proves the *most recent* occurrence was within the hour. The
alert then says "*N serious error type(s)* detected **in the last hour**" and prints "×value"
(errors.go:120, 146) — e.g. a server up 90 days with 4,000 lifetime SOCKET_TIMEOUTs and one new
occurrence 5 minutes ago reports "SOCKET_TIMEOUT (×4000)" under an hourly framing. The thresholds
`cnt >= 5` critical / `cnt >= 10` warn (errors.go:122-124) are therefore thresholds on *uptime ×
error rate*, not on recency — long-lived servers alarm on trivia, freshly restarted ones stay silent
through real bursts. Correct approach: persist previous `value` per (name, code) and alert on delta
(the tool already writes metrics to ch_analyzer.metrics — same pattern as RestartCollector).

### 6.2 Rest of the collector
- `times` fallback (errors.go:54-58): I can find no CH release where system.errors used a `times`
  column (it shipped in 20.11 with `value`); harmless dead fallback.
- Benign-error suppression of Keeper "Bad version" CAS retries (errors.go:189-198) — correct and
  operationally wise.
- text_log Fatal/Critical scan (errors.go:203-266): correct levels, correct fallback when disabled;
  though the capabilities layer has `FeatureTextLog` and it is not consulted — string-matching on
  UNKNOWN_TABLE instead. Consistent theme (see §14).
- detached_parts (errors.go:272-359): `reason NOT IN ('', 'ignored')` correctly skips manual
  DETACHes and ignored parts; >10 → critical arbitrary but sane. `LIMIT 50` caps the count used in
  the severity/message ("N detached parts" is really "min(N,50)").

---

## 7. ReplicationCollector — `internal/collector/replication.go` — OK

The strongest collector. Correct semantics:
- `absolute_delay` (seconds behind) used for lag with warn/crit durations (30 s / 5 min defaults,
  config.go:382-384) — sane; distinct from `queue_size` (>1000 hardcoded, replication.go:148) used
  for backlog. Good separation of time-lag vs op-backlog.
- `is_readonly OR is_session_expired` → critical (replication.go:130-132, 158-172) — right check,
  right severity.
- `parts_to_check > 5` warn (replication.go:143-145) — reasonable.
- `log_max_index - log_pointer` clamped ≥0 as a metric (replication.go:123-127) — fine on OSS.
Notes: on Cloud SMT these columns are mostly 0/synthetic — metrics harmless, alerts stay quiet
(acceptable). 30 s lag warn can flap during large fetches after a node rejoin; batched warn routing
(yaml:132) absorbs this. The hardcoded 1000/5 values bypass the config-thresholds pattern used for
lag but are labeled in messages. No division hazards. UNKNOWN_TABLE guard unnecessary
(system.replicas always exists) but harmless.

---

## 8. MVCollector — `internal/collector/mvs.go`

- query_views_log gating via cached probe (mvs.go:45-67) — good pattern (though `FeatureQueryViewsLog`
  in capabilities.go:240 duplicates it and is unused here).
- Failures/timing queries (mvs.go:119-131, 173-186): correct status enum values
  (`ExceptionWhileProcessing`, `QueryFinish`) and correct column `view_duration_ms`.
- **Timing threshold semantics — MISLEADING**: mvs.go:212-218 compares p95 *per-execution duration*
  against `MV.LagWarn` = 5 min (config.go:390). "Lag" and "duration" are different quantities; a 5-min
  per-execution p95 would mean inserts blocked for 5 minutes — the alert can effectively never fire
  at a meaningful point, and the config name promises lag monitoring that doesn't exist.
- **Bloat check dead — WRONG**: mvs.go:230-243 joins `inner_t.uuid = mv.uuid AND inner_t.name LIKE
  '.inner_id.%'`. The inner table's *name* embeds the MV's UUID (`.inner_id.<mv_uuid>`) but its
  `uuid` is its own — two distinct tables cannot share a UUID, so the join returns 0 rows on every
  CH version. Silent (Debug log). Correct join: `inner_t.name = concat('.inner_id.', toString(mv.uuid))`.
  Consequently `mvs.target.*` metrics never emit and no bloat *ratio* is ever computed —
  `BloatRatioWarn` (config.go:391, yaml:111, thresholds.go:86) is a dead knob. PLACEHOLDER.
- **Chained-MV detection — HAND-WAVY**: mvs.go:274-287 substring-matches `mv2.name` inside
  `mv1.create_table_query`, same-database only. An MV named `events` matches any DDL mentioning
  "events". system.tables has real dependency columns (`dependencies_database/table`) the comment
  even mentions (mvs.go:272-273) but doesn't use. Info-severity so low blast radius.

---

## 9. AsyncInsertsCollector — `internal/collector/async_inserts.go`

**WRONG — flush-failure detection is dead.** async_inserts.go:37 (and registry.go:305):
`countIf(status = 'ExceptionWhileFlushing')` and `countIf(status = 'Flushed')`. The
`system.asynchronous_insert_log.status` enum is **`'Ok'`, `'ParsingError'`, `'FlushError'`** — the
strings used here have never been valid values, so `errors` ≡ 0 forever and "Async insert failures"
(async_inserts.go:74-93), the check whose whole justification is "failures here risk data loss",
can never fire. Same wrong value baked into the playbook (playbook.go:70-77). CH doesn't error on a
non-existent enum literal comparison against a String-typed... actually status is Enum8 — comparing
to an invalid literal raises an exception → depending on version this makes the *whole query fail*
each poll (caught at async_inserts.go:43-53 and logged as WARN, i.e. also no metrics at all). Either
way: dead.
- Queue depth via `count() FROM system.asynchronous_inserts` (async_inserts.go:96) — counts pending
  *insert chunks*, fine as a gauge; 50/100 thresholds arbitrary but plausible.
- Overlap: inserts.go collectIngestDelay also monitors PendingAsyncInsert with different (100/1000)
  thresholds and different alert text — two collectors, one condition, inconsistent numbers.

---

## 10. BackgroundPoolCollector — `internal/collector/background_pool.go`

**WRONG — main pool check dead on all supported versions.** background_pool.go:33-42 queries:
- `BackgroundMergesMutationsPoolTask` / `...PoolSize` — real CurrentMetrics are
  **`BackgroundMergesAndMutationsPoolTask` / `BackgroundMergesAndMutationsPoolSize`** (note "And").
  tables.go's own playbook (tables.go:353) uses the correct spelling — the two files disagree.
- `BackgroundProcessingPoolTask/Size` — the pre-21.6 pool, removed years ago; doesn't exist on any
  23.x+.
- `BackgroundFetchesPoolTask/Size` — correct.
Result: on modern CH only the fetches pool resolves; the merges/mutations pool — the one whose
saturation actually precedes TooManyParts — silently never computes (`size <= 0 → continue`,
background_pool.go:78-80). Registry metadata (registry.go:165-170) advertises the same wrong names.
Percent thresholds 70/90 are fine; also note task > size is possible transiently (queued tasks), so
clamp or document >100%. Also missing the modern `BackgroundCommonPoolTask/Size` and
`BackgroundMovePool*`.

---

## 11. CacheHealthCollector — `internal/collector/cache_health.go`

- **Hit-rate computation — OK, exemplary counter handling**: summing per-query ProfileEvents deltas
  from query_log over a fixed window (cache_health.go:41-48) is the *correct* way to rate a
  cumulative counter; min-traffic gate `total < 100` (cache_health.go:79-81) avoids idle noise;
  division guarded (cache_health.go:70).
- **Interpretation — HAND-WAVY**: <30% critical / <50% warn are not universally meaningful — cold
  scans, ad-hoc analytics, post-restart, and first-touch workloads legitimately run low mark-cache
  hit rates without any "regression". Warn maybe; critical is overreach.
- **Cache sizes — WRONG table**: cache_health.go:101-103 queries `MarkCacheBytes`,
  `UncompressedCacheBytes`, `MarkCacheFiles` from **system.metrics**; these live in
  **system.asynchronous_metrics**. Result set is empty every poll → `system.cache.*` size metrics
  never emit. Silent.
- **Dead config**: `CacheHealthThresholds` (config.go:397-401: 50/30/100) exist, are editable via
  the API (thresholds.go:92-96), and are ignored — collector hardcodes 30/50/100
  (cache_health.go:79,88,92).

---

## 12. ConnectionsCollector — OK
Correct CurrentMetric names, correct gauge semantics, zero-fill for missing interfaces
(connections.go:81-86) is thoughtful. No issues.

---

## 13. DictionaryCollector — `internal/collector/dictionaries.go`

- **NOT_LOADED ≠ broken — MISLEADING**: dictionaries.go:79-102 alerts on any status other than
  `LOADED`. With `dictionaries_lazy_load = 1` (the default), a dictionary that simply hasn't been
  queried since restart sits `NOT_LOADED` — healthy, by design. Also `LOADING` is a transient state
  that will warn if a poll lands mid-load. Should alert on `FAILED` / `FAILED_AND_RELOADING` /
  non-empty `last_exception`, and treat NOT_LOADED as info at most.
- **Config semantics drift**: `reload_fail_threshold: 3` documented as "*consecutive* reload
  failures" (yaml:107) but implemented as "≥3 dictionaries currently not LOADED in one poll"
  (dictionaries.go:119-125) — different quantity entirely; three lazy-unloaded dictionaries trip a
  CRITICAL "Multiple dictionaries failing to load".
- LOADED-but-empty warn (dictionaries.go:106-112): plausible heuristic; legitimately-empty sources
  will nag every poll (no suppression).

---

## 14. FreshnessCollector — `internal/collector/freshness.go`

- Core query (active in 24 h, quiet ≥20 min, >5 inserts/day) is a reasonable heuristic; the modern/
  legacy schema fallback (freshness.go:31-66) is fine (note: the "pre-22 scalar database/table
  columns" premise is dubious — query_log has had array `databases`/`tables` since ~21.x and never
  scalar `database`/`table` for the touched-tables concept — but the fallback only runs on error, so
  harmless).
- **Timezone hazard — WRONG on non-UTC servers**: freshness.go:113 parses `last_insert` with
  `time.Parse("2006-01-02 15:04:05", …)` which assumes **UTC**, then subtracts from local
  `time.Now()`. ClickHouse renders DateTime in the **server timezone**. On a server running e.g.
  Asia/Kolkata, `minutesAgo` is off by 330 min — either every stale table shows "no inserts for
  350 min" or (other direction) the metric goes negative-ish/clamped. Same bug pattern in ttl.go:66
  and query_samples.go:96/206 (query_samples is internally consistent since it round-trips the
  string, but the 7-day fallback vs server TZ can duplicate/miss a window on first run). The July-09
  session already fixed the same class of bug in the UI (`parseFromTo`/`chToDate`); the Go side
  still has it. Fix: `SELECT toUnixTimestamp(max(event_time))` or `time.ParseInLocation` with the
  server TZ from `SELECT timezone()`.
- Hardcoded 20 min / 5-inserts (freshness.go:46,45) duplicate the *existing* `FreshnessThresholds`
  config (config.go:408-411) which is editable via API (thresholds.go:103-106) and ignored — dead
  knobs, misleading UI.
- Batch pipelines with cadence >20 min false-fire daily. HAND-WAVY default, at least visible.

---

## 15. KeeperCollector — `internal/collector/keeper.go`

- Reachability probe + capability gate (keeper.go:40-96) — good: FeatureZookeeper is one of the few
  capabilities actually consumed by a collector; ACCESS_DENIED (Cloud) and NO_ZOOKEEPER handled.
- **Connection-stats check dead — WRONG**: keeper.go:99-105 selects `outstanding_requests`,
  `avg_latency`, `max_latency` from `system.zookeeper_connection`. That table (23.x+) has columns
  like name/host/port/index/connected_time/session_uptime_elapsed_seconds/is_expired/
  keeper_api_version/client_id — **no request-backlog or latency columns in any released version**
  (those live in Keeper's 4-letter-word `mntr`/`srvr` output, not in this table). The query errors
  → silently swallowed (keeper.go:107-111) → the "Keeper overloaded/backlog/latency" alerts
  (keeper.go:129-151) can never fire, and `keeper.connected_nodes` etc. never emit. Note
  registry.go:352-354 advertises the same phantom columns. Thresholds (500/100 outstanding, 500 ms)
  would be reasonable if the data existed.

---

## 16. PartsAgeCollector — `internal/collector/parts_age.go`

**WRONG concept.** Claim: "active parts not merged for a long time indicate merge pressure"
(parts_age.go:13-16). In real MergeTree life-cycle, parts stop being merged once a partition
reaches its merged steady state (or `max_bytes_to_merge_at_max_space_in_pool`); a month-partitioned
table's historical partitions will *always* contain parts with `modification_time` weeks/months old
— that's success, not pressure. The gates `part_count > 5 AND oldest_part_hours > 48`
(parts_age.go:46) plus alert tiers `>72 h & >10 parts` warn / `>168 h & >20 parts` critical
(parts_age.go:74-95) match essentially **every mature production table**, each firing a per-table
dedup-keyed alert every poll. "Parts this old indicate merges are disabled or severely behind"
(parts_age.go:79) is simply false as stated. A meaningful version would restrict to the *active
insert partition* or to partitions where small parts (< some size) coexist with merge eligibility.
Also duplicated verbatim as the second TTL check's engine (ttl.go:95-107) and in registry metadata
(registry.go:317-325).

---

## 17. ProjectionCollector — OK-ish
`has(p.projections, proj.name)` against active parts (projections.go:63-75) is valid (column exists
since projections GA). Caveats: parts predating a projection are *expected* to lack it until
MATERIALIZE — the warn (projections.go:100-119) renags every poll with no "is it shrinking?"
awareness; and query impact is overstated ("may fall back to full table scans" — CH just doesn't use
the projection for those parts). The investigate SQL references `system.projection_parts` — newer
table; fine as guidance. UNKNOWN_TABLE guard handles pre-projections versions; `FeatureProjections`
capability exists (capabilities.go:242) but is not consulted (string-match instead).

---

## 18. QueryLatencyCollector — OK design, dead config
- Baseline "same 2 h window yesterday" (query_latency.go:47-49) sidesteps time-of-day bias — good.
  Min-volume (`currentCnt < 10`) and min-baseline (100 ms) suppressions (query_latency.go:68) are
  the right guards; `baselineCnt` fetched but unused (query_latency.go:73) — baseline from 3 queries
  can still set the bar.
- Mixed query kinds in one quantile: a workload-mix shift (INSERT-heavy hour) reads as a latency
  spike. Acceptable for a coarse signal.
- **Dead config**: `QueryLatencyThresholds` (2×/3×/100 ms/10, config.go:402-407) editable via API
  (thresholds.go:97-102) but the collector hardcodes the same values (query_latency.go:68,78,86) —
  edits do nothing.

---

## 19. QuerySamplesCollector — OK
Correct incremental watermarking, batched escaped INSERTs, `is_initial_query=1`, self-exclusion of
ch_analyzer, LIMIT 10000 backpressure with catch-up. ProfileEvents.Names/Values access works via the
Map compatibility aliases on 22+ (and the indexOf guard covers absence). Minor: watermark uses `>`
on second-granularity event_time — rows sharing the max second collected in the same batch are safe,
but rows landing in that same second *after* the read are permanently skipped (rare, bounded loss);
TZ note as in §14 (self-consistent string round-trip, so low risk).

---

## 20. RestartCollector — restart OK, crash detection dead
- Uptime-regression detection with persisted baseline (restart.go:53-75) — sound, survives analyzer
  restarts, 1 s jitter tolerance, per-epoch dedup key (restart.go:98) is exactly right.
- Ordering race worth noting: if the storage writer persists this cycle's fresh (small) uptime
  before RestartCollector reads `previousUptime`, a restart could be missed; depends on pipeline
  ordering (collectors run before store-write in the poller — verify).
- **Crash detection — WRONG**: restart.go:160 selects `substring(trace_str, 1, 200)` from
  `system.crash_log`. crash_log columns are `trace` (Array(UInt64)) and `trace_full`
  (Array(String)) — **no `trace_str`**. The query errors, `detectCrash` returns `(false, "")`
  (restart.go:168-171), and every crash is downgraded to a clean-restart WARN with no crash summary.
  The embedded playbook (restart.go:229-231) repeats the phantom column. Use
  `arrayStringConcat(trace_full, '\n')`.

---

## 21. SchemaDriftCollector — WRONG for multi-instance fleets
State map `lastColumns` is keyed by `"db.table"` only (schema_drift.go:21,95) and one collector
instance serves *all* monitored CH instances (BuildCollector returns a singleton per name;
`initialized` is a single bool, schema_drift.go:83-90). With ≥2 instances: instance A's snapshot is
overwritten by B's every cycle; any schema difference *between* A and B is reported as "schema
changed" on every alternate poll (or masked). Must key by `client.Name() + db.table` (compare with
MVCollector's per-instance sync.Map, mvs.go:26). Also: state resets on process restart (silent
re-baseline — changes during downtime unseen); dropped tables aren't reported (only mutual keys
diffed, schema_drift.go:94-99). Type-only changes produce "column type changed" without naming the
column (diff strings include type so adds/removes cover it — fine).

---

## 22. SlowQueryFingerprintCollector — HAND-WAVY duplicate
Same query as queries.go collectRepeatedPatterns (5 min window, normalized_query_hash) with a second
set of arbitrary tier thresholds (>200 or >50&>5 s crit; >50 or >10&>30 s warn,
slow_query_fingerprint.go:84-98) vs the other's `HAVING cnt > 50 → info` (queries.go:420,451). Two
overlapping alerts, different severities, for one phenomenon. Column-existence fallback
(slow_query_fingerprint.go:56-63) is fine (normalized_query_hash exists 21.x+ anyway). Neither
excludes the monitoring user — currently below thresholds (each collector statement runs ~5×/5 min),
but dashboard-driven system.query queries could self-trigger.

---

## 23. TTLCollector — HAND-WAVY + shared TZ bug
- Stuck-mutation half (ttl.go:38-91): `command LIKE '%TTL%' OR command LIKE '%MODIFY%'` — the
  `%MODIFY%` arm catches *every* ALTER MODIFY COLUMN mutation, so this is really "any DDL-ish
  mutation older than 1 h", duplicating TableCollector.collectMutations (30 min) with different
  severities — the same stuck mutation raises two differently-worded alert streams. `oldest_create`
  parse assumes UTC (ttl.go:66) — same TZ bug as §14; on non-UTC servers `stuckHours` inflates by
  the offset (false criticals) or deflates (missed).
- Stale-TTL half (ttl.go:95-152): flags TTL tables with parts >14 d old without reading the actual
  TTL *interval* — a table with `TTL date + INTERVAL 90 DAY` legitimately holds 89-day-old parts.
  `create_table_query LIKE '%TTL%'` also matches column-name/comment coincidences. Warn-only at
  >30 d limits harm.

---

## 24. K8sCollector — OK
Correct OOMKilled detection via LastTerminationState (k8s.go:238-243); restart>5 warn arbitrary;
`RestartCount` is cumulative-since-pod-creation so the warn is permanent once crossed (no delta) —
minor counter-vs-gauge echo. Variable `cpuNano := cm.Usage.Cpu().MilliValue()` misnamed (it's milli)
but the emitted metric name is correct. Graceful degradation is good.

---

## 25. Analyzer — `internal/analyzer/analyzer.go`

### 25.1 Labeled metrics collapsed before anomaly detection — WRONG (major)
analyzer.go:84-92: `metricsByName[m.Name] = m.Value` keys by metric **name only**, discarding
labels. Per-entity series — `inserts.table.rows` (one per table), `queries.running.elapsed` (one per
query), `tables.parts.count` (one per table×disk), `replication.absolute_delay_sec`, etc. — collapse
to *whichever row iterated last*. The ring-buffer history (analyzer.go:155-206) then z-scores a
sequence of values from **different tables/queries each cycle**, and fires "Anomaly detected: rows
inserted per table" (metricMeta even has curated copy for these per-entity keys,
analyzer.go:488-493) based on noise. Every labeled-metric anomaly/sustained alert is statistically
meaningless. Fix: key history by name+sorted-labels, or restrict anomaly detection to unlabeled
aggregate metrics.

### 25.2 Cross-collector rules reference non-existent metric names — WRONG (dead)
analyzer.go:229-232, 276:
- `tables.total_parts` — never emitted (actual: `tables.parts.cluster_total`, tables.go:99) → the
  "Merges falling behind" rule reads 0, never fires. (It would also contradict tables.go's
  merges-stalled rule — one alarms on *many* merges, the other on *few*.)
- `storage.s3.avg_latency` — never emitted (actual: `storage.s3.avg_latency_ms`, storage.go:184);
  plus the comparison `> 5` was written for seconds while the real metric is ms → dead AND
  unit-confused.
- `inserts.rows_per_sec` — never emitted (actual: `inserts.total.rows` per interval) → "System
  overloaded" rule dead.
Only the OOM-risk rule (memory% + `system.metrics.Query`) is live. 3 of 4 cross-alerts are
PLACEHOLDER.

### 25.3 Query-pattern subsystem is dead — PLACEHOLDER
`a.patterns` (analyzer.go:54, 127-142) and `NormalizeQuery` (analyzer.go:361-367) are never written
to by anything — `GetQueryPatterns` always returns nil. (The regex would also mangle identifiers
containing digits, if ever used.)

### 25.4 Health score — HAND-WAVY but self-aware
computeHealthScore (analyzer.go:291-347): dedup by category+severity, −10 crit / −3 warn / −1 info,
cap 50. Consequences worth documenting: score can never go below 50 despite `if score < 0` code
(deduct capped first), so any UI band below 50 is unreachable; one critical in each of the ~12
categories scores identically to a full outage. Arbitrary, but bounded, documented in comments, and
harmless as a UX summary. The anomaly gate `anomalySignificant` (analyzer.go:454-463: min-delta 3 on
tiny baselines, ≥20% over mean) is a genuinely good guard against low-cardinality σ traps.

---

## 26. chclient — client.go / capabilities.go

- **client.go — OK.** UseNumber() for 64-bit ints (client.go:307-319), exception-in-body detection,
  epoch-based helpers. One operational gap: monitoring queries set no server-side
  `max_execution_time`; the HTTP client's 30 s timeout abandons the connection but the server keeps
  executing (exactly the zombie mechanism queries.go warns customers about). Heavy collectors
  (system.parts scans, clusterAllReplicas probes) should pass `max_execution_time` via
  QueryWithSettings.
- **capabilities.go — good design, poorly adopted.** Detection (table inventory, column inventory,
  zookeeper probe, cluster probe, edition via `cloud_mode`) is sound, with genuinely useful
  degradation reasons (capabilities.go:265-281). But:
  - `LogTable()` / `FeatureClusterLogs` (capabilities.go:123-132) — the mechanism that makes
    query_log reads cluster-wide on multi-replica Cloud — is used by **zero collectors**. Every
    query_log-based check (inserts, freshness, latency, failures, cache, samples…) sees only the
    connected replica on a scaled Cloud service; the caps layer even records this as "incomplete"
    (capabilities.go:277) and then nobody consumes it. Data is silently partial exactly where the
    tool claims Cloud support.
  - FeatureTextLog / CrashLog / QueryViewsLog / Projections / AsyncInsertLog exist but the
    corresponding collectors re-implement availability via error-string matching
    (`UNKNOWN_TABLE` contains-checks) — duplicated logic, and error-string matching breaks on
    localized/changed messages. Only KeeperCollector uses Caps().
  - Version notes: "system.projections needs CH 23.3+" (capabilities.go:242) — the table landed
    later (24.x); harmless since the gate is existence-based, but the Reason string shown in the UI
    is wrong.
  - `AtLeast`/version parsing fine; `capsTTL` 6 h fine.

---

## 27. web/thresholds.go

- **Phantom knobs — MISLEADING UI**: ThresholdsJSON exposes `background_pool`, `cache_health`,
  `query_latency`, `freshness` sections (thresholds.go:88-106) that round-trip into config, but the
  corresponding collectors are constructed with **no thresholds** (registry.go:402-428 "hardcoded
  thresholds — no config needed") and hardcode their own numbers. Users edit, save, see success, and
  nothing changes. Same for `parts.warn_per_partition` and `mv.bloat_ratio_warn` (dead consumers).
- **Validation gaps**: warn<crit checked only for 5 percent-pairs (thresholds.go:287-303). Not
  validated: S3 latency warn<crit, replication lag warn<crit, cache-health (inverted: warn should be
  > crit since lower is worse — the generic check would actually *reject* the correct configuration
  if it were included), merges MinActiveWhenBacklog vs MaxActive consistency (§3.2),
  LongRunningWarn < LongRunning ordering (queries.go:92-94 silently patches it instead).
- Atomic persist + mutex apply — fine.

---

## 28. Configs

**ch-analyzer.yaml**
- `parts.critical_count: 3000` with comment "your tables normally have 500-1800" (yaml:78) — so
  warn=1000 is *below the acknowledged normal range*: guaranteed steady-state warn noise.
- `s3.latency_warn: "5s"` commented "p99" (yaml:98) — implementation is a biased mean (§4), not p99,
  and the magnitude is ~25× a slow S3 GET.
- `queries.long_running_threshold: "1m"` — with warn defaulting to 30 s, any BI query >30 s warns;
  tight for analytics workloads but at least configurable.
- Missing keys (merges.min_active_when_backlog etc.) inherit the problematic defaults in §3.2 —
  operators reading this file never see the check that will page them.
**suggestions.yaml**
- `parts_to_delay_insert (default 150)` / `parts_to_throw_insert (default 300)` (yaml:101-102) —
  correct for ≤23.5, stale for 23.6+ (1000/3000); meanwhile tables.go:105 asserts "default 3000".
  Pick one story, ideally version-aware.
- `parts:` tip "OPTIMIZE TABLE {table} FINAL" as the second suggestion — on huge tables this is a
  footgun (rewrites everything, competes with the merge pool that's already behind); deserves the
  same caution the FINAL-avoidance tip (yaml:83) shows.
- JOIN advice ("smaller table on RIGHT") — correct for CH. Most other tips accurate.

---

## 29. Cross-cutting themes

1. **Silently-dead checks** (query errors swallowed as warn/debug logs, or enum/name mismatches
   returning 0): async-insert failures (§9), merges-pool saturation (§10), cache sizes (§11),
   Keeper backlog/latency (§15), crash detection (§20), MV bloat (§8), 3 of 4 cross-alerts and the
   pattern subsystem (§25). A monitoring tool's failure mode should be loud; recommend a
   startup-time self-check that runs each collector's SQL once and reports which returned
   errors/empty-by-construction.
2. **Counter vs gauge**: handled correctly in cache_health and DelayedInserts; handled wrongly in
   RejectedInserts (§5.3), system.errors counts (§6.1), K8s RestartCount (§24). No generic
   delta/rate infrastructure exists despite metrics being persisted.
3. **Timezone**: SQL-side windows are safe (server-side now(), epoch toDateTime); Go-side parsing of
   DateTime strings assumes UTC in freshness.go:113, ttl.go:66, query_samples.go:96 — wrong on any
   non-UTC server.
4. **Node vs cluster scope**: everything is per-connected-node. Correct for OSS per-replica
   monitoring; on Cloud multi-replica, *_log-based checks are partial (caps layer knows, collectors
   don't — §26) and system.parts-based totals double-count across monitored replicas of one SMT
   service (§3.5).
5. **Config-vs-code drift**: at least 8 exposed knobs do nothing (§27); two collectors duplicate the
   same check with different hardcoded thresholds (repeated-patterns ×2, pending-async ×2,
   stuck-mutations ×2, parts-age ×2).
6. **Div-by-zero / empty-result handling**: consistently guarded (mem/disk/cache/pool/error-rate/
   CoV) — no crashes found. getFloat(nil)=0 makes NULL quantiles benign.
7. **Alert-vs-playbook consistency**: genuinely good discipline — playbooks mirror alert windows and
   filters (queries.go:236-240, errors.go:339-343, freshness.go:141-158). Best practice in the
   codebase; undermined only where the playbook SQL itself references phantom columns
   (crash trace_str, async status values, background-pool names).
