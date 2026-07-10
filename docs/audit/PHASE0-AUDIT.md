# Phase 0 — Deep Audit: ch-analyzer

Date: 2026-07-10 · Branch: `audit/deep-audit-overhaul` · Scope: entire repo @ `0b02b98` + live site https://ch-analyzer.pages.dev/

Full evidence (file:line citations for every claim) in the five companion reports:

| Report | Covers |
|---|---|
| [audit-collectors.md](audit-collectors.md) | All 24 collectors + analyzer + chclient/capabilities + thresholds, SQL-vs-CH-semantics correctness |
| [audit-alerting-api.md](audit-alerting-api.md) | 68-alert audit table, alerting pipeline, full API map, advisors, score/SLO |
| [audit-frontend.md](audit-frontend.md) | 21 views / 30 components, dead code, duplication, UX |
| [audit-docs-deploy.md](audit-docs-deploy.md) | Docs/theory, build/deploy, config, test infrastructure |
| [audit-live-drift.md](audit-live-drift.md) | Live pages.dev site vs repo |

---

## 1. Architecture map

**Single Go binary** (`cmd/ch-analyzer/main.go`) polls N ClickHouse instances (default 1m):

```
                 ┌─ internal/collector/ (24 collectors, registered in main.go)
poll loop ──────►│    system, queries, storage, tables, inserts, async_inserts,
                 │    background_pool, cache_health, dictionaries, errors, freshness,
                 │    keeper, k8s, mvs, parts_age, projections, query_latency,
                 │    query_samples, replication, restart, schema_drift,
                 │    slow_query_fingerprint, ttl, connections
                 ▼
        internal/analyzer/  (health score, z-score anomalies, 4 cross-alerts)
                 ▼
        internal/alerter/   (Reconcile diff-vs-DB; Slack, PagerDuty, webhook,
                             escalation, inhibition, snooze/ack/maintenance, ratelimit)
                 ▼
        internal/store/     (writes metrics/alerts/samples INTO the monitored
                             ClickHouse itself — 6 tables, schema.sql)
                 ▼
        internal/web/       (~85 HTTP endpoints; embeds React SPA via go:embed;
                             SSE AI analyze/chat via Claude CLI; SQL terminal; MCP server)
        internal/slackapp/  (Socket Mode app: /ch commands, buttons, pinned dashboard)
        internal/prometheus/ (exporter for Grafana)
```

**Frontend**: React/TS SPA (`web/frontend`, ~30.5k lines), Vite build output committed into `internal/web/static/` and embedded in the binary. 18 routed views + 2 unimported dead views. State via a single context store with per-view polling.

**Storage model**: the tool stores its own telemetry in the cluster it monitors (metrics 30d TTL, alerts 90d, query samples 365d). No independent store — if the cluster is down, history/alert persistence is down too.

**Deploy**: systemd (`setup.sh` installs a 3-month-old prebuilt binary from `bin/`), k8s manifest, docker-compose (+ Prometheus/Grafana, Claude CLI baked into image). No Cloudflare Pages config anywhere.

## 2. Docs / theory summary

Claimed theory (README/ARCH): detect the canonical ClickHouse failure modes — parts explosion / TooManyParts, replication lag, Keeper trouble, insert failures/backpressure, disk exhaustion, query pathologies, MV failures, schema drift, restarts/crashes — via system-table polling; score health; alert with playbooks; layer AI diagnosis on top.

The theory is sound and the *taxonomy* of what to watch is genuinely good. The execution drifts from it (below). Docs oversell ~8 capabilities that are dead or stubbed (crash_log forensics, Keeper "leader election"/backlog, MV lag & bloat, TTL reclaim, query-cache hit rate, async flush failures, "auto-learned" baselines = a 30-point in-memory ring buffer lost on restart). README documents threshold config blocks that no code reads; version floor, replication thresholds, and DB-setup claims contradict the code. `web/frontend/README.md` is the raw Vite template.

## 3. Live UI vs repo — drift list

**Root finding: ch-analyzer.pages.dev is not the app.** It is a hand-built one-file static landing page (inline CSS/JS, scripted fake console animation over hardcoded fixtures) whose source is **not in the repo and not in git history**. The real SPA is only ever served embedded in the Go binary. The repo's embedded bundle is byte-identical to a fresh `vite build` — no stale-build drift inside the repo; all drift is landing-page-vs-reality:

1. Slack commands wrong: site says `/status · /alerts · /runcheck`; real is `/ch <sub>` and no runcheck subcommand exists.
2. "ClickHouse 22.x+" — actual floor is OSS 23.x+ / Cloud 25.3+ per the repo's own compat docs.
3. "Go 1.23+" — go.mod requires 1.25.
4. Views strip shows 11 of 18 real views (Alert History, Terminal, App/CH Logs, Maintenance, Audit Log, Threshold Editor missing).
5. Collector grid shows 21; runtime registers 24 (`internal/collector/registry.go` is also out of date — omits k8s, query_samples, restart).
6. README calls the site "Live demo & docs" — it is neither (no demo, no docs).
7. GitHub links point at the pre-rename org (work via 301).
8. Recent shipped work (compat layer, Datadog-style query monitoring) unmentioned.
9. The SPA has **no demo/mock mode at all** (`lib/api.ts` hits relative `/api/*`; 404 toasts suppressed) — deploying it statically would silently render empty states. A real live demo (Phase 3) requires a hosted backend or a fixture layer; `get()/post()` in api.ts is the single interception point.

## 4. Correctness findings (metrics/checks)

Full detail per collector in audit-collectors.md. Classes of defect:

**A. Silently dead checks — query errors swallowed, can never fire (8+):**
- Async-insert flush failures: filters on enum values `'ExceptionWhileFlushing'/'Flushed'` that don't exist (real: `Ok/ParsingError/FlushError`) — the advertised "data-loss risk" check is dead.
- Background merge-pool saturation: queries `BackgroundMergesMutationsPoolTask` — real metric is `BackgroundMergesAndMutationsPoolTask` (the playbook SQL elsewhere spells it right). The most important saturation alert in the product never fires.
- Keeper overload/latency: `system.zookeeper_connection` has no `outstanding_requests`/`avg_latency`/`max_latency` columns in any released CH.
- Crash detection: `system.crash_log.trace_str` doesn't exist → crashes downgrade to a clean-restart WARN.
- OSS CPU: `OSUserTimeCPU` etc. don't exist (real: `OSUserTime` / per-core variants) → falls back to load-average proxy.
- MV bloat: join on `inner_t.uuid = mv.uuid` can never match; `bloat_ratio_warn` config is dead.
- 3 of 4 analyzer cross-alerts read metric names no collector emits (`tables.total_parts`, `storage.s3.avg_latency` [also sec-vs-ms], `inserts.rows_per_sec`).
- Cache sizes: MarkCacheBytes/UncompressedCacheBytes queried from `system.metrics` but live in `asynchronous_metrics`.

**B. Counter-vs-gauge confusion:**
- `RejectedInserts` (cumulative since server start) alerted as instantaneous → one lifetime rejection = permanent CRITICAL every poll until CH restarts, unresolvable.
- `system.errors.value` (cumulative since restart) reported as "N in the last hour" when only the *last* occurrence is recent.
- Insert-throughput baseline divides 9 intervals by 10; `totalRows > 0` gate means a 100% insert stop can never fire the drop alert.

**C. Wrong premise / false-positive machines:**
- `parts_age` + `ttl` treat old active parts as "merge pressure" — old parts are the *normal end-state* of merged partitions; fires critical on virtually every mature partitioned table, permanently.
- Merges-stalled defaults are self-contradictory: with ≥1000 cluster parts (trivial), `<30` merges = "stalled" (crit) while `≥20` = "too many merges" (crit) → every possible merge count is critical.
- `schema_drift` baseline keyed by `db.table` only, shared across instances → perpetual false drift on multi-node fleets.
- Anomaly detection collapses labeled series by name (last-label-wins) → z-scores computed over interleaved per-table/per-query series; labeled-metric anomalies are statistical noise.
- Timezone: `freshness`/`ttl` parse CH DateTime as UTC → hours-off staleness on non-UTC servers.
- S3 latency thresholds are 5s/15s *per request* (real S3 GETs are 10–200ms) → dead-by-default.

**D. Systemic:** capabilities layer's cluster-wide-log feature is used by zero collectors (Cloud multi-replica data silently partial); ~8 threshold-editor knobs are accepted by the API, editable in the UI, and read by nothing.

**Solid:** replication, connections, cache hit-rate math, query_samples ETL, restart detection (best-designed alert in the codebase), detached-parts, per-partition parts ceiling, insert-failure rate normalization, playbook/alert window-consistency discipline.

## 5. Per-alert audit

68 alert types traced end-to-end. Verdict tally (full table with triggers, FP analysis, and remediation quality per alert in audit-alerting-api.md §A):

| Verdict | Count | Meaning |
|---|---|---|
| MEANINGFUL | 24 | Real diagnosable problem, actionable (several with caveats) |
| FP-PRONE | 26 | Fires on healthy systems (aggressive defaults, wrong premise, batch-pipeline blindness) |
| BROKEN | 12 | Can never fire, fires forever, or alerts on wrong data |
| COSMETIC | 4 | Info-noise |
| VAGUE | 2 | Fires without telling you the cause |

So **35% of alerts are trustworthy; 56% are noise or broken.** Standout pipeline bugs beyond individual alerts:

- **PagerDuty incidents leak**: resolves only sent from the clean-check path; stale-sweep and UI resolves never close PD incidents. Documented webhook `all_clear` event is never emitted.
- **Ack doesn't stop escalation**; Slack "Snooze" actually creates a maintenance window that *drops new alerts invisibly* and doesn't silence the firing one; web snooze doesn't apply to already-firing alerts. Three features named "snooze" with three semantics.
- **k8s alerts are unpersistable** (`Instance:"k8s"` matches no store client) → never in UI, PD re-triggers forever with no resolve.
- `fire_count`/`first_seen_at` written but never SELECTed back → Slack "×N" and "firing since" always wrong.
- Severity escalation (warn→critical) of an existing alert produces **no notification**.
- Health score has a floor of 50 while the UI marks critical at <50 → "critical" status is unreachable. **SLO uptime is 100% by construction** (counts `score≥50`) and excludes monitor downtime from the denominator. Health-trend chart sums criticals across polls (1 critical over 4h @1m polls renders as "240 criticals").
- Inhibition is one-shot at insert time (symptom firing one poll before cause defeats it) and can't express the strongest CH causal chain (Keeper→replication→inserts) because keeper alerts are categorized `system`.
- The store's alert-refresh path commits the small-insert anti-pattern the tool itself alerts on, against the monitored production cluster.
- **Zero authentication on the entire API** — SQL terminal, KILL QUERY, alert injection (`/api/alerts/trigger`), Claude OAuth token setters. TLS to CH uses `InsecureSkipVerify:true`. Audit log silently drops all system-wide actions (`LogAction("")` fails).

**Advisors**: several give wrong or harmful advice — cardinality advisor samples first-100k rows in PK order (systematically underestimates cardinality → recommends `LowCardinality` where it's damaging); `too_many_projections` counts projection *parts* not projections; `no_ttl_large` filters on a nonexistent column; `GLOBAL IN/JOIN` branded critical when it's often the correct distributed pattern; FINAL advice outdated for 24.x+; all advisor check errors silently render as "0 issues / clean".

## 6. UI bloat & duplication

~30.5k frontend lines; ~2,200 confirmed dead (unimported `Dashboard.tsx` 803L and `Discover.tsx` 899L, dead runbook code inside Alerts, unused components/API fns). Top duplication clusters (details in audit-frontend.md §C):

1. Anti-pattern scan UI hand-built **4 times** (Explore tab, Advisor §9–10, Detail Queries tab, RunCheck Scheduled tab) over the same 2 endpoints.
2. Three near-identical Recharts wrappers (~600L) **plus a second charting library** (chart.js, Terminal only).
3. Explore's SamplesTab vs QueryLogTab: ~700L, same endpoint/filters/columns.
4. Two chat UIs (ChatAnalyzer + AIAnalysisPanel) with separate markdown/session renderers over one store.
5. Two table-detail surfaces (TableDetail vs TableScanner modal).
6. AlertHistory duplicates Alerts' timeline mode; its row card is copy-pasted 3× internally.
7. 4 StatCard variants, 5 severity-badge renderings, ~6 private byte/duration formatters, ~8 hand-rolled refresh headers.

Overlap also exists at the *concept* level: three "query storm" detectors, four stuck-mutation surfaces, three inconsistent parts thresholds (300/1000/3000), two stalled-pipeline alerts (3min vs 20min) that double-fire on batch pipelines.

Frontend bugs: unreachable maintenance banner, CHLogs level pills silently send only first selection, `?tab=querylog` deep-link broken, dark-only tooltip colors, non-memoized store context, localStorage rewritten per SSE chunk during chat streaming.

## 7. Test infrastructure

18 alerter state-machine unit tests, 7 runcheck handler tests, 1 vitest file. CI runs only the compat harness (23.3→latest matrix) which asserts "collectors don't hard-error + endpoints return 200-shaped JSON"; golden files snapshot 15 capability booleans and gate nothing. `go test`/vitest are not in CI. **Nothing anywhere validates that a metric is computed correctly or that an alert fires on its claimed condition** — which is precisely how 12 broken alerts and 8 dead checks shipped.

## 8. Security notes (fix regardless of direction)

- Plaintext live ClickHouse Cloud credentials on disk in `configs/staging-env.yaml`, `ai-changes-md/ghl-staging.yaml`, admin password in `ai-changes-md/ch_history_check.sh`. Not committed, but excluded only by the **user-global** `~/.gitignore` — one clone/repo-move from leaking. Rotate + move to env/secret store + add repo-local .gitignore.
- Unauthenticated API incl. SQL terminal / KILL QUERY / OAuth token setters (above).
- `InsecureSkipVerify:true` for CH TLS.

---

# Proposed direction (decision requested)

The tool's failure mode is **unverified breadth**: 24 collectors, 68 alerts, 18 views, 85 endpoints — built fast, never validated against real ClickHouse semantics, with a UI that grew a new surface per feature. The core loop (poll → reconcile → notify → playbook) and the alert taxonomy are worth keeping. The fix is **contraction + verification**, not more features.

**Phase 1 — correctness harness first (as specced).** Table-driven Go harness: seed a real ClickHouse (dockerized, version-matrixed reusing the existing compat CI) into known states (parts explosion, stopped merges, killed replica, insert rejection, stale pipeline…), assert exactly which alerts fire and with what values; golden-test each collector's SQL against each CH version; unit-test counter-delta/threshold/dedup logic with a fake clock. Every alert that can't get a red/green scenario gets deleted, not kept.

**Phase 2 — overhaul shaped by the audit:**
- *Alerts*: fix the 12 broken (metric names, deltas, defaults), delete/demote the 26 FP-prone to advisor-level or rework with rate/floor gates, unify snooze semantics, close the PD/resolve/ack/escalation holes, re-derive the health score so bands are reachable and SLO means uptime.
- *UI*: consolidate 18 views → ~8 (Overview, Alerts, Queries, Tables/Storage, Replication+Keeper, AI, Admin, Explore-lite); one chart wrapper, one table-detail, one chat surface, shared formatters; delete dead views; inline education ("what this signal means / why / what to do") on every panel — the playbook content already exists and is good, it's just trapped in Slack messages.
- *Version coverage*: make capability gating real (collectors actually consume `LogTable()`/cluster-wide caps; dead columns fail loudly in the harness, not silently in prod).
- *Security*: token auth on the API, readonly CH profile for the terminal, TLS verify, rotate the staging creds.

**Phase 3 — live demo**: real backend (free-tier VM/container) pointed at ClickHouse Cloud free trial or a public playground, proxied read-only; replace the fictional landing page with the actual app + a guided tour. Static-only fallback: fixture layer at the `api.ts` seam, clearly labeled "recorded data".

Awaiting review before any feature work. Suggested first implementation step on approval: Phase 1 harness scaffolding + the 12 BROKEN-alert fixes it immediately catches.
