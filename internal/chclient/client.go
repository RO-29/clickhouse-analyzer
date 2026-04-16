// Package chclient provides an HTTP-based ClickHouse client wrapper designed
// for monitoring workloads. It speaks directly to the ClickHouse HTTP interface
// (no driver dependency) and supports multiple independent instances, each
// identified by a friendly name.
package chclient

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// InstanceConfig describes a single ClickHouse instance that this client will
// connect to. The struct is intentionally kept plain so it can be populated
// directly from YAML / JSON config files.
type InstanceConfig struct {
	Name     string `json:"name"     yaml:"name"`
	Host     string `json:"host"     yaml:"host"`
	Port     int    `json:"port"     yaml:"port"`
	Username string `json:"username" yaml:"username"`
	Password string `json:"password" yaml:"password"`
	Secure   bool   `json:"secure"   yaml:"secure"`
	Database string `json:"database" yaml:"database"`
}

// ClientOptions controls timeouts and TLS behaviour shared by all instances
// managed through a Manager, or applied to a single Client.
type ClientOptions struct {
	// ConnectTimeout is the maximum time allowed for establishing a TCP
	// connection (dial). Defaults to 5 s.
	ConnectTimeout time.Duration

	// QueryTimeout is the maximum time allowed for a full HTTP round-trip
	// (including reading the response body). Defaults to 30 s.
	QueryTimeout time.Duration

	// InsecureSkipVerify disables TLS certificate verification. Common in
	// Kubernetes environments with self-signed certificates.
	InsecureSkipVerify bool

	// MaxIdleConns controls the maximum number of idle keep-alive connections
	// per host. Defaults to 2.
	MaxIdleConns int
}

func (o *ClientOptions) withDefaults() ClientOptions {
	out := *o
	if out.ConnectTimeout == 0 {
		out.ConnectTimeout = 5 * time.Second
	}
	if out.QueryTimeout == 0 {
		out.QueryTimeout = 30 * time.Second
	}
	if out.MaxIdleConns == 0 {
		out.MaxIdleConns = 2
	}
	return out
}

// ---------------------------------------------------------------------------
// Client – single-instance ClickHouse HTTP client
// ---------------------------------------------------------------------------

// Client wraps net/http.Client to issue queries against one ClickHouse
// instance via the HTTP interface. It is safe for concurrent use.
type Client struct {
	name     string
	baseURL  string
	database string
	username string
	password string
	hc       *http.Client
	logger   *slog.Logger
}

// NewClient creates a Client for a single ClickHouse instance.
func NewClient(cfg InstanceConfig, opts ClientOptions) *Client {
	opts = opts.withDefaults()

	scheme := "http"
	if cfg.Secure {
		scheme = "https"
	}
	port := cfg.Port
	if port == 0 {
		if cfg.Secure {
			port = 8443
		} else {
			port = 8123
		}
	}
	database := cfg.Database
	if database == "" {
		database = "default"
	}

	baseURL := fmt.Sprintf("%s://%s:%d", scheme, cfg.Host, port)

	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout: opts.ConnectTimeout,
		}).DialContext,
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: opts.InsecureSkipVerify, //nolint:gosec // intentional for self-signed certs
		},
		MaxIdleConnsPerHost: opts.MaxIdleConns,
		IdleConnTimeout:     90 * time.Second,
	}

	hc := &http.Client{
		Transport: transport,
		Timeout:   opts.QueryTimeout,
	}

	logger := slog.Default().With(
		slog.String("component", "chclient"),
		slog.String("instance", cfg.Name),
	)

	return &Client{
		name:     cfg.Name,
		baseURL:  baseURL,
		database: database,
		username: cfg.Username,
		password: cfg.Password,
		hc:       hc,
		logger:   logger,
	}
}

// Name returns the friendly instance name.
func (c *Client) Name() string { return c.name }

// ---------------------------------------------------------------------------
// Ping
// ---------------------------------------------------------------------------

// Ping checks connectivity by issuing a lightweight SELECT 1 against the
// instance. It respects the supplied context for cancellation.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.QuerySingleValue(ctx, "SELECT 1")
	if err != nil {
		return fmt.Errorf("ping %s: %w", c.name, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Query – returns []map[string]interface{}
// ---------------------------------------------------------------------------

// ColumnMeta describes one column in a ClickHouse result set.
type ColumnMeta struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// FullQueryResult is the full parsed response from a ClickHouse FORMAT JSON
// query, including column metadata and statistics.
type FullQueryResult struct {
	Meta       []ColumnMeta             `json:"meta"`
	Data       []map[string]interface{} `json:"data"`
	Rows       int                      `json:"rows"`
	ElapsedSec float64                  `json:"elapsed_sec"`
	RowsRead   int64                    `json:"rows_read"`
	BytesRead  int64                    `json:"bytes_read"`
}

// chJSONResponse mirrors the envelope ClickHouse returns when FORMAT JSON is
// requested.
type chJSONResponse struct {
	Meta []struct {
		Name string `json:"name"`
		Type string `json:"type"`
	} `json:"meta"`
	Data       []map[string]interface{} `json:"data"`
	Rows       int                      `json:"rows"`
	Statistics struct {
		Elapsed   float64 `json:"elapsed"`
		RowsRead  int64   `json:"rows_read"`
		BytesRead int64   `json:"bytes_read"`
	} `json:"statistics"`
	Exception string `json:"exception,omitempty"`
}

// Query executes an arbitrary SQL statement against the instance and returns
// the result set as a slice of column-name-keyed maps. The caller does NOT
// need to append FORMAT JSON – it is added automatically.
func (c *Client) Query(ctx context.Context, sql string) ([]map[string]interface{}, error) {
	body, err := c.rawQuery(ctx, sql, true)
	if err != nil {
		return nil, err
	}

	resp, err := decodeQueryResponse(c.name, body)
	if err != nil {
		return nil, err
	}

	c.logger.Debug("query executed",
		slog.String("sql", truncateStr(sql, 120)),
		slog.Int("rows", resp.Rows),
		slog.Float64("elapsed_sec", resp.Statistics.Elapsed),
		slog.Int64("rows_read", resp.Statistics.RowsRead),
		slog.Int64("bytes_read", resp.Statistics.BytesRead),
	)

	return resp.Data, nil
}

// QueryFull executes a SQL statement and returns the full result including
// column metadata and statistics. Useful when the caller needs column names
// and ClickHouse types.
func (c *Client) QueryFull(ctx context.Context, sql string) (*FullQueryResult, error) {
	body, err := c.rawQuery(ctx, sql, true)
	if err != nil {
		return nil, err
	}

	resp, err := decodeQueryResponse(c.name, body)
	if err != nil {
		return nil, err
	}

	meta := make([]ColumnMeta, len(resp.Meta))
	for i, m := range resp.Meta {
		meta[i] = ColumnMeta{Name: m.Name, Type: m.Type}
	}

	c.logger.Debug("query executed (full)",
		slog.String("sql", truncateStr(sql, 120)),
		slog.Int("rows", resp.Rows),
		slog.Float64("elapsed_sec", resp.Statistics.Elapsed),
	)

	return &FullQueryResult{
		Meta:       meta,
		Data:       resp.Data,
		Rows:       resp.Rows,
		ElapsedSec: resp.Statistics.Elapsed,
		RowsRead:   resp.Statistics.RowsRead,
		BytesRead:  resp.Statistics.BytesRead,
	}, nil
}

// QueryWithSettings executes a SQL statement with additional ClickHouse
// settings passed as URL query parameters (e.g. max_execution_time,
// max_result_rows). It returns the full result including column metadata.
func (c *Client) QueryWithSettings(ctx context.Context, sql string, settings map[string]string) (*FullQueryResult, error) {
	body, err := c.rawQueryWithSettings(ctx, sql, true, settings)
	if err != nil {
		return nil, err
	}

	resp, err := decodeQueryResponse(c.name, body)
	if err != nil {
		return nil, err
	}

	meta := make([]ColumnMeta, len(resp.Meta))
	for i, m := range resp.Meta {
		meta[i] = ColumnMeta{Name: m.Name, Type: m.Type}
	}

	return &FullQueryResult{
		Meta:       meta,
		Data:       resp.Data,
		Rows:       resp.Rows,
		ElapsedSec: resp.Statistics.Elapsed,
		RowsRead:   resp.Statistics.RowsRead,
		BytesRead:  resp.Statistics.BytesRead,
	}, nil
}

// ---------------------------------------------------------------------------
// decodeQueryResponse decodes a ClickHouse FORMAT JSON response body.
// It uses json.Decoder with UseNumber() so that large 64-bit integer values
// (UInt64 / Int64) are preserved as json.Number strings rather than being
// truncated to float64. Callers can use fmt.Sprintf("%v", v) or the local
// toString() helper to convert json.Number values to exact decimal strings.
func decodeQueryResponse(name string, body []byte) (*chJSONResponse, error) {
	var resp chJSONResponse
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&resp); err != nil {
		return nil, fmt.Errorf("chclient[%s]: failed to decode JSON response: %w (body prefix: %s)",
			name, err, truncate(body, 256))
	}
	if resp.Exception != "" {
		return nil, fmt.Errorf("chclient[%s]: server exception: %s", name, resp.Exception)
	}
	return &resp, nil
}

// QuerySingleValue – returns a single scalar as string
// ---------------------------------------------------------------------------

// QuerySingleValue executes a query that is expected to return exactly one row
// with one column. It returns that value as a string. This is useful for
// scalar monitoring queries such as `SELECT count() FROM system.parts`.
func (c *Client) QuerySingleValue(ctx context.Context, sql string) (string, error) {
	// Use TabSeparated for single-value queries – simpler and avoids JSON
	// parsing overhead.
	body, err := c.rawQuery(ctx, sql, false)
	if err != nil {
		return "", err
	}

	value := strings.TrimSpace(string(body))
	// ClickHouse may return multi-line output if the query accidentally
	// returns more than one row. Take only the first line.
	if idx := strings.IndexByte(value, '\n'); idx >= 0 {
		value = value[:idx]
	}
	// If the first line itself contains a tab (multiple columns), take the
	// first column only and log a warning.
	if idx := strings.IndexByte(value, '\t'); idx >= 0 {
		c.logger.Warn("QuerySingleValue: query returned multiple columns, using first",
			slog.String("sql", truncateStr(sql, 120)))
		value = value[:idx]
	}

	return value, nil
}

// ---------------------------------------------------------------------------
// HTTP internals
// ---------------------------------------------------------------------------

// rawQuery issues the HTTP POST to ClickHouse. When jsonFormat is true it
// appends FORMAT JSON to the SQL.
func (c *Client) rawQuery(ctx context.Context, sql string, jsonFormat bool) ([]byte, error) {
	query := strings.TrimSpace(sql)
	if jsonFormat {
		// Strip any trailing semicolons before appending FORMAT.
		query = strings.TrimRight(query, "; ")
		query += " FORMAT JSON"
	}

	params := url.Values{}
	params.Set("database", c.database)
	if jsonFormat {
		// Return 64-bit integers as JSON numbers (not quoted strings) so the
		// frontend can use them directly without type coercion.
		params.Set("output_format_json_quote_64bit_integers", "0")
	}
	// Send the query as a POST body for better handling of large SQL.
	// The query parameter in the URL is left empty.
	reqURL := c.baseURL + "/?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, strings.NewReader(query))
	if err != nil {
		return nil, fmt.Errorf("chclient[%s]: build request: %w", c.name, err)
	}
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	if c.username != "" {
		req.SetBasicAuth(c.username, c.password)
	}

	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("chclient[%s]: http request: %w", c.name, err)
	}
	defer resp.Body.Close()

	// ClickHouse returns errors with 500 status but also inline in the body.
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("chclient[%s]: read response body: %w", c.name, err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("chclient[%s]: HTTP %d: %s",
			c.name, resp.StatusCode, truncate(body, 512))
	}

	return body, nil
}

// rawQueryWithSettings is like rawQuery but accepts additional ClickHouse
// settings to pass as URL query parameters.
func (c *Client) rawQueryWithSettings(ctx context.Context, sql string, jsonFormat bool, settings map[string]string) ([]byte, error) {
	query := strings.TrimSpace(sql)
	if jsonFormat {
		query = strings.TrimRight(query, "; ")
		query += " FORMAT JSON"
	}

	params := url.Values{}
	params.Set("database", c.database)
	if jsonFormat {
		params.Set("output_format_json_quote_64bit_integers", "0")
	}
	for k, v := range settings {
		params.Set(k, v)
	}
	reqURL := c.baseURL + "/?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, strings.NewReader(query))
	if err != nil {
		return nil, fmt.Errorf("chclient[%s]: build request: %w", c.name, err)
	}
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	if c.username != "" {
		req.SetBasicAuth(c.username, c.password)
	}

	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("chclient[%s]: http request: %w", c.name, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("chclient[%s]: read response body: %w", c.name, err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("chclient[%s]: HTTP %d: %s",
			c.name, resp.StatusCode, truncate(body, 512))
	}

	return body, nil
}

// ---------------------------------------------------------------------------
// Manager – multi-instance registry
// ---------------------------------------------------------------------------

// Manager holds Client instances for every configured ClickHouse instance and
// provides convenience methods to address them by name or iterate over all.
type Manager struct {
	mu      sync.RWMutex
	clients map[string]*Client
	// order preserves insertion order so ForEach is deterministic.
	order []string
}

// NewManager creates a Manager pre-populated with one Client per entry in
// instances. Duplicate names are silently overwritten (last wins).
func NewManager(instances []InstanceConfig, opts ClientOptions) *Manager {
	m := &Manager{
		clients: make(map[string]*Client, len(instances)),
		order:   make([]string, 0, len(instances)),
	}
	for _, inst := range instances {
		client := NewClient(inst, opts)
		if _, exists := m.clients[inst.Name]; !exists {
			m.order = append(m.order, inst.Name)
		}
		m.clients[inst.Name] = client
	}
	slog.Info("chclient manager initialised",
		slog.Int("instances", len(m.clients)),
	)
	return m
}

// Get returns the Client for the named instance, or nil if it does not exist.
func (m *Manager) Get(instanceName string) *Client {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.clients[instanceName]
}

// ForEach invokes fn for every registered instance in the order they were
// configured. If fn returns a non-nil error, iteration stops immediately and
// that error is returned.
func (m *Manager) ForEach(fn func(instanceName string, client *Client) error) error {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, name := range m.order {
		if err := fn(name, m.clients[name]); err != nil {
			return err
		}
	}
	return nil
}

// ForEachParallel invokes fn for every registered instance concurrently and
// collects all errors. It is useful for fan-out monitoring queries where you
// don't want one slow instance to block the rest.
func (m *Manager) ForEachParallel(ctx context.Context, fn func(ctx context.Context, instanceName string, client *Client) error) map[string]error {
	m.mu.RLock()
	names := make([]string, len(m.order))
	copy(names, m.order)
	m.mu.RUnlock()

	var mu sync.Mutex
	errs := make(map[string]error)
	var wg sync.WaitGroup

	for _, name := range names {
		wg.Add(1)
		go func(n string) {
			defer wg.Done()
			c := m.Get(n)
			if c == nil {
				mu.Lock()
				errs[n] = fmt.Errorf("instance %q not found", n)
				mu.Unlock()
				return
			}
			if err := fn(ctx, n, c); err != nil {
				mu.Lock()
				errs[n] = err
				mu.Unlock()
			}
		}(name)
	}
	wg.Wait()

	if len(errs) == 0 {
		return nil
	}
	return errs
}

// Names returns the ordered list of registered instance names.
func (m *Manager) Names() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]string, len(m.order))
	copy(out, m.order)
	return out
}

// Len returns the number of registered instances.
func (m *Manager) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.clients)
}

// PingAll pings every instance in parallel and returns a map of instance name
// to error. Healthy instances are omitted from the result. A nil return means
// all instances are reachable.
func (m *Manager) PingAll(ctx context.Context) map[string]error {
	return m.ForEachParallel(ctx, func(ctx context.Context, name string, c *Client) error {
		return c.Ping(ctx)
	})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func truncate(b []byte, max int) string {
	if len(b) <= max {
		return string(b)
	}
	return string(b[:max]) + "..."
}

func truncateStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
