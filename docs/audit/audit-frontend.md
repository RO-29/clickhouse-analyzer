# CH Analyzer Frontend Audit
`/Users/rohit/ch-analyzer/web/frontend/src` — ~30,474 lines TS/TSX/CSS across 21 views, 24 components (+6 chat), 4 hooks, 4 lib modules, 1 types file.

Stack: React 19 + Vite 8 + Tailwind 4 + Recharts (+ chart.js in Terminal only) + CodeMirror + marked/dompurify. Build outputs to `../../internal/web/static` (embedded in the Go binary, `vite.config.ts:8`). Dev proxy `/api → localhost:8080`. Tests: a single vitest file (`hooks/useStore.test.ts`, 137 lines) covering only `viewRouting.ts` pure functions.

---

## A) View inventory

Routing: no router library. `useStore.tsx:84` reads `?view=` from URL; `App.tsx:143-161` maps view name → component; `Sidebar.tsx:15-57` defines 5 nav groups; `TopBar.tsx:7-26` titles; `CommandPalette.tsx:20-35` quick-nav. `hooks/viewRouting.ts` whitelists 18 views.

| View (key) | File / lines | Reached via | API endpoints (via lib/api.ts) |
|---|---|---|---|
| Overview (`overview`) | Overview.tsx / 1287 | Sidebar, default route | `/api/overview`, `/api/alerts/active`, `/health`, `/api/force-poll`, `/api/alerts/stats`; widgets add `/api/instances/:i/metrics`, `/api/instances/:i/queries`, `/api/instances/:i/slo`, `/api/instances/:i/query-patterns-v2` |
| Instance Detail (`detail`) | Detail.tsx / 1314 | NOT in sidebar nav — reached by clicking an instance (sidebar instance list `Sidebar.tsx:252`, NodeCard, CommandPalette instance entries, alert panels) | 11 parallel calls (Detail.tsx:252-264): `alerts/active?instance`, `alerts/history`, `queries`, `tables`, `disks`, `mvs`, `s3-stats`, `cache-stats`, `table-memory`, `replication`, `maintenance`; plus `history/query-patterns` (v1), `history/failures`, `history/merges`, `slo`, `advisor/query-antipatterns`, `advisor/table-antipatterns`, `alerts/resolve` |
| Alerts (`alerts`) | Alerts.tsx / 1565 | Sidebar | `alerts/active`, `alerts/history`, `alerts/resolve`, `alerts/resolve-stale`, `force-poll`, `snoozes`, `acks` (poll 30s) |
| Alert History (`history`) | AlertHistory.tsx / 590 | Sidebar | `alerts/history`, `alerts/stats`, `notify/status` (auto-refresh 60s) |
| Audit Log (`audit`) | AuditLog.tsx / 287 | Sidebar | `/api/audit` (auto-refresh 60s) |
| Explore (`explore`) | Explore.tsx / 4115 (largest file) | Sidebar; deep links `?tab=`/`?hash=` from Overview widgets, AlertDetailPanel, samples drill | 16 tabs. patterns→`query-patterns-v2`+`query-pattern-overview`+`query-pattern-timeline`+`history/failures`; samples & querylog→`query-samples`; live→`queries`+`kill-query` (5s poll); connections→`connections`+`connections/history`+`connections/sessions`+5×`metrics` (5s poll); users→`query-users`; tables→`query-tables`; failures→`history/failures`; merges→`history/merges`; partsage→`parts-age`; mvs→`history/mvs`; s3→`history/s3`+`s3-stats`+`s3-latency-by-table`; inserts→`history/inserts`; metrics→`history/async-metrics`; diskio→`history/disk-io`; antipatterns→`advisor/query-antipatterns`+`advisor/table-antipatterns`; plus `capabilities` (CompatibilityChip) |
| Compare (`compare`) | Compare.tsx / 1914 | Sidebar | `compare/tables`, `compare/settings`, `compare/metrics`, `compare/query-stats` (on demand), `compare/query-patterns`, `compare/metrics-timeline`, `table-detail` (Diff tab), `table-memory`+`cache-stats` (Memory tab) |
| Advisor (`advisor`) | Advisor.tsx / 1125 | Sidebar | On "Run Analysis": 9 parallel — `advisor/compression|query-regression|new-patterns|unused-tables|schema|storage-policy|query-antipatterns|table-antipatterns` + `table-memory`; `advisor/cardinality` behind separate button |
| Table Scanner (`scanner`) | TableScanner.tsx / 1093 | Sidebar; `navToScanner` from Advisor/CostExplorer rows | `table-scan`, `table-partitions` |
| Terminal (`terminal`) | Terminal.tsx / 968 | Sidebar; `navToTerminal` from SqlBlock/Advisor Fix/QueryModal | `POST /api/query` (multi-node parallel + abort), `query/history`; schema autocomplete via two `POST /api/query` against system.tables/columns |
| Run Checks (`runcheck`) | RunCheck.tsx / 1398 | Sidebar | `collectors`, `overview`, `run-check`, `force-poll`, `alerts/trigger`, `schedules` CRUD, `advisor/*antipatterns` (Scheduled tab) |
| Maintenance (`maintenance`) | Maintenance.tsx / 377 | Sidebar | `maintenance` list/create/update/delete, `instances` (30s poll) |
| Thresholds (`thresholds`) | ThresholdEditor.tsx / 419 | Sidebar | `GET/POST /api/thresholds` |
| AI Analyzer (`analyzer`) | ChatAnalyzer.tsx / 644 | Sidebar; kept mounted after first visit (App.tsx:39,180) | `POST /api/instances/:i/chat` (SSE) |
| Cost Explorer (`cost`) | CostExplorer.tsx / 532 | Sidebar | `/api/cost`, `/api/instances/:i/cost` |
| App Logs (`logs`) | AppLogs.tsx / 323 | Sidebar | `/api/logs` (fetch 5000, filter client-side) |
| CH Logs (`chlogs`) | CHLogs.tsx / 363 | Sidebar; "Open in CH Logs" from Explore samples | `/api/instances/:i/ch-logs` |
| Feature Guide (`guide`) | FeatureGuide.tsx / 207 | NOT in sidebar — `?` hotkey (App.tsx:60-68) + TopBar help icon (TopBar.tsx:560). Static content, no API |

**Views NOT reachable at all (dead files, not imported anywhere):**
- **`views/Dashboard.tsx` — 803 lines, dead.** Near-verbatim ancestor of the widget system now inlined in Overview.tsx:16-679 (same `WidgetType` union, same `DEFAULT_WIDGETS`, same `ch-dashboard-layout` localStorage key). Zero imports.
- **`views/Discover.tsx` — 899 lines, dead.** A feature-catalog/navigation directory superseded by FeatureGuide. Zero imports; only trace is a stale comment `Explore.tsx:3829` ("set by Discover page navigation").

**Nav entries pointing to thin views:** none broken; all 16 sidebar entries resolve. But CommandPalette omits `audit`, `thresholds`, `guide` (CommandPalette.tsx:20-35), and Sidebar omits `detail`/`guide` by design.

---

## B) Dead / broken UI paths

1. **Two entire dead view files** (Dashboard.tsx 803L, Discover.tsx 899L) — see above. ~1,700 lines, ~5.6% of the codebase.
2. **~280 lines of dead code inside Alerts.tsx**: `RUNBOOKS` (142-243), `getRunbook` (245-251), `RunbookPanel` (253-290), `investigationSql` (306-375), `AlertMessageRenderer`+`parseAlertMessage`+`looksLikeSql` (380-421) are defined but never rendered — the detail flow moved to `AlertDetailPanel`, which carries its own (better) PLAYBOOKS + AlertMessageRenderer copies (AlertDetailPanel.tsx:30-699).
3. **Alerts.tsx maintenance banner never shows** — bug. `Alerts.tsx:1093`: `cachedInstances.filter((inst: any) => inst.in_maintenance)` but `cachedInstances` is `string[]` from the store (`useStore` `instances`), so `.in_maintenance` is always `undefined`. The whole banner block (1106-1125) is unreachable. (Detail.tsx does this correctly via `api.maintenance.list()`.)
4. **AIAnalysisPanel deep-query confirm flow is dead**: `confirmDialog` state is only ever set to `null` (AIAnalysisPanel.tsx:255,281,465) — nothing calls `setConfirmDialog(info)`, so `QueryConfirmDialog` never opens from the panel and `setLoadingDeep` (256) is never invoked ("Go Deeper" now just sends a follow-up prompt). `components/QueryConfirmDialog.tsx` (114 lines) is effectively dead, and `api.analyzeElementQueries` (api.ts:274-280) has zero callers.
5. **Fully unused components**: `EmptyState.tsx` (46L), `ThinkingSpinner.tsx` (72L) — zero imports.
6. **Unused API surface**: `api.alerts.at` (api.ts:143), `api.analyzeElementQueries` (274). `api.history.queryPatterns` (v1) survives only in Detail History tab while everything else uses v2.
7. **CHLogs level filter is misleading**: pills are multi-select UI but only the *first* selected level is sent (`CHLogs.tsx:88`, comment admits "Backend supports a single level filter"). Selecting Error+Warning silently shows only Error.
8. **Explore `querylog` tab can't be deep-linked**: it's in `TABS` (Explore.tsx:57) but missing from the `validTabs` whitelist at Explore.tsx:3833, so `?tab=querylog` falls back to patterns.
9. **Decorative no-op controls**: `Detail.tsx:501-503` help button ("What is the health score?") with `cursor-default` and no handler; same pattern in `Alerts.tsx:1131-1133`, `AlertHistory.tsx:352-354`, and `Advisor.tsx:367-372` ("Feature Guide" title, no onClick). These render as buttons but do nothing.
10. **Maintenance.tsx `handleDelete` (121-128) unused** — ConfirmDialog at 359-374 re-implements delete inline.
11. **Config-gated features that may never activate**: Cost Explorer compute shows `?` + "Set vcpu_override in config" when `altinity` config absent (CostExplorer.tsx:265-266, 330-333) — reasonable gating, but on OSS deployments the whole Compute panel is a permanent dead-end with no link to docs. TopBar settings popover shows Slack/PagerDuty/Webhook "not configured" rows (TopBar.tsx:541-551) with no path to configure.
12. **Placeholder copy**: none found — no "coming soon"/lorem/TODO in src (grep verified). The only `{placeholders}` are intentional SQL template vars in playbooks.

---

## C) Bloat & duplication

### C1. Big duplication offenders (quantified)
1. **Dashboard.tsx (803L) vs Overview widget system (Overview.tsx:16-679, ~660L)** — the same 10 widgets (ActiveAlerts, HealthScores, QueryThroughput, DiskUsage, InsertRate, ErrorRate, SlowQueries, SLOOverview, Uptime, LiveQueries), same layout persistence key. One copy is dead but still maintained-looking. Delete Dashboard.tsx.
2. **Discover.tsx (899L) vs FeatureGuide.tsx (207L)** — two feature-directory pages; Discover dead.
3. **Anti-pattern scan rendered on FOUR surfaces**, each with its own UI for the same two endpoints (`advisor/query-antipatterns` + `advisor/table-antipatterns`):
   - Explore → Anti-patterns tab (`Explore.tsx:3590-3812`, QueryAPCard/TableAPCard, ~220L)
   - Advisor → sections 9-10 (`Advisor.tsx:~960-1120`)
   - Detail → Queries tab "Anti-pattern Scan" section (`Detail.tsx:736-796`)
   - RunCheck → "Scheduled" tab "Advisor Anti-pattern Scan" (`RunCheck.tsx:1146-1229`) — oddly parked under Scheduled.
   Four fetch implementations, four card styles, zero shared component.
4. **Alert playbooks/runbooks duplicated**: Alerts.tsx RUNBOOKS+investigationSql (~280L dead) vs AlertDetailPanel PLAYBOOKS (~670L live). Also `parseTableFromAlert` exists twice verbatim (Alerts.tsx:295-301, AlertDetailPanel.tsx:705-711), `looksLikeSql`/`parseAlertMessage`/`AlertMessageRenderer` twice (Alerts.tsx:380-421 vs AlertDetailPanel.tsx:659-699).
5. **Three near-identical Recharts area-chart wrappers**: `MetricChart.tsx` (269L, fetches `/metrics` itself), `HistoryChart.tsx` (200L, takes data), `MultiInstanceChart.tsx` (139L, takes series) — each has its own ChartTooltip, formatTs, spanMs>7d/1d tick logic, gradient defs. ~600L that could be one chart primitive + two thin data adapters. Terminal additionally uses chart.js/react-chartjs-2 (a **second charting library**, ~90KB gz) for its result charts (Terminal.tsx:3-30).
6. **Explore SamplesTab vs QueryLogTab** (Explore.tsx:1585-1850 and 1856-2261, ~700L combined) — both hit `/query-samples` with the same filter set (user/kind/minMs/errorsOnly/table), both render time/user/kind/status/duration/CPU/memory/query/tables rows. QueryLog adds offset paging + `q` full-text; Samples adds hash-drill + expandable rows. Two tab entries for one dataset; users must learn which to use.
7. **Explore failure-drill chart stack duplicated**: QueryPatternsTab failure panel (Explore.tsx:1074-1172) vs SamplesTab drill charts (1954-2046) — same `history/failures`+`query-pattern-timeline` fetch + same 3-6 HistoryCharts (latency/execs/memory), written twice (~180L).
8. **AlertHistory row card copy-pasted 3×** inside the same file (single row 84-122, expanded group child 154-195, day-grouped list 533-575) — ~40L each, byte-similar.
9. **Two "table detail" surfaces**: global `components/TableDetail.tsx` slide-over (286L, via `openTableDetail`) vs TableScanner's `TableDetailModal` (TableScanner.tsx:254-557, ~300L) — both show metadata/keys, parts, memory, compression, query patterns for one table with different layouts. Explore Tables tab drills into TableDetail; Scanner rows into TableDetailModal.
10. **Two chat UIs sharing one store**: full-page ChatAnalyzer (644L + chat/* 925L) and bottom-docked AIAnalysisPanel (470L + useAIAnalysis 367L) both render `chatSessions` with separate SessionCard/message-bubble/markdown-renderer implementations (`renderMd` AIAnalysisPanel.tsx:73-87 vs `renderMarkdown` chat/ChatMessage.tsx:55). Different endpoints (`/chat` vs `/analyze-element`) but ~50% duplicated presentation code.
11. **Terminal has two "Query History" buttons side by side** (Terminal.tsx:834-850): in-memory session history (left panel) and server history (right panel), both labeled "Query History", one icon-only. Confusing duplicate control.
12. **Alert-surface overlap**: Alerts view has grouped/flat/**timeline** modes; AlertHistory is itself a day-grouped timeline with the same filters (instance/severity/category/search/firing-only) + stats strip. Alerts.tsx:498-600 TimelineView vs AlertHistory's whole render — a third of AlertHistory duplicates Alerts' timeline mode.
13. **Local formatter re-implementations** instead of lib/utils: TableScanner.tsx:16-36 (`fmtBytes`,`fmtRows`,`fmtCount`), CostExplorer.tsx:25-30 (`fmtBytes`), AlertHistory.tsx:22-29 (`fmtDuration` w/ different semantics — seconds not ms), Overview UptimeWidget `formatUptime` (480-487) ≈ Explore LiveTab `elapsed` (2331-2336) ≈ NodeCard `elapsedStr` (383). At least 6 private byte/duration formatters.
14. **StatCard defined 4×**: Explore.tsx:245, Alerts.tsx:605, Compare.tsx:1401, CostExplorer.tsx:34 (plus Overview `MetricChip`/`StatMini`). All are "big number + small label" cards with slightly different padding.
15. **"Updated HH:MM:SS + Refresh button" header cluster** hand-rolled in ≥8 views (Overview:1044-1074, Detail:505-529, Alerts:1134-1148, AlertHistory:356-370, Explore:3946-3993, Maintenance:158-172, CHLogs:227-248, AppLogs:190-217) — same 3 states (loadedAt, refreshing, manualTick), never extracted.
16. **Skeleton loaders**: at least 7 bespoke implementations (Overview `Skeleton`, Detail `Skeleton`, Explore `LoadingSkeleton`, Compare `LoadingSkeleton`, Alerts inline, CHLogs inline rows, AppLogs inline rows, CrossQueryView inline).

### C2. Size hotspots
Explore.tsx 4115L (16 tabs in one file), Compare.tsx 1914L (7 tabs), Alerts.tsx 1565L, RunCheck.tsx 1398L, Detail.tsx 1314L, Overview.tsx 1287L, AlertDetailPanel.tsx 1277L (of which ~500L is a hardcoded PLAYBOOKS content database that arguably belongs in JSON/backend).

Estimated removable/consolidatable: ~1,700L dead views + ~450L dead in-file code (Alerts runbooks, QueryConfirmDialog flow, EmptyState, ThinkingSpinner) + ~1,500-2,000L consolidation opportunity (charts, stat cards, anti-pattern UI, alert rows) ≈ **12-14% of the frontend**.

---

## D) State / data-flow assessment

### Store pattern (`hooks/useStore.tsx`, 365L)
- Single React Context with one big object literal rebuilt every render (`useStore.tsx:312-339`, not memoized) → every consumer re-renders on any store change (view switch, tick, chat streaming chunk). Chat streaming writes `setChatSessions` per SSE chunk (ChatAnalyzer.tsx:449-466), each persisting the **entire session list to localStorage** (`useStore.tsx:172`) — O(sessions×messages) JSON.stringify per token streamed. This is the biggest perf smell.
- Compat aliases kept on purpose: `instance`/`selectedInstance`, `customFrom`/`from`, `setInstance` (39-66) — fine but signals migration debt.
- URL sync is hand-rolled and mostly good: pushState per view change, popstate handler (342-356), absolute from/to written to URL for shareable links (229-231).
- localStorage keys proliferate without a registry: `ch-theme`, `ch-chat-sessions`, `ch-active-chat`, `ch-dense`, `ch-stale-hours`, `ch-alerts-filter`, `ch-alert-saved-views`, `ch-dashboard-layout`, `ch-terminal-bookmarks`, `ch-notifs`, `compare-baseline`, `compare-selected-nodes`, `ch-cols-*`, `*-sort`. Cross-tab sync only for chat sessions (179-189).

### Polling / refresh
- Global tick: `App.tsx:122-141` — interval from store `refreshInterval` (default 300s), visibility-gated, immediate tick on tab re-focus. Views receive `refreshKey` prop. Good pattern, but **inconsistently adopted**: Compare, Advisor, CostExplorer, Maintenance, RunCheck, ThresholdEditor ignore the global tick; Sidebar (60s), Explore LiveTab & ConnectionsTab (5s), Overview LiveQueriesWidget (15s), NodeCard queries (15s), Alerts snooze/ack (30s), AlertHistory (60s), AuditLog (60s), Maintenance (30s) each run private intervals. With Overview open + widgets panel expanded, an N-instance deployment fires ~3N+6 requests per tick plus per-widget intervals — no request coalescing or caching layer (no react-query/swr; every view hand-rolls `cancelled` flags).
- NodeCard fetches 3 endpoints per instance on Overview mount (metrics×2 + health-trend, NodeCard.tsx:113-136) — Overview with 20 instances = 60 extra calls just for sparklines.

### Error handling
- `lib/api.ts:66-93`: GET errors toast via `ch-toast` event except 401 (auth event) / 403 / 404; POST errors never toast (thrown to caller). Inconsistent downstream: many views `catch(() => [])` and silently render empty states (Detail.tsx:252-264 swallows all 11), others show error boxes (Explore ErrorBox), others banner+dismiss (Alerts/AlertHistory/AuditLog). Silent-empty vs explicit-error is unpredictable per view.
- `AbortSignal.timeout(30_000)` on every request is good; Terminal and chat support user abort.
- ErrorBoundary wraps each view render (App.tsx:182-191). Good.

### Hardcoded values
- Color literals everywhere despite CSS vars: `#ef4444/#eab308/#22c55e` repeated in ≥15 files plus 4 separate `COLORS`/`USER_COLORS`/`BAR_COLORS`/`TREND_BAR_COLORS`/`CHART_COLORS` palettes (Explore.tsx:72-81 defines `C` twice-over with 726 & 755 local arrays).
- Chart tooltips hardcode dark-theme backgrounds (`background: '#0f1420'` Explore.tsx:965,2794; chartOptions Terminal.tsx:206) — broken contrast in light mode, unlike MetricChart which uses `var(--card)`.
- Threshold literals baked into UI logic: latency badge 100/1000ms (utils.ts:125-131), elapsed 10/60/300s (Explore LiveTab:2338-2344, Overview:597-599, NodeCard:380-382 — three different scales for the same concept), parts >100/>300 (Detail tableCols:416, TableDetail:90), PK >5GB (Advisor:314), SLO 95/99 (Overview:407-411) — none tied to the user-editable ThresholdEditor values.
- `instance.replace('single-node-', '')` in Overview LiveQueriesWidget (608, 633) — a deployment-specific name hack hardcoded in shared UI.

### Mock / demo / fixture data — **NONE EXISTS**
Exhaustive grep for `mock|demo|fixture|sample data|VITE_|import.meta.env` found **zero** mock-mode, demo-mode, fixtures, or env flags. `import.meta.env` is never referenced; there are no `VITE_*` variables. `lib/api.ts:49` sets `BASE = ''` — all requests are same-origin relative `/api/*`.

**Behavior when the backend is absent (e.g., the static Cloudflare Pages deployment):**
- If the host 404s unknown paths: every `get()` throws (`HTTP 404`); 404 toasts are suppressed (api.ts:72), so failures are *silent*. If the host SPA-fallbacks `/api/*` to index.html with 200: `r.json()` throws SyntaxError — also caught everywhere.
- Net result: the shell (sidebar, topbar, theme, palette, FeatureGuide, ThresholdEditor spinner→error) renders fine, but **Overview shows the "Failed to load instances" error screen** (Overview.tsx:964-986) or, if the response parses to `[]`, the SetupWizard "Get started" card (811-854) telling the user to edit a server config file — nonsensical on a static demo. Sidebar shows "No instances configured" (Sidebar.tsx:222-228). Every other view shows its empty/error state. Auth checks fail silently (App.tsx:96-99 catch ignored) so no re-auth modal storm, but the 5-minute auth poll keeps firing. AI panel/chat POSTs error out with "HTTP 4xx" bubbles.
- **Conclusion: there is no way to demo this UI without the Go backend.** If a static showcase deployment is a goal, a fetch-layer mock (single interception point exists: `get`/`post` in api.ts) or a `VITE_DEMO=1` fixture mode would need to be built; the current code has zero scaffolding for it.

---

## E) UX quality notes

### Inconsistent patterns (same concept, different widget)
- **Severity badges**: `Badge` + `sevColor` (utils.ts:74) vs Explore `SevBadge` (3574) vs RunCheck `severityBg` (13) vs AlertHistory SEV_DOT/SEV_TEXT/SEV_BORDER maps (49-63) vs Overview `sevDot` (145) — five renderings of critical/warn/info.
- **Tables**: shared `DataTable` (sortable, column toggle, pagination, ctx menu) is used in ~8 views, but Explore Connections/QueryLog/Sessions, Detail Replication, Compare Tables/Settings/Metrics, RunCheck metrics, CostExplorer tables all hand-roll `<table>`/grid rows — losing sorting/column-toggle/dense-mode for identical tabular data. Dense mode (`denseMode`) only affects the two DataTables that pass it (Overview:1269, RunCheck none) — the "Dense" toggle in Sidebar/CommandPalette/TopBar (3 places to toggle it!) is close to a no-op.
- **Spinners/loaders**: Loader2 spin, RefreshCw spin, pulse-skeletons, custom SVG spinner (Advisor.tsx:63), and the unused ThinkingSpinner — five idioms.
- **Time range**: global TopBar picker applies only to `detail|alerts|explore|compare|advisor` (TopBar.tsx:435); TableScanner, RunCheck, AlertHistory, CHLogs, CostExplorer each have their own local presets with different option sets (1h/6h/24h/7d/30d vs Live/5m/15m/1h/6h/24h/custom vs 6h/24h/7d/30d vs 15m/1h/6h/24h). Users must relearn range selection per page.
- **Refresh semantics**: Overview offers "Refresh" vs "Collect Now"; Alerts "Refresh" vs "Force Poll Now"; RunCheck "Force Poll Now" — same backend action, three labels/colors (green/orange/accent).
- **Drill-in idioms differ per surface**: Explore patterns → right slide-in panel; Alerts → right slide-in; Table Scanner → centered modal; TableDetail → right slide-over; Terminal results inline. Ok-ish, but the two table detail surfaces (C9) render the same data with different information architecture.

### Information hierarchy
- Overview stacks header actions + optional widget panel (10 widgets) + 7 metric chips + alert strip + instance table + alerts table — with widgets open the "current state" headline scrolls away; widgets duplicate the chips (Active Alerts widget vs Critical/Warning chips vs NodeCard counts = three alert counts on one screen).
- Explore's 16 flat tabs mix query forensics (7), infra history (6), connections, anti-patterns; no grouping; `Anti-patterns` gets an "AI" pill though it's not AI (it calls advisor heuristics) — mislabeled affordance (Explore.tsx:4010-4015).
- Alerts page presents 4 stat cards + status-badge row + 5 dropdown filters + token search + saved views + view-mode toggle before the list — very high control density; the status filter exists in 3 forms (badges row, Status dropdown, stale selector).
- RunCheck hides the Advisor scan + Schedules under a tab named "Scheduled" (RunCheck.tsx:472,1145) — the on-demand Advisor scan is neither scheduled nor discoverable there.

### Education (does the UI explain signals?)
- **Strong**: AlertDetailPanel playbooks ("What is this alert?", "Common causes", trigger SQL + threshold note, numbered investigation queries) are genuinely excellent operator education (AlertDetailPanel.tsx:1014-1136). DataTable column `tooltip`s across Explore explain metrics ("Green <1s · Amber 1-10s · Red >10s", Explore.tsx:831). Detail memory charts have per-series `seriesHelp` (Detail.tsx:635-657). Detail S3 orphan diagnostics is a built-in runbook (Detail.tsx:927-1048). CompatibilityChip explains feature unavailability by version/edition.
- **Gaps**: health score composition explained only via a tooltip icon that is *dead* on Detail (D9 no-op button; the InfoTooltip at Detail.tsx:578 does explain it — the two icons at 501 vs 578 are inconsistent). Latency/parts color thresholds are shown but not linked to the Thresholds editor, so users can't tell which colors are configurable vs hardcoded. Overview `MetricChip`s (Running Queries, Active Merges) and SLO percentages have no tooltips at all. Anti-pattern severity (critical/warn) criteria unexplained. The three duplicated alert counters (widget/chips/NodeCard) can disagree during refresh with no explanation of scope ("fresh" filtering is documented only in code comments).

### Accessibility/misc
- Interactive rows are `div onClick` without role/tabindex in most hand-rolled tables (keyboard nav exists only in Alerts flat mode + DataTable `keyboardNav`, which no caller enables — grep shows no `keyboardNav` usage).
- Nested `<button>` inside `<button>` in Explore SamplesTab row (2138-2184: expand button wraps CH Logs button) and FailuresTab (2891-2912) — invalid HTML, React warns.
- Tooltip `title=` attributes are the primary help mechanism — not touch-accessible.
- Light theme: chart tooltips and Terminal chart axes hardcode dark colors (D-hardcoded) — visibly broken in light mode.

---

## Top recommendations (ordered by leverage)
1. Delete `views/Dashboard.tsx`, `views/Discover.tsx`, `components/EmptyState.tsx`, `components/ThinkingSpinner.tsx`, Alerts.tsx dead runbook block, `QueryConfirmDialog` flow + `api.analyzeElementQueries`, `api.alerts.at` (~2,200 lines, zero behavior change).
2. Fix real bugs: Alerts maintenance banner (`string[].in_maintenance`), CHLogs multi-select→single-level filter, `querylog` deep-link whitelist, dead help buttons, nested buttons.
3. Extract shared primitives: one chart wrapper (retire chart.js from Terminal), one StatCard, one SeverityBadge, one RefreshHeader, one AntiPatternPanel used by 4 surfaces.
4. Merge Samples+QueryLog tabs; unify TableDetail vs TableDetailModal; consider folding Alerts timeline mode and AlertHistory.
5. Memoize the store value / split contexts, and stop persisting all chat sessions to localStorage on every streamed chunk.
6. If a backend-less demo is desired: add a `VITE_DEMO` fixture layer at `get()/post()` in lib/api.ts — nothing exists today, and the static deployment currently lands on an error screen / setup wizard.
