-- ch-analyzer ClickHouse schema
--
-- Run once per instance before starting ch-analyzer:
--   clickhouse-client --host <host> --port 8443 --secure \
--     --user admin --password <pass> \
--     --multiquery < schema.sql
--
-- Safe to re-run on existing installs: every CREATE uses IF NOT EXISTS and the
-- Migrations block at the bottom uses ADD COLUMN IF NOT EXISTS / MODIFY TTL.
-- ch-analyzer no longer runs DDL at startup — if you upgrade the app, re-run
-- this file before (or right after) restart.

CREATE DATABASE IF NOT EXISTS ch_analyzer;

-- metrics: time-series metric store (365-day TTL)
CREATE TABLE IF NOT EXISTS ch_analyzer.metrics (
    instance String,
    name     String,
    labels   String    DEFAULT '{}',
    value    Float64,
    ts       DateTime
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (instance, name, ts)
TTL ts + INTERVAL 365 DAY
SETTINGS index_granularity = 8192;

-- alerts: alert state — ReplacingMergeTree deduplicates by version
CREATE TABLE IF NOT EXISTS ch_analyzer.alerts (
    id            Int64,
    instance      String,
    severity      String,
    category      String,
    title         String,
    message       String,
    resolved      UInt8             DEFAULT 0,
    resolved_at   Nullable(DateTime),
    created_at    DateTime,
    dedup_key     String,
    version       UInt64            DEFAULT 1,
    updated_at    DateTime          DEFAULT created_at,
    first_seen_at DateTime          DEFAULT created_at,
    fire_count    UInt32            DEFAULT 1
) ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(created_at)
ORDER BY (dedup_key, created_at)
SETTINGS index_granularity = 8192;

-- digest_snapshots: daily digest state (365-day TTL)
CREATE TABLE IF NOT EXISTS ch_analyzer.digest_snapshots (
    instance String,
    snapshot String,
    ts       DateTime
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(ts)
ORDER BY (instance, ts)
TTL ts + INTERVAL 365 DAY
SETTINGS index_granularity = 8192;

-- health_snapshots: per-instance health score history (30-day TTL)
CREATE TABLE IF NOT EXISTS ch_analyzer.health_snapshots (
    instance  LowCardinality(String),
    score     Float32,
    criticals UInt16,
    warns     UInt16,
    infos     UInt16,
    ts        DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (instance, ts)
TTL ts + INTERVAL 30 DAY;

-- audit_log: user/system action history (90-day TTL)
CREATE TABLE IF NOT EXISTS ch_analyzer.audit_log (
    id       String,
    instance LowCardinality(String) DEFAULT '',
    action   LowCardinality(String),
    actor    String                 DEFAULT '',
    details  String                 DEFAULT '',
    ts       DateTime               DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (ts, instance, action)
TTL ts + INTERVAL 90 DAY;

-- query_samples: rolling 365-day copy of system.query_log. Powers Query
-- Patterns, Query Log, Samples, Users, Tables, and Connections → "Clients
-- in range". Retention bumped from the original 30 days so long-range
-- forensics ("what ran on this table 6 months ago?") work. Disk impact on
-- busy instances can be significant — shrink via
--   ALTER TABLE ch_analyzer.query_samples MODIFY TTL event_time + INTERVAL 90 DAY
-- if you need to claw storage back.
CREATE TABLE IF NOT EXISTS ch_analyzer.query_samples (
    collected_at          DateTime               DEFAULT now(),
    event_time            DateTime,
    user                  LowCardinality(String),
    query_kind            LowCardinality(String),
    normalized_query_hash UInt64,
    query_text            String,
    query_duration_ms     UInt64,
    memory_usage          UInt64,
    read_rows             UInt64,
    read_bytes            UInt64,
    written_rows          UInt64,
    written_bytes         UInt64,
    result_rows           UInt64,
    result_bytes          UInt64,
    exception_code        Int32,
    exception             String                 DEFAULT '',
    is_exception          UInt8,
    client_name           LowCardinality(String),
    interface             LowCardinality(String),
    databases             Array(String)          DEFAULT [],
    tables                Array(String)          DEFAULT [],
    cpu_user_us           UInt64                 DEFAULT 0,
    cpu_system_us         UInt64                 DEFAULT 0,
    initial_address       String                 DEFAULT '',
    interface_code        UInt8                  DEFAULT 0,
    http_user_agent       String                 DEFAULT '',
    forwarded_for         String                 DEFAULT ''
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_time)
ORDER BY (event_time, normalized_query_hash)
TTL event_time + INTERVAL 365 DAY
SETTINGS index_granularity = 8192;

-- ---------------------------------------------------------------------------
-- Migrations (idempotent — safe to re-run on every upgrade)
--
-- New installs do not need these (the CREATE TABLE statements above already
-- include every column). Existing installs created before the corresponding
-- release need them the first time they upgrade past that release.
--
-- Columns are IF NOT EXISTS so re-running is a no-op; the MODIFY TTL is
-- metadata-only (no rewrite) so re-running is cheap.
-- ---------------------------------------------------------------------------

-- alerts.updated_at — added so the reconcile loop can rate-limit touches
-- and so the UI can show "last seen" without walking all versions.
ALTER TABLE ch_analyzer.alerts
    ADD COLUMN IF NOT EXISTS updated_at DateTime DEFAULT created_at;

-- alerts.first_seen_at + fire_count — preserved across restarts so an alert
-- re-firing after a reconcile restart doesn't reset its age/counter.
ALTER TABLE ch_analyzer.alerts
    ADD COLUMN IF NOT EXISTS first_seen_at DateTime DEFAULT created_at;
ALTER TABLE ch_analyzer.alerts
    ADD COLUMN IF NOT EXISTS fire_count UInt32 DEFAULT 1;

-- query_samples: per-query table/CPU attribution + per-client forensics.
-- Needed by the Query Log, Tables, Users, and Connections tabs.
ALTER TABLE ch_analyzer.query_samples
    ADD COLUMN IF NOT EXISTS databases Array(String) DEFAULT [];
ALTER TABLE ch_analyzer.query_samples
    ADD COLUMN IF NOT EXISTS tables Array(String) DEFAULT [];
ALTER TABLE ch_analyzer.query_samples
    ADD COLUMN IF NOT EXISTS cpu_user_us UInt64 DEFAULT 0;
ALTER TABLE ch_analyzer.query_samples
    ADD COLUMN IF NOT EXISTS cpu_system_us UInt64 DEFAULT 0;
ALTER TABLE ch_analyzer.query_samples
    ADD COLUMN IF NOT EXISTS initial_address String DEFAULT '';
ALTER TABLE ch_analyzer.query_samples
    ADD COLUMN IF NOT EXISTS interface_code UInt8 DEFAULT 0;
ALTER TABLE ch_analyzer.query_samples
    ADD COLUMN IF NOT EXISTS http_user_agent String DEFAULT '';
ALTER TABLE ch_analyzer.query_samples
    ADD COLUMN IF NOT EXISTS forwarded_for String DEFAULT '';

-- query_samples.exception — the exception MESSAGE text (not just the code) for
-- failed queries, so the Samples "errors only" view can show why a query failed.
-- Before this column existed, the Samples read selected a non-existent `exception`
-- column, which hard-errored query_samples and silently fell back to the
-- short-retention system.query_log (breaking error drills on ClickHouse Cloud).
ALTER TABLE ch_analyzer.query_samples
    ADD COLUMN IF NOT EXISTS exception String DEFAULT '';

-- query_samples retention: bump from the old 30-day default to 365 days so
-- long-range forensics work. If you need to claw storage back, override with:
--   ALTER TABLE ch_analyzer.query_samples MODIFY TTL event_time + INTERVAL 90 DAY
ALTER TABLE ch_analyzer.query_samples
    MODIFY TTL event_time + INTERVAL 365 DAY;
