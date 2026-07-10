# ch-analyzer Audit — Alerting Pipeline & Backend Web/API Layer

Auditor: expert ClickHouse operator/SRE review. All paths relative to `/Users/rohit/ch-analyzer`.
Scope: `internal/alerter/*`, `internal/web/*`, `internal/store/*`, `internal/prometheus/exporter.go`, `internal/slackapp/*`, `internal/config/config.go`, `schema.sql`, plus collectors/analyzer (traced to enumerate every alert) and `cmd/ch-analyzer/main.go` (adapter/reconcile wiring).

Verdict legend: **MEANINGFUL** (maps to real diagnosable CH problem, actionable) / **VAGUE** (fires but doesn't tell you the cause) / **COSMETIC** (info-noise) / **FP-PRONE** (will fire on healthy systems) / **BROKEN** (cannot fire, fires forever, or logic is wrong).

---

## A) PER-ALERT AUDIT TABLE

### system collector (`internal/collector/system.go`)

| # | Alert | Trigger (exact) | Real CH problem? | Cause clear? | Remediation? | FP risk | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | OS memory critically high / elevated | `(1-avail/total)*100 >= 90 / 80` (system.go:145-157); CGroup fallback derives avail from `limit - RSS` (system.go:115-130) | Yes — OOM-kill precursor | Yes, values inline | `memoryConsumersPlaybook` attached | Low; CGroup fallback is sane | **MEANINGFUL** |
| 2 | ClickHouse RSS critically high / elevated | `rss/total*100 >= 95 / 85`, rss from MemoryResident→OSProcessRSSMemory→MemoryTracking (system.go:102-113,159-176) | Yes | Yes | Playbook | Low | **MEANINGFUL** |
| 3 | CPU critically high / elevated | busy% ≥ 95/80; OSS path `(user+sys)/(user+sys+idle)`; Altinity fallback `load1/CGroupMaxCPU` (system.go:181-219) | Yes | Partially — the load-average fallback is *not* CPU% (I/O-wait inflates load); can misfire on disk-bound nodes | Playbook | Medium on cgroup builds | **MEANINGFUL** (fallback path FP-PRONE) |

### queries collector (`internal/collector/queries.go`)

| # | Alert | Trigger | Real problem? | Cause clear? | Remediation? | FP risk | Verdict |
|---|---|---|---|---|---|---|---|
| 4 | Maximum concurrent queries reached (crit) | `len(system.processes initial rows) >= 100` (queries.go:72-77) | Yes — near `max_concurrent_queries` | Yes | processesPlaybook | Low, though threshold is static, not read from server settings | **MEANINGFUL** |
| 5 | High concurrent query count (warn) | `>= 50` (queries.go:78-84) | Marginal | — | yes | Medium (50 concurrent is fine on big nodes) | **FP-PRONE** |
| 6 | Long-running queries (critical) | any query `elapsed >= 60s` default (queries.go:86-146) | Sometimes — 60s is *normal* for OLAP | Lists query_id/user/mem/SQL — good | Kill/playbook | High on analytics workloads (configurable, but default is aggressive; fires *critical* for one 61s query) | **FP-PRONE** |
| 7 | Long-running queries (warn) | `elapsed >= 30s` (queries.go:149-158) | Weak | same | yes | Very high | **FP-PRONE** |
| 8 | Full table scans | running query `read_rows > 1e9` (queries.go:128-168) | Sometimes (big legit aggregations read >1B rows) | Lists queries | fullScansPlaybook | Medium-high | **FP-PRONE** |
| 9 | Query storm detected | any user with `>= max(warnConcurrent/2,5)` concurrent queries (queries.go:170-190) | Marginal — 5 concurrent from one dashboard user is normal | Names user | Investigate SQL | High | **FP-PRONE** |
| 10 | Query failures: N in 5m | **any** `ExceptionWhileProcessing` in 5m (excl. 159/160/394) → warn; `>20` → crit (queries.go:194-245) | The *count* is real, but a single user typo fires a warn alert on a healthy cluster | Groups by exception_code only — no per-code names | Playbook with exact matching SQL (good) | Very high — this is the classic noise generator; no floor, no error-rate normalization | **FP-PRONE** |
| 11 | Query timeouts: N in 5m | any 159/160/394 in 5m → warn; any code >5 → crit (queries.go:250-322) | Timeouts are usually client-set `max_execution_time` working as intended | code names given | matching playbook (good) | High | **FP-PRONE** |
| 12 | Zombie queries | HTTP queries `elapsed > 600s`, warn; `>=3` crit (queries.go:328-391) | Real CH failure mode (no `cancel_http_readonly_queries_on_client_close`) but "client disconnected" is *assumed*, not observed | Yes + exact KILL statement and the server setting to fix — best remediation text in the codebase | Yes | Medium (legit long HTTP queries flagged) | **MEANINGFUL** but FP-tinged |
| 13 | Repeated query patterns (info) | pattern `>50×` in 5m (queries.go:407-455) | Advisory only | yes | caching/MV suggestions | n/a (info→digest) | **COSMETIC** |

### storage collector (`internal/collector/storage.go`)

| # | Alert | Trigger | Verdict / notes |
|---|---|---|---|
| 14 | Disk nearly full crit/warn | used% ≥ 90/80 per disk, object-storage disks skipped (storage.go:71-92) | **MEANINGFUL**. Correct S3 skip. |
| 15 | Disk may be broken or full | `free==0 && total>0` (storage.go:95-101) | **COSMETIC/redundant** — a 100%-full disk fires BOTH #14-critical and this, two rows for one condition (separate dedup keys `disk_full` vs `disk_broken`). |
| 16 | S3 latency critically high/elevated | avg `S3ReadMicroseconds/S3ReadRequestsCount` over top-20 queries in 5m vs thresholds **5s/15s per request** (storage.go:140-203; defaults config.go:377-380) | **BROKEN-by-default** — per-request S3 GET latency is 10-200 ms; a 5,000 ms warn threshold will never trip until S3 is essentially down. Also sampled only from the 20 highest-`s3_read_us` queries → biased mean. Real signal, dead thresholds. |
| 17 | High tier movement (info) | `>50 MovePart` in 10m (storage.go:234-239) | **COSMETIC**. |

### tables collector (`internal/collector/tables.go`)

| # | Alert | Trigger | Verdict / notes |
|---|---|---|---|
| 18 | Active parts at cluster ceiling (crit) | cluster active parts ≥ 30000 (tables.go:100-112) | **MEANINGFUL** capacity signal. But remediation text is wrong: "raising `merge_max_block_size`" does not reduce part count (it's rows-per-block during merge). |
| 19 | Too many parts: N tables critical/warn | per-table parts ≥ 3000 / 1000 (tables.go:114-152) | **MEANINGFUL** — the classic TooManyParts precursor, grouped per severity, good SQL. |
| 20 | Over-partitioned tables | > 1200 partitions/table (tables.go:213-238) | **MEANINGFUL** — correct diagnosis + PARTITION BY fix. |
| 21 | Partition near parts_to_throw_insert (crit) | any partition ≥ 1000 parts (tables.go:242-268) | **MEANINGFUL** — this is *the* proximate trigger of insert rejection; exact fix given. Best alert in the file. |
| 22 | Too many concurrent merges crit/warn | merges ≥ 20 / 10 (tables.go:324-336) | **FP-PRONE** — active merges are the system *healing itself*; 10-20 merges is routine on any node with `background_pool_size ≥ 16`. Penalizing merge concurrency contradicts alert #23. |
| 23 | Merges stalled while parts pile up (crit) | `merges < MinActiveWhenBacklog(30) && clusterParts >= BacklogPartCount(1000)` (tables.go:342-365; defaults config.go:354-359) | **BROKEN defaults.** (a) 1000 active parts cluster-wide is a *tiny, healthy* number (any prod cluster has thousands). (b) `MinActiveWhenBacklog=30 > MaxActive=20`: with ≥1000 parts you are **critical at every possible merge count** — <30 fires "stalled", ≥20 fires "too many merges". A cluster with default config and >1000 parts is permanently critical. The concept (pool starvation) is excellent; defaults make it a siren. Playbook SQL uses the correct `BackgroundMergesAndMutationsPoolTask` name, unlike the background_pool collector (see #35). |
| 24 | Stuck mutation detected | `is_done=0` older than 30 min; crit when `latest_fail_reason != ''` (tables.go:369-421) | **MEANINGFUL** — fail_reason surfaces the actual cause. Caveat: one alert **per mutation** with no LIMIT — a mutation storm creates an alert storm; 30 min is short for legit heavy mutations on big tables (warn ok, but flappy). |
| 25 | JBOD disk imbalance | coefficient of variation of bytes across `disk_name` > 30% (tables.go:426-484) | **FP-PRONE** — computed across *all* disks including different storage tiers (hot NVMe vs cold volume). Tiered-storage policies are imbalanced *by design*; alert should be restricted to disks within one volume. Permanent warn on every tiered deployment. |

### inserts collector (`internal/collector/inserts.go`)

| # | Alert | Trigger | Verdict / notes |
|---|---|---|---|
| 26 | Insert throughput drop | current-interval rows ≥50% below rolling avg (inserts.go:100-137) | **FP-PRONE** for bursty/batch pipelines (fires every quiet minute after a burst). Off-by-one: rolling window spans 9 intervals but divides by 10 (inserts.go:103-114) → baseline understated ~10%. Warn-only, tolerable. |
| 27 | Insert failures on db.table | any INSERT exception in interval; crit if error-rate ≥5% or (0 success && ≥5 fails) (inserts.go:263-345) | **MEANINGFUL** — rate-normalized, last exception text inline, per-table dedup. |
| 28 | Small insert anti-pattern | ≥10 inserts of <100 rows per table per interval (inserts.go:143-197) | **MEANINGFUL** CH advice. Caveat: workloads correctly using `async_insert` still log per-client INSERT entries with small `written_rows` → FP for people already doing the right thing. |
| 29 | Possible pipeline stall | table had inserts in last 1h but none in `3×poll_interval` (= **3 minutes** at default 1m poll) (inserts.go:202-258) | **FP-PRONE (severe)** — any pipeline that batches every 5-15 min alarms constantly. Redundant with FreshnessCollector (#44) which does the same at 20 min. The `thresholds.freshness.gap_minutes` config exists (config.go:237-240) but is **not wired to either collector**. |
| 30 | Inserts being delayed by ClickHouse | `DelayedInserts` gauge ≥ 1 warn / 50 crit (inserts.go:385-398) | **MEANINGFUL** — direct `parts_to_delay_insert` backpressure signal, correct metric, good playbook. |
| 31 | Async insert queue backed up/elevated | `PendingAsyncInsert` ≥ 100 warn / 1000 crit (inserts.go:400-413) | **MEANINGFUL** (message calls the value "rows"; metric counts pending inserts — minor). |
| 32 | INSERTs rejected (TOO_MANY_PARTS) | `system.events.RejectedInserts > 0` — **cumulative counter since server start** (inserts.go:421-450) | **BROKEN** — the counter never resets; after one rejection ever, this critical alert fires on *every* poll until CH restarts, and the clean-check path can never resolve it. The code comment admits a rate baseline is needed and alerts on the raw counter anyway. Needs delta-vs-last-poll. |

### async_inserts collector (`internal/collector/async_inserts.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 33 | Async insert failures | flush errors in 5m; crit if >10% or ≥5 (async_inserts.go:74-93) | **MEANINGFUL** — real data-loss risk. |
| 34 | Async insert queue deep/growing | `count() FROM system.asynchronous_inserts` > 100 crit / > 50 warn (async_inserts.go:96-117) | **MEANINGFUL**, but overlaps #31 (same condition from two sources, two dedup keys → double alerts). |

### background_pool collector (`internal/collector/background_pool.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 35 | Background pool near full | pool used% > 90 crit / > 70 warn (background_pool.go:74-99) | **BROKEN for the pool that matters** — queries metric names `BackgroundMergesMutationsPoolTask/Size` (background_pool.go:36-37); the real CH metric is `BackgroundMergesAndMutationsPoolTask/Size` (note "And"; tables.go:353 uses the correct name). `BackgroundProcessingPool*` was removed in 21.x. Only the fetches pool check can ever fire. The most important saturation alert in the product silently returns nothing. Thresholds also hardcoded — `thresholds.background_pool.*` config is used nowhere. |

### cache_health collector (`internal/collector/cache_health.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 36 | Mark cache hit rate low | hit-rate <30% crit / <50% warn with ≥100 lookups in 10m (cache_health.go:74-97) | **FP-PRONE / VAGUE** — cold caches after restart, ad-hoc scans, and first-touch of cold partitions all legitimately miss; "queries are doing full disk reads" overstates (OS page cache absorbs most). Hardcodes 30/50/100 — `thresholds.cache_health.*` config (config.go:397-401) is dead. Severity *critical* for a cache ratio is excessive. |

### dictionaries collector (`internal/collector/dictionaries.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 37 | Dictionary not loaded | `status != 'LOADED'` per dictionary; crit when `last_exception` set (dictionaries.go:79-102) | **MEANINGFUL** when exception present; **FP-PRONE** otherwise: dictionaries with `lazy_load` sit in NOT_LOADED forever by design and will warn permanently. |
| 38 | Dictionary loaded but empty | LOADED && element_count==0 (dictionaries.go:106-112) | **FP-PRONE** — legitimately empty sources exist; warn noise. |
| 39 | Multiple dictionaries failing | notLoaded ≥ 3 (dictionaries.go:119-125) | Inherits #37's lazy-load FP; escalates it to critical. **FP-PRONE**. |

### errors collector (`internal/collector/errors.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 40 | Serious ClickHouse errors (crit) | `system.errors` name ∈ serious list AND count ≥5 AND `last_error_time` in last hour (errors.go:45-165) | **MEANINGFUL with a counting flaw**: `value` is cumulative **since restart**, but the filter only requires the *last* occurrence to be recent — an error seen 500× last month and once just now reports "×500 in the last hour". Severity therefore inflated. Benign-Keeper-CAS filter (errors.go:189-199) is a genuinely good touch. |
| 41 | Repeated ClickHouse errors (warn) | cnt ≥10 OR serious ≥3 (errors.go:166-181) | Same cumulative-count flaw. **FP-PRONE**. |
| 42 | Fatal/Critical log entries | any `system.text_log` Fatal/Critical in 10m; crit if Fatal (errors.go:203-265) | **MEANINGFUL** — rare and always serious; matching playbook window. |
| 43 | Detached parts | `system.detached_parts` with real reasons; crit >10 (errors.go:272-358) | **MEANINGFUL** — correct integrity signal, ATTACH/DROP remediation, filter mirrors playbook. |

### freshness collector (`internal/collector/freshness.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 44 | Insert gap detected (per table / grouped >3) | >5 inserts in 24h AND none in 20 min (freshness.go:34-64,134-198) | Concept **MEANINGFUL**, but: fires for every ≥30-min batch cadence (**FP-PRONE**); duplicates #29 with a different threshold and dedup key (two alerts for one stalled pipeline); hardcoded 20min/5 — `thresholds.freshness` config dead; dedup key flips between `freshness:multiple_tables_stale` and `freshness:db.table` as the count crosses 3, churning alert history. |

### keeper collector (`internal/collector/keeper.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 45 | Keeper/ZooKeeper unreachable (crit) | connection-class errors probing `system.zookeeper` (keeper.go:76-91) | **MEANINGFUL** — top-tier CH failure mode, correct consequence text, capability-gated for Cloud (good). Category is `system`, so it cannot participate in a keeper→replication inhibition rule. |
| 46 | Keeper overloaded | `sum(outstanding_requests) > 500/100` from `system.zookeeper_connection` (keeper.go:99-142) | **BROKEN** — `system.zookeeper_connection` has no `outstanding_requests`/`avg_latency`/`max_latency` columns in any released CH; the query errors and the code silently returns (keeper.go:107-111). These alerts can never fire. |
| 47 | Keeper high latency | `max(avg_latency) > 500ms` (keeper.go:144-151) | **BROKEN** — same nonexistent columns. |

### k8s collector (`internal/collector/k8s.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 48 | Container restart count high | lifetime `RestartCount > 5` (k8s.go:147-152) | **FP-PRONE + BROKEN persistence** — restarts never reset, so it fires forever; and see below. |
| 49 | Container OOMKilled (crit) | last termination reason OOMKilled (k8s.go:156-163) | Real problem, but **BROKEN pipeline**: alerts carry `Instance: "k8s"` (k8s.go:148,158). `store.clientFor("k8s")` returns nil unless an instance is literally named "k8s" → `InsertAlert` fails every cycle (store.go:423-426), alert never persists, never appears in UI, PD triggers repeat every 5 min (rate-limiter floor) with **no resolve ever**, and the Slack path posts an "All Clear" for a phantom instance "k8s" (alerter.go:534-616). |

### mvs collector (`internal/collector/mvs.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 50 | Materialized view failures | per-view exceptions in 5m from `query_views_log`; crit >10 (mvs.go:118-165) | **MEANINGFUL**; probe-and-cache of the opt-in table (mvs.go:45-67) is well done. |
| 51 | Slow materialized view | p95 view duration > `mv.lag_warn` (default 5 min) (mvs.go:172-219) | **MEANINGFUL-ish**; a 5-minute p95 default means it almost never fires; conflates "lag" with per-execution duration. |
| 52 | Chained materialized view (info) | `mv1.create_table_query LIKE '%<mv2 name>%'` same DB (mvs.go:274-306) | **COSMETIC + FP** — substring match: an MV named `events` "chains" to everything mentioning "events". Info-only so harmless. |

### parts_age collector (`internal/collector/parts_age.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 53 | Cold parts (crit) | oldest active part >7 days AND >20 parts (parts_age.go:74-84) | **BROKEN premise** — ClickHouse never merges across partitions and stops merging once parts reach max size, so *any* partitioned table with history has years-old parts and >20 total parts. This fires **critical, permanently, on virtually every healthy partitioned table**. Old `modification_time` ≠ merge debt. |
| 54 | Stale parts (warn) | >3 days AND >10 parts (parts_age.go:85-94) | Same wrong premise. **FP-PRONE/BROKEN**. |

### projections collector (`internal/collector/projections.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 55 | Projection missing parts | active parts lacking projection data (projections.go:62-119) | **MEANINGFUL** — exact diagnostic SQL + `MATERIALIZE PROJECTION` fix. Minor: claim "queries may fall back to full table scans" — CH just doesn't use the projection for those parts; phrasing overstates. |

### query_latency collector (`internal/collector/query_latency.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 56 | Query P95 latency spike | current 30-min p95 vs same 2h window yesterday; ×2 warn, ×3 crit; gated on ≥10 queries and baseline ≥100 ms (query_latency.go:44-92) | **MEANINGFUL-ish / VAGUE** — decent anomaly gate, but workload-mix shift (one new heavy query) moves p95 without any server regression; message can't say *why*, playbook helps. Multipliers hardcoded — `thresholds.query_latency.*` config (config.go:402-407) dead. |

### restart collector (`internal/collector/restart.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 57 | ClickHouse restarted / crashed and restarted | `uptime()` regressed vs last stored `system.uptime_seconds`; crit if `system.crash_log` rows near boundary (restart.go:45-111) | **MEANINGFUL** — best-designed alert in the codebase: per-epoch dedup key so restarts never merge, crash evidence inlined, pre-restart forensic playbook bounded to the right window. |

### schema_drift collector (`internal/collector/schema_drift.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 58 | Schema changed: db.table | column-set hash differs from previous poll (schema_drift.go:92-133) | **BROKEN on multi-instance fleets** — `lastColumns` is keyed by `"db.table"` only, not by instance (schema_drift.go:21), and one collector instance is shared across all monitored nodes. Two instances with different schemas overwrite each other's baseline every cycle → perpetual false "schema changed" alerts ping-ponging between nodes. Fine on single-instance. Also: every intentional migration = warn alert. |

### slow_query_fingerprint collector (`internal/collector/slow_query_fingerprint.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 59 | Query storm / High-frequency pattern | crit: >200 exec/5m (= **0.67 QPS!**) or >50 & avg>5s; warn: >50/5m or >10 & avg>30s (slow_query_fingerprint.go:84-98) | **FP-PRONE** — 0.67 QPS of one pattern is normal app traffic, yet fires *critical*. Third overlapping "same query too often" detector (with #9 and #13), each with its own dedup key. |

### ttl collector (`internal/collector/ttl.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 60 | TTL mutation stuck/delayed | mutations `command LIKE '%TTL%' OR '%MODIFY%'` older than 1h; crit >8h (ttl.go:38-90) | `%MODIFY%` matches every `ALTER … MODIFY COLUMN` mutation — mislabeled as TTL; fully overlaps #24 (30-min stuck-mutation alert) → the same mutation raises two different alerts. **FP-PRONE/redundant**. |
| 61 | TTL may not be running | table DDL contains 'TTL' and oldest active part >30 days (ttl.go:95-151) | **FP-PRONE** — ignores the actual TTL interval; a `TTL date + INTERVAL 90 DAY` table legitimately holds 89-day-old parts; also inherits the parts_age "old parts are bad" fallacy, and `LIKE '%TTL%'` matches column-level TTL/names. |

### analyzer (`internal/analyzer/analyzer.go`)

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 62 | Anomaly detected: <metric> | last value > mean+2σ over 30-poll ring buffer + significance gate (analyzer.go:155-190,454-463) | **FP-PRONE / statistically unsound for labeled metrics**: `metricsByName` collapses labeled series to "last label wins" (analyzer.go:83-92) — e.g. `inserts.table.rows` mixes arbitrary different tables into one buffer, so mean/σ describe nothing. The significance gate and plain-English messages (analyzer.go:587-600) are good; the underlying series is garbage for any per-table/per-query metric. |
| 63 | Sustained elevated: <metric> | last 3 values > mean+1σ (analyzer.go:192-221) | Same series problem; also mean includes the elevated values (self-dampening). **FP-PRONE**. |
| 64 | OOM risk: high memory with many queries (cross, crit) | mem>85% && `system.metrics.Query`>20 (analyzer.go:233-245) | Plausible correlation; overlaps #1. **MEANINGFUL-ish**. |
| 65 | Merges falling behind (cross, crit) | `m["tables.total_parts"] > 300` (analyzer.go:248-259) | **BROKEN — can never fire.** No collector emits `tables.total_parts` (the actual metric is `tables.parts.cluster_total`, tables.go:99). |
| 66 | S3 contention (cross, warn) | `m["storage.s3.avg_latency"] > 5` (analyzer.go:262-273) | **BROKEN — can never fire.** Actual metric is `storage.s3.avg_latency_ms` (storage.go:184). |
| 67 | System overloaded (cross, warn) | `m["inserts.rows_per_sec"] > 100` (analyzer.go:276-288) | **BROKEN — can never fire.** No collector emits `inserts.rows_per_sec`. Three of the four cross-collector correlations are dead code. |

### main.go

| # | Alert | Trigger | Verdict |
|---|---|---|---|
| 68 | Instance unreachable (crit, connectivity) | 5 consecutive total collection failures; kept alive during backoff (main.go:656-673, connectivityAlert main.go:794-804) | **MEANINGFUL**. Note: category `connectivity` is missing from the Overview `categoryToArea` map (server.go:896-910) so it colors no area pill, and no inhibition rule uses it. |

### Verdict tally (68 alert types)

- **MEANINGFUL:** 24 (#1,2,3,4,12,14,18,19,20,21,24,27,28,30,31,33,34,40,42,43,45,50,55,57,64,68 — several with caveats)
- **VAGUE:** 2 (#36, #56)
- **COSMETIC:** 4 (#13,15,17,52)
- **FP-PRONE:** 26 (#5,6,7,8,9,10,11,22,25,26,29,37,38,39,41,44,48,51,53*,54,58*,59,60,61,62,63)
- **BROKEN (cannot fire / fires forever / wrong data):** 12 (#16 dead-threshold, #23 contradictory defaults, #32 cumulative counter, #35 wrong metric names, #46, #47, #48/49 k8s unpersistable, #53 wrong premise, #58 multi-instance clobber, #65, #66, #67)

---

## B) API SURFACE MAP (`internal/web/server.go:208-359`)

No authentication middleware exists anywhere (`registerRoutes` wraps only `recoveryMiddleware`, server.go:169). Every endpoint below — including arbitrary SQL execution, KILL QUERY, alert injection, threshold writes, and Claude OAuth token setters — is unauthenticated. Acceptable only behind a trusted network; worth an explicit note in docs or a token gate.

| Endpoint | Handler (file) | Purpose | Used by UI bundle? |
|---|---|---|---|
| GET /assets/, GET / | static/handleIndex (server.go:211-214) | SPA | yes |
| GET /api/instances | handleInstances (server.go:386) | list + health score | yes |
| GET /api/instances/{name}/metrics | handleMetrics (server.go:414) | metric series from store | yes |
| GET /api/instances/{name}/alerts | handleAlerts (server.go:456) | active/resolved alerts | yes |
| GET /api/instances/{name}/queries | handleQueries (server.go:503) | live system.processes | yes |
| GET .../connections, /connections/history, /connections/sessions | history.go:1370,1473; server.go:609 | connection stats, session_log | yes |
| GET .../tables, /disks, /mvs | server.go:752,794,827 | inventory | yes |
| GET /api/overview | handleOverview (server.go:857) | NodeCard triage summary | yes |
| GET /api/alerts/active, /api/alerts/history, /api/alerts/stats | server.go:1296,1125,1204 | alert views | yes |
| POST /api/alerts/resolve, /api/alerts/resolve-stale | server.go:1653,1684 | resolve one / bulk | yes |
| GET /api/logs, GET .../ch-logs | server.go:1452,1383 | app logbuffer / system.text_log | yes |
| POST /api/query, GET /api/query/history | terminal.go:229,378 | **SQL terminal** (keyword-allowlisted read-only, 30s/max_result_rows guard) | yes |
| GET .../alerts-at | terminal.go:390 | time-travel alerts | yes |
| GET .../s3-stats, .../s3-latency-by-table | terminal.go:599; s3_latency.go:22 | S3 profile events | yes |
| GET .../replication | server.go:1702 | system.replicas | yes |
| GET /api/compare/* (tables, query-stats, settings, metrics, metrics-timeline, query-patterns) | compare.go, metrics_timeline.go | cross-instance compare | yes |
| GET .../table-memory, .../cache-stats | compare.go:874,912 | memory/cache detail | yes |
| GET /api/suggestions/{category} | suggestions.go:254 | static suggestion content | yes |
| POST .../analyze, GET .../analyze/context, POST .../analyze-element, GET .../analyze-element/queries | analyze.go | AI analysis (SSE) | yes |
| POST .../chat | chat.go:1119 | agentic chat w/ tools | yes |
| GET .../table-scan | table_scanner.go:87 | full table scanner | yes |
| GET .../table-scan-debug | table_scanner.go:512 | debug variant | **NOT referenced in bundle — dead/debug endpoint, candidate for removal** |
| GET .../table-partitions | table_partitions.go:24 | per-partition detail | yes |
| GET .../advisor/* (9 endpoints) | advisor.go, advisor_*_antipatterns.go | advisors (see D) | yes |
| GET .../table-detail/{db}/{table} | advisor.go:797 | table drill-down (incl. fan-out to other nodes) | yes |
| GET .../health-trend | health_trend.go:13 | score history | yes |
| GET .../health-check, .../capabilities | history.go:84; capabilities.go:15 | deep health, compat panel | yes |
| GET .../query-patterns, query-patterns-v2, query-pattern-timeline, query-samples, query-pattern-overview, query-users, query-tables | history.go | Datadog-style query monitoring | both v1 and v2 referenced; v1 kept for older views |
| POST .../kill-query | server.go:708 | KILL QUERY (query_id charset-validated) | yes |
| GET .../history/* (failures, merges, mvs, inserts, s3, async-metrics, disk-io) | history.go | historical panels | yes |
| GET .../cost, GET /api/cost | cost.go:108,296 | Altinity cost explorer | yes |
| GET /health | health.go:26 | liveness + per-instance status | yes (also ops) |
| GET/POST /api/auth/* (status, login, callback, refresh, set-tokens) | auth.go | **Claude CLI OAuth management** — unauthenticated token set/refresh endpoints; highest-risk surface in the file | yes |
| GET/POST/PUT/DELETE /api/maintenance[/{id}] | maintenance.go | maintenance windows | yes |
| GET/POST/DELETE /api/alerts/snooze* | snooze.go | snoozes | yes |
| GET/POST/DELETE /api/alerts/ack* | ack.go | acks | yes |
| GET /api/notify/status | notify_status.go:19 | channel config status (URL masked) | yes |
| GET /api/collectors, POST /api/run-check | runcheck.go:49,54 | ad-hoc collector runs | yes |
| POST /api/alerts/trigger | runcheck.go:202 | **inject arbitrary alert row** — bypasses alerter (no notify/inhibition), unauthenticated; test hook exposed in prod | referenced in bundle |
| POST /api/force-poll | runcheck.go:250 | immediate poll | yes |
| GET/POST/DELETE/PUT /api/schedules* | schedule.go | scheduled checks | yes |
| GET /api/audit | audit.go:14 | audit log | yes |
| GET .../anomaly-context | anomaly_context.go:21 | ring-buffer stats | yes |
| GET .../slo | slo.go:22 | SLO report | yes |
| GET/POST /api/thresholds | thresholds.go:273,342 | threshold editor | yes |

Dead-endpoint candidates: `GET .../table-scan-debug` (not in bundle). `POST /api/alerts/trigger` should be dev-gated. `/api/query-patterns` (v1) is superseded by v2 but still referenced.

---

## C) ALERTING PIPELINE CORRECTNESS

### Architecture (sound parts first)
`Reconcile` (alerter.go:272-553) is a clean diff-against-DB design: DB is source of truth, inserts retry naturally on failure (alerter.go:413-426), clean-check counters (default 4 clean polls) gate resolution, `ReconcileWithObservation` correctly skips clean-checks for instances with partially failed collection (alerter.go:281-296, main.go:739-750) — this prevents flaky-collector auto-resolves. `AutoResolveStale` 24h sweep (alerter.go:639-656) is a sensible ghost-buster. Test coverage of these paths exists (alerter_test.go:389-676).

### Bugs and logic errors

1. **`fire_count`/`first_seen_at` are written but never read back.** `store.GetActiveAlerts` SELECTs neither column (store.go:601-613; same in `GetAlertHistory` store.go:653-664), so every rehydrated alert has `FireCount=0`, `FirstSeenAt=zero→CreatedAt`. Consequences: Slack "×N" repeat counter is always suppressed (`projectActiveAlert` count fallback = 1, alerter.go:828-844; formatAlertLine alerter/slack.go:432-440), webhook `fire_count` is always 1, and "Firing Since" reflects the latest re-fire, not the true first occurrence. The whole carry-forward machinery in `InsertAlert` (store.go:439-455) is write-only.

2. **PagerDuty incidents leak.** `pagerduty.ResolveAlert` is only called from the clean-check resolve path (alerter.go:452-457). Alerts resolved by (a) the 24h stale sweep (`AutoResolveStale`, alerter.go:648-655), (b) the UI `POST /api/alerts/resolve` (server.go:1653-1681), or (c) bulk resolve-stale (server.go:1684-1699) never send a PD resolve → open PD incidents forever. Same for webhook `alert_resolved` events. The documented webhook event `"all_clear"` (webhook.go:35) is never emitted anywhere.

3. **Escalation ignores ack/snooze/severity-change.** `heartbeatTick` escalates any instance with non-info active alerts after 30 min (alerter.go:673-703) without consulting `ackStore` or `snoozeStore`. Clicking "✅ Acknowledge" in Slack (slackapp/actions.go:91-125) therefore does **not** stop the "firing for N minutes with no response" notices — precisely what an ack is supposed to do. `instanceFirstFired`/`lastEscalated` are in-memory only, so a process restart resets escalation timers.

4. **Slack "Snooze" is actually a maintenance window, and it can't silence an active alert.** The escalation notice's Snooze 1h/4h buttons (alerter/slack.go:271-286) route to `doSnooze` → `maintStore.Add` (slackapp/commands.go:374-389). Maintenance only filters *new inserts* (alerter.go:346-352); the already-firing alert stays active, keeps updating the instance message, and keeps escalating. Meanwhile new alerts during the window are **dropped entirely — no DB row, invisible to the UI** — unlike the web snooze (persist-but-silent, alerter.go:373-380). Two features named "snooze" with three different semantics.

5. **Web snooze also does nothing for already-firing alerts**: `IsSnoozed` is only consulted in the `toInsert` branch (alerter.go:374). Snoozing an active alert changes nothing until it resolves and re-fires.

6. **Inhibition — rules are plausible but the mechanism is one-shot.** Rules (inhibition.go:55-88): memory:critical→queries:warn/info and cpu:warn (real: memory pressure slows queries — OK); replication:critical→tables:warn (defensible: broken replication ⇒ queue/merge backlog ⇒ parts); storage:critical→inserts:warn (real: full disk ⇒ insert failures). Missing the *strongest* CH causal chain — Keeper down ⇒ replication readonly ⇒ insert failures — and it can't be expressed because keeper alerts use category `system` (keeper.go:82). Mechanically: inhibition is evaluated only at insert time (alerter.go:363-371); if the symptom fires one poll before the root cause, both notify; when the source resolves, inhibited alerts are never re-notified. Instance-scoping (inhibition.go:33-35) is correct.

7. **Merges-stalled default contradiction** (see alert #23): with default thresholds a cluster holding ≥1000 active parts is critical at every merge count. config.go:354-359 vs tables.go:324-336.

8. **`store.Store.alertSeq` resets on restart** (store.go:58,432) — alert `id`s repeat after every process restart. IDs aren't in the CH ORDER BY key so no data loss, but UI/API `id` is not unique across restarts.

9. **RefreshAlerts write amplification on the monitored cluster.** Every rate-limited refresh runs one `INSERT…SELECT` per alert per *registered instance* (`BulkRefreshAlerts` loops `manager.ForEach` inside the per-alert loop, store.go:936-961; same broadcast in `BulkTouchAlerts` store.go:913-918). With 20 alerts × 5 instances that's 100 tiny inserts into a ReplacingMergeTree every 5 minutes — the monitoring tool commits the small-insert anti-pattern it alerts users about (#28), on the production cluster it monitors.

10. **`handleTriggerAlert` bypasses the pipeline** (runcheck.go:202-246): writes directly to the store — no inhibition, no maintenance check, no notification. Unauthenticated alert injection into the incident stream.

11. **Audit log broken for system-wide actions.** `LogAction` comment says "If instance is empty, writes to the first available instance" but `clientFor("")` returns nil (store/audit.go:33-37; store.go:239-241), so every call with `instance=""` — `alert_resolve_stale` (server.go:1697), `threshold_update` (thresholds.go:370), `snooze_delete`, `ack_delete`, `maintenance_delete` — errors and is swallowed (`_ =` / Debug). Those actions are never audited.

12. **Race/consistency nits:** `RateLimiter.Allow` consumes the budget even when the subsequent send fails (ratelimit.go:27-35) — a failed PD/webhook call blocks retries for 5 min. `maintenance.saveToFile` writes with `os.WriteFile` (maintenance.go:186) while snooze/ack use atomic tmp+rename — inconsistent; crash mid-write can corrupt the maintenance persist file. Severity escalation of an existing dedup_key (warn→critical) lands in `toTouch`, not `toInsert` → no notification, no PD trigger, Slack message updates only via 5-min heartbeat and DB severity only via rate-limited refresh (alerter.go:312-318,428-439).

13. **Flapping:** a condition flapping faster than 4 clean polls never resolves (counter reset at alerter.go:406-409) — by design, but combined with #2, a flapping critical produces repeated PD triggers (one per re-insert after each eventual resolve) throttled only by PD's own 5-min limiter. There is no hysteresis on the firing side (a single poll over threshold inserts + notifies immediately). Asymmetric: 1 poll to fire, 4 to clear — reasonable, but 30s-long-running-query type alerts (#6/7) flap hard against it, churning alert history rows.

---

## D) ADVISOR AUDIT

### advisor.go
- **Compression (advisor.go:30-112):** "ratio < 2 ⇒ Poor compression, consider ZSTD" — directionally fine as generic advice (LZ4 default vs ZSTD(1) is standard guidance), but ratio < 1.5 marked **critical** is silly for columns that are inherently incompressible (UUIDs, hashes, encrypted blobs, Float64 sensor noise). No codec awareness (columns already on ZSTD get the same advice). Fix template `MODIFY COLUMN ... CODEC(ZSTD(1))` is a placeholder, not actionable.
- **Query regression (advisor.go:118-259):** current-hour avg vs same-hour-yesterday and rolling-24h, flag at ×2. avg-of-avg with no variance/volume weighting → any pattern whose input data grew flags as "regression". Fine as an advisory list; `hex(normalized_query_hash)` to avoid UInt64 precision loss is a nice touch. Not wrong, just crude.
- **New patterns (advisor.go:266-327):** sound (≥100/h and unseen in prior 24h).
- **Unused tables (advisor.go:333-391):** compares against `arrayJoin(tables)` from `system.query_log` over 30 days — **breaks when query_log TTL < 30 days** (common: 7-14d), flagging actively-used tables as unused; also misses tables read only via MV cascades or external BI over distributed wrappers on other nodes (per-instance query_log). Needs a caveat in the UI.
- **Schema (advisor.go:397-578):** partitions>100 warn (OK, duplicates collector #20 at a different threshold); columns>30 → "consider projections" is a **non sequitur** (projection ≠ wide-table remedy; vertical splitting or dropping unused columns is); >1TiB w/o TTL (OK); >5 Nullable columns advice is *correct* CH guidance (Nullable adds a mask file + prevents some optimizations).
- **Cardinality (advisor.go:585-669):** samples `uniq(col)` over the **first 100k rows in PK order** — for time-ordered tables this systematically underestimates global cardinality (e.g. session IDs look low-cardinality in any 100k-row slice). Recommending `LowCardinality` on a globally high-cardinality column is *actively harmful* (dictionary bloat, slower merges). Should sample randomly (`ORDER BY rand()` on a sample, or `uniq` over `SAMPLE`) or use full-column `uniq` with a threshold nearer 10k **globally**. FP-prone and potentially damaging advice.
- **Storage policy (advisor.go:676-791):** string-parsing `engine_full` for `storage_policy`/`TTL` — `system.tables` already exposes a `storage_policy` column (they even SELECT it in handleAdvisorSchema, advisor.go:411) — the parser is redundant and `Contains(upperEF,"TTL")` false-positives on identifiers containing "TTL". Advice itself (TTL for >1TiB, tiered storage for >100GiB on default policy) is reasonable boilerplate.
- **Table detail (advisor.go:797-989):** solid; db/table interpolated via `sqlEscape` (quotes escaped) — injection-safe for string literals.

### advisor_query_antipatterns.go
Checks run against 24h of query_log. Assessment per check:
1. `select_star` — legit advice; regex `\bSELECT\s+\*` also nets `SELECT * FROM (subquery already pruned)` — acceptable heuristic.
2. `high_memory` >512MB — fine, though "may cause OOM" for a server with 256GB is context-free; static threshold.
3. `full_scan` read/result ratio >10000 — good heuristic; note aggregations *legitimately* have huge ratios (GROUP BY reading 1B rows returning 100 is often the intended design) — description should say "check PK/partition pruning", which it does. OK.
4. `no_limit` / 5. `order_no_limit` — `NOT match(query,'LIMIT')` misses LIMIT inside views and flags exports intentionally streaming full results; warn-level, acceptable.
6. `high_error_rate` ≥20% + ≥5 errors — **good** check, correctly rate-based (contrast with collector alert #10).
7. `low_mark_cache` <50% — same caveats as #36; as an advisor (not an alert) this is fine, and the "PK doesn't match filter → projection/skip index" explanation is correct CH guidance.
8. `high_frequency` ≥200/h — fine as advisory.
9. `uses_final` — **partially outdated advice**: text says "very expensive... use background merges or GROUP BY deduplification [sic]". Since 23.x FINAL is substantially cheaper (parallel FINAL, `do_not_merge_across_partitions_select_final`, 23.12+ skips fully-merged parts). Still worth surfacing, but severity/wording overstate the cost on 24.x+, and the misspelling ships to users.
10. `global_in_join` marked **critical** — **wrong framing**: on distributed setups `GLOBAL IN/JOIN` is frequently the *correct and required* pattern (the alternative local IN re-executes the subquery per shard or is semantically wrong). Flagging every use as a critical anti-pattern will teach users the opposite of Altinity/ClickHouse guidance. Should be info with "verify the broadcast set is small".
Also: per-check errors are captured into `results[idx].err` and then **never surfaced** (advisor_query_antipatterns.go:356-383) — a failing check renders as a healthy zero-count section.

### advisor_table_antipatterns.go
1. `too_many_projections` — **BROKEN**: counts rows of `system.projection_parts` grouped by table (advisor_table_antipatterns.go:99-116), i.e. **projections × active parts**, not distinct projections. A table with 1 projection and 50 parts reports "50 projections". Needs `count(DISTINCT name)` or `system.projections`.
2. `small_granularity` <4096 — advice fine; fix hint `MODIFY SETTING index_granularity=8192` affects only new parts (unstated).
3. `large_granularity` — reasonable.
4. `too_many_parts` >300 — fine, third overlapping parts signal (collector warn=1000, this=300; inconsistent thresholds confuse users).
5. `no_ttl_large` — **likely BROKEN**: filters on `has_ttl_expression` (advisor_table_antipatterns.go:227), a column that does not exist in `system.tables` on any known CH release (TTL visibility is via `create_table_query`/`engine_full`). The query errors; combined with the swallowed-error rendering (advisor_table_antipatterns.go:362-377) the check silently always shows 0. Verify against a live server; if the column is real on some Altinity build, it still fails on OSS/Cloud.
6. `no_partition` >10GB — sound advice.
7. `too_many_columns` >150 — fine; "use JSON/Map" is current-era advice, OK.
8. `wide_pk` >5 columns via `splitByString(',', primary_key)` — miscounts when PK expressions contain function commas (`cityHash64(a,b)` = 2); warn-level, tolerable. Advice (prefix pruning, ORDER BY vs PRIMARY KEY split) is correct.
9. `mutation_backlog` — duplicates collector alerts #24/#60 (fourth surface for stuck mutations). Claim "pending mutations block parts from being merged and slow all queries" is overstated — mutations serialize with merges per-part but don't globally block; regular merges continue.
Same silent-error flaw as the query advisor (`res.err` dropped, advisor_table_antipatterns.go:362-377).

---

## E) SCORE / HEALTH / SLO — PRINCIPLED OR ARBITRARY?

**Health score (analyzer.go:291-347):** `100 − Σ(unique category+severity: crit 10, warn 3, info 1)`, capped at 50 deduction → **score can never go below 50**. Category-dedup is a good idea (10 noisy tables ≠ 10× deduction). But:
- `handleInstances`/`handleOverview` map `<50 → "critical"` (server.go:397-401, 930-934) — **an unreachable threshold**. No instance can ever be shown critical by score. The floor and the UI bands were designed independently.
- Weights are arbitrary and unvalidated; because most FP-prone alerts above are warns (−3 each, one per category), a completely healthy-but-noisy node hovers ~85-91 and a genuinely dying node reads 50 — a 2:1 dynamic range for a 0-100 scale. Cosmetically principled, numerically arbitrary.
- Score for an instance never polled defaults to 100 (analyzer.go:117-124) — an unreachable-from-boot instance shows perfect health until the connectivity alert lands.

**/health (health.go:26-66):** per-instance `Status:"unreachable"` when *any critical alert* exists — a disk-space critical marks the instance "unreachable" to load balancers/operators. Mislabeled semantics; should be "critical".

**SLO (slo.go:22-69):** `UptimePct = countIf(score >= 50)/total` — since the score floor is 50 (see above), **UptimePct is 100% by construction**. It is also computed only over recorded polls: when ch-analyzer (or the node, hence no snapshot insert — `RecordHealthSnapshot` requires a live client, store.go:753-766) is down, those minutes vanish from the denominator — the one thing an uptime SLO must not do. `HealthyPct (score≥70)` and P50/P95 inherit the arbitrary scoring. Verdict: **not principled — degenerate uptime metric**.

**Health trend (health_trend.go / store.go:770-822):** buckets `avg(score)` (fine) but `sum(criticals)`/`sum(warns)` across polls in the bucket — one critical firing through a 4-hour bucket at 1-min polls displays as "240 criticals". Should be `max()` or avg. Misleading chart.

**Stale doc:** `RecordHealthSnapshot` comment claims `score = 100 - criticals*15 - warns*5` (store.go:752) — not the actual formula (main.go:781 stores the analyzer score); the comment describes a formula that exists nowhere.

---

## F) OTHER NOTABLE FINDINGS

- **Dead configuration silently accepted and even editable in the UI.** `thresholds.freshness.*`, `thresholds.cache_health.*`, `thresholds.query_latency.*`, `thresholds.mv.bloat_ratio_warn`, `thresholds.s3.max_concurrent_reads`, `thresholds.parts.warn_per_partition`, `thresholds.background_pool.*`, `slack.severity_routing`, `slack.resolve_messages` are defined (config.go) and round-tripped by the threshold editor (thresholds.go:92-268) but **no collector or alerter code reads them** (verified by grep). Users edit a number in the UI, get a 200, and nothing changes. `slack.dedup_window` is plumbed to a field the reconcile loop admits it ignores (alerter.go:120-125).
- **MV bloat detection is a stub**: `collectMVBloat` (mvs.go:225-266) emits metrics only; the `bloat_ratio_warn` threshold and the advertised bloat alert don't exist.
- **Prometheus exporter** (prometheus/exporter.go): sound overall (pre-registration trick documented at :27-33, per-instance cache prevents cross-wipe :236-273). Full `Reset()` of every gauge on each update means a scrape racing between Reset and republish can read empty series (updateMu serializes updates but not scrapes). Unbounded label cardinality: per-query_id labels (`queries.running.*`, queries.go:110-117) flow into gauges → GaugeVec cardinality grows without bound until restart (Reset clears values, not the registered label combos memory in `knownMetrics`-miss path — practically a slow leak on busy clusters).
- **query_samples 365-day TTL** (schema.sql:84-123) stores full `query_text` for a year on the monitored cluster — disk and PII implications acknowledged in the comment; default is aggressive.
- **SQL injection posture:** store/web consistently escape string literals (`escape` store.go:1008, `sqlEscape` advisor.go:20, whitelisted level filter server.go:1411-1425, sanitized query_id server.go:726-731, identifier-escape in cardinality advisor advisor.go:635-639). Terminal enforces first-keyword allowlist per statement after comment-stripping and per-statement splitting with string-literal awareness (terminal.go:90-194,258-266) plus `max_result_rows`/`max_execution_time` settings — competent. Residual: allowlisted `WITH`/`SELECT` still permits unrestricted data reads and heavy queries (readonly=1 profile on the CH user would be a stronger guarantee than keyword filtering).
- **slackapp**: reconnect/backoff loop, state persistence, and event-drain design are good (app.go:99-159). `socketmode.OptionDebug(true)` hardcoded (app.go:67) spams stderr in production.

## Top remediation priorities
1. Fix defaults/logic of the always-critical or never-firing alerts: #23 merges-stalled defaults, #32 RejectedInserts delta, #35 pool metric names, #46/47 keeper columns, #65-67 cross-alert metric names, #53/54 parts-age premise, #16 S3 thresholds (ms not s).
2. Route k8s alerts to a real instance (or a dedicated store path).
3. Send PD/webhook resolves from *all* resolve paths; emit `all_clear`.
4. Make ack stop escalation; unify snooze semantics; let snooze apply to active alerts.
5. SELECT `first_seen_at`/`fire_count` in `GetActiveAlerts`.
6. Wire or delete dead threshold config; surface advisor check errors instead of rendering 0.
7. Fix score floor vs UI bands; fix SLO uptime definition; fix `LogAction("")`.
