package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
	"github.com/rohitjain/ch-analyzer/internal/config"
)

// newTestServer returns a minimal *Server suitable for runcheck handler tests.
// The manager is populated with the given instance names, all pointing at
// localhost:1 (a port that will immediately refuse connections), so Collect
// returns a network error without needing a real ClickHouse instance.
//
// ConnectTimeout is set to 1 second so that tests complete quickly even if
// the OS does not immediately refuse port 1 connections on this platform.
func newTestServer(t *testing.T, instanceNames []string) *Server {
	t.Helper()

	instances := make([]chclient.InstanceConfig, len(instanceNames))
	for i, name := range instanceNames {
		instances[i] = chclient.InstanceConfig{
			Name: name,
			Host: "127.0.0.1",
			Port: 1, // port 1 is reserved/privileged; connections are refused immediately
		}
	}
	mgr := chclient.NewManager(instances, chclient.ClientOptions{
		ConnectTimeout: 1, // 1 nanosecond — forces immediate timeout/refusal
		QueryTimeout:   1,
	})

	return &Server{
		cfg:     &config.Config{},
		manager: mgr,
	}
}

// TestHandleRunCheckTwoInstancesTwoCollectors is the regression test for the
// previous panic where req.Collectors[idx] was accessed with an out-of-bounds
// index when instances×collectors > len(collectors).
//
// With 2 instances and 2 collectors there are 4 (instance, collector) work
// items. The handler must produce exactly 4 result entries and return 200.
//
// Because the clients point to a non-listening port, every Collect() call
// returns a network error. The handler records this as "check failed" in the
// result item's Error field (graceful degradation, no panic).
func TestHandleRunCheckTwoInstancesTwoCollectors(t *testing.T) {
	srv := newTestServer(t, []string{"inst-1", "inst-2"})

	body, _ := json.Marshal(map[string]interface{}{
		"collectors": []string{"errors", "system"},
		"instances":  []string{"inst-1", "inst-2"},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/run-check", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	srv.handleRunCheck(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d; body: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]json.RawMessage
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response is not valid JSON: %v; body: %s", err, rr.Body.String())
	}

	if _, ok := resp["results"]; !ok {
		t.Fatalf("response missing 'results' key; body: %s", rr.Body.String())
	}

	var results []map[string]interface{}
	if err := json.Unmarshal(resp["results"], &results); err != nil {
		t.Fatalf("'results' is not a JSON array: %v", err)
	}

	// 2 instances × 2 collectors = 4 work items expected.
	if len(results) != 4 {
		t.Errorf("expected 4 result items (2 instances × 2 collectors), got %d", len(results))
	}

	// Verify no panic occurred: we get 4 clean result entries.
	// Collectors handle CH errors internally (log + return empty result),
	// so the "error" field stays empty — the absence of a panic is the proof.
	for i, r := range results {
		if _, ok := r["instance"]; !ok {
			t.Errorf("result[%d]: missing 'instance' field", i)
		}
		if _, ok := r["collector"]; !ok {
			t.Errorf("result[%d]: missing 'collector' field", i)
		}
	}
}

// TestHandleRunCheckUnknownInstance verifies the handler rejects requests for
// instances that are not registered in the manager.
func TestHandleRunCheckUnknownInstance(t *testing.T) {
	srv := newTestServer(t, []string{"inst-1"})

	body, _ := json.Marshal(map[string]interface{}{
		"collectors": []string{"errors"},
		"instances":  []string{"does-not-exist"},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/run-check", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	srv.handleRunCheck(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected status 400 for unknown instance, got %d", rr.Code)
	}
}

// TestHandleRunCheckUnknownCollector verifies the handler rejects requests for
// collector names that are not registered.
func TestHandleRunCheckUnknownCollector(t *testing.T) {
	srv := newTestServer(t, []string{"inst-1"})

	body, _ := json.Marshal(map[string]interface{}{
		"collectors": []string{"this-collector-does-not-exist"},
		"instances":  []string{"inst-1"},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/run-check", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	srv.handleRunCheck(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected status 400 for unknown collector, got %d", rr.Code)
	}
}

// TestHandleRunCheckEmptyCollectors verifies the handler rejects empty
// collectors list.
func TestHandleRunCheckEmptyCollectors(t *testing.T) {
	srv := newTestServer(t, []string{"inst-1"})

	body, _ := json.Marshal(map[string]interface{}{
		"collectors": []string{},
		"instances":  []string{"inst-1"},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/run-check", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	srv.handleRunCheck(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected status 400 for empty collectors, got %d", rr.Code)
	}
}

// TestHandleRunCheckEmptyInstances verifies the handler rejects empty instances
// list.
func TestHandleRunCheckEmptyInstances(t *testing.T) {
	srv := newTestServer(t, []string{"inst-1"})

	body, _ := json.Marshal(map[string]interface{}{
		"collectors": []string{"errors"},
		"instances":  []string{},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/run-check", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	srv.handleRunCheck(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected status 400 for empty instances, got %d", rr.Code)
	}
}

// TestHandleRunCheckInvalidJSON verifies the handler rejects malformed JSON
// request bodies with a 400.
func TestHandleRunCheckInvalidJSON(t *testing.T) {
	srv := newTestServer(t, []string{"inst-1"})

	req := httptest.NewRequest(http.MethodPost, "/api/run-check", bytes.NewReader([]byte("not-json")))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	srv.handleRunCheck(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected status 400 for invalid JSON, got %d", rr.Code)
	}
}

// TestHandleRunCheckResultStructure verifies that successful (error) results
// have all expected JSON fields with the correct types.
func TestHandleRunCheckResultStructure(t *testing.T) {
	srv := newTestServer(t, []string{"inst-1"})

	body, _ := json.Marshal(map[string]interface{}{
		"collectors": []string{"errors"},
		"instances":  []string{"inst-1"},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/run-check", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	srv.handleRunCheck(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}

	var resp struct {
		Results []struct {
			Instance    string      `json:"instance"`
			Collector   string      `json:"collector"`
			DisplayName string      `json:"display_name"`
			DurationMs  int64       `json:"duration_ms"`
			Alerts      interface{} `json:"alerts"`
			Metrics     interface{} `json:"metrics"`
			Queries     interface{} `json:"queries"`
			Error       string      `json:"error"`
		} `json:"results"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("cannot decode response: %v", err)
	}
	if len(resp.Results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(resp.Results))
	}
	r := resp.Results[0]
	if r.Instance != "inst-1" {
		t.Errorf("result.instance = %q, want %q", r.Instance, "inst-1")
	}
	if r.Collector != "errors" {
		t.Errorf("result.collector = %q, want %q", r.Collector, "errors")
	}
	// Queries should be non-nil (populated from CollectorMeta).
	if r.Queries == nil {
		t.Error("result.queries should not be nil")
	}
	// Alerts and Metrics should be non-nil (empty arrays on error path).
	if r.Alerts == nil {
		t.Error("result.alerts should not be nil")
	}
	if r.Metrics == nil {
		t.Error("result.metrics should not be nil")
	}
}
