package collector

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSQLContract guards against the class of bug that made ~8 collector checks
// silently dead: SQL that references a ClickHouse column, table, metric, or enum
// value that does not exist in any supported release. Because collector query
// errors are deliberately swallowed (so one broken check can't stop a poll), a
// wrong identifier produces no error a human would notice — the check just never
// fires.
//
// It scans only string-literal contents (where SQL lives), not comments, so
// documenting a past mistake in a comment is allowed. It complements the
// behavior scenario tests: those prove the fixed query fires the right alert;
// this prevents the wrong identifier from returning.
func TestSQLContract(t *testing.T) {
	// Tokens that must never appear inside a SQL string literal, with the
	// correct replacement.
	banned := map[string]string{
		"BackgroundMergesMutationsPoolTask": "BackgroundMergesAndMutationsPoolTask (note the 'And')",
		"BackgroundMergesMutationsPoolSize": "BackgroundMergesAndMutationsPoolSize (note the 'And')",
		"BackgroundProcessingPool":          "BackgroundCommonPool* (Processing pool removed in CH 21.x)",
		"ExceptionWhileFlushing":            "'FlushError' (asynchronous_insert_log.status enum)",
		"'Flushed'":                         "'Ok' (asynchronous_insert_log.status enum)",
		"trace_str":                         "trace_full (system.crash_log)",
		"OSUserTimeCPU":                     "OSUserTimeNormalized",
		"OSSystemTimeCPU":                   "OSSystemTimeNormalized",
		"OSIdleTimeCPU":                     "OSIdleTimeNormalized",
		"has_ttl_expression":               "parse create_table_query / engine_full (no such system.tables column)",
		"tables.total_parts":               "tables.parts.cluster_total (metric key no collector emits)",
		"inserts.rows_per_sec":             "inserts.total.rows (metric key no collector emits)",
	}

	// system.zookeeper_connection lacks these columns; flag them only in a
	// literal that actually references that table (avg_latency/max_latency are
	// legitimate aliases in S3-latency SQL elsewhere).
	zkBanned := []string{"outstanding_requests", "avg_latency", "max_latency"}

	files := goFilesIn(t, ".")
	files = append(files, goFilesIn(t, "../web")...) // advisor + history SQL

	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		base := filepath.Base(f)
		for _, raw := range stringLiterals(string(src)) {
			lit := stripSQLComments(raw)
			if !looksLikeSQL(lit) {
				continue // skip Go map keys and other non-SQL string literals
			}
			for bad, instead := range banned {
				if strings.Contains(lit, bad) {
					t.Errorf("%s: SQL references banned identifier %q — use %s", base, bad, instead)
				}
			}
			if strings.Contains(lit, "zookeeper_connection") {
				for _, bad := range zkBanned {
					if strings.Contains(lit, bad) {
						t.Errorf("%s: SQL reads system.zookeeper_connection.%s, which does not exist", base, bad)
					}
				}
			}
			// Cache-size metrics live in asynchronous_metrics, not system.metrics.
			if strings.Contains(lit, "MarkCacheBytes") &&
				strings.Contains(lit, "system.metrics") &&
				!strings.Contains(lit, "asynchronous_metrics") {
				t.Errorf("%s: MarkCacheBytes must be read from system.asynchronous_metrics, not system.metrics", base)
			}
		}
	}
}

// stringLiterals extracts the contents of Go interpreted ("...") and raw
// (`...`) string literals from source, skipping // and /* */ comments. It is a
// small purpose-built scanner — good enough to isolate SQL text from comments.
func stringLiterals(src string) []string {
	var out []string
	var cur strings.Builder
	inLine, inBlock := false, false
	inInterp, inRaw := false, false

	for i := 0; i < len(src); i++ {
		c := src[i]
		switch {
		case inLine:
			if c == '\n' {
				inLine = false
			}
		case inBlock:
			if c == '*' && i+1 < len(src) && src[i+1] == '/' {
				inBlock = false
				i++
			}
		case inInterp:
			if c == '\\' && i+1 < len(src) {
				cur.WriteByte(src[i+1])
				i++
			} else if c == '"' {
				out = append(out, cur.String())
				cur.Reset()
				inInterp = false
			} else {
				cur.WriteByte(c)
			}
		case inRaw:
			if c == '`' {
				out = append(out, cur.String())
				cur.Reset()
				inRaw = false
			} else {
				cur.WriteByte(c)
			}
		default:
			switch c {
			case '/':
				if i+1 < len(src) && src[i+1] == '/' {
					inLine = true
					i++
				} else if i+1 < len(src) && src[i+1] == '*' {
					inBlock = true
					i++
				}
			case '"':
				inInterp = true
			case '`':
				inRaw = true
			}
		}
	}
	return out
}

// looksLikeSQL heuristically distinguishes SQL string literals from ordinary
// Go string constants (map keys, labels), so the contract checks only fire on
// real queries.
func looksLikeSQL(lit string) bool {
	u := strings.ToUpper(lit)
	return strings.Contains(u, "SELECT ") || strings.Contains(lit, "FROM system")
}

// stripSQLComments removes -- to-end-of-line comments so a token documented in
// a SQL comment doesn't count as a use.
func stripSQLComments(lit string) string {
	var b strings.Builder
	for _, line := range strings.Split(lit, "\n") {
		if i := strings.Index(line, "--"); i >= 0 {
			line = line[:i]
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return b.String()
}

func goFilesIn(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			return nil
		}
		if strings.HasSuffix(path, ".go") {
			out = append(out, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
	return out
}
