package web

// MCP stdio server — exposes the same 7 CH tools over JSON-RPC 2.0.
// Started as a subprocess by the Claude CLI via --mcp-config.
// Communication: newline-delimited JSON on stdin/stdout.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

type mcpMsg struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *mcpRPCError    `json:"error,omitempty"`
}

type mcpRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// mcpToolDef is the MCP tool schema (inputSchema is camelCase, unlike Anthropic's input_schema).
type mcpToolDef struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"inputSchema"`
}

// ---------------------------------------------------------------------------
// Tool list (MCP format)
// ---------------------------------------------------------------------------

func mcpTools() []mcpToolDef {
	prop := func(desc string) map[string]interface{} {
		return map[string]interface{}{"type": "string", "description": desc}
	}
	propInt := func(desc string) map[string]interface{} {
		return map[string]interface{}{"type": "integer", "description": desc}
	}
	return []mcpToolDef{
		{
			Name:        "execute_sql",
			Description: "Execute a read-only SQL query on the ClickHouse instance. Returns up to 200 rows as JSON.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"sql":         prop("Read-only SQL (SELECT, SHOW, DESCRIBE, EXPLAIN, WITH)."),
					"description": prop("Short description of what this query investigates."),
				},
				"required": []string{"sql", "description"},
			},
		},
		{
			Name:        "get_cluster_health",
			Description: "Get overall cluster health: active queries, merges, mutations, replication queue, disk usage, uptime, version.",
			InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
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
			InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
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
// Server loop
// ---------------------------------------------------------------------------

// RunMCPServer runs a JSON-RPC 2.0 MCP stdio server until stdin closes.
// Called from main() when --mcp-server flag is set.
func RunMCPServer(ctx context.Context, client *chclient.Client) {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4*1024*1024), 4*1024*1024)

	send := func(msg mcpMsg) {
		b, _ := json.Marshal(msg)
		fmt.Fprintf(os.Stdout, "%s\n", b)
	}

	errResp := func(id interface{}, code int, msg string) {
		send(mcpMsg{JSONRPC: "2.0", ID: id, Error: &mcpRPCError{Code: code, Message: msg}})
	}

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var req mcpMsg
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}

		// Notifications (no id) — don't respond.
		if req.ID == nil {
			continue
		}

		switch req.Method {

		case "initialize":
			send(mcpMsg{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result: map[string]interface{}{
					"protocolVersion": "2024-11-05",
					"capabilities":    map[string]interface{}{"tools": map[string]interface{}{}},
					"serverInfo":      map[string]interface{}{"name": "ch-tools", "version": "1.0"},
				},
			})

		case "tools/list":
			send(mcpMsg{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result:  map[string]interface{}{"tools": mcpTools()},
			})

		case "tools/call":
			var params struct {
				Name      string                 `json:"name"`
				Arguments map[string]interface{} `json:"arguments"`
			}
			if err := json.Unmarshal(req.Params, &params); err != nil {
				slog.Warn("mcp: invalid params", "err", err)
				errResp(req.ID, -32602, "invalid params")
				continue
			}

			result := runToolOnClient(ctx, client, params.Name, params.Arguments)
			resultText := toolResultJSON(result)

			send(mcpMsg{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result: map[string]interface{}{
					"content": []map[string]interface{}{
						{"type": "text", "text": resultText},
					},
				},
			})

		default:
			errResp(req.ID, -32601, "method not found: "+req.Method)
		}
	}
}
