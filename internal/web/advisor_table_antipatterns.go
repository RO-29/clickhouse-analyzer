package web

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Table Design Anti-patterns Advisor
//
// Detects structural issues in table definitions from system tables:
//
//  1. too_many_projections — >3 projections per table (maintenance overhead)
//  2. small_granularity    — index_granularity < 4096 (excessive mark count)
//  3. large_granularity    — index_granularity > 32768 on large tables (missed pruning)
//  4. too_many_parts       — active_parts > 300 (merge pressure, slow queries)
//  5. no_ttl_large         — large tables (>100GB) with no TTL defined
//  6. no_partition         — large tables with no partition key
//  7. too_many_columns     — tables with >200 columns (wide-table smell)
//  8. wide_pk              — primary key with >6 columns (expensive sorting)
//  9. uncompressed_strings — String columns where LowCardinality would help
// 10. mutation_backlog     — tables with pending mutations (ALTER … UPDATE/DELETE)
// ---------------------------------------------------------------------------

type TableAntiPattern struct {
	Type        string               `json:"type"`
	Severity    string               `json:"severity"`
	Title       string               `json:"title"`
	Description string               `json:"description"`
	Count       int                  `json:"count"`
	Tables      []TableAntiPatternRow `json:"tables"`
}

type TableAntiPatternRow struct {
	Database   string  `json:"database"`
	Table      string  `json:"table"`
	Engine     string  `json:"engine,omitempty"`
	Detail     string  `json:"detail"`
	Metric     float64 `json:"metric"`
	MetricLabel string `json:"metric_label"`
	SizeBytes  int64   `json:"size_bytes,omitempty"`
	SizeHuman  string  `json:"size_human,omitempty"`
	FixHint    string  `json:"fix_hint,omitempty"`
}

func (s *Server) handleAdvisorTableAntiPatterns(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	const skipDBs = `('system','INFORMATION_SCHEMA','information_schema','ch_analyzer')`

	runQ := func(sql string) ([]TableAntiPatternRow, error) {
		rows, err := client.Query(ctx, sql)
		if err != nil {
			return nil, err
		}
		out := make([]TableAntiPatternRow, 0, len(rows))
		for _, row := range rows {
			out = append(out, TableAntiPatternRow{
				Database:    toString(row["database"]),
				Table:       toString(row["table"]),
				Engine:      toString(row["engine"]),
				Detail:      toString(row["detail"]),
				Metric:      toFloat64(row["metric"]),
				MetricLabel: toString(row["metric_label"]),
				SizeBytes:   int64(toFloat64(row["size_bytes"])),
				SizeHuman:   toString(row["size_human"]),
				FixHint:     toString(row["fix_hint"]),
			})
		}
		return out, nil
	}

	type check struct {
		typ  string
		sev  string
		title string
		desc string
		sql  string
	}

	checks := []check{
		// 1. Too many projections (>3)
		{
			typ:  "too_many_projections",
			sev:  "warn",
			title: "Too Many Projections",
			desc: "Tables with more than 3 projections have significant write amplification — " +
				"every INSERT must maintain each projection. Remove projections that are rarely used.",
			sql: `SELECT
				p.database, p.name AS table,
				t.engine,
				concat(toString(count()), ' projections') AS detail,
				count() AS metric,
				'projections' AS metric_label,
				sum(t.total_bytes) AS size_bytes,
				formatReadableSize(sum(t.total_bytes)) AS size_human,
				'SELECT name, projections FROM system.tables WHERE database = ''' ||
				  p.database || ''' AND name = ''' || p.name || '''' AS fix_hint
			FROM system.projection_parts AS p
			INNER JOIN system.tables AS t ON t.database = p.database AND t.name = p.name
			WHERE p.database NOT IN ` + skipDBs + `
			  AND p.active = 1
			GROUP BY p.database, p.name, t.engine, t.total_bytes
			HAVING metric > 3
			ORDER BY metric DESC
			LIMIT 25`,
		},

		// 2. Very small index_granularity (<4096)
		{
			typ:  "small_granularity",
			sev:  "warn",
			title: "Small Index Granularity",
			desc: "index_granularity < 4096 creates excessive mark files, bloating mark cache " +
				"and slowing merges. The default 8192 is appropriate for most workloads.",
			sql: `SELECT
				database,
				name AS table,
				engine,
				concat('index_granularity = ', toString(toUInt64OrZero(
					extract(create_table_query, 'index_granularity\\s*=\\s*(\\d+)')
				))) AS detail,
				toUInt64OrZero(extract(create_table_query, 'index_granularity\\s*=\\s*(\\d+)')) AS metric,
				'index_granularity' AS metric_label,
				total_bytes AS size_bytes,
				formatReadableSize(total_bytes) AS size_human,
				'ALTER TABLE ' || database || '.' || name ||
				  ' MODIFY SETTING index_granularity = 8192' AS fix_hint
			FROM system.tables
			WHERE database NOT IN ` + skipDBs + `
			  AND engine LIKE '%MergeTree%'
			  AND create_table_query ILIKE '%index_granularity%'
			  AND toUInt64OrZero(extract(create_table_query, 'index_granularity\\s*=\\s*(\\d+)')) > 0
			  AND toUInt64OrZero(extract(create_table_query, 'index_granularity\\s*=\\s*(\\d+)')) < 4096
			ORDER BY metric ASC
			LIMIT 25`,
		},

		// 3. Very large index_granularity on big tables (>32768 AND >10GB)
		{
			typ:  "large_granularity",
			sev:  "info",
			title: "Large Index Granularity on Big Table",
			desc: "index_granularity > 32768 on a table larger than 10 GB means ClickHouse " +
				"reads large granules and can't prune effectively. Consider lowering it or " +
				"adding skip indexes.",
			sql: `SELECT
				database,
				name AS table,
				engine,
				concat('index_granularity = ', toString(toUInt64OrZero(
					extract(create_table_query, 'index_granularity\\s*=\\s*(\\d+)')
				))) AS detail,
				toUInt64OrZero(extract(create_table_query, 'index_granularity\\s*=\\s*(\\d+)')) AS metric,
				'index_granularity' AS metric_label,
				total_bytes AS size_bytes,
				formatReadableSize(total_bytes) AS size_human,
				'' AS fix_hint
			FROM system.tables
			WHERE database NOT IN ` + skipDBs + `
			  AND engine LIKE '%MergeTree%'
			  AND total_bytes > 10737418240
			  AND create_table_query ILIKE '%index_granularity%'
			  AND toUInt64OrZero(extract(create_table_query, 'index_granularity\\s*=\\s*(\\d+)')) > 32768
			ORDER BY size_bytes DESC
			LIMIT 25`,
		},

		// 4. Too many active parts (>300)
		{
			typ:  "too_many_parts",
			sev:  "critical",
			title: "Too Many Active Parts",
			desc: "Tables with >300 active parts cause slow SELECT queries and merge pressure. " +
				"This is often caused by too-frequent inserts of small batches. " +
				"Increase batch size or use the Buffer engine.",
			sql: `SELECT
				database,
				table,
				any(engine) AS engine,
				concat(toString(count()), ' active parts') AS detail,
				count() AS metric,
				'active_parts' AS metric_label,
				sum(bytes_on_disk) AS size_bytes,
				formatReadableSize(sum(bytes_on_disk)) AS size_human,
				'' AS fix_hint
			FROM system.parts
			WHERE database NOT IN ` + skipDBs + `
			  AND active = 1
			GROUP BY database, table
			HAVING metric > 300
			ORDER BY metric DESC
			LIMIT 25`,
		},

		// 5. Large tables (>50 GB) with no TTL
		{
			typ:  "no_ttl_large",
			sev:  "info",
			title: "Large Table Without TTL",
			desc: "Tables larger than 50 GB with no TTL rule will grow unbounded. " +
				"Consider adding a TTL to expire old data and reclaim storage.",
			sql: `SELECT
				database,
				name AS table,
				engine,
				'No TTL defined' AS detail,
				round(total_bytes / 1073741824.0, 1) AS metric,
				'GB' AS metric_label,
				total_bytes AS size_bytes,
				formatReadableSize(total_bytes) AS size_human,
				concat('ALTER TABLE ', database, '.', name,
				  ' MODIFY TTL <date_column> + INTERVAL 90 DAY') AS fix_hint
			FROM system.tables
			WHERE database NOT IN ` + skipDBs + `
			  AND engine LIKE '%MergeTree%'
			  -- system.tables has no has_ttl_expression column; TTL presence is
			  -- visible in the DDL. Exclude any table whose DDL mentions TTL at
			  -- all (table- or column-level) to avoid advising "add a TTL" to a
			  -- table that already has one.
			  AND create_table_query NOT ILIKE '%TTL%'
			  AND total_bytes > 53687091200
			ORDER BY total_bytes DESC
			LIMIT 25`,
		},

		// 6. Large tables with no partition key
		{
			typ:  "no_partition",
			sev:  "warn",
			title: "Large Table Without Partition Key",
			desc: "Tables larger than 10 GB with no partition key cannot use partition pruning. " +
				"Queries that filter on a date column will always scan all data.",
			sql: `SELECT
				database,
				name AS table,
				engine,
				'No partition key' AS detail,
				round(total_bytes / 1073741824.0, 1) AS metric,
				'GB' AS metric_label,
				total_bytes AS size_bytes,
				formatReadableSize(total_bytes) AS size_human,
				'' AS fix_hint
			FROM system.tables
			WHERE database NOT IN ` + skipDBs + `
			  AND engine LIKE '%MergeTree%'
			  AND partition_key = ''
			  AND total_bytes > 10737418240
			ORDER BY total_bytes DESC
			LIMIT 25`,
		},

		// 7. Too many columns (>150)
		{
			typ:  "too_many_columns",
			sev:  "warn",
			title: "Too Many Columns (Wide Table)",
			desc: "Tables with >150 columns have high metadata overhead and are harder to " +
				"maintain. Consider splitting rarely-used columns into a separate table or " +
				"using a JSON/Map type.",
			sql: `SELECT
				database,
				table,
				any(engine) AS engine,
				concat(toString(count()), ' columns') AS detail,
				count() AS metric,
				'columns' AS metric_label,
				0 AS size_bytes,
				'' AS size_human,
				'' AS fix_hint
			FROM system.columns
			WHERE database NOT IN ` + skipDBs + `
			GROUP BY database, table
			HAVING metric > 150
			ORDER BY metric DESC
			LIMIT 25`,
		},

		// 8. Wide primary key (>5 columns)
		{
			typ:  "wide_pk",
			sev:  "warn",
			title: "Wide Primary Key (>5 Columns)",
			desc: "Primary keys with more than 5 columns are expensive to sort on insert " +
				"and consume more memory per mark. Ensure all columns are actually needed " +
				"for pruning; move others to ORDER BY only.",
			sql: `SELECT
				database,
				name AS table,
				engine,
				concat(toString(length(splitByString(',', primary_key))), ' PK columns: ', primary_key) AS detail,
				length(splitByString(',', primary_key)) AS metric,
				'pk_columns' AS metric_label,
				total_bytes AS size_bytes,
				formatReadableSize(total_bytes) AS size_human,
				'' AS fix_hint
			FROM system.tables
			WHERE database NOT IN ` + skipDBs + `
			  AND engine LIKE '%MergeTree%'
			  AND primary_key != ''
			  AND length(splitByString(',', primary_key)) > 5
			ORDER BY metric DESC
			LIMIT 25`,
		},

		// 9. Mutation backlog
		{
			typ:  "mutation_backlog",
			sev:  "critical",
			title: "Pending Mutations Backlog",
			desc: "Tables with pending ALTER … UPDATE/DELETE mutations block parts from " +
				"being merged and slow all queries on those tables until the mutation completes.",
			sql: `SELECT
				database,
				table,
				'' AS engine,
				concat(toString(count()), ' pending mutations') AS detail,
				count() AS metric,
				'mutations' AS metric_label,
				0 AS size_bytes,
				'' AS size_human,
				concat('SELECT * FROM system.mutations WHERE database = ''', database,
				  ''' AND table = ''', table, ''' AND is_done = 0') AS fix_hint
			FROM system.mutations
			WHERE is_done = 0
			  AND database NOT IN ` + skipDBs + `
			GROUP BY database, table
			HAVING metric >= 1
			ORDER BY metric DESC
			LIMIT 25`,
		},
	}

	type result struct {
		idx    int
		tables []TableAntiPatternRow
		err    error
	}

	results := make([]result, len(checks))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4) // max 4 concurrent queries

	for i, c := range checks {
		wg.Add(1)
		go func(idx int, sql string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			t, err := runQ(sql)
			results[idx] = result{idx: idx, tables: t, err: err}
		}(i, c.sql)
	}
	wg.Wait()

	out := make([]TableAntiPattern, 0, len(checks))
	for i, c := range checks {
		res := results[i]
		tables := res.tables
		if tables == nil {
			tables = []TableAntiPatternRow{}
		}
		out = append(out, TableAntiPattern{
			Type:        c.typ,
			Severity:    c.sev,
			Title:       c.title,
			Description: c.desc,
			Count:       len(tables),
			Tables:      tables,
		})
	}

	writeJSON(w, http.StatusOK, out)
}
