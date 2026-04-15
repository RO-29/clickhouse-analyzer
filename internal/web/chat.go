package web

import (
	"bytes"
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// ---------------------------------------------------------------------------
// POST /api/instances/{name}/chat — agentic ClickHouse chat with tool use
// ---------------------------------------------------------------------------

type chatRequest struct {
	Question       string           `json:"question"`
	History        []chatHistoryMsg `json:"history"`
	TimeWindowMins int              `json:"time_window_mins"`
}

type chatHistoryMsg struct {
	Role    string `json:"role"`    // "user" | "assistant"
	Content string `json:"content"`
}

// ---------------------------------------------------------------------------
// Anthropic API types (minimal, raw HTTP)
// ---------------------------------------------------------------------------

type anthropicRequest struct {
	Model     string             `json:"model"`
	MaxTokens int                `json:"max_tokens"`
	System    string             `json:"system,omitempty"`
	Messages  []anthropicMessage `json:"messages"`
	Tools     []anthropicTool    `json:"tools,omitempty"`
	Stream    bool               `json:"stream,omitempty"`
}

// anthropicMessage.Content can be string OR []anthropicContent.
type anthropicMessage struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
}

type anthropicContent struct {
	Type       string      `json:"type"`
	Text       string      `json:"text,omitempty"`
	ID         string      `json:"id,omitempty"`
	Name       string      `json:"name,omitempty"`
	Input      interface{} `json:"input,omitempty"`
	ToolUseID  string      `json:"tool_use_id,omitempty"`
	Content    interface{} `json:"content,omitempty"` // for tool_result
	IsError    bool        `json:"is_error,omitempty"`
}

type anthropicTool struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"input_schema"`
}

type anthropicResponse struct {
	ID           string             `json:"id"`
	Type         string             `json:"type"`
	Role         string             `json:"role"`
	Content      []anthropicContent `json:"content"`
	StopReason   string             `json:"stop_reason"`
	Model        string             `json:"model"`
	ErrorMessage string             `json:"-"`
}

// anthropicError is returned when the API responds with a non-200 status.
type anthropicError struct {
	Type  string `json:"type"`
	Error struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

// ---------------------------------------------------------------------------
// SSE event helpers
// ---------------------------------------------------------------------------

type statusEvent struct {
	Phase string `json:"phase"`
}

type thinkingEvent struct {
	Text string `json:"text"`
}

type toolStartEvent struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Label string `json:"label"`
	SQL   string `json:"sql,omitempty"`
}

type toolDoneEvent struct {
	ID        string `json:"id"`
	ElapsedMs int64  `json:"elapsed_ms"`
	Rows      int    `json:"rows"`
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

func chatTools() []anthropicTool {
	prop := func(desc string) map[string]interface{} {
		return map[string]interface{}{"type": "string", "description": desc}
	}
	propInt := func(desc string) map[string]interface{} {
		return map[string]interface{}{"type": "integer", "description": desc}
	}

	return []anthropicTool{
		{
			Name:        "execute_sql",
			Description: "Execute a read-only SQL query on the ClickHouse instance. Returns up to 200 rows as JSON. Use this for custom diagnostics.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"sql":         prop("The SQL query to execute. Must be read-only (SELECT, SHOW, DESCRIBE, EXPLAIN, WITH)."),
					"description": prop("Short human-readable description of what this query investigates."),
				},
				"required": []string{"sql", "description"},
			},
		},
		{
			Name:        "get_cluster_health",
			Description: "Get overall cluster health: active queries, merges, mutations, replication queue, disk usage, uptime, version.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			Name:        "get_slow_queries",
			Description: "Get top slow queries from query_log for the given time window.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"time_window_mins": propInt("How far back to look in minutes (default 60)."),
					"limit":            propInt("Number of results (default 15, max 50)."),
					"order_by":         prop("Sort field: avg_sec (default) | max_sec | avg_mem_mb | cnt"),
				},
				"required": []string{},
			},
		},
		{
			Name:        "get_error_patterns",
			Description: "Get recent error patterns from query_log.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"time_window_mins": propInt("How far back to look in minutes (default 60)."),
					"limit":            propInt("Number of results (default 20)."),
				},
			},
		},
		{
			Name:        "get_merge_stats",
			Description: "Get currently active merges from system.merges.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			Name:        "get_parts_health",
			Description: "Get tables with high part counts from system.parts.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"min_parts": propInt("Only show tables with at least this many active parts (default 1)."),
				},
			},
		},
		{
			Name:        "get_insert_patterns",
			Description: "Get insert statistics from query_log for the given time window.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"time_window_mins": propInt("How far back to look in minutes (default 60)."),
				},
			},
		},
	}
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

type toolExecResult struct {
	Rows  []map[string]interface{}
	Error string
}

func (s *Server) executeTool(
	ctx context.Context,
	instance string,
	toolName string,
	input map[string]interface{},
) toolExecResult {
	client := s.manager.Get(instance)
	if client == nil {
		return toolExecResult{Error: "instance not found: " + instance}
	}
	return runToolOnClient(ctx, client, toolName, input)
}

// runToolOnClient executes a named tool against a CH client directly.
// Used by both the Server (Mode A/B) and the MCP stdio server subprocess.
func runToolOnClient(
	ctx context.Context,
	client *chclient.Client,
	toolName string,
	input map[string]interface{},
) toolExecResult {
	getInt := func(key string, def int) int {
		if v, ok := input[key]; ok {
			switch n := v.(type) {
			case float64:
				return int(n)
			case int:
				return n
			}
		}
		return def
	}
	getString := func(key, def string) string {
		if v, ok := input[key]; ok {
			if s, ok := v.(string); ok {
				return s
			}
		}
		return def
	}

	timeRange := func(mins int) (string, string) {
		from := time.Now().Add(-time.Duration(mins) * time.Minute).UTC().Format("2006-01-02 15:04:05")
		to := time.Now().UTC().Format("2006-01-02 15:04:05")
		return from, to
	}

	var sql string

	switch toolName {
	case "execute_sql":
		rawSQL := getString("sql", "")
		if rawSQL == "" {
			return toolExecResult{Error: "sql parameter is required"}
		}
		if !isReadOnlyQuery(rawSQL) {
			return toolExecResult{Error: "blocked: only read-only queries are allowed (SELECT, SHOW, DESCRIBE, EXPLAIN, WITH)"}
		}
		sql = rawSQL

	case "get_cluster_health":
		sql = `SELECT
  (SELECT count() FROM system.processes WHERE query != '') AS active_queries,
  (SELECT count() FROM system.merges) AS active_merges,
  (SELECT count() FROM system.mutations WHERE NOT is_done) AS pending_mutations,
  (SELECT sum(queue_size) FROM system.replicas) AS replication_queue,
  (SELECT formatReadableSize(sum(free_space)) FROM system.disks) AS free_disk,
  (SELECT formatReadableSize(sum(total_space)) FROM system.disks) AS total_disk,
  (SELECT round(100*(1 - avg(free_space/total_space)), 1) FROM system.disks) AS disk_used_pct,
  uptime() AS uptime_seconds,
  version() AS version`

	case "get_slow_queries":
		mins := getInt("time_window_mins", 60)
		limit := getInt("limit", 15)
		if limit > 50 {
			limit = 50
		}
		orderBy := getString("order_by", "avg_sec")
		allowed := map[string]bool{"avg_sec": true, "max_sec": true, "avg_mem_mb": true, "cnt": true}
		if !allowed[orderBy] {
			orderBy = "avg_sec"
		}
		from, to := timeRange(mins)
		sql = fmt.Sprintf(`SELECT
  normalized_query_hash,
  count() AS cnt,
  round(avg(query_duration_ms)/1000, 2) AS avg_sec,
  round(max(query_duration_ms)/1000, 2) AS max_sec,
  round(avg(memory_usage)/1e6, 1) AS avg_mem_mb,
  round(avg(read_rows)/1e6, 2) AS avg_read_M_rows,
  any(user) AS user,
  substring(any(query), 1, 300) AS sample_query
FROM system.query_log
WHERE type = 'QueryFinish'
  AND is_initial_query = 1
  AND event_time BETWEEN '%s' AND '%s'
GROUP BY normalized_query_hash
ORDER BY %s DESC
LIMIT %d`, from, to, orderBy, limit)

	case "get_error_patterns":
		mins := getInt("time_window_mins", 60)
		limit := getInt("limit", 20)
		from, to := timeRange(mins)
		sql = fmt.Sprintf(`SELECT
  exception_code,
  count() AS cnt,
  any(exception) AS sample_msg,
  any(user) AS user,
  any(substring(query, 1, 200)) AS sample_query
FROM system.query_log
WHERE type = 'ExceptionWhileProcessing'
  AND is_initial_query = 1
  AND event_time BETWEEN '%s' AND '%s'
GROUP BY exception_code
ORDER BY cnt DESC
LIMIT %d`, from, to, limit)

	case "get_merge_stats":
		sql = `SELECT
  database, table, elapsed,
  round(progress*100, 1) AS pct,
  num_parts,
  result_part_name,
  is_mutation,
  formatReadableSize(total_size_bytes_compressed) AS size
FROM system.merges
ORDER BY elapsed DESC
LIMIT 20`

	case "get_parts_health":
		minParts := getInt("min_parts", 1)
		sql = fmt.Sprintf(`SELECT
  database, table,
  count() AS total_parts,
  countIf(active) AS active_parts,
  formatReadableSize(sum(bytes_on_disk)) AS size_on_disk,
  uniqExact(partition) AS partitions
FROM system.parts
WHERE active = 1
GROUP BY database, table
HAVING active_parts >= %d
ORDER BY active_parts DESC
LIMIT 30`, minParts)

	case "get_insert_patterns":
		mins := getInt("time_window_mins", 60)
		from, to := timeRange(mins)
		sql = fmt.Sprintf(`SELECT
  databases[1] AS db,
  tables[1] AS tbl,
  count() AS insert_count,
  round(avg(written_rows)) AS avg_rows,
  sum(written_rows) AS total_rows,
  countIf(written_rows < 100) AS small_inserts
FROM system.query_log
WHERE type = 'QueryFinish'
  AND query_kind = 'Insert'
  AND is_initial_query = 1
  AND event_time BETWEEN '%s' AND '%s'
GROUP BY db, tbl
ORDER BY insert_count DESC
LIMIT 15`, from, to)

	default:
		return toolExecResult{Error: "unknown tool: " + toolName}
	}

	rows, err := client.Query(ctx, sql)
	if err != nil {
		return toolExecResult{Error: err.Error()}
	}

	// Cap at 200 rows.
	if len(rows) > 200 {
		rows = rows[:200]
	}

	return toolExecResult{Rows: rows}
}

// toolResultJSON serialises the result and enforces a 50 KB cap.
func toolResultJSON(res toolExecResult) string {
	if res.Error != "" {
		b, _ := json.Marshal(map[string]string{"error": res.Error})
		return string(b)
	}
	b, _ := json.Marshal(res.Rows)
	const maxBytes = 50 * 1024
	if len(b) > maxBytes {
		// Truncate rows until it fits.
		rows := res.Rows
		for len(rows) > 0 && len(b) > maxBytes {
			rows = rows[:len(rows)/2]
			b, _ = json.Marshal(rows)
		}
		type truncated struct {
			Rows     []map[string]interface{} `json:"rows"`
			Truncated bool                    `json:"truncated"`
			Note     string                   `json:"note"`
		}
		b, _ = json.Marshal(truncated{
			Rows:     rows,
			Truncated: true,
			Note:     fmt.Sprintf("result truncated to %d rows to fit 50 KB limit", len(rows)),
		})
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// Mode A: Direct Anthropic API
// ---------------------------------------------------------------------------

// callAnthropic sends a single request to the Anthropic messages API and
// returns the parsed response. It does NOT stream.
func callAnthropic(ctx context.Context, apiKey string, req anthropicRequest) (*anthropicResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.anthropic.com/v1/messages", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("http do: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		var apiErr anthropicError
		if json.Unmarshal(respBody, &apiErr) == nil && apiErr.Error.Message != "" {
			return nil, fmt.Errorf("anthropic API error %d: %s", resp.StatusCode, apiErr.Error.Message)
		}
		return nil, fmt.Errorf("anthropic API error %d: %s", resp.StatusCode, string(respBody))
	}

	var result anthropicResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("unmarshal response: %w", err)
	}
	return &result, nil
}

// streamAnthropic sends a streaming request to the Anthropic messages API and
// calls onChunk for each text delta. Returns the full concatenated text.
func streamAnthropic(ctx context.Context, apiKey string, req anthropicRequest, onChunk func(string)) error {
	req.Stream = true
	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("marshal stream request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.anthropic.com/v1/messages", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build stream request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("http do stream: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		var apiErr anthropicError
		if json.Unmarshal(body, &apiErr) == nil && apiErr.Error.Message != "" {
			return fmt.Errorf("anthropic stream error %d: %s", resp.StatusCode, apiErr.Error.Message)
		}
		return fmt.Errorf("anthropic stream error %d: %s", resp.StatusCode, string(body))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 64*1024)

	var eventType string
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event: ") {
			eventType = strings.TrimPrefix(line, "event: ")
			continue
		}
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			break
		}
		if eventType != "content_block_delta" {
			continue
		}

		var delta struct {
			Type  string `json:"type"`
			Delta struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"delta"`
		}
		if err := json.Unmarshal([]byte(data), &delta); err != nil {
			continue
		}
		if delta.Delta.Type == "text_delta" && delta.Delta.Text != "" {
			onChunk(delta.Delta.Text)
		}
	}
	return scanner.Err()
}

// handleChatAPI implements Mode A: direct Anthropic API with agentic tool-use loop.
func (s *Server) handleChatAPI(
	ctx context.Context,
	instance string,
	apiKey string,
	req chatRequest,
	sendEvent func(event, data string),
) {
	model := os.Getenv("CLAUDE_MODEL")
	if model == "" {
		model = "claude-opus-4-5-20251101"
	}

	systemPrompt := fmt.Sprintf(
		"You are an expert ClickHouse DBA assistant. The instance is %s.\n"+
			"You have access to tools to query ClickHouse system tables directly.\n"+
			"When answering questions about the cluster, use your tools to get real data.\n"+
			"Always use execute_sql or the specific helper tools before giving recommendations.\n"+
			"Format your response in clear markdown with sections, tables where useful, and specific SQL recommendations.\n"+
			"Severity levels: 🔴 CRITICAL | 🟠 WARNING | 🟡 INFO",
		instance,
	)

	// Build initial messages from history + current question.
	var messages []anthropicMessage
	for _, h := range req.History {
		messages = append(messages, anthropicMessage{
			Role:    h.Role,
			Content: h.Content,
		})
	}
	messages = append(messages, anthropicMessage{
		Role:    "user",
		Content: req.Question,
	})

	tools := chatTools()

	// Agentic tool-use loop.
	sendEvent("status", `{"phase":"planning"}`)

	toolCallCount := 0
	const maxToolCalls = 20 // safety cap

	for {
		if toolCallCount >= maxToolCalls {
			slog.Warn("chat: reached max tool call limit", "instance", instance, "limit", maxToolCalls)
			break
		}

		apiReq := anthropicRequest{
			Model:     model,
			MaxTokens: 8192,
			System:    systemPrompt,
			Messages:  messages,
			Tools:     tools,
			Stream:    false,
		}

		resp, err := callAnthropic(ctx, apiKey, apiReq)
		if err != nil {
			slog.Error("chat: anthropic API error", "instance", instance, "err", err)
			sendEvent("error", jsonStr(err.Error()))
			return
		}

		// Emit any text content as thinking events.
		for _, block := range resp.Content {
			if block.Type == "text" && block.Text != "" {
				if b, err := json.Marshal(thinkingEvent{Text: block.Text}); err == nil {
					sendEvent("thinking", string(b))
				}
			}
		}

		// Add assistant message to history.
		messages = append(messages, anthropicMessage{
			Role:    "assistant",
			Content: resp.Content,
		})

		if resp.StopReason != "tool_use" {
			// No more tool calls — move to streaming final response.
			break
		}

		// Collect tool_use blocks.
		var toolUseBlocks []anthropicContent
		for _, block := range resp.Content {
			if block.Type == "tool_use" {
				toolUseBlocks = append(toolUseBlocks, block)
			}
		}
		if len(toolUseBlocks) == 0 {
			break
		}

		sendEvent("status", `{"phase":"collecting"}`)

		// Execute tool calls in parallel.
		type toolResult struct {
			id        string
			name      string
			resultJSON string
		}
		results := make([]toolResult, len(toolUseBlocks))
		var wg sync.WaitGroup

		for i, block := range toolUseBlocks {
			i, block := i, block
			wg.Add(1)
			go func() {
				defer wg.Done()

				// Parse input map.
				var inputMap map[string]interface{}
				switch v := block.Input.(type) {
				case map[string]interface{}:
					inputMap = v
				default:
					if b, err := json.Marshal(block.Input); err == nil {
						json.Unmarshal(b, &inputMap) //nolint:errcheck
					}
				}
				if inputMap == nil {
					inputMap = map[string]interface{}{}
				}

				// Emit tool_start event.
				toolLabel := inputMap["description"]
				if toolLabel == nil {
					toolLabel = block.Name
				}
				startEvt := toolStartEvent{
					ID:    block.ID,
					Name:  block.Name,
					Label: fmt.Sprintf("%v", toolLabel),
				}
				if sql, ok := inputMap["sql"].(string); ok {
					startEvt.SQL = sql
				}
				if b, err := json.Marshal(startEvt); err == nil {
					sendEvent("tool_start", string(b))
				}

				t0 := time.Now()
				res := s.executeTool(ctx, instance, block.Name, inputMap)
				elapsed := time.Since(t0).Milliseconds()

				rowCount := len(res.Rows)
				doneEvt := toolDoneEvent{
					ID:        block.ID,
					ElapsedMs: elapsed,
					Rows:      rowCount,
				}
				if b, err := json.Marshal(doneEvt); err == nil {
					sendEvent("tool_done", string(b))
				}

				results[i] = toolResult{
					id:         block.ID,
					name:       block.Name,
					resultJSON: toolResultJSON(res),
				}
			}()
		}
		wg.Wait()
		toolCallCount += len(toolUseBlocks)

		// Build tool_result message.
		var resultContents []anthropicContent
		for _, r := range results {
			resultContents = append(resultContents, anthropicContent{
				Type:      "tool_result",
				ToolUseID: r.id,
				Content:   r.resultJSON,
			})
		}
		messages = append(messages, anthropicMessage{
			Role:    "user",
			Content: resultContents,
		})
	}

	// Final streaming response — build a fresh request without tools to get
	// a clean streaming answer based on all the tool results gathered.
	sendEvent("status", `{"phase":"streaming"}`)

	// Build final messages: strip the tools from this last request so
	// Claude produces a final text answer, not another tool call.
	finalReq := anthropicRequest{
		Model:     model,
		MaxTokens: 8192,
		System:    systemPrompt,
		Messages:  messages,
		Stream:    true,
	}

	err := streamAnthropic(ctx, apiKey, finalReq, func(chunk string) {
		sendEvent("chunk", jsonStr(chunk))
	})
	if err != nil {
		slog.Error("chat: stream error", "instance", instance, "err", err)
		sendEvent("error", jsonStr(err.Error()))
		return
	}

	sendEvent("status", `{"phase":"done"}`)
}

// ---------------------------------------------------------------------------
// Mode B: Two-pass claude CLI fallback
// ---------------------------------------------------------------------------

type chatPlanQuery struct {
	Label string `json:"label"`
	SQL   string `json:"sql"`
}

type chatPlan struct {
	Queries []chatPlanQuery `json:"queries"`
}

func (s *Server) handleChatCLI(
	ctx context.Context,
	instance string,
	req chatRequest,
	sendEvent func(event, data string),
) {
	claudeBin, err := claudeBinary()
	if err != nil {
		slog.Warn("chat: claude CLI not available", "err", err)
		sendEvent("error", jsonStr("Claude CLI not available: "+err.Error()))
		return
	}

	if s.manager.Get(instance) == nil {
		sendEvent("error", jsonStr("instance not found: "+instance))
		return
	}

	// ── Try MCP-backed single-pass if we have a config path ──────────────────
	if s.configPath != "" {
		s.handleChatCLIWithMCP(ctx, claudeBin, instance, req, sendEvent)
		return
	}

	client := s.manager.Get(instance)

	sendEvent("status", `{"phase":"planning"}`)

	// ── Pass 1: Ask Claude to produce a JSON query plan ───────────────────────
	planPrompt := fmt.Sprintf(
		"User asks: %q. List up to 5 SQL queries to run on ClickHouse system tables to answer this. "+
			`Output ONLY valid JSON: {"queries": [{"label": "...", "sql": "SELECT ... LIMIT 100"}]}. No explanation.`,
		req.Question,
	)

	planCtx, planCancel := context.WithTimeout(ctx, 2*time.Minute)
	defer planCancel()

	planArgs := []string{"-p", "-"}
	model := os.Getenv("CLAUDE_MODEL")
	if model != "" {
		planArgs = append(planArgs, "--model", model)
	}
	planArgs = appendClaudeFlags(planArgs)

	planCmd := exec.CommandContext(planCtx, claudeBin, planArgs...)
	planCmd.Env = buildClaudeEnv()
	planCmd.Stdin = strings.NewReader(planPrompt)

	planOutput, err := planCmd.Output()
	if err != nil {
		slog.Warn("chat: plan pass failed", "err", err)
		sendEvent("error", jsonStr("Planning step failed: "+err.Error()))
		return
	}

	// Extract JSON from the plan output (Claude may wrap it in fences).
	planJSON := extractJSON(string(planOutput))

	var plan chatPlan
	if err := json.Unmarshal([]byte(planJSON), &plan); err != nil {
		slog.Warn("chat: could not parse plan JSON", "raw", string(planOutput), "err", err)
		// Fall through with no queries — still ask Claude with just the question.
		plan = chatPlan{}
	}

	// Validate and filter queries.
	var validQueries []chatPlanQuery
	for _, q := range plan.Queries {
		q.SQL = strings.TrimSpace(q.SQL)
		if q.SQL == "" {
			continue
		}
		if !isReadOnlyQuery(q.SQL) {
			slog.Warn("chat: CLI plan contained non-read-only query, skipping", "sql", q.SQL[:min(100, len(q.SQL))])
			continue
		}
		validQueries = append(validQueries, q)
	}

	// ── Pass 1.5: Run queries in parallel ─────────────────────────────────────
	sendEvent("status", `{"phase":"collecting"}`)

	type queryResult struct {
		label string
		sql   string
		rows  []map[string]interface{}
		err   error
		ms    int64
	}

	results := make([]queryResult, len(validQueries))
	var wg sync.WaitGroup

	for i, q := range validQueries {
		i, q := i, q
		wg.Add(1)
		go func() {
			defer wg.Done()

			startEvt := toolStartEvent{
				ID:    fmt.Sprintf("q%d", i),
				Name:  "execute_sql",
				Label: q.Label,
				SQL:   q.SQL,
			}
			if b, err := json.Marshal(startEvt); err == nil {
				sendEvent("tool_start", string(b))
			}

			t0 := time.Now()
			rows, qErr := client.Query(ctx, q.SQL)
			elapsed := time.Since(t0).Milliseconds()

			if len(rows) > 200 {
				rows = rows[:200]
			}

			doneEvt := toolDoneEvent{
				ID:        fmt.Sprintf("q%d", i),
				ElapsedMs: elapsed,
				Rows:      len(rows),
			}
			if b, err := json.Marshal(doneEvt); err == nil {
				sendEvent("tool_done", string(b))
			}

			results[i] = queryResult{
				label: q.Label,
				sql:   q.SQL,
				rows:  rows,
				err:   qErr,
				ms:    elapsed,
			}
		}()
	}
	wg.Wait()

	// ── Pass 2: Build context + stream final answer ───────────────────────────
	sendEvent("status", `{"phase":"streaming"}`)

	var contextSB strings.Builder
	contextSB.WriteString(fmt.Sprintf("# ClickHouse Instance: %s\n\n", instance))
	contextSB.WriteString(fmt.Sprintf("User question: %s\n\n", req.Question))

	if len(req.History) > 0 {
		contextSB.WriteString("## Conversation History\n")
		for _, h := range req.History {
			contextSB.WriteString(fmt.Sprintf("**%s**: %s\n\n", h.Role, h.Content))
		}
	}

	if len(results) > 0 {
		contextSB.WriteString("## Query Results\n\n")
		for _, r := range results {
			contextSB.WriteString(fmt.Sprintf("### %s\n```sql\n%s\n```\n", r.label, r.sql))
			if r.err != nil {
				contextSB.WriteString(fmt.Sprintf("**Error:** %s\n\n", r.err.Error()))
			} else {
				b, _ := json.MarshalIndent(r.rows, "", "  ")
				contextSB.WriteString(fmt.Sprintf("```json\n%s\n```\n\n", string(b)))
			}
		}
	}

	contextSB.WriteString(`---

You are an expert ClickHouse DBA assistant. Based on the query results above, answer the user's question.
Format your response in clear markdown with sections and tables where useful.
Severity levels: 🔴 CRITICAL | 🟠 WARNING | 🟡 INFO
Provide specific SQL recommendations where applicable.
`)

	finalPrompt := contextSB.String()

	// Trim if too large.
	const maxPromptBytes = 1 << 20
	truncated := len(finalPrompt) > maxPromptBytes
	if truncated {
		finalPrompt = finalPrompt[:maxPromptBytes] + "\n\n[...context truncated...]"
	}

	// Send debug event so the browser can log the full prompt.
	{
		head := finalPrompt
		if len(head) > 5120 {
			head = head[:5120]
		}
		debugPayload := map[string]interface{}{
			"mode":         "cli_two_pass",
			"instance":     instance,
			"plan_queries": len(validQueries),
			"prompt_bytes": len(finalPrompt),
			"prompt_kb":    float64(len(finalPrompt)) / 1024.0,
			"truncated":    truncated,
			"prompt_head":  head,
		}
		if b, err2 := json.Marshal(debugPayload); err2 == nil {
			sendEvent("debug", string(b))
		}
	}

	streamArgs := []string{"-p", "-"}
	if model != "" {
		streamArgs = append(streamArgs, "--model", model)
	}
	streamArgs = appendClaudeFlags(streamArgs)

	streamCtx, streamCancel := context.WithTimeout(ctx, 5*time.Minute)
	defer streamCancel()

	streamCmd := exec.CommandContext(streamCtx, claudeBin, streamArgs...)
	streamCmd.Env = buildClaudeEnv()
	streamCmd.Stdin = strings.NewReader(finalPrompt)

	stdout, err := streamCmd.StdoutPipe()
	if err != nil {
		sendEvent("error", jsonStr("Failed to create stdout pipe: "+err.Error()))
		return
	}
	stderrPipe, err := streamCmd.StderrPipe()
	if err != nil {
		sendEvent("error", jsonStr("Failed to create stderr pipe: "+err.Error()))
		return
	}

	if err := streamCmd.Start(); err != nil {
		slog.Warn("chat: claude CLI stream pass failed to start", "err", err)
		sendEvent("error", jsonStr("Claude CLI failed to start: "+err.Error()))
		return
	}

	var wg2 sync.WaitGroup

	wg2.Add(1)
	go func() {
		defer wg2.Done()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 128*1024), 128*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.Contains(line, "API Error: 401") ||
				strings.Contains(line, `"authentication_error"`) ||
				strings.Contains(line, "Invalid authentication credentials") {
				sendEvent("auth_error", jsonStr("Your Claude session has expired. Click the lock icon in the top bar to re-authenticate."))
				streamCancel()
				return
			}
			if strings.Contains(line, "API Error: 429") || strings.Contains(line, `"code":"1302"`) {
				sendEvent("error", jsonStr("Rate limited (429) — wait ~60 seconds and retry."))
				streamCancel()
				return
			}
			sendEvent("chunk", jsonStr(line+"\n"))
		}
	}()

	wg2.Add(1)
	go func() {
		defer wg2.Done()
		scanner := bufio.NewScanner(stderrPipe)
		var lines []string
		for scanner.Scan() {
			line := scanner.Text()
			slog.Warn("chat: claude stderr", "line", line)
			lines = append(lines, line)
		}
		if len(lines) > 0 {
			slog.Warn("chat: claude stderr output", "instance", instance, "lines", strings.Join(lines, "\n"))
		}
	}()

	wg2.Wait()
	streamCmd.Wait() //nolint:errcheck

	sendEvent("status", `{"phase":"done"}`)
}

// buildClaudeEnv returns the environment for the claude CLI process.
// Inherits all env vars from the parent (including any MCP tokens / secrets),
// augments PATH, and pins HOME to wherever the claude auth config lives.
func buildClaudeEnv() []string {
	env := os.Environ()
	env = setEnv(env,
		"PATH",
		"/home/ec2-user/.local/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin:"+os.Getenv("PATH"),
	)
	claudeCfgHome := findClaudeHome()
	if claudeCfgHome != "" {
		env = setEnv(env, "HOME", claudeCfgHome)
	}
	return env
}

// appendClaudeFlags appends optional env-driven flags to a claude CLI arg slice.
//
//	CLAUDE_ALLOWED_TOOLS  – comma-separated tool patterns  (e.g. "mcp__your-server__*,Bash")
//	CLAUDE_ADD_DIR        – project dir whose CLAUDE.md / skills should be loaded
func appendClaudeFlags(args []string) []string {
	if tools := os.Getenv("CLAUDE_ALLOWED_TOOLS"); tools != "" {
		args = append(args, "--allowedTools", tools)
	}
	if dir := os.Getenv("CLAUDE_ADD_DIR"); dir != "" {
		args = append(args, "--add-dir", dir)
	}
	return args
}

// extractJSON attempts to extract a JSON object from a string that may contain
// markdown fences or surrounding prose.
func extractJSON(s string) string {
	s = strings.TrimSpace(s)

	// Strip markdown code fences.
	if idx := strings.Index(s, "```json"); idx >= 0 {
		s = s[idx+7:]
		if end := strings.Index(s, "```"); end >= 0 {
			s = s[:end]
		}
	} else if idx := strings.Index(s, "```"); idx >= 0 {
		s = s[idx+3:]
		if end := strings.Index(s, "```"); end >= 0 {
			s = s[:end]
		}
	}

	// Find first '{' and last '}'.
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return s
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found: "+instance)
		return
	}
	_ = client // used via s.manager.Get inside executeTool / handleChatCLI

	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}

	req.Question = strings.TrimSpace(req.Question)
	if req.Question == "" {
		writeErr(w, http.StatusBadRequest, "question is required")
		return
	}
	if req.TimeWindowMins <= 0 {
		req.TimeWindowMins = 60
	}

	// ── Set up SSE ────────────────────────────────────────────────────────────
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{}) // no deadline for streaming

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	// sendEvent is safe to call from the goroutines spawned below because
	// they all run sequentially from a single goroutine (the handler itself),
	// or from within the API/CLI helpers which are called serially.
	var mu sync.Mutex
	sendEvent := func(event, data string) {
		mu.Lock()
		defer mu.Unlock()
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
		flusher.Flush()
	}

	// ── 5-minute overall timeout ──────────────────────────────────────────────
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()

	slog.Info("chat: request received",
		"instance", instance,
		"question_len", len(req.Question),
		"history_len", len(req.History),
		"time_window_mins", req.TimeWindowMins,
	)

	// ── Dispatch to Mode A or Mode B ──────────────────────────────────────────
	apiKey := os.Getenv("ANTHROPIC_API_KEY")
	if apiKey != "" {
		slog.Info("chat: using direct Anthropic API", "instance", instance)
		s.handleChatAPI(ctx, instance, apiKey, req, sendEvent)
	} else {
		slog.Info("chat: using claude CLI fallback", "instance", instance)
		s.handleChatCLI(ctx, instance, req, sendEvent)
	}
}

// ---------------------------------------------------------------------------
// Mode B with MCP: single-pass claude CLI with ch-tools MCP server
// ---------------------------------------------------------------------------

func (s *Server) handleChatCLIWithMCP(
	ctx context.Context,
	claudeBin string,
	instance string,
	req chatRequest,
	sendEvent func(event, data string),
) {
	// Write temp MCP config pointing to this binary.
	binaryPath, err := os.Executable()
	if err != nil {
		slog.Warn("chat: could not get executable path, falling back to two-pass", "err", err)
		sendEvent("status", `{"phase":"planning"}`)
		// fall through to two-pass — handled by the caller already returning early,
		// so we should not reach here if configPath == "". Defensive:
		return
	}

	mcpConfig := map[string]interface{}{
		"mcpServers": map[string]interface{}{
			"ch-tools": map[string]interface{}{
				"command": binaryPath,
				"args":    []string{"--mcp-server", "--mcp-instance", instance, "--config", s.configPath},
			},
		},
	}
	mcpJSON, _ := json.Marshal(mcpConfig)

	tmpFile, err := os.CreateTemp("", "ch-mcp-*.json")
	if err != nil {
		slog.Warn("chat: could not write MCP config", "err", err)
		return
	}
	defer os.Remove(tmpFile.Name())
	tmpFile.Write(mcpJSON)
	tmpFile.Close()

	sendEvent("status", `{"phase":"planning"}`)

	// Build prompt: include conversation history + current question.
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf(
		"You are an expert ClickHouse DBA assistant. The instance is %s.\n"+
			"Use your tools to query ClickHouse system tables and get real data before answering.\n"+
			"Format your response in clear markdown with sections and tables where useful.\n"+
			"Severity levels: 🔴 CRITICAL | 🟠 WARNING | 🟡 INFO\n\n",
		instance,
	))
	if len(req.History) > 0 {
		sb.WriteString("## Conversation History\n")
		for _, h := range req.History {
			sb.WriteString(fmt.Sprintf("**%s**: %s\n\n", h.Role, h.Content))
		}
	}
	sb.WriteString("## Question\n" + req.Question + "\n")
	prompt := sb.String()

	// Send debug event so the browser can log the full prompt.
	{
		head := prompt
		if len(head) > 5120 {
			head = head[:5120]
		}
		debugPayload := map[string]interface{}{
			"mode":        "cli_mcp",
			"instance":    instance,
			"prompt_bytes": len(prompt),
			"prompt_kb":   float64(len(prompt)) / 1024.0,
			"truncated":   false,
			"prompt_head": head,
		}
		if b, err2 := json.Marshal(debugPayload); err2 == nil {
			sendEvent("debug", string(b))
		}
	}

	streamCtx, streamCancel := context.WithTimeout(ctx, 5*time.Minute)
	defer streamCancel()

	streamArgs := []string{
		"-p", "-",
		"--mcp-config", tmpFile.Name(),
		"--allowedTools", "mcp__ch-tools__*",
	}
	streamArgs = appendClaudeFlags(streamArgs)
	if model := os.Getenv("CLAUDE_MODEL"); model != "" {
		streamArgs = append(streamArgs, "--model", model)
	}

	cmd := exec.CommandContext(streamCtx, claudeBin, streamArgs...)
	cmd.Env = buildClaudeEnv()
	cmd.Stdin = strings.NewReader(prompt)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		sendEvent("error", jsonStr("Failed to create stdout pipe: "+err.Error()))
		return
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		sendEvent("error", jsonStr("Failed to create stderr pipe: "+err.Error()))
		return
	}
	if err := cmd.Start(); err != nil {
		slog.Warn("chat: claude CLI MCP start failed", "err", err)
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
			if strings.TrimSpace(line) != "" {
				sendEvent("chunk", jsonStr(line+"\n"))
			}
		}
	}()
	go func() {
		scanner := bufio.NewScanner(stderrPipe)
		for scanner.Scan() {
			slog.Debug("chat: claude CLI MCP stderr", "line", scanner.Text())
		}
	}()

	wg.Wait()
	_ = cmd.Wait()
	sendEvent("status", `{"phase":"done"}`)
}
