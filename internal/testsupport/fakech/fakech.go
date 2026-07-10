// Package fakech provides an in-process fake ClickHouse HTTP server for testing
// collectors end-to-end. It speaks the same HTTP + FORMAT JSON / TabSeparated
// protocol that internal/chclient talks, so a *chclient.Client built with
// Server.Client() drives the *real* query, decode, and error-handling paths —
// only the ClickHouse server itself is faked.
//
// Tests register rules that match on a substring of the SQL and return either
// canned rows (JSON) or a ClickHouse-style exception. This lets a test put a
// collector into a known cluster state ("40 active merges, 5000 parts") and
// assert exactly which alerts fire, with which values — the property the
// correctness harness exists to verify.
package fakech

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rohitjain/ch-analyzer/internal/chclient"
)

// Col is a ClickHouse column descriptor for the JSON response `meta` block.
type Col struct {
	Name string
	Type string
}

// Response is what a matched rule returns.
type Response struct {
	Data []map[string]any
	Meta []Col
	// Exception, when non-empty, is returned as a ClickHouse server exception
	// (the string should include a `Code: NN` and the CH error name, e.g.
	// "Code: 60. DB::Exception: ... UNKNOWN_TABLE", so collector substring
	// checks behave as they would against a real server).
	Exception string
}

type rule struct {
	match   func(sql string) bool
	resp    Response
	respond func() Response // when set, takes precedence over resp
}

// Server is a fake ClickHouse HTTP endpoint.
type Server struct {
	ts    *httptest.Server
	mu    sync.Mutex
	rules []rule
	calls []string
}

// New starts a fake ClickHouse server that is automatically closed at test end.
func New(t *testing.T) *Server {
	t.Helper()
	s := &Server{}
	s.ts = httptest.NewServer(http.HandlerFunc(s.handle))
	t.Cleanup(s.ts.Close)
	return s
}

// On registers a rule that returns rows for any query containing substr.
// Rules are evaluated in registration order; the first match wins.
func (s *Server) On(substr string, data []map[string]any) *Server {
	return s.OnFunc(containsMatcher(substr), Response{Data: data})
}

// OnScalar registers a rule for a QuerySingleValue-style scalar query. The
// value is returned verbatim as the TabSeparated body.
func (s *Server) OnScalar(substr string, value any) *Server {
	return s.OnFunc(containsMatcher(substr), Response{Data: []map[string]any{{"v": value}}})
}

// OnError registers a rule that returns a ClickHouse exception for queries
// containing substr.
func (s *Server) OnError(substr, exception string) *Server {
	return s.OnFunc(containsMatcher(substr), Response{Exception: exception})
}

// OnFunc registers a rule with a custom matcher.
func (s *Server) OnFunc(match func(sql string) bool, resp Response) *Server {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rules = append(s.rules, rule{match: match, resp: resp})
	return s
}

// OnDynamic registers a rule whose response is produced fresh on every matching
// call — useful for simulating a counter that changes between polls.
func (s *Server) OnDynamic(substr string, respond func() Response) *Server {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rules = append(s.rules, rule{match: containsMatcher(substr), respond: respond})
	return s
}

// Client returns a chclient.Client pointed at this fake server.
func (s *Server) Client(name string) *chclient.Client {
	u, err := url.Parse(s.ts.URL)
	if err != nil {
		panic(err)
	}
	host, portStr, err := net.SplitHostPort(u.Host)
	if err != nil {
		panic(err)
	}
	port, _ := strconv.Atoi(portStr)
	return chclient.NewClient(chclient.InstanceConfig{
		Name: name,
		Host: host,
		Port: port,
	}, chclient.ClientOptions{
		ConnectTimeout: 2 * time.Second,
		QueryTimeout:   5 * time.Second,
	})
}

// Calls returns every SQL statement (with FORMAT JSON stripped) received so far.
func (s *Server) Calls() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.calls))
	copy(out, s.calls)
	return out
}

func containsMatcher(substr string) func(string) bool {
	return func(sql string) bool { return strings.Contains(sql, substr) }
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	bodyBytes, _ := io.ReadAll(r.Body)
	sql := strings.TrimSpace(string(bodyBytes))

	jsonFormat := strings.HasSuffix(sql, "FORMAT JSON")
	sql = strings.TrimSpace(strings.TrimSuffix(sql, "FORMAT JSON"))

	s.mu.Lock()
	s.calls = append(s.calls, sql)
	var matched *Response
	for i := range s.rules {
		if s.rules[i].match(sql) {
			if s.rules[i].respond != nil {
				r := s.rules[i].respond()
				matched = &r
			} else {
				matched = &s.rules[i].resp
			}
			break
		}
	}
	s.mu.Unlock()

	// Unmatched queries return an empty result set — mirrors a query that ran
	// fine but produced no rows, which is the common "nothing wrong" path.
	if matched == nil {
		matched = &Response{}
	}

	if matched.Exception != "" {
		writeException(w, jsonFormat, matched.Exception)
		return
	}

	if jsonFormat {
		writeJSON(w, matched)
		return
	}
	writeScalar(w, matched)
}

func writeException(w http.ResponseWriter, jsonFormat bool, exc string) {
	if jsonFormat {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"exception": exc})
		return
	}
	// TabSeparated path: ClickHouse returns non-200 with the error text inline.
	w.WriteHeader(http.StatusInternalServerError)
	_, _ = io.WriteString(w, exc)
}

func writeJSON(w http.ResponseWriter, resp *Response) {
	data := resp.Data
	if data == nil {
		data = []map[string]any{}
	}
	env := map[string]any{
		"meta": metaOrInfer(resp),
		"data": data,
		"rows": len(data),
		"statistics": map[string]any{
			"elapsed":    0.001,
			"rows_read":  len(data),
			"bytes_read": 0,
		},
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(env)
}

func writeScalar(w http.ResponseWriter, resp *Response) {
	w.Header().Set("Content-Type", "text/tab-separated-values")
	w.WriteHeader(http.StatusOK)
	if len(resp.Data) == 0 {
		return
	}
	row := resp.Data[0]
	// Prefer an explicit "v" column (set by OnScalar); otherwise take the first.
	if v, ok := row["v"]; ok {
		_, _ = io.WriteString(w, fmt.Sprintf("%v", v))
		return
	}
	for _, v := range row {
		_, _ = io.WriteString(w, fmt.Sprintf("%v", v))
		return
	}
}

func metaOrInfer(resp *Response) []map[string]string {
	if len(resp.Meta) > 0 {
		out := make([]map[string]string, len(resp.Meta))
		for i, c := range resp.Meta {
			out[i] = map[string]string{"name": c.Name, "type": c.Type}
		}
		return out
	}
	// Infer column names from the first data row so the envelope is well-formed.
	if len(resp.Data) == 0 {
		return []map[string]string{}
	}
	var out []map[string]string
	for k := range resp.Data[0] {
		out = append(out, map[string]string{"name": k, "type": "String"})
	}
	return out
}
