# Live-vs-Repo Drift Audit: ch-analyzer.pages.dev vs /Users/rohit/ch-analyzer

Date: 2026-07-10. Live HTML captured to `scratchpad/live-index.html` (61,351 bytes).

## 1. What the live site actually is

**A hand-built, self-contained static marketing/landing page — NOT the React app, not a stale app build, not pointed at any backend.**

Evidence:
- Single HTML document, 61,351 bytes, all CSS and JS inline. Only external requests: Google Fonts (`fonts.googleapis.com`). Zero `<script src>`, zero `<link>` to hashed assets, zero `fetch()`/XHR, no API base URL, no backend hostname anywhere in the page.
- Cloudflare Pages serves it as an SPA catch-all: `/app`, `/dashboard`, `/demo`, and even `/assets/index-CSagklCW.js` and `/assets/index-Dz2gEIn3.css` all return the **same 61,351-byte text/html** (verified with curl status/content-type probes). The React app bundle is not deployed anywhere on the domain.
- The "See it live ↓" hero console (`#demo`) and the alert-playbook widget are **scripted animations over hardcoded fixture data** in the inline JS: fake nodes `name:"node-a" / node-b / node-c`, canned metrics ("S3 read latency 4.1 s"), a hardcoded `const PB=[...]` array of 3 demo playbooks (OOM risk, Too many parts, Replica read-only/delay) with pre-written SQL snippets. Nothing is live.
- Interactive elements that DO work: theme toggle, collector search/filter chips (over a hardcoded `const COLLECTORS=[...]` array of 21 entries), playbook tab switcher, copy-to-clipboard buttons, anchor nav. All client-side only.
- `/og.png` exists (200, image/png, 194,859 bytes) — social card is real.

## 2. Bundle comparison (step 2 of audit)

- **There is no live JS bundle to compare.** Requesting the repo's asset paths on the live domain returns the landing HTML fallback.
- Repo-internal check instead: fresh `vite build` from `/Users/rohit/ch-analyzer/web/frontend` (rolldown-vite, node v22.22.2) outputs directly to `internal/web/static` (vite.config.ts: `outDir: '../../internal/web/static'`) and reproduces the **exact same hashed filenames** `index-CSagklCW.js` (2,038.78 kB) and `index-Dz2gEIn3.css` (80.57 kB); `git status internal/web/static/` is clean after the build. So the embedded bundle IS current with frontend source — no in-repo staleness there.

## 3. Landing page source is not in the repo

- No file in the repo contains the landing page markup (grep for its distinctive font "Bricolage" across all `*.html`: only match is the live capture).
- `git log --all -S "Bricolage"` returns nothing; no `landing`/`site`/`pages` paths ever committed.
- Conclusion: the Cloudflare Pages project is maintained **out-of-band** (direct upload or a separate repo). Any repo change requires a manual, separate site update — this is the structural root of all drift below.

## 4. Mismatches: live claims vs repo reality

### 4.1 FALSE / misleading on the live site

1. **Slack slash commands wrong, one doesn't exist.** Live: "`/status` · `/alerts` · `/runcheck`". Repo: one slash command `/ch <subcommand>` (internal/slackapp/app.go:32 "slash commands (/ch ...)") with subcommands `status`, `alerts`, `snooze`, `unsnooze|resume`, `snoozed`, `maintenance|maint`, `analyze|ai`, `refresh`, `help` (internal/slackapp/commands.go:25-61). **There is no `runcheck` Slack command at all** (grep over internal/slackapp/ finds none). The live page both mis-formats the two real ones and advertises a nonexistent one, while underselling snooze/maintenance/AI subcommands.
2. **ClickHouse version support overstated.** Live hero chip + Requirements table: "ClickHouse 22.x+". Repo compatibility layer/README: **OSS 23.x → latest, Cloud 25.3 → latest** (README.md:407-408; :438 "OSS 23.x+ or Cloud 25.3+ … older OSS mostly [unsupported]"). 22.x is not a supported floor.
3. **Go version stale.** Live Requirements: "Go 1.23+". `go.mod:3` says `go 1.25.0` — building requires Go 1.25+. (README.md:436 has the same stale "Go 1.23+", so live copied a stale README; both diverge from the source of truth.)
4. **README mislabels the site.** README.md:4 and :7 link ch-analyzer.pages.dev as "**Live demo & docs**". It is neither a live demo (animated fixtures, no running instance) nor docs (marketing copy only). Drift in the repo→live direction.
5. **GitHub link uses the pre-rename repo name.** Live links `https://github.com/RO-29/ch-analyzer` (3 places). Actual remote is `RO-29/clickhouse-analyzer`; the link only works via GitHub's 301 rename redirect. Functional but stale.

### 4.2 Features in repo NOT surfaced live (undersold)

6. **7 of 18 app views missing from the live "views" strip.** Live `const VIEWS` lists 11 pills: Overview, Instance Detail, Alerts, Query Analyzer, Table Scanner, Cost Explorer, Compare, AI Analyzer, Advisor, Run Checks, Feature Guide. Repo `View` type (web/frontend/src/hooks/viewRouting.ts:6) has 18: `overview | detail | alerts | history | explore | compare | advisor | terminal | logs | chlogs | analyzer | scanner | cost | maintenance | runcheck | audit | thresholds | guide`. Missing live: **Alert History, SQL Terminal, App Logs, CH Logs, Maintenance, Audit Log, Threshold Editor**. All confirmed present as label strings in the built bundle (`grep` hits in index-CSagklCW.js: "Alert History" 3, "Terminal" 7, "App Logs" 4, "CH Logs" 4, "Maintenance" 5, "Audit Log" 2, "Thresholds" 2). (Maintenance windows are mentioned in alerting prose but have no view pill.)
7. **Collector list drift: live shows 21, runtime has 24.** Live `const COLLECTORS` (21 cards): System, Queries, Slow Query Fingerprint, Query Latency, Cache Health, Tables, Storage, Parts Age, TTL, Projections, Inserts, Async Inserts, Replication, Materialized Views, Dictionaries, Freshness, Schema Drift, Errors, Background Pool, Keeper, Kubernetes. Actual `buildCollectors()` (cmd/ch-analyzer/main.go:489-554) registers 23 always-on + K8s when enabled = 24; live omits **Connections, Query Samples, Restart**. Headline "Twenty collectors, one poll cycle" undercounts.
8. **Version/edition compatibility layer absent from live.** The July 2026 compat work (capability detection, OSS/Cloud modes, `--compat-check`, UI compatibility chip — merged in 0b02b98; string "compatibility" present in the built bundle; CI matrix `.github/workflows/compat.yml`, golden files `test/compat/golden/*.json`) is a differentiator the landing page never mentions — and instead it advertises the wrong ("22.x+") support floor (see 4.1.2).
9. **Datadog-style query monitoring tabs unmentioned.** Samples/Live/Users query monitooring surfaces exist in the app (bundle: "Live Queries" 4 hits, "Samples" 5 hits); live page only generically says "Patterns, live queries, users… in one view".

### 4.3 In-repo side finding uncovered by the audit

10. **Repo's own collector registry metadata is stale.** `internal/collector/registry.go` (feeds the Feature Guide / collector catalog, 21 entries) includes `connections` but omits `k8s`, `query_samples`, and `restart`, which ARE real runtime collectors (main.go:541-552). So the in-app catalog undercounts by 3, same class of drift as the landing page.

### 4.4 Live claims verified ACCURATE (no action)

- "Six tables … metrics · alerts · health_snapshots · digest_snapshots · query_samples · audit_log" — matches the 6 `CREATE TABLE` statements in schema.sql exactly.
- "circuit breaker skips nodes that fail 5× in a row" — matches main.go:655 (`instanceFailures[instanceName] >= 5`) and :797/:804.
- "1m default poll interval" — configs/ch-analyzer.yaml:55 `interval: "1m"`.
- "Node (frontend build) 22+" — matches README.md:437.
- Dashboard at `localhost:8080` — configs/ch-analyzer.yaml:139 / internal/config/config.go:429 `ListenAddr: ":8080"`.
- Install/quick-start artifacts all exist: setup.sh, schema.sql, Makefile (`build-linux`, `build-go`), Dockerfile, deploy/k8s.yaml, deploy/ch-analyzer.service, configs/ch-analyzer.yaml; monitoring-user GRANTs match schema conventions.
- Alerting features (inhibition, escalation, snooze+ack, maintenance windows, audit log), AI Analyzer, Cost Explorer, Compare & Advisor + suggestions.yaml, Slack pinned dashboard with Resolve/Snooze buttons, PagerDuty/webhook/Prometheus surfaces — all exist in repo.
- Playbook demo's 3 sample alerts (OOM risk, too-many-parts, replica read-only/delay) correspond to real collector/analyzer categories.

## 5. Dead controls / non-functional elements on the live page

- None strictly broken: all nav is same-page anchors; theme, filter, tabs, copy buttons are client-side and work. The closest to "dead" are (a) the "See it live ↓" CTA, which implies a live product but scrolls to a scripted animation, and (b) the `/assets/*` URLs, which silently return HTML instead of 404 (SPA fallback), masking the absence of the app.

## 6. Summary of required fixes (by owner)

Live page (out-of-band asset — must be located/recommitted to fix):
- Fix slash commands to `/ch status`, `/ch alerts`, etc.; drop `/runcheck`.
- Change "ClickHouse 22.x+" → "OSS 23.x+ / Cloud 25.3+"; "Go 1.23+" → "Go 1.25+".
- Add Connections/Query Samples/Restart collectors (24 total); add 7 missing view pills; mention compat layer.
- Update GitHub links to RO-29/clickhouse-analyzer.

Repo:
- README.md:4,7 — stop calling the site a "Live demo"; README.md:436 Go 1.23+ → 1.25+.
- internal/collector/registry.go — add k8s, query_samples, restart entries.
- Consider committing the landing page source to the repo (or a sibling repo with CI deploy) so it can't drift silently again.
