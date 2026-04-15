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
		prompt = prompt[:maxPromptBytes] + "\n\n[...context truncated to 1 MB limit...]"
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
		"prompt_head":         prompt[:min(5120, len(prompt))],
		"prompt_tail":         prompt[max(0, len(prompt)-512):],
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

	claudeArgs := []string{"-p", "-"}
	if m := os.Getenv("CLAUDE_MODEL"); m != "" {
		claudeArgs = append(claudeArgs, "--model", m)
	}
	if os.Getenv("CLAUDE_DEBUG") != "" {
		claudeArgs = append(claudeArgs, "--verbose")
	}
	claudeArgs = appendClaudeFlags(claudeArgs)
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
	cmd.Stdin = strings.NewReader(prompt)

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
			// Detect auth errors — kill early and tell the user to re-authenticate.
			if strings.Contains(line, "API Error: 401") ||
				strings.Contains(line, `"authentication_error"`) ||
				strings.Contains(line, "Invalid authentication credentials") {
				sendEvent("auth_error", jsonStr("Your Claude session has expired. Click the lock icon in the top bar to re-authenticate."))
				claudeCancel()
				return
			}
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

// ---------------------------------------------------------------------------
// escapeSQLString escapes a value to be embedded in a SQL string literal.
func escapeSQLString(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "'", "\\'")
	return s
}

// ---------------------------------------------------------------------------
// POST /api/instances/{name}/analyze-element — element-level AI analysis
// ---------------------------------------------------------------------------

type analyzeElementRequest struct {
	ContextType  string                 `json:"context_type"`  // tab | row | chart
	ContextLabel string                 `json:"context_label"` // human label
	Tab          string                 `json:"tab"`           // tab key
	VisibleData  map[string]interface{} `json:"visible_data"`  // frontend data
	Mode         string                 `json:"mode"`          // quick | deep
	DeepQueries  []string               `json:"deep_queries"`  // only for mode=deep, pre-approved by user
}

func (s *Server) handleAnalyzeElement(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found: "+instance)
		return
	}

	var req analyzeElementRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.Mode == "" {
		req.Mode = "quick"
	}

	// ── Server-side read-only validation for deep mode ────────────────────────
	if req.Mode == "deep" {
		for _, q := range req.DeepQueries {
			if !isReadOnlyQuery(q) {
				writeErr(w, http.StatusBadRequest, "blocked: non-read-only query rejected: "+q[:min(200, len(q))])
				return
			}
		}
	}

	// ── Set up SSE ────────────────────────────────────────────────────────────
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})

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

	// ── For deep mode: run approved read-only queries ─────────────────────────
	var deepResults []map[string]interface{}
	if req.Mode == "deep" && len(req.DeepQueries) > 0 {
		sendEvent("status", `{"phase":"collecting"}`)
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()

		type qResult struct {
			idx  int
			rows []map[string]interface{}
			err  error
		}
		ch := make(chan qResult, len(req.DeepQueries))
		var wg sync.WaitGroup
		for i, q := range req.DeepQueries {
			i, q := i, q
			wg.Add(1)
			go func() {
				defer wg.Done()
				rows, err := client.Query(ctx, q)
				ch <- qResult{idx: i, rows: rows, err: err}
			}()
		}
		wg.Wait()
		close(ch)

		deepResults = make([]map[string]interface{}, len(req.DeepQueries))
		for res := range ch {
			if res.err != nil {
				slog.Warn("analyze-element: deep query error", "idx", res.idx, "err", res.err)
				continue
			}
			// Merge rows into a single summary map per query slot
			if len(res.rows) > 0 {
				deepResults[res.idx] = res.rows[0]
				if len(res.rows) > 1 {
					// Store full array as "rows" key
					deepResults[res.idx] = map[string]interface{}{"rows": res.rows}
				}
			}
		}
	}

	sendEvent("status", `{"phase":"sending"}`)

	// ── Build prompt ──────────────────────────────────────────────────────────
	prompt := buildElementPrompt(req, instance, deepResults)

	const maxPromptBytes = 1 << 20
	if len(prompt) > maxPromptBytes {
		prompt = prompt[:maxPromptBytes] + "\n\n[...truncated...]"
	}

	// ── Spawn claude CLI ──────────────────────────────────────────────────────
	claudeBin, err := claudeBinary()
	if err != nil {
		sendEvent("error", jsonStr(err.Error()))
		return
	}

	claudeCtx, claudeCancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer claudeCancel()

	claudeArgs := []string{"-p", "-"}
	if m := os.Getenv("CLAUDE_MODEL"); m != "" {
		claudeArgs = append(claudeArgs, "--model", m)
	}
	claudeArgs = appendClaudeFlags(claudeArgs)
	cmd := exec.CommandContext(claudeCtx, claudeBin, claudeArgs...)

	claudeEnv := os.Environ()
	claudeEnv = setEnv(claudeEnv, "PATH",
		"/home/ec2-user/.local/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin:"+os.Getenv("PATH"))

	claudeCfgHome := findClaudeHome()
	if claudeCfgHome != "" {
		claudeEnv = setEnv(claudeEnv, "HOME", claudeCfgHome)
	} else if tmpHome, err2 := os.MkdirTemp("", "claude-home-*"); err2 == nil {
		claudeEnv = setEnv(claudeEnv, "HOME", tmpHome)
		cfgPath := filepath.Join(tmpHome, ".claude.json")
		_ = os.WriteFile(cfgPath, []byte(buildClaudeCfg()), 0600)
		defer os.RemoveAll(tmpHome)
	}
	cmd.Env = claudeEnv
	cmd.Stdin = strings.NewReader(prompt)

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
		sendEvent("error", jsonStr("Claude CLI failed to start: "+err.Error()))
		return
	}

	sendEvent("status", `{"phase":"streaming"}`)

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 128*1024), 128*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.Contains(line, "API Error: 401") ||
				strings.Contains(line, `"authentication_error"`) ||
				strings.Contains(line, "Invalid authentication credentials") {
				sendEvent("auth_error", jsonStr("Your Claude session has expired. Click the lock icon in the top bar to re-authenticate."))
				claudeCancel()
				return
			}
			if strings.Contains(line, "API Error: 429") || strings.Contains(line, `"code":"1302"`) {
				sendEvent("error", jsonStr("Rate limited (429) — wait ~60 seconds and retry."))
				claudeCancel()
				return
			}
			sendEvent("chunk", jsonStr(line+"\n"))
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(stderrPipe)
		var lines []string
		for scanner.Scan() {
			lines = append(lines, scanner.Text())
		}
		if len(lines) > 0 {
			sendEvent("stderr", jsonStr(strings.Join(lines, "\n")))
		}
	}()
	wg.Wait()
	_ = cmd.Wait()
	sendEvent("status", `{"phase":"done"}`)
}

// buildElementPrompt constructs a focused prompt for element-level analysis.
// chSchemaReviewSkill is the content of ~/.claude/commands/ch-schema-review.md
// embedded here so the server-side Claude receives it without needing local skills.
const chSchemaReviewSkill = `
## ClickHouse Schema Review Checklist

### 1. Primary Key / ORDER BY vs Query Patterns

**Rule — Index prefix check:**
- ClickHouse's sparse index only prunes granules using a **left-prefix** of the ORDER BY.
- A query is efficient if **the first ORDER BY column is present** in the WHERE clause.
- A query degrades to a partial/full scan **only when the first ORDER BY column is entirely absent** from the WHERE clause.
- Do NOT label a query as "full scan" solely because a non-prefix column appears in WHERE together with the prefix key.

Flag only queries where the first ORDER BY key is missing.

**Recommendation:** If multiple query patterns have different "natural" first keys, pick the one used by the highest-traffic or most critical queries as the ORDER BY prefix. Document the trade-off.

### 2. PARTITION BY

- Tables should have PARTITION BY toYYYYMM(time_column) or equivalent.
- Missing PARTITION BY: no partition pruning, expensive TTL drops, slow mutations.
- Verify partition key expression is derivable from ORDER BY columns (ClickHouse requirement).

### 3. Skip Indexes for Non-Key Filter Columns

Choose index type based on cardinality:
- Low cardinality (< ~100 distinct values): TYPE set(N) — deterministic, best skip rate
- High cardinality or unknown: TYPE bloom_filter — probabilistic
- Numeric ranges: TYPE minmax
- Do NOT recommend skip indexes for columns already in the ORDER BY prefix — redundant.

**Effectiveness rule:** Skip indexes only work when values are clustered within granules (i.e. the column is in ORDER BY or has low cardinality). High-cardinality columns not in ORDER BY will have near-100% false positive rate — every granule matches. Fix: add the column to ORDER BY instead.

### 4. ReplacingMergeTree Version Column

- ReplacingMergeTree without an explicit version column: deduplication is non-deterministic.
- Flag any ReplacingMergeTree/SharedReplacingMergeTree that omits the version argument.
- Recommend using updatedAt or equivalent as the version column.

### 5. Schema Drift

When both primary and backup/mirror tables are present:
- Flag missing columns in backup vs primary.
- Check DateTime vs DateTime64(3) precision — backup tables using DateTime lose sub-second precision.
- Check that ReplacingMergeTree version columns are consistent.

### 6. Output Format

Produce:
1. **Per-table verdict** (ORDER BY assessment, PARTITION BY, skip index gaps, version column)
2. **Schema drift table** (only if backup/mirror tables present)
3. **Prioritized action list** — P0 / P1 / P2
   - P0 = correctness/full-scan risk on top queries
   - P1 = significant performance gap
   - P2 = schema hygiene / future-proofing
`

func buildElementPrompt(req analyzeElementRequest, instance string, deepResults []map[string]interface{}) string {
	fmtJSON := func(v interface{}) string {
		if v == nil {
			return "null"
		}
		b, _ := json.MarshalIndent(v, "", "  ")
		return string(b)
	}

	tabLabels := map[string]string{
		"patterns": "Query Patterns", "failures": "Failures",
		"merges": "Merges & Parts", "mvs": "MV Performance",
		"s3": "S3 Latency", "inserts": "Insert Throughput",
		"metrics": "System Metrics", "diskio": "Disk I/O",
		"scanner": "Table Scanner",
	}
	tabLabel := tabLabels[req.Tab]
	if tabLabel == "" {
		tabLabel = req.Tab
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("# ClickHouse Explorer — %s\n\n", req.ContextLabel))
	sb.WriteString(fmt.Sprintf("Instance: %s\nTab: %s\nAnalyzed at: %s\n\n", instance, tabLabel, time.Now().UTC().Format(time.RFC3339)))

	switch req.ContextType {
	case "tab":
		sb.WriteString("## Visible Tab Data\n```json\n" + fmtJSON(req.VisibleData) + "\n```\n\n")

		isSchemaAnalysis := strings.Contains(strings.ToLower(req.ContextLabel), "schema")
		if isSchemaAnalysis {
			sb.WriteString("## Schema Review Guidelines\n")
			sb.WriteString(chSchemaReviewSkill)
			sb.WriteString("\n")
			sb.WriteString(`## Instructions
Apply the schema review checklist above to the data provided. For each table:
1. Check ORDER BY / primary key vs query patterns — flag full-scan risks
2. Check PARTITION BY — flag if missing or suboptimal
3. Recommend skip indexes only where effective (respect cardinality rules)
4. Flag ReplacingMergeTree without version column
5. Note any schema drift between primary and mirror tables

Produce the structured output format: per-table verdict, drift table if applicable, and prioritized P0/P1/P2 action list.
Use 🔴 CRITICAL, 🟠 WARNING, 🟡 INFO severity markers.
`)
		} else {
			sb.WriteString(fmt.Sprintf(`## Instructions
Analyze the %s data above. Provide:
1. Key observations and notable patterns
2. Anomalies, warning signs, or concerning values
3. Specific, actionable recommendations

Use severity markers: 🔴 CRITICAL, 🟠 WARNING, 🟡 INFO
Be concise and focus on what matters most.
`, tabLabel))
		}

	case "row":
		if req.Mode == "deep" && len(deepResults) > 0 {
			sb.WriteString("## Deep Diagnostic Data (from ClickHouse)\n")
			for i, r := range deepResults {
				if r != nil {
					sb.WriteString(fmt.Sprintf("### Query %d Result\n```json\n%s\n```\n\n", i+1, fmtJSON(r)))
				}
			}
			sb.WriteString(fmt.Sprintf(`## Instructions
Perform a deep analysis of this %s entry. Cover:
1. Root cause analysis based on the diagnostic data
2. Performance characteristics and what they indicate
3. Specific fixes with ready-to-run SQL if applicable
4. What to monitor going forward

Use severity markers: 🔴 CRITICAL, 🟠 WARNING, 🟡 INFO
Be specific and reference actual values from the data.
`, tabLabel))
		} else {
			sb.WriteString("## This Entry\n```json\n" + fmtJSON(req.VisibleData["row"]) + "\n```\n\n")
			if ctx, ok := req.VisibleData["allPatterns"]; ok {
				sb.WriteString("## All Patterns (Context)\n```json\n" + fmtJSON(ctx) + "\n```\n\n")
			} else if ctx, ok := req.VisibleData["allErrors"]; ok {
				sb.WriteString("## All Errors (Context)\n```json\n" + fmtJSON(ctx) + "\n```\n\n")
			} else if ctx, ok := req.VisibleData["allViews"]; ok {
				sb.WriteString("## All Views (Context)\n```json\n" + fmtJSON(ctx) + "\n```\n\n")
			} else if ctx, ok := req.VisibleData["allTables"]; ok {
				sb.WriteString("## All Tables (Context)\n```json\n" + fmtJSON(ctx) + "\n```\n\n")
			} else if ctx, ok := req.VisibleData["allQueries"]; ok {
				sb.WriteString("## Related Entries (Context)\n```json\n" + fmtJSON(ctx) + "\n```\n\n")
			}
			sb.WriteString(fmt.Sprintf(`## Instructions
Explain this specific %s entry compared to the others shown. Cover:
1. What this entry represents and why its values are notable
2. How it compares to other entries in the same view
3. What to investigate or action next

Be concise. Use 🔴 CRITICAL, 🟠 WARNING, 🟡 INFO for severity.
`, tabLabel))
		}

	case "chart":
		if chartData, ok := req.VisibleData["data"]; ok {
			sb.WriteString("## Time-Series Data\n```json\n" + fmtJSON(chartData) + "\n```\n\n")
		}
		if series, ok := req.VisibleData["series"]; ok {
			sb.WriteString("## Series\n```json\n" + fmtJSON(series) + "\n```\n\n")
		}
		sb.WriteString(`## Instructions
Analyze this time-series chart. Cover:
1. **Trend**: overall direction (increasing, decreasing, stable, cyclical)
2. **Anomalies**: identify spikes, drops, gaps, or unusual patterns with approximate timestamps
3. **Meaning**: what these patterns indicate about the ClickHouse cluster health
4. **Action**: recommend specific steps if concerning patterns exist

Use 🔴 CRITICAL, 🟠 WARNING, 🟡 INFO for severity.
If the chart looks normal, say so clearly — do not invent issues.
`)

	case "followup":
		if history, ok := req.VisibleData["history"]; ok {
			sb.WriteString("## Previous Analysis\n```json\n" + fmtJSON(history) + "\n```\n\n")
		}
		question := ""
		if q, ok := req.VisibleData["question"].(string); ok {
			question = q
		}
		if question == "" {
			question = "Please summarize and provide additional insights."
		}
		sb.WriteString("## User Question\n" + question + "\n\n")
		sb.WriteString(`## Instructions
Answer the user's question above using the previous analysis context.
Be specific and reference relevant data points from the analysis history.
Use 🔴 CRITICAL, 🟠 WARNING, 🟡 INFO severity markers where appropriate.
Keep the response focused and actionable.
`)
	}

	return sb.String()
}

// ---------------------------------------------------------------------------
// GET /api/instances/{name}/analyze-element/queries — preview deep queries
// ---------------------------------------------------------------------------

type deepQueryItem struct {
	SQL         string `json:"sql"`
	Description string `json:"description"`
}

type analyzeElementQueriesResponse struct {
	Queries     []deepQueryItem `json:"queries"`
	Description string          `json:"description"`
}

func (s *Server) handleAnalyzeElementQueries(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	if s.manager.Get(instance) == nil {
		writeErr(w, http.StatusNotFound, "instance not found: "+instance)
		return
	}

	tab := r.URL.Query().Get("tab")
	elementID := r.URL.Query().Get("element_id")

	queries := deepQueriesForTab(tab, elementID)
	if len(queries) == 0 {
		writeErr(w, http.StatusBadRequest, "no deep queries available for tab: "+tab)
		return
	}

	n := len(queries)
	noun := "query"
	if n != 1 {
		noun = "queries"
	}
	desc := fmt.Sprintf("This will run %d read-only %s against %s to fetch detailed diagnostics.", n, noun, instance)

	writeJSON(w, http.StatusOK, analyzeElementQueriesResponse{
		Queries:     queries,
		Description: desc,
	})
}

// deepQueriesForTab returns the set of read-only diagnostic queries for a tab.
// elementID is validated-safe data from the frontend (originally from CH),
// still escaped before embedding in SQL strings.
func deepQueriesForTab(tab, elementID string) []deepQueryItem {
	safe := escapeSQLString(elementID)

	switch tab {
	case "patterns":
		if elementID == "" {
			return nil
		}
		return []deepQueryItem{
			{
				SQL: fmt.Sprintf(`SELECT
  query,
  query_duration_ms,
  formatReadableSize(memory_usage) AS memory,
  read_rows,
  formatReadableSize(read_bytes) AS read_bytes,
  written_rows,
  result_rows,
  user,
  exception_code,
  event_time
FROM system.query_log
WHERE normalized_query_hash = '%s'
  AND event_time >= now() - INTERVAL 24 HOUR
ORDER BY event_time DESC
LIMIT 20`, safe),
				Description: "Recent executions of this query pattern (last 24h)",
			},
			{
				SQL: fmt.Sprintf(`SELECT
  count() AS executions,
  round(avg(query_duration_ms)) AS avg_ms,
  round(max(query_duration_ms)) AS max_ms,
  formatReadableSize(round(avg(memory_usage))) AS avg_memory,
  countIf(exception_code != 0) AS failures
FROM system.query_log
WHERE normalized_query_hash = '%s'
  AND event_time >= now() - INTERVAL 7 DAY
  AND type IN ('QueryFinish', 'ExceptionWhileProcessing')`, safe),
				Description: "7-day aggregate stats for this query pattern",
			},
		}

	case "failures":
		if elementID == "" {
			return nil
		}
		return []deepQueryItem{
			{
				SQL: fmt.Sprintf(`SELECT
  exception_code,
  exception,
  query,
  user,
  event_time,
  query_duration_ms
FROM system.query_log
WHERE exception_code = %s
  AND event_time >= now() - INTERVAL 24 HOUR
ORDER BY event_time DESC
LIMIT 20`, safe),
				Description: "Recent errors with this exception code (last 24h)",
			},
		}

	case "merges":
		return []deepQueryItem{
			{
				SQL: `SELECT database, table, elapsed,
  round(progress*100, 1) AS pct,
  num_parts,
  is_mutation,
  formatReadableSize(total_size_bytes_compressed) AS size
FROM system.merges
ORDER BY elapsed DESC`,
				Description: "Currently active merges",
			},
			{
				SQL: `SELECT database, table,
  count() AS parts,
  formatReadableSize(sum(bytes_on_disk)) AS size,
  max(modification_time) AS newest_part
FROM system.parts
WHERE active = 1
GROUP BY database, table
HAVING parts > 50
ORDER BY parts DESC
LIMIT 20`,
				Description: "Tables with elevated part counts (>50)",
			},
		}

	case "mvs":
		if elementID == "" {
			return nil
		}
		return []deepQueryItem{
			{
				SQL: fmt.Sprintf(`SELECT
  view_name,
  count() AS cnt,
  round(avg(view_duration_ms)) AS avg_ms,
  round(max(view_duration_ms)) AS max_ms,
  countIf(exception_code != 0) AS failures,
  any(exception) AS sample_error
FROM system.query_views_log
WHERE view_name = '%s'
  AND event_time >= now() - INTERVAL 24 HOUR
GROUP BY view_name`, safe),
				Description: "Execution stats for this materialized view (last 24h)",
			},
		}

	case "s3":
		return []deepQueryItem{
			{
				SQL: `SELECT
  user,
  count() AS queries,
  formatReadableSize(sum(ProfileEvents['S3ReadBytes'])) AS total_read,
  formatReadableSize(sum(ProfileEvents['S3WriteBytes'])) AS total_write,
  round(avg(ProfileEvents['S3ReadMicroseconds']) / 1000) AS avg_read_ms
FROM system.query_log
WHERE (ProfileEvents['S3ReadBytes'] > 0 OR ProfileEvents['S3WriteBytes'] > 0)
  AND event_time >= now() - INTERVAL 24 HOUR
  AND type = 'QueryFinish'
GROUP BY user
ORDER BY sum(ProfileEvents['S3ReadBytes']) DESC
LIMIT 20`,
				Description: "S3 usage breakdown by user (last 24h)",
			},
		}

	case "inserts":
		if elementID == "" {
			return nil
		}
		return []deepQueryItem{
			{
				SQL: fmt.Sprintf(`SELECT
  tables[1] AS tbl,
  count() AS inserts,
  round(avg(written_rows)) AS avg_rows,
  round(max(written_rows)) AS max_rows,
  countIf(written_rows < 100) AS small_inserts,
  round(avg(query_duration_ms)) AS avg_ms,
  round(max(query_duration_ms)) AS max_ms
FROM system.query_log
WHERE query_kind = 'Insert'
  AND has(tables, '%s')
  AND event_time >= now() - INTERVAL 24 HOUR
  AND type = 'QueryFinish'
GROUP BY tables[1]`, safe),
				Description: "Insert patterns for this table (last 24h)",
			},
		}

	case "metrics":
		return []deepQueryItem{
			{
				SQL: `SELECT metric, value, description
FROM system.metrics
ORDER BY metric
LIMIT 100`,
				Description: "Current system metrics snapshot",
			},
		}

	case "diskio":
		return []deepQueryItem{
			{
				SQL: `SELECT name, path,
  formatReadableSize(free_space) AS free,
  formatReadableSize(total_space) AS total,
  round(100*(1 - free_space/total_space), 1) AS used_pct
FROM system.disks`,
				Description: "Disk usage details",
			},
		}
	}
	return nil
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
