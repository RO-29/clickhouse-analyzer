-- ch-analyzer ClickHouse schema
-- Run once per instance before starting ch-analyzer:
--   clickhouse-client --host <host> --port 8443 --secure \
--     --user admin --password <pass> \
--     --multiquery < schema.sql

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
