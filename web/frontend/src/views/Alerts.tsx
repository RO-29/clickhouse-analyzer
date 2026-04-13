import { useEffect, useState, useMemo, useCallback } from 'react'
import { ChevronDown, ChevronRight, Table2 } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { api } from '../lib/api'
import { fmtTime, cn } from '../lib/utils'
import { Card } from '../components/Card'
import { Badge } from '../components/Badge'
import { SqlBlock } from '../components/SqlBlock'
import type { Alert, Suggestion } from '../types/api'

/* ------------------------------------------------------------------ */
/*  Parse table info from alert dedup_key or message                  */
/* ------------------------------------------------------------------ */
function parseTableFromAlert(alert: Alert): { database: string; table: string } | null {
  // Try dedup_key format: instance:tables:parts:database.table
  const dedupMatch = alert.dedup_key?.match(/^[^:]+:tables:[^:]+:([^.]+)\.(.+)$/)
  if (dedupMatch) return { database: dedupMatch[1], table: dedupMatch[2] }

  // Try message format: database.table or `database`.`table`
  const msgMatch = alert.message?.match(/`?(\w+)`?\.`?(\w+)`?/)
  if (msgMatch) return { database: msgMatch[1], table: msgMatch[2] }

  return null
}

/* ------------------------------------------------------------------ */
/*  Investigation SQL generators by category                          */
/* ------------------------------------------------------------------ */
function investigationSql(alert: Alert): string[] {
  const ts = alert.created_at
  const from = new Date((ts - 600) * 1000).toISOString().replace('T', ' ').slice(0, 19)
  const to = new Date((ts + 600) * 1000).toISOString().replace('T', ' ').slice(0, 19)

  const cat = (alert.category || '').toLowerCase()
  const title = (alert.title || '').toLowerCase()

  // ── Sustained / drop alerts — keyed by metric name in title ──────────────
  if (cat === 'sustained' || cat === 'drop') {
    // Extract metric name: "Sustained elevated: some.metric.name" → "some.metric.name"
    const metricMatch = alert.title.match(/(?:sustained elevated|sustained drop|drop):\s*(.+)/i)
    const metric = metricMatch?.[1]?.trim() ?? ''
    const metricLower = metric.toLowerCase()

    if (metricLower.includes('memory') || metricLower.includes('mem')) {
      return [
        `SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric LIKE '%Memory%'\nORDER BY event_time DESC\nLIMIT 50`,
        `SELECT query_id, memory_usage, peak_memory_usage,\n  substring(query, 1, 200) as q\nFROM system.query_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND memory_usage > 500000000\nORDER BY memory_usage DESC\nLIMIT 20`,
      ]
    }
    if (metricLower.includes('cpu') || metricLower.includes('oscp')) {
      return [
        `SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric IN ('OSCPUVirtualTimeMicroseconds', 'OSCPUWaitMicroseconds', 'CPUFrequencyMHz_0')\nORDER BY event_time DESC\nLIMIT 50`,
        `SELECT query_id, query_duration_ms, read_rows,\n  substring(query, 1, 200) as q\nFROM system.query_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND type = 'QueryFinish'\nORDER BY query_duration_ms DESC\nLIMIT 20`,
      ]
    }
    if (metricLower.includes('part')) {
      return [
        `SELECT database, table, count() as part_count,\n  sum(rows) as total_rows,\n  formatReadableSize(sum(bytes_on_disk)) as size\nFROM system.parts\nWHERE active\nGROUP BY database, table\nORDER BY part_count DESC\nLIMIT 20`,
        `SELECT event_time, database, table, event_type, rows_read, size_compressed\nFROM system.part_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\nORDER BY event_time DESC\nLIMIT 50`,
      ]
    }
    if (metricLower.includes('merge')) {
      return [
        `SELECT database, table, elapsed, progress, num_parts,\n  result_part_name, is_mutation\nFROM system.merges\nORDER BY elapsed DESC`,
        `SELECT event_time, database, table, event_type, rows_read,\n  formatReadableSize(size_compressed) as size\nFROM system.part_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\nORDER BY event_time DESC\nLIMIT 50`,
      ]
    }
    if (metricLower.includes('insert') || metricLower.includes('rolling_avg.rows')) {
      return [
        `SELECT databases[1] as db, tables[1] as tbl,\n  count() as insert_count, sum(written_rows) as total_rows,\n  avg(written_rows) as avg_rows_per_insert\nFROM system.query_log\nWHERE type = 'QueryFinish'\n  AND query_kind = 'Insert'\n  AND event_time BETWEEN '${from}' AND '${to}'\nGROUP BY db, tbl\nORDER BY insert_count DESC\nLIMIT 20`,
        `SELECT event_time, database, table, count() as new_parts\nFROM system.part_log\nWHERE event_type = 'NewPart'\n  AND event_time BETWEEN '${from}' AND '${to}'\nGROUP BY event_time, database, table\nORDER BY event_time DESC\nLIMIT 50`,
      ]
    }
    if (metricLower.includes('disk') || metricLower.includes('storage') || metricLower.includes('distribution.rows')) {
      return [
        `SELECT name, path,\n  formatReadableSize(free_space) as free,\n  formatReadableSize(total_space) as total,\n  round(100 - (free_space / total_space * 100), 1) as used_pct\nFROM system.disks\nORDER BY used_pct DESC`,
        `SELECT database, table,\n  formatReadableSize(sum(bytes_on_disk)) as size,\n  count() as parts, sum(rows) as rows\nFROM system.parts\nWHERE active\nGROUP BY database, table\nORDER BY sum(bytes_on_disk) DESC\nLIMIT 20`,
      ]
    }
    if (metricLower.includes('uptime')) {
      return [
        `SELECT uptime() as uptime_seconds, version()`,
        `SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric = 'Uptime'\nORDER BY event_time DESC\nLIMIT 50`,
      ]
    }
    if (metricLower.includes('s3')) {
      return [
        `SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric LIKE '%S3%'\nORDER BY event_time DESC\nLIMIT 50`,
      ]
    }
    if (metricLower.includes('replica') || metricLower.includes('queue')) {
      return [
        `SELECT database, table, is_leader, total_replicas, active_replicas,\n  queue_size, inserts_in_queue, merges_in_queue\nFROM system.replicas\nORDER BY queue_size DESC\nLIMIT 20`,
      ]
    }
    // Generic sustained — show the metric trend from async_metric_log
    if (metric) {
      return [
        `SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric = '${metric}'\nORDER BY event_time\nLIMIT 100`,
        `SELECT toStartOfMinute(event_time) as minute, avg(value) as avg_val, max(value) as max_val\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric = '${metric}'\nGROUP BY minute\nORDER BY minute`,
      ]
    }
  }

  // ── Standard categories ───────────────────────────────────────────────────

  if (cat.includes('memory') || title.includes('memory')) {
    return [
      `SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric LIKE '%Memory%'\nORDER BY event_time DESC\nLIMIT 100`,
      `SELECT query_id, memory_usage, peak_memory_usage,\n  substring(query, 1, 200) as q\nFROM system.query_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND memory_usage > 1e9\nORDER BY memory_usage DESC\nLIMIT 20`,
    ]
  }

  if (cat.includes('cpu') || title.includes('cpu')) {
    return [
      `SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric IN ('OSCPUVirtualTimeMicroseconds', 'OSCPUWaitMicroseconds')\nORDER BY event_time DESC\nLIMIT 100`,
      `SELECT query_id, query_duration_ms, read_rows,\n  substring(query, 1, 200) as q\nFROM system.query_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\nORDER BY query_duration_ms DESC\nLIMIT 20`,
    ]
  }

  if (cat.includes('part') || cat.includes('merge') || title.includes('part') || title.includes('merge')) {
    return [
      `SELECT event_time, database, table, event_type, rows_read, size_compressed\nFROM system.part_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\nORDER BY event_time DESC\nLIMIT 50`,
      `SELECT database, table, count() as part_count,\n  sum(rows) as total_rows, formatReadableSize(sum(bytes_on_disk)) as size\nFROM system.parts\nWHERE active\nGROUP BY database, table\nORDER BY part_count DESC\nLIMIT 20`,
    ]
  }

  if (cat.includes('quer') || title.includes('quer') || title.includes('failure') || title.includes('failed')) {
    return [
      `SELECT exception_code, count() as cnt, any(exception) as sample_msg,\n  any(user) as sample_user\nFROM system.query_log\nWHERE type = 'ExceptionWhileProcessing'\n  AND event_time BETWEEN '${from}' AND '${to}'\nGROUP BY exception_code\nORDER BY cnt DESC`,
      `SELECT query_id, type, query_duration_ms, read_rows, memory_usage,\n  substring(query, 1, 200) as q\nFROM system.query_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND type = 'QueryFinish'\nORDER BY query_duration_ms DESC\nLIMIT 30`,
    ]
  }

  if (cat.includes('s3') || cat.includes('storage') || title.includes('s3') || title.includes('storage')) {
    return [
      `SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric LIKE '%S3%'\nORDER BY event_time DESC\nLIMIT 100`,
    ]
  }

  if (cat.includes('replica') || cat.includes('zoo') || title.includes('replica')) {
    return [
      `SELECT database, table, is_leader, total_replicas, active_replicas,\n  queue_size, inserts_in_queue, merges_in_queue, log_pointer, last_queue_update\nFROM system.replicas\nWHERE queue_size > 0 OR active_replicas < total_replicas\nORDER BY queue_size DESC`,
    ]
  }

  if (cat.includes('disk') || title.includes('disk')) {
    return [
      `SELECT name, path, formatReadableSize(free_space) as free,\n  formatReadableSize(total_space) as total,\n  round(100 - (free_space / total_space * 100), 1) as used_pct\nFROM system.disks`,
    ]
  }

  if (cat.includes('insert') || title.includes('insert')) {
    return [
      `SELECT databases[1] as db, tables[1] as tbl, count() as inserts,\n  avg(written_rows) as avg_rows, sum(written_rows) as total_rows\nFROM system.query_log\nWHERE type = 'QueryFinish' AND query_kind = 'Insert'\n  AND event_time BETWEEN '${from}' AND '${to}'\nGROUP BY db, tbl\nORDER BY inserts DESC\nLIMIT 20`,
    ]
  }

  // Generic fallback
  return [
    `SELECT event_time, type, query_duration_ms, read_rows, memory_usage,\n  substring(query, 1, 200) as q\nFROM system.query_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\nORDER BY event_time DESC\nLIMIT 50`,
  ]
}

/* ------------------------------------------------------------------ */
/*  Tip detector: does a string look like SQL?                        */
/* ------------------------------------------------------------------ */
function looksLikeSql(s: string): boolean {
  const u = s.toUpperCase()
  return (u.includes('SELECT') && u.includes('FROM')) || u.includes('SHOW ') || u.includes('SYSTEM ') || u.includes('OPTIMIZE ') || u.includes('KILL ')
}

/* ------------------------------------------------------------------ */
/*  Alert message renderer — parses markdown-style messages           */
/* ------------------------------------------------------------------ */
interface MessageSegment {
  type: 'text' | 'sql'
  content: string
}

function parseAlertMessage(message: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  // Split on triple-backtick code blocks
  const parts = message.split(/```(?:\w+)?\n?([\s\S]*?)```/g)
  // split result: [before, capture1, after, capture2, ...]
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // Text segment — strip leading/trailing whitespace
      const text = parts[i].trim()
      if (text) segments.push({ type: 'text', content: text })
    } else {
      // Code block — treat as SQL if it looks like SQL, otherwise text
      const code = parts[i].trim()
      if (code) {
        segments.push({ type: looksLikeSql(code) ? 'sql' : 'text', content: code })
      }
    }
  }
  return segments
}

function AlertMessageRenderer({ message, instance }: { message: string; instance: string }) {
  const segments = parseAlertMessage(message)
  return (
    <div className="space-y-2">
      {segments.map((seg, i) => {
        if (seg.type === 'sql') {
          return <SqlBlock key={i} sql={seg.content} instance={instance} />
        }
        // Render text: convert *bold* → <strong>, strip leading dashes/bullets
        const lines = seg.content.split('\n')
        return (
          <div key={i} className="text-sm bg-[var(--hover)] rounded-md p-3 border border-[var(--border)] space-y-0.5">
            {lines.map((line, j) => {
              // Apply inline bold: *text* → <strong>
              const parts = line.split(/\*([^*]+)\*/g)
              const rendered = parts.map((p, k) =>
                k % 2 === 1 ? <strong key={k}>{p}</strong> : <span key={k}>{p}</span>
              )
              return <div key={j}>{rendered}</div>
            })}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  AlertRow (expandable)                                             */
/* ------------------------------------------------------------------ */
function AlertRow({ alert, showMeta }: { alert: Alert; showMeta?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion | null>(null)
  const [loadingSugg, setLoadingSugg] = useState(false)
  const { openTableDetail } = useStore()

  const handleExpand = useCallback(() => {
    const next = !expanded
    setExpanded(next)
    if (next && !suggestions && !loadingSugg) {
      setLoadingSugg(true)
      api.suggestions(alert.category)
        .then(setSuggestions)
        .catch(() => {})
        .finally(() => setLoadingSugg(false))
    }
  }, [expanded, suggestions, loadingSugg, alert.category])

  const invSql = useMemo(() => investigationSql(alert), [alert])
  const tableInfo = useMemo(() => parseTableFromAlert(alert), [alert])

  return (
    <div className="border-b border-[var(--border)] last:border-0">
      {/* Row header */}
      <button
        onClick={handleExpand}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-[var(--hover)] transition-colors"
      >
        {expanded ? (
          <ChevronDown size={14} className="shrink-0 text-[var(--dim)]" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-[var(--dim)]" />
        )}
        <Badge severity={alert.severity} />
        {showMeta && (
          <>
            <span className="text-xs text-[var(--dim)] shrink-0">{alert.instance}</span>
            <span className="text-xs text-[var(--dim)] shrink-0">{alert.category}</span>
          </>
        )}
        <span className="font-medium truncate flex-1">{alert.title}</span>
        <span className="text-[var(--dim)] text-xs shrink-0">{fmtTime(alert.created_at)}</span>
        {alert.resolved && (
          <Badge className="bg-green-500/10 text-green-400 border-green-500/20">resolved</Badge>
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-4 pl-10 space-y-4">
          {/* Metadata grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-sm">
            <div>
              <span className="text-[var(--dim)]">Instance: </span>{alert.instance}
            </div>
            <div>
              <span className="text-[var(--dim)]">Category: </span>{alert.category}
            </div>
            <div>
              <span className="text-[var(--dim)]">Dedup Key: </span>
              <span className="font-mono text-xs">{alert.dedup_key}</span>
            </div>
            <div>
              <span className="text-[var(--dim)]">Created: </span>{fmtTime(alert.created_at)}
            </div>
            {alert.resolved_at && (
              <div>
                <span className="text-[var(--dim)]">Resolved: </span>{fmtTime(alert.resolved_at)}
              </div>
            )}
          </div>

          {/* Full message */}
          {alert.message && (
            <AlertMessageRenderer message={alert.message} instance={alert.instance} />
          )}

          {/* Suggestions */}
          {loadingSugg && (
            <div className="text-sm text-[var(--dim)]">Loading suggestions...</div>
          )}
          {suggestions && suggestions.suggestions.length > 0 && (
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-[var(--dim)] mb-2">
                Suggestions
              </div>
              <div className="space-y-2">
                {suggestions.suggestions.map((tip, i) => {
                  // If the tip contains a backtick SQL block, extract it
                  const backtickMatch = tip.match(/^([\s\S]*?)```(?:\w+)?\n?([\s\S]+?)```([\s\S]*)$/s)
                  if (backtickMatch) {
                    const before = backtickMatch[1].trim()
                    const sql = backtickMatch[2].trim()
                    const after = backtickMatch[3].trim()
                    return (
                      <div key={i} className="space-y-1">
                        {before && <div className="text-sm pl-2 border-l-2 border-[var(--border)]">{before}</div>}
                        {looksLikeSql(sql) ? (
                          <SqlBlock sql={sql} instance={alert.instance} />
                        ) : (
                          <pre className="text-sm bg-[var(--hover)] rounded p-2 border border-[var(--border)] font-mono">{sql}</pre>
                        )}
                        {after && <div className="text-sm pl-2 border-l-2 border-[var(--border)]">{after}</div>}
                      </div>
                    )
                  }
                  // Split "description: SQL" format into text + sql
                  const sqlMatch = tip.match(/^(.*?):\s*(SELECT\s|SHOW\s|SYSTEM\s|OPTIMIZE\s|KILL\s)(.*)/is)
                  if (sqlMatch) {
                    const desc = sqlMatch[1].trim()
                    const sql = (sqlMatch[2] + sqlMatch[3]).trim()
                    return (
                      <div key={i} className="space-y-1">
                        <div className="text-sm pl-2 border-l-2 border-[var(--border)]">{desc}</div>
                        <SqlBlock sql={sql} instance={alert.instance} />
                      </div>
                    )
                  }
                  if (looksLikeSql(tip)) {
                    return <SqlBlock key={i} sql={tip} instance={alert.instance} />
                  }
                  return (
                    <div key={i} className="text-sm pl-2 border-l-2 border-[var(--border)]">
                      {tip}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Explore Table button for table-related alerts */}
          {tableInfo && (
            <button
              onClick={() => openTableDetail(alert.instance, tableInfo.database, tableInfo.table)}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25 transition-colors"
            >
              <Table2 size={14} />
              Explore Table: {tableInfo.database}.{tableInfo.table}
            </button>
          )}

          {/* Investigation SQL */}
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-[var(--dim)] mb-2">
              Investigation Queries
            </div>
            <div className="space-y-2">
              {invSql.map((sql, i) => (
                <SqlBlock key={i} sql={sql} instance={alert.instance} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Stat Card (local to alerts view)                                  */
/* ------------------------------------------------------------------ */
function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <Card>
      <div className="text-3xl font-bold" style={{ color }}>{value}</div>
      <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">{label}</div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Alerts view                                                       */
/* ------------------------------------------------------------------ */
export default function Alerts() {
  const { instances: cachedInstances, customFrom, customTo } = useStore()
  const [activeAlerts, setActiveAlerts] = useState<Alert[]>([])
  const [historyAlerts, setHistoryAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)

  /* View mode */
  const [viewMode, setViewMode] = useState<'grouped' | 'flat'>('grouped')

  /* Filters */
  const [filterInstance, setFilterInstance] = useState('all')
  const [filterSeverity, setFilterSeverity] = useState('all')
  const [filterCategory, setFilterCategory] = useState('all')
  const [filterType, setFilterType] = useState('all')
  const [filterStatus, setFilterStatus] = useState('all')

  /* Collapsed groups */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const [active, history] = await Promise.all([
          api.alerts.active(),
          api.alerts.history(),
        ])
        if (!cancelled) {
          setActiveAlerts(active)
          setHistoryAlerts(history)
        }
      } catch {
        // keep empty
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [customFrom, customTo])

  /* ---- All alerts combined ---- */
  const allAlerts = useMemo(() => {
    const map = new Map<number, Alert>()
    activeAlerts.forEach((a) => map.set(a.id, a))
    historyAlerts.forEach((a) => { if (!map.has(a.id)) map.set(a.id, a) })
    return Array.from(map.values()).sort((a, b) => b.created_at - a.created_at)
  }, [activeAlerts, historyAlerts])

  /* ---- Derived filter options ---- */
  const categories = useMemo(
    () => [...new Set(allAlerts.map((a) => a.category))].sort(),
    [allAlerts],
  )
  const alertTypes = useMemo(
    () => [...new Set(allAlerts.map((a) => a.title))].sort(),
    [allAlerts],
  )
  const instanceNames = useMemo(
    () => [...new Set([...cachedInstances, ...allAlerts.map((a) => a.instance)])].sort(),
    [cachedInstances, allAlerts],
  )

  /* ---- Filtered alerts ---- */
  const filtered = useMemo(() => {
    return allAlerts.filter((a) => {
      if (filterInstance !== 'all' && a.instance !== filterInstance) return false
      if (filterSeverity !== 'all' && a.severity !== filterSeverity) return false
      if (filterCategory !== 'all' && a.category !== filterCategory) return false
      if (filterType !== 'all' && a.title !== filterType) return false
      if (filterStatus === 'firing' && a.resolved) return false
      if (filterStatus === 'resolved' && !a.resolved) return false
      return true
    })
  }, [allAlerts, filterInstance, filterSeverity, filterCategory, filterType, filterStatus])

  /* ---- Grouped by instance+category ---- */
  const groups = useMemo(() => {
    const map = new Map<string, Alert[]>()
    filtered.forEach((a) => {
      const key = `${a.instance}::${a.category}`
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(a)
    })
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [filtered])

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /* ---- Stats ---- */
  const firing = filtered.filter((a) => !a.resolved).length
  const resolved = filtered.filter((a) => a.resolved).length

  /* ---- Dropdown helper ---- */
  const Select = ({
    value,
    onChange,
    options,
    label,
  }: {
    value: string
    onChange: (v: string) => void
    options: { value: string; label: string }[]
    label: string
  }) => (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-[var(--dim)] uppercase tracking-wider">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--accent)]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="grid grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <Card key={i}>
              <div className="h-9 bg-[var(--hover)] rounded w-1/3 mb-2" />
              <div className="h-3 bg-[var(--hover)] rounded w-1/2" />
            </Card>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ---- Stat cards ---- */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Firing" value={firing} color={firing > 0 ? '#ef4444' : undefined} />
        <StatCard label="Resolved" value={resolved} color="#22c55e" />
        <StatCard label="Total" value={filtered.length} />
      </div>

      {/* ---- View mode toggle ---- */}
      <div className="flex gap-1 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-1 w-fit">
        <button
          onClick={() => setViewMode('grouped')}
          className={cn(
            'px-4 py-1.5 text-sm font-medium rounded-md transition-colors',
            viewMode === 'grouped'
              ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
              : 'text-[var(--dim)] hover:text-[var(--text)]',
          )}
        >
          Grouped
        </button>
        <button
          onClick={() => setViewMode('flat')}
          className={cn(
            'px-4 py-1.5 text-sm font-medium rounded-md transition-colors',
            viewMode === 'flat'
              ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
              : 'text-[var(--dim)] hover:text-[var(--text)]',
          )}
        >
          Flat
        </button>
      </div>

      {/* ---- Filters ---- */}
      <div className="grid grid-cols-4 gap-4">
        <Select
          label="Instance"
          value={filterInstance}
          onChange={setFilterInstance}
          options={[{ value: 'all', label: 'All instances' }, ...instanceNames.map((n) => ({ value: n, label: n }))]}
        />
        <Select
          label="Severity"
          value={filterSeverity}
          onChange={setFilterSeverity}
          options={[
            { value: 'all', label: 'All severities' },
            { value: 'critical', label: 'Critical' },
            { value: 'warn', label: 'Warning' },
            { value: 'info', label: 'Info' },
          ]}
        />
        <Select
          label="Category"
          value={filterCategory}
          onChange={setFilterCategory}
          options={[{ value: 'all', label: 'All categories' }, ...categories.map((c) => ({ value: c, label: c }))]}
        />
        <Select
          label="Alert Type"
          value={filterType}
          onChange={setFilterType}
          options={[{ value: 'all', label: 'All types' }, ...alertTypes.map((t) => ({ value: t, label: t }))]}
        />
        <Select
          label="Status"
          value={filterStatus}
          onChange={setFilterStatus}
          options={[
            { value: 'all', label: 'All' },
            { value: 'firing', label: 'Firing' },
            { value: 'resolved', label: 'Resolved' },
          ]}
        />
      </div>

      {/* ---- Alerts list ---- */}
      {filtered.length === 0 ? (
        <div className="text-sm text-[var(--dim)] text-center py-12">
          No alerts match the current filters
        </div>
      ) : viewMode === 'flat' ? (
        /* ---- Flat mode ---- */
        <Card className="!p-0">
          {filtered.map((alert) => (
            <AlertRow key={alert.id} alert={alert} showMeta />
          ))}
        </Card>
      ) : (
        /* ---- Grouped mode ---- */
        <div className="space-y-3">
          {groups.map(([key, groupAlerts]) => {
            const [inst, cat] = key.split('::')
            const isCollapsed = collapsedGroups.has(key)
            const groupFiring = groupAlerts.filter((a) => !a.resolved).length
            const groupResolved = groupAlerts.filter((a) => a.resolved).length
            const worstSev = groupAlerts.some((a) => a.severity === 'critical')
              ? 'critical'
              : groupAlerts.some((a) => a.severity === 'warn')
                ? 'warn'
                : 'info'

            return (
              <Card key={key} className="!p-0">
                {/* Group header */}
                <button
                  onClick={() => toggleGroup(key)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--hover)] transition-colors"
                >
                  {isCollapsed ? (
                    <ChevronRight size={16} className="shrink-0 text-[var(--dim)]" />
                  ) : (
                    <ChevronDown size={16} className="shrink-0 text-[var(--dim)]" />
                  )}
                  <span className="font-medium">{inst}</span>
                  <span className="text-[var(--dim)]">/</span>
                  <span className="text-sm">{cat}</span>
                  <Badge severity={worstSev} />
                  <div className="flex-1" />
                  {groupFiring > 0 && (
                    <span className="text-xs text-red-400">{groupFiring} firing</span>
                  )}
                  {groupResolved > 0 && (
                    <span className="text-xs text-green-400 ml-2">{groupResolved} resolved</span>
                  )}
                </button>

                {/* Group rows */}
                {!isCollapsed && (
                  <div className="border-t border-[var(--border)]">
                    {groupAlerts.map((alert) => (
                      <AlertRow key={alert.id} alert={alert} />
                    ))}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
