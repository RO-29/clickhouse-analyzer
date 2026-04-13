package web

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"log/slog"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// claudeBinary returns the full path to the claude CLI.
// Resolution order:
//  1. CLAUDE_BIN env var (explicit override — set this in the systemd unit)
//  2. exec.LookPath (process $PATH)
//  3. `sh -c "command -v claude"` (shell PATH, reads /etc/profile.d/ etc.)
//  4. Glob search across common install locations
func claudeBinary() (string, error) {
	// 1. Explicit override — trust the caller, skip stat check so that
	//    systemd ProtectHome restrictions don't cause false negatives.
	if p := os.Getenv("CLAUDE_BIN"); p != "" {
		return p, nil
	}

	// 2. Process PATH.
	if path, err := exec.LookPath("claude"); err == nil {
		return path, nil
	}

	// 3. Shell lookup — the shell reads /etc/profile.d/ and user dotfiles,
	//    so it often succeeds even when the process PATH is stripped.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "sh", "-c", "command -v claude").Output()
	if err == nil {
		if p := strings.TrimSpace(string(out)); p != "" {
			if info, err2 := os.Stat(p); err2 == nil && !info.IsDir() {
				return p, nil
			}
		}
	}

	// 4. Glob search across common install locations.
	patterns := []string{
		"/usr/local/bin/claude",
		"/usr/bin/claude",
		"/root/.local/bin/claude",
		"/root/.npm-global/bin/claude",
		"/root/.nvm/versions/node/*/bin/claude",
		"/home/*/.local/bin/claude",
		"/home/*/.npm-global/bin/claude",
		"/home/*/.npm/bin/claude",
		"/home/*/.nvm/versions/node/*/bin/claude",
	}
	if home := os.Getenv("HOME"); home != "" {
		patterns = append(patterns,
			filepath.Join(home, ".local", "bin", "claude"),
			filepath.Join(home, ".npm-global", "bin", "claude"),
		)
	}
	var checked []string
	for _, p := range patterns {
		matches, _ := filepath.Glob(p)
		for _, m := range matches {
			checked = append(checked, m)
			if info, err := os.Stat(m); err == nil && !info.IsDir() {
				return m, nil
			}
		}
		if len(matches) == 0 {
			checked = append(checked, p+"(no match)")
		}
	}

	return "", fmt.Errorf(
		"claude executable not found. "+
			"Set CLAUDE_BIN=/path/to/claude in the systemd unit, or install with: npm install -g @anthropic-ai/claude-code. "+
			"Searched: %s",
		strings.Join(checked, ", "),
	)
}

// setEnv replaces the value of key in the env slice (or appends it).
func setEnv(env []string, key, value string) []string {
	prefix := key + "="
	for i, e := range env {
		if strings.HasPrefix(e, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

// ---------------------------------------------------------------------------
// POST /api/instances/{name}/analyze — AI-powered cluster analysis via Claude
// ---------------------------------------------------------------------------

type analyzeRequest struct {
	Mode           string `json:"mode"`             // full | slow-queries | parts-merges | inserts | errors
	TimeWindowMins int    `json:"time_window_mins"` // 60, 180, 360, 1440, etc.
	Question       string `json:"question"`         // optional user question
}

type analyzeContext struct {
	ClusterStatus       interface{} `json:"cluster_status"`
	SlowQueriesDuration interface{} `json:"slow_queries_duration"`
	SlowQueriesMemory   interface{} `json:"slow_queries_memory"`
	InsertPatterns      interface{} `json:"insert_patterns"`
	ActiveMerges        interface{} `json:"active_merges"`
	PartsHealth         interface{} `json:"parts_health"`
	ErrorPatterns       interface{} `json:"error_patterns"`
	Disks               interface{} `json:"disks"`
	CollectionErrors    []string    `json:"collection_errors"`
	CollectedAt         time.Time   `json:"collected_at"`
	TimeWindowMins      int         `json:"time_window_mins"`
}

// handleAnalyze collects ClickHouse diagnostics, builds a prompt, spawns
// claude CLI, and streams its output as Server-Sent Events.
func (s *Server) handleAnalyze(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found: "+instance)
		return
	}

	var req analyzeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.TimeWindowMins <= 0 {
		req.TimeWindowMins = 180
	}
	if req.Mode == "" {
		req.Mode = "full"
	}

	// ── Set up SSE ────────────────────────────────────────────────────────────
	// Disable the server's global WriteTimeout for this long-running SSE
	// handler — claude analysis can take several minutes and the default 30s
	// write timeout would kill the connection mid-stream.
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{}) // zero = no deadline

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	sendEvent := func(event, data string) {
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
		flusher.Flush()
	}

	// ── Collect data ──────────────────────────────────────────────────────────
	sendEvent("status", `{"phase":"collecting"}`)

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()

	ac := collectAnalysisContext(ctx, client, instance, req.Mode, req.TimeWindowMins)

	// ── Optionally report step completions ────────────────────────────────────
	for _, e := range ac.CollectionErrors {
		slog.Warn("collection error", "instance", instance, "err", e)
	}

	sendEvent("status", `{"phase":"sending"}`)

	// ── Build prompt ──────────────────────────────────────────────────────────
	prompt := buildAnalysisPrompt(ac, req.Mode, req.Question)

	// ── Env vars audit ────────────────────────────────────────────────────────
	authEnvs := map[string]string{}
	for _, key := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_OAUTH_TOKEN", "CLAUDE_MODEL", "ANTHROPIC_BASE_URL"} {
		if v := os.Getenv(key); v != "" {
			authEnvs[key] = fmt.Sprintf("len=%d prefix=%.8s…", len(v), v)
		}
	}

	// ── Config home ───────────────────────────────────────────────────────────
	claudeCfgHome := findClaudeHome()
	cfgKeys := []string{}
	if claudeCfgHome != "" {
		if cfgBytes, readErr := os.ReadFile(filepath.Join(claudeCfgHome, ".claude.json")); readErr == nil {
			var cfgMap map[string]interface{}
			if json.Unmarshal(cfgBytes, &cfgMap) == nil {
				for k := range cfgMap {
					cfgKeys = append(cfgKeys, k)
				}
			}
		}
	}

	// ── Collection row counts ─────────────────────────────────────────────────
	rowCounts := map[string]int{}
	countRows := func(label string, v interface{}) {
		if rows, ok := v.([]map[string]interface{}); ok {
			rowCounts[label] = len(rows)
		}
	}
	countRows("cluster_status", ac.ClusterStatus)
	countRows("disks", ac.Disks)
	countRows("slow_queries_duration", ac.SlowQueriesDuration)
	countRows("slow_queries_memory", ac.SlowQueriesMemory)
	countRows("insert_patterns", ac.InsertPatterns)
	countRows("active_merges", ac.ActiveMerges)
	countRows("parts_health", ac.PartsHealth)
	countRows("error_patterns", ac.ErrorPatterns)

	// ── Trim prompt ───────────────────────────────────────────────────────────
	const maxPromptBytes = 1 << 20 // 1 MB
	truncated := false
	if len(prompt) > maxPromptBytes {
		prompt = prompt[:maxPromptBytes] + "\n\n[...context truncated to fit ARG_MAX...]"
		truncated = true
	}

	// ── Write full prompt to debug file (always, for now) ────────────────────
	debugFile := fmt.Sprintf("/var/lib/ch-analyzer/debug-prompt-%s.txt", time.Now().UTC().Format("20060102-150405"))
	if werr := os.WriteFile(debugFile, []byte(prompt), 0600); werr != nil {
		slog.Warn("analyze: could not write debug prompt file", "err", werr)
	} else {
		slog.Info("analyze: prompt written to file", "file", debugFile)
	}

	// ── Structured log ───────────────────────────────────────────────────────
	slog.Info("analyze: prompt ready",
		"instance", instance,
		"mode", req.Mode,
		"time_window_mins", req.TimeWindowMins,
		"prompt_bytes", len(prompt),
		"prompt_kb", len(prompt)/1024,
		"truncated", truncated,
		"collection_errors", ac.CollectionErrors,
		"row_counts", rowCounts,
		"auth_envs_present", authEnvs,
		"config_home", claudeCfgHome,
		"config_keys", cfgKeys,
	)

	// ── Send debug snapshot to browser console ────────────────────────────────
	debugPayload := map[string]interface{}{
		"prompt_bytes":        len(prompt),
		"prompt_kb":           len(prompt) / 1024,
		"truncated":           truncated,
		"prompt_head":         prompt[:min(800, len(prompt))],
		"prompt_tail":         prompt[max(0, len(prompt)-400):],
		"collection_errors":   ac.CollectionErrors,
		"row_counts":          rowCounts,
		"auth_envs_present":   authEnvs,
		"config_home":         claudeCfgHome,
		"config_keys":         cfgKeys,
		"mode":                req.Mode,
		"instance":            instance,
	}
	if dbgB, _ := json.Marshal(debugPayload); dbgB != nil {
		sendEvent("debug", string(dbgB))
	}

	// ── Spawn claude CLI ──────────────────────────────────────────────────────
	claudeBin, err := claudeBinary()
	if err != nil {
		slog.Warn("claude CLI not available", "err", err)
		sendEvent("error", jsonStr(err.Error()))
		return
	}
	slog.Info("analyze: claude binary", "path", claudeBin)

	claudeCtx, claudeCancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer claudeCancel()

	claudeArgs := []string{"-p", prompt}
	if m := os.Getenv("CLAUDE_MODEL"); m != "" {
		claudeArgs = append(claudeArgs, "--model", m)
	}
	if os.Getenv("CLAUDE_DEBUG") != "" {
		claudeArgs = append(claudeArgs, "--verbose")
	}
	cmd := exec.CommandContext(claudeCtx, claudeBin, claudeArgs...)

	// Inherit full env + augment PATH.
	claudeEnv := os.Environ()
	claudeEnv = setEnv(claudeEnv,
		"PATH",
		"/home/ec2-user/.local/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin:"+os.Getenv("PATH"),
	)

	if claudeCfgHome != "" {
		claudeEnv = setEnv(claudeEnv, "HOME", claudeCfgHome)
	} else if tmpHome, err2 := os.MkdirTemp("", "claude-home-*"); err2 == nil {
		claudeEnv = setEnv(claudeEnv, "HOME", tmpHome)
		cfgPath := filepath.Join(tmpHome, ".claude.json")
		if err3 := os.WriteFile(cfgPath, []byte(buildClaudeCfg()), 0600); err3 != nil {
			slog.Warn("analyze: could not write claude temp config", "err", err3)
		}
		defer os.RemoveAll(tmpHome)
		slog.Info("analyze: using temp HOME (no real config found)", "path", tmpHome)
	} else {
		slog.Warn("analyze: could not create claude temp HOME", "err", err2)
	}

	cmd.Env = claudeEnv

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		sendEvent("error", jsonStr(err.Error()))
		return
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		sendEvent("error", jsonStr(err.Error()))
		return
	}

	if err := cmd.Start(); err != nil {
		slog.Warn("claude CLI failed to start", "path", claudeBin, "err", err)
		sendEvent("error", jsonStr("Claude CLI failed to start: "+err.Error()))
		return
	}

	sendEvent("status", `{"phase":"streaming"}`)

	var wg sync.WaitGroup
	var stdoutLines, stderrLines int

	// Stream stdout.
	wg.Add(1)
	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 128*1024), 128*1024)
		for scanner.Scan() {
			stdoutLines++
			line := scanner.Text()
			// Detect rate-limit errors immediately — claude CLI retries
			// internally for ~3 minutes before printing this, so killing the
			// process early saves the user a 3-minute wait.
			if strings.Contains(line, "API Error: 429") || strings.Contains(line, `"code":"1302"`) {
				sendEvent("error", jsonStr("Rate limited (429) — wait ~60 seconds and retry. Your subscription enforces a request cooldown for large prompts."))
				claudeCancel()
				return
			}
			sendEvent("chunk", jsonStr(line+"\n"))
		}
	}()

	// Collect stderr — forward to UI and log.
	wg.Add(1)
	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(stderrPipe)
		var lines []string
		for scanner.Scan() {
			stderrLines++
			line := scanner.Text()
			slog.Warn("claude stderr", "line", line)
			lines = append(lines, line)
		}
		if len(lines) > 0 {
			sendEvent("stderr", jsonStr(strings.Join(lines, "\n")))
		}
	}()

	wg.Wait()
	exitErr := cmd.Wait()

	slog.Info("claude finished",
		"instance", instance,
		"stdout_lines", stdoutLines,
		"stderr_lines", stderrLines,
		"exit_err", exitErr,
	)

	sendEvent("status", `{"phase":"done"}`)
}

// ---------------------------------------------------------------------------
// Context collector — all queries run in parallel
// ---------------------------------------------------------------------------

type queryJob struct {
	label string
	sql   string
}

func collectAnalysisContext(
	ctx context.Context,
	client *chclient.Client,
	instance, mode string,
	timeWindowMins int,
) analyzeContext {
	ac := analyzeContext{
		CollectedAt:    time.Now(),
		TimeWindowMins: timeWindowMins,
	}

	from := time.Now().Add(-time.Duration(timeWindowMins) * time.Minute).UTC().Format("2006-01-02 15:04:05")
	to := time.Now().UTC().Format("2006-01-02 15:04:05")

	needsSlowQueries := mode == "full" || mode == "slow-queries"
	needsInserts := mode == "full" || mode == "inserts"
	needsMergesParts := mode == "full" || mode == "parts-merges" || mode == "inserts"
	needsErrors := mode == "full" || mode == "errors"

	jobs := []queryJob{
		{
			label: "cluster_status",
			sql: `SELECT
  (SELECT count() FROM system.processes WHERE query != '') as active_queries,
  (SELECT count() FROM system.merges) as active_merges,
  (SELECT count() FROM system.mutations WHERE NOT is_done) as pending_mutations,
  (SELECT sum(queue_size) FROM system.replicas) as replication_queue,
  (SELECT formatReadableSize(sum(free_space)) FROM system.disks) as free_disk,
  (SELECT formatReadableSize(sum(total_space)) FROM system.disks) as total_disk,
  (SELECT round(100*(1 - avg(free_space/total_space)), 1) FROM system.disks) as disk_used_pct,
  uptime() as uptime_seconds,
  version() as version`,
		},
		{
			label: "disks",
			sql: `SELECT name, path,
  formatReadableSize(free_space) as free,
  formatReadableSize(total_space) as total,
  round(100*(1-free_space/total_space), 1) as used_pct
FROM system.disks`,
		},
	}

	if needsSlowQueries {
		jobs = append(jobs,
			queryJob{
				label: "slow_queries_duration",
				sql: fmt.Sprintf(`SELECT normalized_query_hash,
  count() as cnt,
  round(avg(query_duration_ms)/1000, 2) as avg_sec,
  round(max(query_duration_ms)/1000, 2) as max_sec,
  round(avg(memory_usage)/1e6, 1) as avg_mem_mb,
  round(avg(read_rows)/1e6, 2) as avg_read_M_rows,
  any(user) as user,
  substring(any(query), 1, 300) as sample_query
FROM system.query_log
WHERE type = 'QueryFinish'
  AND is_initial_query = 1
  AND event_time BETWEEN '%s' AND '%s'
GROUP BY normalized_query_hash
ORDER BY avg_sec DESC
LIMIT 15`, from, to),
			},
			queryJob{
				label: "slow_queries_memory",
				sql: fmt.Sprintf(`SELECT normalized_query_hash,
  count() as cnt,
  round(avg(memory_usage)/1e6, 1) as avg_mem_mb,
  round(max(memory_usage)/1e6, 1) as max_mem_mb,
  round(avg(query_duration_ms)/1000, 2) as avg_sec,
  any(user) as user,
  substring(any(query), 1, 300) as sample_query
FROM system.query_log
WHERE type = 'QueryFinish'
  AND is_initial_query = 1
  AND event_time BETWEEN '%s' AND '%s'
GROUP BY normalized_query_hash
ORDER BY avg_mem_mb DESC
LIMIT 10`, from, to),
			},
		)
	}

	if needsInserts {
		jobs = append(jobs, queryJob{
			label: "insert_patterns",
			sql: fmt.Sprintf(`SELECT databases[1] as db, tables[1] as tbl,
  count() as insert_count,
  round(avg(written_rows)) as avg_rows,
  sum(written_rows) as total_rows,
  countIf(written_rows < 100) as small_inserts
FROM system.query_log
WHERE type = 'QueryFinish'
  AND query_kind = 'Insert'
  AND is_initial_query = 1
  AND event_time BETWEEN '%s' AND '%s'
GROUP BY db, tbl
ORDER BY insert_count DESC
LIMIT 15`, from, to),
		})
	}

	if needsMergesParts {
		jobs = append(jobs,
			queryJob{
				label: "active_merges",
				sql: `SELECT database, table, elapsed,
  round(progress*100,1) as pct, num_parts,
  result_part_name, is_mutation,
  formatReadableSize(total_size_bytes_compressed) as size
FROM system.merges
ORDER BY elapsed DESC
LIMIT 20`,
			},
			queryJob{
				label: "parts_health",
				sql: `SELECT database, table,
  count() as total_parts,
  countIf(active) as active_parts,
  formatReadableSize(sum(bytes_on_disk)) as size_on_disk,
  uniqExact(partition) as partitions
FROM system.parts
WHERE active = 1
GROUP BY database, table
ORDER BY active_parts DESC
LIMIT 30`,
			},
		)
	}

	if needsErrors {
		jobs = append(jobs, queryJob{
			label: "error_patterns",
			sql: fmt.Sprintf(`SELECT exception_code, count() as cnt,
  any(exception) as sample_msg,
  any(user) as user,
  any(substring(query, 1, 200)) as sample_query
FROM system.query_log
WHERE type = 'ExceptionWhileProcessing'
  AND is_initial_query = 1
  AND event_time BETWEEN '%s' AND '%s'
GROUP BY exception_code
ORDER BY cnt DESC
LIMIT 20`, from, to),
		})
	}

	// Run all jobs in parallel.
	type result struct {
		label string
		rows  []map[string]interface{}
		err   error
	}
	ch := make(chan result, len(jobs))

	var wg sync.WaitGroup
	for _, job := range jobs {
		job := job
		wg.Add(1)
		go func() {
			defer wg.Done()
			rows, err := client.Query(ctx, job.sql)
			ch <- result{label: job.label, rows: rows, err: err}
		}()
	}

	wg.Wait()
	close(ch)

	for res := range ch {
		if res.err != nil {
			ac.CollectionErrors = append(ac.CollectionErrors, res.label+": "+res.err.Error())
			continue
		}
		switch res.label {
		case "cluster_status":
			ac.ClusterStatus = res.rows
		case "slow_queries_duration":
			ac.SlowQueriesDuration = res.rows
		case "slow_queries_memory":
			ac.SlowQueriesMemory = res.rows
		case "insert_patterns":
			ac.InsertPatterns = res.rows
		case "active_merges":
			ac.ActiveMerges = res.rows
		case "parts_health":
			ac.PartsHealth = res.rows
		case "disks":
			ac.Disks = res.rows
		case "error_patterns":
			ac.ErrorPatterns = res.rows
		}
	}

	return ac
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

func buildAnalysisPrompt(ac analyzeContext, mode, userQuestion string) string {
	fmtJSON := func(v interface{}) string {
		if v == nil {
			return "(not collected)"
		}
		b, _ := json.MarshalIndent(v, "", "  ")
		return string(b)
	}

	fmtWindow := func(mins int) string {
		switch {
		case mins < 60:
			return fmt.Sprintf("%d minutes", mins)
		case mins < 1440:
			return fmt.Sprintf("%d hours", mins/60)
		default:
			return fmt.Sprintf("%d days", mins/1440)
		}
	}

	modeLabel := map[string]string{
		"full": "Full Health Scan", "slow-queries": "Slow Query Hunter",
		"parts-merges": "Parts & Merges", "inserts": "Insert Optimization",
		"errors": "Error Investigation",
	}
	modeInstructions := map[string]string{
		"full": `Perform a comprehensive cluster health review. Cover:
1. Infrastructure health (disk, memory, uptime, active queries)
2. Query performance (slow selects, memory-heavy patterns)
3. Insert pipeline health (throughput, part creation rate, merge backlog)
4. Parts hygiene (part explosion risk, partition strategy)
5. Errors and anomalies
Prioritize findings by severity. Correlate across signals.`,
		"slow-queries": `Focus on query performance:
1. Identify most expensive patterns by duration and memory
2. For each top pattern: why it's slow, what index/schema change helps, provide ready-to-run fix SQL
3. Look for antipatterns: missing partition filters, high-cardinality GROUP BY, FINAL keyword overuse`,
		"parts-merges": `Focus on parts, merges, and mutations:
1. Identify tables with dangerous part counts (>500=WARNING, >1000=CRITICAL)
2. Analyze active merges: are any taking too long? What is the backlog?
3. Correlate high part counts with insert patterns`,
		"inserts": `Focus on insert optimization:
1. Analyze insert batch sizes, frequency, which tables are insert-heavy
2. Identify tables with high rate but small batches (fragmentation risk)
3. Recommend settings (max_insert_block_size, async_insert, Buffer tables)`,
		"errors": `Focus on error investigation:
1. Categorize errors by type and frequency
2. Root cause for top error types (241=memory, 159=timeout, 60=table not found)
3. Actionable fixes for each category`,
	}

	label := modeLabel[mode]
	if label == "" {
		label = "Full Health Scan"
	}
	instructions := modeInstructions[mode]
	if instructions == "" {
		instructions = modeInstructions["full"]
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("# ClickHouse Cluster Analysis — %s\n", label))
	sb.WriteString(fmt.Sprintf("Collected at: %s\nTime window: %s\n\n", ac.CollectedAt.Format(time.RFC3339), fmtWindow(ac.TimeWindowMins)))

	if len(ac.CollectionErrors) > 0 {
		sb.WriteString("## ⚠️ Collection Warnings\n")
		for _, e := range ac.CollectionErrors {
			sb.WriteString("- " + e + "\n")
		}
		sb.WriteString("\n")
	}

	sb.WriteString("## Cluster Health Overview\n```json\n" + fmtJSON(ac.ClusterStatus) + "\n```\n\n")
	sb.WriteString("## Disk Usage\n```json\n" + fmtJSON(ac.Disks) + "\n```\n\n")

	if ac.SlowQueriesDuration != nil {
		sb.WriteString("## Top Slow Queries (by Duration)\n```json\n" + fmtJSON(ac.SlowQueriesDuration) + "\n```\n\n")
	}
	if ac.SlowQueriesMemory != nil {
		sb.WriteString("## Top Memory-Intensive Queries\n```json\n" + fmtJSON(ac.SlowQueriesMemory) + "\n```\n\n")
	}
	if ac.InsertPatterns != nil {
		sb.WriteString("## Insert Patterns\n```json\n" + fmtJSON(ac.InsertPatterns) + "\n```\n\n")
	}
	if ac.ActiveMerges != nil {
		sb.WriteString("## Active Merges\n```json\n" + fmtJSON(ac.ActiveMerges) + "\n```\n\n")
	}
	if ac.PartsHealth != nil {
		sb.WriteString("## Parts Health\n```json\n" + fmtJSON(ac.PartsHealth) + "\n```\n\n")
	}
	if ac.ErrorPatterns != nil {
		sb.WriteString("## Recent Errors\n```json\n" + fmtJSON(ac.ErrorPatterns) + "\n```\n\n")
	}

	sb.WriteString("---\n\n## Analysis Instructions\n\n" + instructions + `

## Required Output Format

For each finding:
### [SEVERITY] Finding Title
**Impact:** One-line impact statement
**Evidence:** Key data from the context above
**Explanation:** Why this is a problem
**Fix:**
` + "```sql\n-- Ready-to-run SQL\n```" + `

Severity: 🔴 CRITICAL | 🟠 WARNING | 🟡 INFO

End with a **## Summary** section: overall health (CRITICAL/WARNING/OK), top 3 actions, cross-finding correlations.
If no issues, say so. Do not invent findings.
`)

	if userQuestion != "" {
		sb.WriteString("\n## Additional User Question\n" + userQuestion + "\n\nAnswer using the collected data above.\n")
	}

	return sb.String()
}

// findClaudeHome returns the HOME directory that contains a valid .claude.json,
// checking well-known locations so the service user doesn't need HOME set.
// Returns "" if none found (caller falls back to temp HOME).
func findClaudeHome() string {
	candidates := []string{
		"/var/lib/ch-analyzer", // service StateDirectory after `claude login`
	}
	if h := os.Getenv("HOME"); h != "" {
		candidates = append([]string{h}, candidates...) // prefer $HOME if set
	}
	for _, dir := range candidates {
		if _, err := os.Stat(filepath.Join(dir, ".claude.json")); err == nil {
			return dir
		}
	}
	return ""
}

// buildClaudeCfg returns the ~/.claude.json content for the temp HOME.
// Injects CLAUDE_OAUTH_TOKEN if set, so subscription-based auth works on
// headless servers where `claude login` can't open a browser.
func buildClaudeCfg() string {
	base := map[string]interface{}{
		"hasCompletedProjectOnboarding": true,
		"installedExtensions":           []interface{}{},
	}
	if tok := os.Getenv("CLAUDE_OAUTH_TOKEN"); tok != "" {
		base["oauthToken"] = tok
	}
	b, _ := json.Marshal(base)
	return string(b)
}

// jsonStr encodes s as a JSON string for SSE data fields.
func jsonStr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// ---------------------------------------------------------------------------
// GET /api/instances/{name}/analyze/context — Preview collected context (no AI)
// ---------------------------------------------------------------------------

func (s *Server) handleAnalyzeContext(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	mode := r.URL.Query().Get("mode")
	if mode == "" {
		mode = "full"
	}
	timeWindowMins := 180
	if v := r.URL.Query().Get("time_window_mins"); v != "" {
		fmt.Sscanf(v, "%d", &timeWindowMins) //nolint:errcheck
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()

	ac := collectAnalysisContext(ctx, client, instance, mode, timeWindowMins)
	writeJSON(w, http.StatusOK, ac)
}
