# ch-analyzer — Documentation / Theory / Build-Deploy / Test-Infra Audit

Audited: 2026-07-10. Repo: /Users/rohit/ch-analyzer (branch `main`, HEAD 0b02b98).

---

## A) THEORY reconstruction — what the tool CLAIMS to detect

### A.1 Claims and where they are made

**README.md (lines 13–74, the Features section)** — 20-row collector table claiming detection of:

| Claim | Where |
|---|---|
| Memory pressure (RSS + CH MemoryTracking), CPU, OS load, concurrent queries | README.md:17 |
| Long-running queries (>1m), failed queries, query storms, full-table scans | README.md:18 |
| Parts explosion per table/partition, merge throughput, stuck/slow mutations | README.md:19 |
| Disk usage per tier, S3 read latency, S3 concurrency contention, tier movement | README.md:20 |
| Insert throughput drops, small-insert anti-pattern, insert exceptions | README.md:21 |
| Async insert queue depth, error rate, flush failures | README.md:22 |
| Exception rates by code, fatal errors from system.crash_log | README.md:23 |
| Replication lag/readonly replicas/queue backlog | README.md:24 |
| Background pool saturation | README.md:25 |
| Mark/uncompressed/query cache hit rates | README.md:26 |
| MV lag, failures, bloat, chained-MV breakage | README.md:27 |
| Dictionary reload failures, staleness | README.md:28 |
| Projection part counts, coverage analysis | README.md:29 |
| TTL enabled-but-not-deleting, TTL reclaim rates | README.md:30 |
| Oldest-part-age anomalies | README.md:31 |
| Keeper health, latency, leader election, session timeouts | README.md:32 |
| Data freshness gaps (tables that stopped receiving inserts) | README.md:33 |
| Schema drift between replicas | README.md:34 |
| Slow-query fingerprint regression factor | README.md:35 |
| K8s OOMKills / pod restarts (optional) | README.md:36 |

**Analyzer claims (README.md:38–41)**: std-dev anomaly baseline "auto-learned per metric", sustained-elevation detection, cross-collector rules (OOM risk = high memory + many queries; merge overload; S3 contention). ARCH.md never documents the analyzer as a layer of its own — it appears only inside `runReconcile` (ARCH.md:88–90) and in main.go where its thresholds are hardcoded (`AnomalyStdDevMultiplier: 2.0`, `SustainedIssueCount: 3`, cmd/ch-analyzer/main.go:176–179 — **not configurable via YAML despite README implying tunability of everything**).

**Alert-system claims (README.md:43–50)**: "20+ alert categories", per-alert plain-English playbooks with pre-populated SQL investigation queries, snooze/ack, inhibition, escalation, maintenance windows, Slack severity routing. ARCH.md Appendix B (ARCH.md:648) enumerates 19 categories + `connectivity` (main.go:798) = matches "20+" roughly.

**ARCH.md collector roster (ARCH.md:151–176)** is the most precise statement of theory: 24 collectors with exact system-table sources and fallback chains (e.g. RSS fallback `MemoryResident → OSProcessRSSMemory → MemoryTracking`, ARCH.md:153).

**ai-changes-md/what.md** (the original A–Z guide) makes the earliest and most concrete numeric claims: query storm >25 concurrent per user, full scan >1B rows, failed queries >10 warn />50 critical in 5m (what.md:74–84), analyzer compound rules with exact conjunctions (what.md:196–200), health score formula −25/−10/−2 per critical/warn/info (what.md:206–210).

### A.2 Where the docs oversell

1. **"Keeper health, latency, leader election, session timeouts" (README.md:32)** — ARCH.md:173 says the KeeperCollector reads `system.zookeeper` / `system.zookeeper_connection` connection stats and treats missing/denied as silent. Golden snapshots show `system.zookeeper: false` on *every* tested OSS version and it's denied on Cloud (test/compat/golden/*.json, PR_BODY.md:106). "Leader election" detection is not evidenced anywhere in ARCH or the compat reports; in practice this collector is a no-op on most deployments. A reader expects Keeper monitoring; on the two supported editions as actually tested, they get "not configured (silent)".
2. **"Fatal errors from system.crash_log" (README.md:23)** — every golden file has `system.crash_log: false`; ARCH.md:161 admits "`system.crash_log` may be missing → 'no crash evidence'". The headline feature is unavailable on all six tested versions.
3. **"MV lag, failures, bloat, chained MV breakage" (README.md:27)** — ARCH.md:158 shows MVCollector only emits `mvs.total_count` / `mvs.exists` as metrics and per-MV failure detection "only when `system.query_views_log` is populated" — which is `false` on every golden snapshot. MV *lag* has a threshold key (`mv.lag_warn`) but no documented metric or collector output backs it.
4. **"Projection … coverage analysis" (README.md:29)** — ARCH.md:168 says ProjectionCollector emits "projection staleness" from `system.projection_parts`; `system.projections` is unavailable before 25.3 per goldens. "Coverage analysis" overstates it.
5. **"TTL reclaim rates" (README.md:30)** — ARCH.md:169 says TTLCollector emits only "TTL-enabled table count". No reclaim-rate metric documented anywhere.
6. **"Anomaly detection via standard-deviation baseline (auto-learned per metric)" (README.md:39)** — the baseline is an in-memory rolling window of 30 points (what.md:202), lost on every restart; "auto-learned" implies persistence that does not exist (ARCH.md's "In-memory state lost on restart" table doesn't even list the analyzer window).
7. **"Query cache hit rates" (README.md:26)** — ARCH.md:163 documents CacheHealthCollector emitting only `mark_hit_rate` and `uncompressed_hit_rate`; no query-cache metric.
8. **"Insert exception tracking" and async "flush failures" (README.md:21–22)** — ARCH.md:157/170 document delayed/rejected counters and queue depth/age only; `system.asynchronous_insert_log` (which would carry flush failures) is `false` in every golden file.
9. **Config reference drift**: README.md:283–299 documents `background_pool`, `cache_health`, `query_latency`, `freshness` threshold blocks — none of these appear in the shipped `configs/ch-analyzer.yaml`, `deploy/k8s.yaml`, or `configs/staging-env.yaml`; and main.go:531–535 constructs `BackgroundPoolCollector{}`, `CacheHealthCollector{}`, `QueryLatencyCollector{}`, `FreshnessCollector{}` **with no threshold fields at all**, so those four README blocks are configuration theater (whether config.go parses them is moot — the values are never passed to the collectors).

---

## B) Docs-vs-reality gaps

### B.1 README vs code layout
- **`https://ch-analyzer.pages.dev` "Live demo & docs" (README.md:3–7)** — nothing in the repo produces this site. No wrangler.toml, no `_headers`/`_redirects`, no Pages workflow, no `functions/` dir (verified: only `.github/workflows/compat.yml` exists; grep for wrangler/cloudflare hits only README). See §C.4.
- **README collector table has 20 rows; ARCH.md documents 24 collectors; code has 26 collector files** (internal/collector/: 24 collectors + `types.go`, `registry.go`, `playbook.go`; main.go:489–553 registers 24, +K8s conditional = matches ARCH). README omits Connections, Restart, and QuerySamples collectors from its table while the Dashboard section depends on them (Samples/Live/Users tabs, restart chips). Compat reports say "24/24 ok" (test/compat/reports/24.8.md:4) — README's "20" undercounts, a mild inverse-staleness.
- **README replication threshold `lag_critical: "2m"` (README.md:282)** vs every shipped config using `"300s"` = 5m (configs/ch-analyzer.yaml:104, deploy/k8s.yaml:88). One of them is wrong.
- **README says `storage.database … created automatically on every instance` is *not* the case** — README.md:94 correctly says schema is NOT auto-created, but configs/ch-analyzer.yaml:147 and staging-env.yaml:98 still carry the stale comment "created automatically on every instance". Contradiction inside the shipped config.
- **README Quick Start `make build-linux` then `sudo ./setup.sh`** is consistent with setup.sh:69 expecting `bin/ch-analyzer-linux-amd64`; but setup.sh:85 prefers a `configs/my-config.yaml` that no doc except ai-changes-md/what.md ever mentions.
- **web/frontend/README.md is the untouched Vite template** ("React + TypeScript + Vite", no project content). Anyone landing there learns nothing about the app.
- **ARCH.md self-dates "regenerated 2026-05-02" (ARCH.md:4)** yet describes the July compat layer (ARCH.md:723–753) added in the 2026-07 PR — the date stamp was not refreshed when the doc was.
- **ARCH.md time conventions contradiction**: ARCH.md:581 still says "All wall-clock timestamps are local time on the ch-analyzer host", but README.md:139–144 ("Time ranges are now UTC-correct", `.UTC()` formatting) and PR_BODY.md §1 say the opposite was just shipped. ARCH's "Cross-cutting concerns → Time" section is stale post-UTC-fix.
- **ARCH.md route count "~70 routes" (ARCH.md:331)** vs CONTEXT.md "40+" vs feature_report.py probing 45 instance + 6 global read-only endpoints — internally inconsistent counts across docs (not verified against server.go, but the three docs disagree with each other).
- **README Slack config omission**: README.md:302–314's slack block omits `app_token`/`signing_secret` which the Socket-Mode app (README.md:65–69, main.go:366) requires; configs/ch-analyzer.yaml:121–122 has them. Following only the README config reference yields a Slack app that never starts.
- **`prometheus.listen_addr` three-way mismatch**: README/config say `":9090"`; deploy/prometheus.yml:3 says 'set to ":9100" in ch-analyzer.yaml — see README below' (there is no such README text) and scrapes `host.docker.internal:9100` (prometheus.yml:20); docker-compose.yml:27–28 says Prometheus scrapes ch-analyzer **via the internal docker network on 9090**. The shipped compose + shipped prometheus.yml cannot work together as written: the scrape target is host.docker.internal:9100, there is no `extra_hosts` mapping in docker-compose.yml despite prometheus.yml:7 claiming there is, and ch-analyzer's config ships `prometheus.enabled: false`.
- **Grafana dashboard description**: README.md:396 says grafana-dashboard.json "reads from the ch_analyzer tables", but deploy/grafana/provisioning/datasources/prometheus.yml provisions only a Prometheus datasource — the compose stack wires Grafana→Prometheus, not Grafana→ClickHouse. Also two near-duplicate dashboards exist (deploy/grafana-dashboard.json, 58,888 B, vs deploy/grafana-dashboards/ch-analyzer.json, 58,928 B); compose mounts only the former.
- **README package coverage check**: internal/ = alerter, analyzer, chclient, collector, config, prometheus, slackapp, store, web. Every README feature maps to a real package; the gap direction is mostly features-in-code-not-in-README (schedules/run-check cron in internal/web/schedule.go + main.go:374–425, SLO endpoint, thresholds editor — mentioned in ARCH only).

### B.2 ARCH vs code (spot checks)
- ARCH.md's `runReconcile` walkthrough, circuit breaker (5 failures → 5 min backoff), `fullyObserved`/trusted-instance gating, and force-poll channel semantics all match cmd/ch-analyzer/main.go:453–486, 602–737 precisely — ARCH.md is substantially accurate on orchestration.
- ARCH.md:186–189 says threshold defaults live in `config.go:DefaultConfig` and the dashboard writes `thresholds.json` — matches main.go:332–339.
- ARCH.md line-number citations (store.go:478, alerter.go:391-401 etc.) are unverifiable freshness risks — the doc admits being a 2026-05 walk.

---

## C) Build / deploy map

### C.1 Build pipeline
1. `make frontend` → `cd web/frontend && npm ci && npm run build` (Makefile:13–14). **Vite outputs directly into the Go tree**: `build.outDir: '../../internal/web/static'` with `emptyOutDir: true` (web/frontend/vite.config.ts). 
2. `make build` = frontend + `go build -ldflags "-X main.version=… -X main.buildTime=…" -o bin/ch-analyzer ./cmd/ch-analyzer` (Makefile:17–18). Static assets are `go:embed`-ed (CONTEXT.md:193; ARCH.md:419). `make build-linux` cross-compiles GOOS=linux/amd64 (Makefile:20–21); `build-go`/`build-go-linux` skip the frontend.
3. **The built bundle is COMMITTED**: `git ls-files` tracks `internal/web/static/assets/index-CSagklCW.js` (2,038,781 B) and `index-Dz2gEIn3.css` (80,570 B) plus `index.html` referencing exactly those hashes (internal/web/static/index.html:8–9, title still the Vite default "frontend"). This is why CI's `make build-go` (compat.yml:48) works without Node — it embeds the checked-in bundle. Consequence: any frontend change requires re-committing a 2 MB hashed blob, and a `build-go` after frontend edits silently ships stale UI (CONTEXT.md:193–198 documents this exact footgun).
4. **bin/ contains two ~70 MB binaries** (`bin/ch-analyzer` 70,119,186 B dated today; `bin/ch-analyzer-linux-amd64` 70,418,075 B dated 17 Apr). `bin/` is gitignored (.gitignore:2) so they are **not committed** — local build artifacts only, but the 3-month-old linux binary sitting next to setup.sh (which will happily install it, setup.sh:69–72) is a stale-deploy hazard, not a repo-hygiene one.

### C.2 Container / compose
- Dockerfile: 3 stages — node:22-alpine builds the frontend into /app/internal/web/static; golang:1.25-alpine builds the static binary **overwriting the committed static dir with the fresh build** (Dockerfile:17–18); final stage is node:22-alpine **because it globally installs `@anthropic-ai/claude-code`** so the AI features can spawn `claude -p` (Dockerfile:33–38). Exposes 8080 + 9090.
- docker-compose.yml: ch-analyzer (8080 published; 9090 deliberately internal-only), prom/prometheus v2.51.2 (UI on 9091), grafana 11.1.0 (3000, admin/${GRAFANA_PASSWORD:-admin}), volumes for prometheus/grafana data and a `claude-config` volume persisting OAuth tokens. Healthcheck = `wget http://localhost:8080/api/instances`. Note the §B.1 prometheus.yml target mismatch — the shipped scrape config points at host.docker.internal:9100, not the compose-internal ch-analyzer:9090.
- .env.example: only ANTHROPIC_API_KEY and GRAFANA_PASSWORD.

### C.3 Systemd / K8s
- setup.sh (run as root): creates `monitoring` CH user with `GRANT SELECT ON *.*` + `SELECT, INSERT ON ch_analyzer.*` on every host, applies schema.sql via clickhouse-client, installs binary to /usr/local/bin, config to /etc/ch-analyzer/config.yaml, service user `ch-analyzer`, state dir /var/lib/ch-analyzer, systemd unit; deletes legacy SQLite files (setup.sh:108 — vestige of the SQLite era, see §E).
- deploy/ch-analyzer.service: hardened unit (NoNewPrivileges, ProtectSystem=strict, ReadWritePaths=/var/lib/ch-analyzer, HOME=/var/lib/ch-analyzer so claude credentials land there).
- deploy/k8s.yaml: Namespace + Secret-embedded config.yaml + Deployment (image `ch-analyzer:latest`, IfNotPresent — assumes a locally-loaded image; no registry) + ClusterIP Service 8080/9090. Liveness/readiness probe `/api/instances`. Prometheus enabled:true in the K8s config (unlike the default config).
- **Ports/auth summary**: dashboard :8080 (NO authentication of any kind on the HTTP API — the only "auth" in the system, ARCH.md:401–413, is OAuth *to Anthropic* for the AI features; `/api/query` is protected only by a read-only SQL validator, ARCH.md:361); Prometheus exporter :9090; monitored CH over HTTPS :8443 with the `monitoring` user; Slack via Socket Mode WebSocket (no inbound endpoint).

### C.4 Cloudflare Pages (ch-analyzer.pages.dev)
**There is no Pages deploy config anywhere in the repo.** No wrangler.toml/wrangler.jsonc, no `pages` GitHub workflow, no `_redirects`/`_headers`, no functions/. The only artifact that *could* be published is the Vite output in internal/web/static/ — but that SPA is hardwired to a same-origin `/api` backend (vite dev proxy → :8080; embedded serving in prod), so publishing it to Pages alone would yield a dead dashboard unless a separate demo/docs build exists outside this repo. Conclusion: **ch-analyzer.pages.dev is produced manually or from a different source entirely; the README's headline "Live demo & docs" link (README.md:3–7) is not reproducible from this repository.** If it is a manual `wrangler pages deploy internal/web/static`, it will drift from every release unless someone remembers to redo it.

### C.5 Credentials on disk (flag)
Not committed to git (protected only by the *user-global* /Users/rohit/.gitignore lines `**/ai-changes-md/` and `staging-env.yaml` — fragile: any other clone/collaborator lacks that protection), but present in the working tree in plaintext:
- configs/staging-env.yaml:15 — live ClickHouse Cloud host m7eybak4t3.us-central1.gcp.clickhouse.cloud with `monitoring` password.
- ai-changes-md/ghl-staging.yaml:13–14 — same host, `readonly_user_rohit` password.
- ai-changes-md/ch_history_check.sh:7 — hardcoded default admin password (`qDNJc49!e2NmRtw`).
Also: chclient is constructed with `InsecureSkipVerify: true` unconditionally (main.go:83, 153) — TLS verification is disabled for all monitored instances and is not documented in README/ARCH.

---

## D) Test infrastructure inventory

### D.1 What exists
| Layer | Files | What it actually asserts |
|---|---|---|
| Go unit | internal/alerter/alerter_test.go (763 lines, 18 tests) | Severity ordering; inhibition rule matching; reconcile lifecycle against a **fake store**: insert-on-new, idempotency, failed-insert retry, UI-resolve→re-fire, maintenance drop, auto-resolve after N clean checks, inhibited-persists-no-notify, info→digest, dedup-key autogen, per-instance counts. |
| Go unit | internal/web/runcheck_test.go (259 lines, 7 tests) | `/api/runcheck` handler plumbing: 2×2 instance/collector fan-out, unknown instance/collector, empty inputs, bad JSON, result shape. Uses stub collectors. |
| Frontend (vitest) | web/frontend/src/hooks/useStore.test.ts (137 lines, only test file) | Pure routing helpers: `resolveView`/`resolveViewFromSearch` fallbacks, the 17-view whitelist. Zero component/API tests. |
| Compat harness | scripts/compat-test.sh + cmd `--compat-check` (main.go:1039–1083) | Per OSS version in Docker: apply schema, run all 24 collectors once, fail on any returned error. |
| Feature e2e | scripts/feature-check.sh + scripts/feature_report.py | Boots the real binary + web server against the container, probes 6 global + 45 instance read-only endpoints, fails on 5xx / connection-refused / 200-with-`{"error":…}` body; 4xx is only a warn. Writes test/compat/reports/<ver>.md (gitignored except the checked-in 24.8.md sample: 24/24 collectors, 47/47 endpoints ok). |
| Golden files | test/compat/golden/{23.3,23.8,24.3,24.8,25.3,latest}.json | Snapshot of `{edition, features{name→available}}` only — 15 boolean capability probes (clusterAllReplicas, system.crash_log, system.projections, …). Drift prints a ⚠️ **but does not fail the run** (compat-test.sh:169–173 has no exit-code effect), and `feature-check`/CI never compares against goldens at all — goldens gate nothing in CI. |
| CI | .github/workflows/compat.yml | Matrix ch_version ∈ {23.3, 23.8, 24.3, 24.8, 25.3, latest} × ubuntu; `make build-go` (embedded committed frontend, no Node step); schema apply via inline Python; `scripts/feature-check.sh`; report → job summary + artifact. **This is the only workflow.** No `go test`, no `go vet`/lint, no vitest, no frontend build check in CI — `make test` exists (Makefile:59–60) but nothing runs it. |
| Cloud | "live smoke test" (README.md:429–433, PR_BODY.md:101) | Manual/live, no script in repo — the Cloud row of the support matrix is untested by any committed automation. |

### D.2 Does anything validate metric correctness or alert firing conditions?
**No.**
- The compat/feature harness asserts only *absence of hard errors and 200-shaped responses*. A collector that returns `memory.used_percent = 0` forever, or a threshold comparison inverted (`<` for `>`), passes every existing test. The empty throwaway container has no load, so no alert condition ever fires in CI; `--compat-check` discards `CollectResult.Metrics`/`Alerts` entirely (main.go:1063 ignores the result value).
- alerter_test.go validates the *reconcile state machine* given already-constructed `collector.Alert` values — i.e., alert lifecycle plumbing, not the firing predicates. No test constructs a system-table fixture and asserts "with parts=3001 the tables collector emits critical".
- There are **zero tests in internal/collector/** (no `_test.go` files) and zero in internal/analyzer/, internal/store/, internal/chclient/ — the entire detection theory (thresholds, SQL, anomaly math, health-score formula) and the load-bearing dedup SQL (ARCH.md:290–313) are untested.
- `--dry-run` (main.go:291–313) is a manual smoke tool, not a test.
- Frontend: one pure-function test file; no rendering, API-contract, or chart tests.

Net: the harness answers "does it run everywhere?" convincingly, and answers "is it right?" not at all.

---

## E) The ai-changes-md/ folder — development history & intended vs shipped

The folder (excluded from git by the user-global gitignore) is a fossil record of AI-assisted development, mostly frozen 2026-04-13:

- **CONTEXT.md** (Apr 13): project snapshot when the tool monitored **5 Altinity-managed nodes** holding the `chains` blockchain DB (~82 TiB, 56 tables, 59 MVs), CH 25.6/25.8 Altinity builds. Documents 8 collectors, 40+ endpoints, Altinity quirks that still shape the code (LoadAverage/CGroupMaxCPU CPU fallback, MemoryResident RSS, `databases[1]/tables[1]` instead of ARRAY JOIN, UInt64-as-JSON-string fix — all still visible in ARCH.md:153–157). Its "Known Issues" (health-score tuning, narrow-timeline empty state) were UI-era concerns.
- **what.md + plan.md** (Apr 13): the same "A–Z feature guide" in two forms — plan.md is literally a **pasted Claude chat transcript** ("❯ give me full plan…", plan.md:16, including "Rotate your CH password that was exposed in this chat", plan.md:12). Key intended-design deltas vs shipped:
  - **SQLite metric store** (`./data/metrics.db`, WAL, hourly pruner — what.md:327–336, config key `storage.path`) → shipped: ClickHouse-native `ch_analyzer` DB per node with TTL retention (schema.sql; setup.sh:108 still cleans up the abandoned `metrics.db*`; main.go:427 comment "no pruner needed").
  - **8 collectors** intended → **24 shipped** (the whole replication/errors/keeper/freshness/fingerprint/samples/restart family arrived later, per the memory-session trail Apr 14–16).
  - Parts thresholds intended 300/500 (what.md:399–401) → shipped defaults 1000/3000 (configs/ch-analyzer.yaml:77–78) — retuned to the chains workload.
  - Resolution after "2 consecutive polls" (what.md:272) → shipped 4 clean checks default (ARCH.md:217).
  - Chart.js single-file index.html dashboard (562 lines, what.md:633) → shipped full React/TS/Tailwind SPA with 17 views.
  - k8s.enabled: true with namespace/label_selector keys intended (what.md:459–463) → shipped config has bare `k8s.enabled: false`, no namespace/selector keys in any shipped config.
  - "Dockerfile — not included yet" (what.md:562) → shipped 3-stage Dockerfile that additionally bakes in the Claude CLI (an axis the plan never imagined: no AI/chat/advisor/MCP feature appears anywhere in plan.md/what.md — the entire AI surface, ~a third of the shipped product, was unplanned scope growth).
- **ch_audit.sh / ch_audit_output.txt (146 KB), ch_history_check.sh / .txt (156 KB)** (Apr 11–13): one-off recon scripts + raw dumps of the production cluster's storage policies, disks, and log-table ranges — the empirical basis for the collector SQL. ch_history_check.sh hardcodes an admin password (§C.5).
- **ghl-staging.yaml** (Apr 15): shows the tool being pointed at a *second* environment — GHL's ClickHouse Cloud staging — which is the origin story of the July Cloud-compatibility work (the memory notes and PR_BODY.md confirm: TZ bugs, S3 starvation, capability layer all fell out of running against this instance).
- **.planning/design-audit/INVENTORY.md** (Apr 18, 85 lines + screenshots dir): "Phase 1, factual baseline only" frontend design audit — 17-view inventory with states/pagination/keyboard columns, full dark-theme token dump, type-scale census. Indicates a planned design-system pass whose later phases don't appear in the repo.

**Reconstruction**: the tool began (Apr 11–13) as a bespoke Slack-alerting monitor for one team's 5-node Altinity cluster, with SQLite storage and 8 collectors, spec'd via chat transcripts. Within a week it tripled its collector count, swapped storage to CH-native, grew a full SPA, Slack Socket-Mode app, PagerDuty/webhook, and an unplanned AI layer. In July it was generalized (capability probes, compat matrix, UTC handling) to survive ClickHouse Cloud and arbitrary versions. README/ARCH were rewritten for the generalized product but retain overselling from the aspirational era (§A.2) and stale operational details (§B.1), while ai-changes-md preserves the abandoned intent (SQLite, 8 collectors, Chart.js) that setup.sh and stray config comments still echo.

---

## Top findings (ranked)
1. **No test anywhere validates a metric value or an alert-firing predicate** — CI proves "runs without hard errors on 6 CH versions", nothing more (§D.2); collectors/analyzer/store have zero unit tests.
2. **ch-analyzer.pages.dev is not reproducible from the repo** — the README's headline link has no deploy config; it's manual/external (§C.4).
3. **Plaintext live credentials in the working tree**, protected only by a user-global gitignore; plus unconditional `InsecureSkipVerify: true` (§C.5).
4. **Committed 2 MB built frontend bundle in internal/web/static/assets/** (hash index-CSagklCW.js) is the actual CI/deploy input; `bin/` holds 70 MB local binaries (gitignored, but a stale 3-month-old linux binary is what setup.sh installs if you forget to rebuild) (§C.1).
5. **README oversells ~8 detection claims** (crash_log, Keeper, MV lag/bloat, projections coverage, TTL reclaim, query-cache, async flush failures, "auto-learned" baselines) relative to ARCH.md's own collector roster and the golden capability snapshots (§A.2).
6. **Shipped observability stack is self-inconsistent**: prometheus.yml scrapes host.docker.internal:9100 while compose promises internal :9090 scraping and ships prometheus disabled; duplicate Grafana dashboards; README misdescribes the Grafana datasource (§B.1).
7. **Golden files gate nothing** — drift only warns locally and is never checked in CI; `make test`/vitest are absent from CI entirely (§D.1).
8. **Config-reference blocks in README for thresholds that no shipped collector consumes** (background_pool, cache_health, query_latency, freshness) and analyzer thresholds hardcoded in main.go despite "everything configurable" framing (§A.2 item 9).
