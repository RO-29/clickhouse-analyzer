import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { Bell, BellOff, BookOpen, Brain, ChevronDown, ChevronLeft, ChevronRight, Clock, RefreshCw, Sparkles, Table2, Trash2, Wrench, Zap, Bookmark, X, CheckSquare, Square, CheckCheck, AlertCircle } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { fmtTime, cn } from '../lib/utils'
import { flashToast } from '../lib/notify'
import { Card } from '../components/Card'
import { Badge } from '../components/Badge'
import { AlertDetailPanel } from '../components/AlertDetailPanel'
import { SqlBlock } from '../components/SqlBlock'
import type { Alert, Suggestion } from '../types/api'

/* ------------------------------------------------------------------ */
/*  Staleness helpers                                                  */
/* ------------------------------------------------------------------ */

const STALE_LS_KEY = 'ch-stale-hours'
const STALE_OPTIONS = [
  { label: '1 hour', value: 1 },
  { label: '6 hours', value: 6 },
  { label: '24 hours', value: 24 },
  { label: '48 hours', value: 48 },
  { label: '7 days', value: 168 },
]

function loadStaleHours(): number {
  try { return parseInt(localStorage.getItem(STALE_LS_KEY) ?? '24', 10) || 24 } catch { return 24 }
}

/* ------------------------------------------------------------------ */
/*  Saved filter views                                                  */
/* ------------------------------------------------------------------ */
const SAVED_VIEWS_KEY = 'ch-alert-saved-views'
interface SavedView {
  name: string
  instance: string
  severity: string
  category: string
  type: string
  status: string
}
function loadSavedViews(): SavedView[] {
  try { return JSON.parse(localStorage.getItem(SAVED_VIEWS_KEY) ?? '[]') } catch { return [] }
}
function persistSavedViews(views: SavedView[]) {
  try { localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views)) } catch {}
}

function isStale(a: Alert, staleHours: number): boolean {
  if (a.resolved) return false
  const updatedAt = a.updated_at ?? a.created_at
  return (Date.now() / 1000 - updatedAt) > staleHours * 3600
}

/* ------------------------------------------------------------------ */
/*  Snooze — localStorage-based, no backend needed                    */
/* ------------------------------------------------------------------ */
const SNOOZE_LS_KEY = 'ch-snoozed-alerts'

function loadSnoozed(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SNOOZE_LS_KEY) ?? '{}') } catch { return {} }
}

function snoozeAlert(dedupKey: string, hours: number) {
  const snoozed = loadSnoozed()
  snoozed[dedupKey] = Math.floor(Date.now() / 1000) + hours * 3600
  // Prune expired entries
  const now = Math.floor(Date.now() / 1000)
  Object.keys(snoozed).forEach(k => { if (snoozed[k] < now) delete snoozed[k] })
  try { localStorage.setItem(SNOOZE_LS_KEY, JSON.stringify(snoozed)) } catch {}
}

function unsnoozeAlert(dedupKey: string) {
  const snoozed = loadSnoozed()
  delete snoozed[dedupKey]
  try { localStorage.setItem(SNOOZE_LS_KEY, JSON.stringify(snoozed)) } catch {}
}

function isSnoozed(dedupKey: string, snoozed: Record<string, number>): boolean {
  const exp = snoozed[dedupKey]
  return exp != null && exp > Math.floor(Date.now() / 1000)
}

function snoozeUntil(dedupKey: string, snoozed: Record<string, number>): number | null {
  const exp = snoozed[dedupKey]
  return (exp != null && exp > Math.floor(Date.now() / 1000)) ? exp : null
}

/* ------------------------------------------------------------------ */
/*  Acknowledge — localStorage-based, no backend needed               */
/* ------------------------------------------------------------------ */
const ACK_LS_KEY = 'ch-acked-alerts'

function loadAcked(): Record<string, { by: string; note: string; at: number }> {
  try { return JSON.parse(localStorage.getItem(ACK_LS_KEY) ?? '{}') } catch { return {} }
}

function ackAlert(dedupKey: string, by: string, note: string) {
  const acked = loadAcked()
  acked[dedupKey] = { by, at: Math.floor(Date.now() / 1000), note }
  try { localStorage.setItem(ACK_LS_KEY, JSON.stringify(acked)) } catch {}
}

function unackAlert(dedupKey: string) {
  const acked = loadAcked()
  delete acked[dedupKey]
  try { localStorage.setItem(ACK_LS_KEY, JSON.stringify(acked)) } catch {}
}

function isAcked(dedupKey: string, acked: Record<string, any>): boolean {
  return !!acked[dedupKey]
}

/* ------------------------------------------------------------------ */
/*  Runbooks — per-category remediation steps                          */
/* ------------------------------------------------------------------ */
interface Runbook { title: string; steps: string[] }

const RUNBOOKS: Record<string, Runbook> = {
  memory: {
    title: 'Memory Runbook',
    steps: [
      'Check current memory consumers: SELECT query_id, peak_memory_usage, substring(query,1,150) as q FROM system.processes ORDER BY peak_memory_usage DESC',
      'Review `max_memory_usage` setting — lower it to prevent runaway queries from consuming all memory',
      'Check if mark cache or primary key index is too large: SELECT * FROM system.metrics WHERE metric LIKE \'%Cache%\'',
      'Consider enabling `max_bytes_before_external_group_by` / `max_bytes_before_external_sort` to spill to disk',
      'If RSS is high but CH memory is normal, check for OS-level memory leaks or huge pages fragmentation',
    ],
  },
  cpu: {
    title: 'CPU Runbook',
    steps: [
      'Identify hot queries: SELECT query_id, elapsed, read_rows, substring(query,1,200) as q FROM system.processes ORDER BY elapsed DESC',
      'Check if high CPU correlates with merges: SELECT * FROM system.merges ORDER BY elapsed DESC',
      'Look for missing indexes causing full scans: check EXPLAIN output for queries with high read_rows',
      'Consider reducing `max_threads` per query if CPU is saturated across many concurrent queries',
      'Review load average trend — if > vCPU count, the system is genuinely overloaded; scale up or throttle inserts',
    ],
  },
  queries: {
    title: 'Queries Runbook',
    steps: [
      'Kill blocking long-running queries: KILL QUERY WHERE elapsed > 300 (use carefully)',
      'Check for missing partition pruning — queries reading all partitions will be slow',
      'Review query concurrency limit: `max_concurrent_queries` in server settings',
      'Check if a single user/service is flooding with queries: SELECT user, count() FROM system.processes GROUP BY user',
      'Look for repeated identical queries that should be cached upstream',
    ],
  },
  tables: {
    title: 'Tables / Parts Runbook',
    steps: [
      'Too many parts → force merge: OPTIMIZE TABLE <db>.<table> FINAL (use sparingly on large tables)',
      'Check merge backlog: SELECT database, table, elapsed, progress FROM system.merges ORDER BY elapsed DESC',
      'High parts usually means inserts are too small/frequent — batch them to ≥100K rows per insert',
      'For detached parts: verify with CHECK TABLE, then ATTACH or DROP DETACHED PART after investigation',
      'Review `parts_to_delay_insert` / `parts_to_throw_insert` settings — raise if inserts are being throttled',
    ],
  },
  replication: {
    title: 'Replication Runbook',
    steps: [
      'Check replica status: SELECT database, table, is_readonly, is_session_expired, last_exception, absolute_delay FROM system.replicas',
      'If replica is readonly: check ZooKeeper connectivity — SELECT * FROM system.zookeeper WHERE path = \'/\'',
      'Large queue: check for stuck mutations — SELECT * FROM system.mutations WHERE is_done = 0',
      'Replica lag: verify disk space is not full (full disk prevents replication)',
      'After fixing ZooKeeper: restart ClickHouse to re-establish the session',
    ],
  },
  storage: {
    title: 'Storage / Disk Runbook',
    steps: [
      'Identify largest tables: SELECT database, table, formatReadableSize(sum(bytes_on_disk)) as size FROM system.parts WHERE active GROUP BY database, table ORDER BY sum(bytes_on_disk) DESC',
      'Check TTL policies are running: SELECT name, engine_full FROM system.tables WHERE engine LIKE \'%MergeTree%\' AND engine_full LIKE \'%TTL%\'',
      'Look for orphaned temporary files: ls -la /var/lib/clickhouse/tmp/',
      'Consider moving cold data to S3 tiered storage if available',
      'If S3 latency is high: check network connectivity to S3 endpoint, review retry settings',
    ],
  },
  inserts: {
    title: 'Insert Pipeline Runbook',
    steps: [
      'Small insert anti-pattern: batch inserts to ≥100K rows to avoid part explosion',
      'Check async inserts if enabled: SELECT * FROM system.asynchronous_inserts',
      'Throughput drop: check if upstream pipeline is paused or rate-limited',
      'Verify async insert buffer: set `async_insert_max_data_size` and `async_insert_busy_timeout_ms`',
      'Monitor insert errors: SELECT exception, count() FROM system.query_log WHERE type = \'ExceptionWhileProcessing\' AND kind = \'Insert\' GROUP BY exception',
    ],
  },
  mvs: {
    title: 'Materialized Views Runbook',
    steps: [
      'Find failing MV executions: SELECT view, event_time, status, exception FROM system.query_views_log WHERE status = \'ExceptionWhileProcessing\' ORDER BY event_time DESC LIMIT 20',
      'Slow MVs may block inserts on the source table — consider reducing MV complexity',
      'Check for MV bloat: inner table growing much faster than expected',
      'Chained MVs (MV → MV) compound latency; flatten them if possible',
      'If MV fails due to schema mismatch, DROP and recreate the MV after fixing the query',
    ],
  },
  errors: {
    title: 'Errors Runbook',
    steps: [
      'Check full error list: SELECT name, times, last_error_time, last_error_message FROM system.errors ORDER BY times DESC',
      'MEMORY_LIMIT_EXCEEDED: reduce query memory limits or add more RAM',
      'KEEPER_EXCEPTION / ZOOKEEPER_ERROR: check ZooKeeper cluster health and CH-ZK connectivity',
      'CORRUPTED_DATA / CHECKSUM_DOESNT_MATCH: run CHECK TABLE to identify, then detach/drop corrupt parts',
      'Review recent text_log for Fatal/Critical entries: SELECT * FROM system.text_log WHERE level IN (\'Fatal\', \'Critical\') ORDER BY event_time DESC LIMIT 20',
    ],
  },
  dictionaries: {
    title: 'Dictionaries Runbook',
    steps: [
      'Check dictionary status: SELECT name, status, last_exception FROM system.dictionaries',
      'Force reload: SYSTEM RELOAD DICTIONARY <name>',
      'Verify source connectivity (DB/HTTP/file) — failed connection = dictionary not loaded',
      'Empty dictionary (0 elements) may indicate empty source table or wrong WHERE clause',
      'For large dictionaries, consider increasing `max_execution_time` for dictionary loads',
    ],
  },
}

function getRunbook(alert: Alert): Runbook | null {
  const cat = (alert.category || '').toLowerCase()
  for (const key of Object.keys(RUNBOOKS)) {
    if (cat.includes(key)) return RUNBOOKS[key]
  }
  return null
}

function RunbookPanel({ runbook }: { runbook: Runbook }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
      >
        <BookOpen size={12} />
        {open ? 'Hide runbook' : 'Show runbook'}: {runbook.title}
      </button>
      {open && (
        <div className="mt-2 bg-blue-500/5 border border-blue-500/15 rounded-lg p-3 space-y-2">
          <div className="text-xs font-semibold text-blue-400 uppercase tracking-wider mb-1">{runbook.title}</div>
          {runbook.steps.map((step, i) => {
            const sqlMatch = step.indexOf(': SELECT') > 0 || step.indexOf(': KILL') > 0 || step.indexOf(': OPTIMIZE') > 0 || step.indexOf(': SYSTEM') > 0
            if (sqlMatch) {
              const colonIdx = step.indexOf(': ')
              const label = step.slice(0, colonIdx)
              const sql = step.slice(colonIdx + 2)
              return (
                <div key={i} className="space-y-1">
                  <div className="text-xs text-[var(--dim)]"><span className="text-blue-300 font-medium">{i + 1}.</span> {label}</div>
                  <div className="font-mono text-xs bg-[var(--hover)] rounded p-2 border border-[var(--border)] overflow-x-auto whitespace-pre">{sql}</div>
                </div>
              )
            }
            return (
              <div key={i} className="text-xs text-[var(--dim)]">
                <span className="text-blue-300 font-medium">{i + 1}.</span> {step}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Parse table info from alert dedup_key or message                  */
/* ------------------------------------------------------------------ */
function parseTableFromAlert(alert: Alert): { database: string; table: string } | null {
  const dedupMatch = alert.dedup_key?.match(/^[^:]+:tables:[^:]+:([^.]+)\.(.+)$/)
  if (dedupMatch) return { database: dedupMatch[1], table: dedupMatch[2] }
  const msgMatch = alert.message?.match(/`?(\w+)`?\.`?(\w+)`?/)
  if (msgMatch) return { database: msgMatch[1], table: msgMatch[2] }
  return null
}

/* ------------------------------------------------------------------ */
/*  Investigation SQL generators                                       */
/* ------------------------------------------------------------------ */
function investigationSql(alert: Alert): string[] {
  const ts = alert.created_at
  const from = new Date((ts - 600) * 1000).toISOString().replace('T', ' ').slice(0, 19)
  const to = new Date((ts + 600) * 1000).toISOString().replace('T', ' ').slice(0, 19)

  const cat = (alert.category || '').toLowerCase()
  const title = (alert.title || '').toLowerCase()

  if (cat === 'sustained' || cat === 'drop') {
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
      ]
    }
    if (metricLower.includes('part')) {
      return [
        `SELECT database, table, count() as part_count,\n  sum(rows) as total_rows,\n  formatReadableSize(sum(bytes_on_disk)) as size\nFROM system.parts\nWHERE active\nGROUP BY database, table\nORDER BY part_count DESC\nLIMIT 20`,
      ]
    }
    if (metricLower.includes('merge')) {
      return [
        `SELECT database, table, elapsed, progress, num_parts, result_part_name, is_mutation\nFROM system.merges\nORDER BY elapsed DESC`,
      ]
    }
    if (metric) {
      return [
        `SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric = '${metric}'\nORDER BY event_time\nLIMIT 100`,
      ]
    }
  }

  if (cat.includes('memory') || title.includes('memory')) {
    return [
      `SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric LIKE '%Memory%'\nORDER BY event_time DESC\nLIMIT 100`,
    ]
  }
  if (cat.includes('cpu') || title.includes('cpu')) {
    return [
      `SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric IN ('OSCPUVirtualTimeMicroseconds', 'OSCPUWaitMicroseconds')\nORDER BY event_time DESC\nLIMIT 100`,
    ]
  }
  if (cat.includes('part') || cat.includes('merge') || title.includes('part') || title.includes('merge')) {
    return [
      `SELECT event_time, database, table, event_type, rows_read, size_compressed\nFROM system.part_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\nORDER BY event_time DESC\nLIMIT 50`,
    ]
  }
  if (cat.includes('quer') || title.includes('quer') || title.includes('failure') || title.includes('failed')) {
    return [
      `SELECT exception_code, count() as cnt, any(exception) as sample_msg\nFROM system.query_log\nWHERE type = 'ExceptionWhileProcessing'\n  AND event_time BETWEEN '${from}' AND '${to}'\nGROUP BY exception_code\nORDER BY cnt DESC`,
    ]
  }
  if (cat.includes('disk') || title.includes('disk')) {
    return [
      `SELECT name, path, formatReadableSize(free_space) as free,\n  formatReadableSize(total_space) as total,\n  round(100 - (free_space / total_space * 100), 1) as used_pct\nFROM system.disks`,
    ]
  }
  return [
    `SELECT event_time, type, query_duration_ms, read_rows, memory_usage,\n  substring(query, 1, 200) as q\nFROM system.query_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\nORDER BY event_time DESC\nLIMIT 50`,
  ]
}

/* ------------------------------------------------------------------ */
/*  Alert message renderer                                             */
/* ------------------------------------------------------------------ */
function looksLikeSql(s: string): boolean {
  const u = s.toUpperCase()
  return (u.includes('SELECT') && u.includes('FROM')) || u.includes('SHOW ') || u.includes('SYSTEM ') || u.includes('OPTIMIZE ') || u.includes('KILL ')
}

interface MessageSegment { type: 'text' | 'sql'; content: string }

function parseAlertMessage(message: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  const parts = message.split(/```(?:\w+)?\n?([\s\S]*?)```/g)
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const text = parts[i].trim()
      if (text) segments.push({ type: 'text', content: text })
    } else {
      const code = parts[i].trim()
      if (code) segments.push({ type: looksLikeSql(code) ? 'sql' : 'text', content: code })
    }
  }
  return segments
}

function AlertMessageRenderer({ message, instance }: { message: string; instance: string }) {
  const segments = parseAlertMessage(message)
  return (
    <div className="space-y-2">
      {segments.map((seg, i) => {
        if (seg.type === 'sql') return <SqlBlock key={i} sql={seg.content} instance={instance} />
        const lines = seg.content.split('\n')
        return (
          <div key={i} className="text-sm bg-[var(--hover)] rounded-md p-3 border border-[var(--border)] space-y-0.5">
            {lines.map((line, j) => {
              const parts = line.split(/\*([^*]+)\*/g)
              const rendered = parts.map((p, k) => k % 2 === 1 ? <strong key={k}>{p}</strong> : <span key={k}>{p}</span>)
              return <div key={j}>{rendered}</div>
            })}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  AlertRow — slim clickable row, opens slide-in panel              */
/* ------------------------------------------------------------------ */
function AlertRow({ alert, showMeta, staleHours, snoozed, acked, onSelect }: {
  alert: Alert
  showMeta?: boolean
  staleHours: number
  snoozed: Record<string, number>
  acked: Record<string, any>
  onSelect?: (alert: Alert) => void
}) {
  const stale = isStale(alert, staleHours)
  const snoozedUntil = snoozeUntil(alert.dedup_key, snoozed)
  const alertIsAcked = isAcked(alert.dedup_key, acked)

  return (
    <div className={cn('border-b border-[var(--border)] last:border-0', stale && 'opacity-60')}>
      <button
        onClick={() => onSelect?.(alert)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-[var(--hover)] transition-colors"
      >
        <ChevronRight size={14} className="shrink-0 text-[var(--dim)]" />
        {stale
          ? <Badge className="bg-[var(--border)] text-[var(--dim)] border border-[var(--border)] text-xs shrink-0">stale</Badge>
          : <Badge severity={alert.severity} />
        }
        {snoozedUntil && (
          <span className="inline-flex items-center gap-1 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5 shrink-0">
            <BellOff size={10} />
            snoozed
          </span>
        )}
        {alertIsAcked && (
          <span className="inline-flex items-center gap-1 text-xs text-green-400 bg-green-500/10 border border-green-500/20 rounded px-1.5 py-0.5 shrink-0">
            ✓ Investigating
          </span>
        )}
        {showMeta && (
          <>
            <span className="text-xs text-[var(--dim)] shrink-0">{alert.instance}</span>
            <span className="text-xs text-[var(--dim)] shrink-0">{alert.category}</span>
          </>
        )}
        <span className="font-medium truncate flex-1" title={alert.title}>{alert.title}</span>
        <span className="text-[var(--dim)] text-xs shrink-0">{fmtTime(alert.created_at)}</span>
        {alert.resolved && <Badge className="bg-green-500/10 text-green-400 border-green-500/20">resolved</Badge>}
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Timeline view                                                      */
/* ------------------------------------------------------------------ */
function TimelineView({ alerts, staleHours, onSelect }: { alerts: Alert[]; staleHours: number; onSelect?: (alert: Alert) => void }) {
  // Group by calendar day (local time), newest first
  const byDay = useMemo(() => {
    const map = new Map<string, Alert[]>()
    for (const a of alerts) {
      const d = new Date((a.created_at) * 1000)
      const key = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(a)
    }
    return Array.from(map.entries())
  }, [alerts])

  const { openTableDetail } = useStore()

  if (byDay.length === 0) {
    return <div className="text-sm text-[var(--dim)] text-center py-12">No alerts match the current filters</div>
  }

  return (
    <div className="space-y-8">
      {byDay.map(([day, dayAlerts]) => (
        <div key={day}>
          {/* Day header */}
          <div className="flex items-center gap-3 mb-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)] shrink-0">{day}</div>
            <div className="flex-1 h-px bg-[var(--border)]" />
            <div className="text-xs text-[var(--dim)] shrink-0">{dayAlerts.length} alert{dayAlerts.length !== 1 ? 's' : ''}</div>
          </div>

          {/* Alert cards */}
          <div className="space-y-2 pl-2">
            {dayAlerts.map((a) => {
              const stale = isStale(a, staleHours)
              const tableInfo = parseTableFromAlert(a)
              const d = new Date(a.created_at * 1000)
              const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

              return (
                <div key={a.id} className={cn(
                  'flex gap-4 items-start',
                  stale && 'opacity-50',
                )}>
                  {/* Time + spine */}
                  <div className="flex flex-col items-center shrink-0 w-14">
                    <div className="text-xs text-[var(--dim)] tabular-nums">{timeStr}</div>
                    <div className="w-px flex-1 bg-[var(--border)] mt-1 min-h-4" />
                  </div>

                  {/* Card */}
                  <div
                    onClick={() => onSelect?.(a)}
                    className={cn(
                      'flex-1 rounded-lg border p-3 mb-2 transition-colors',
                      onSelect && 'cursor-pointer hover:brightness-95',
                      stale
                        ? 'border-[var(--border)] bg-[var(--hover)]'
                        : a.resolved
                          ? 'border-green-500/20 bg-green-500/5'
                          : a.severity === 'critical'
                            ? 'border-red-500/20 bg-red-500/5'
                            : a.severity === 'warn'
                              ? 'border-yellow-500/20 bg-yellow-500/5'
                              : 'border-[var(--border)] bg-[var(--surface)]',
                    )}
                  >
                    <div className="flex items-start gap-2">
                      {stale
                        ? <Badge className="bg-[var(--border)] text-[var(--dim)] border border-[var(--border)] text-xs shrink-0">stale</Badge>
                        : <Badge severity={a.severity} />
                      }
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium">{a.title}</div>
                        <div className="flex items-center gap-2 mt-1 text-xs text-[var(--dim)]">
                          <span>{a.instance}</span>
                          <span>·</span>
                          <span>{a.category}</span>
                          {a.resolved && <><span>·</span><span className="text-green-400">resolved</span></>}
                        </div>
                        {a.message && (
                          <div className="text-xs text-[var(--dim)] mt-1 truncate" title={a.message}>{a.message.slice(0, 120)}</div>
                        )}
                      </div>
                      {tableInfo && (
                        <button
                          onClick={() => openTableDetail(a.instance, tableInfo.database, tableInfo.table)}
                          className="shrink-0 p-1 rounded hover:bg-[var(--hover)] text-[var(--accent)] transition-colors"
                          title={`Explore ${tableInfo.database}.${tableInfo.table}`}
                        >
                          <Table2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Stat Card                                                          */
/* ------------------------------------------------------------------ */
function StatCard({ label, value, color, sub }: { label: string; value: string | number; color?: string; sub?: string }) {
  return (
    <Card>
      <div className="text-3xl font-bold" style={{ color }}>{value}</div>
      <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">{label}</div>
      {sub && <div className="text-xs text-[var(--dim)] mt-0.5">{sub}</div>}
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Alerts view                                                        */
/* ------------------------------------------------------------------ */
type ViewMode = 'grouped' | 'flat' | 'timeline'

export default function Alerts({ refreshKey }: { refreshKey?: number }) {
  const { instances: cachedInstances, customFrom, customTo, setView, selectedInstance, alertPreset, setAlertPreset, navToDetail } = useStore()
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null)
  const { analyze } = useAIAnalysis(selectedInstance)
  const handleAnalyzeAlert = useCallback((alert: Alert) => {
    analyze(`Alert: ${alert.title}`, { row: alert }, { contextType: 'row', tab: 'alerts', elementId: String(alert.id) })
  }, [analyze])
  const handleAnalyzeAll = useCallback((alerts: Alert[]) => {
    analyze('Active Alerts', { alerts }, { contextType: 'tab', tab: 'alerts' })
  }, [analyze])
  const [activeAlerts, setActiveAlerts] = useState<Alert[]>([])
  const [historyAlerts, setHistoryAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [forcingPoll, setForcingPoll] = useState(false)
  const [forcePollMsg, setForcePollMsg] = useState('')

  const handleForcePoll = useCallback(async () => {
    setForcingPoll(true)
    setForcePollMsg('')
    try {
      await api.forcePoll()
      setForcePollMsg('Polling now — refresh in a few seconds')
      setTimeout(() => setForcePollMsg(''), 5000)
    } catch {
      setForcePollMsg('Failed to trigger poll')
      setTimeout(() => setForcePollMsg(''), 3000)
    } finally {
      setForcingPoll(false)
    }
  }, [])
  const [resolving, setResolving] = useState(false)
  const resolvingRef = useRef(false)
  const isFirstLoad = useRef(true)

  const [viewMode, setViewMode] = useState<ViewMode>('grouped')
  const [staleHours, setStaleHours] = useState<number>(loadStaleHours)

  const [filterInstance, setFilterInstance] = useState(alertPreset?.instance ?? 'all')
  const [filterSeverity, setFilterSeverity] = useState(alertPreset?.severity ?? 'all')
  const [filterCategory, setFilterCategory] = useState('all')
  const [filterType, setFilterType] = useState('all')
  const [filterStatus, setFilterStatus] = useState('all')

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [flatPage, setFlatPage] = useState(0)
  const FLAT_PAGE_SIZE = 50

  // Saved filter views
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => loadSavedViews())
  const [savingView, setSavingView] = useState(false)
  const [saveViewName, setSaveViewName] = useState('')

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkResolving, setBulkResolving] = useState(false)

  // Snooze state — tick forces re-reads from localStorage
  const [snoozeTick, setSnoozeTick] = useState(0)
  const snoozed = useMemo(() => loadSnoozed(), [snoozeTick]) // eslint-disable-line react-hooks/exhaustive-deps
  const handleSnoozeChange = useCallback(() => setSnoozeTick(t => t + 1), [])

  // Ack state — tick forces re-reads from localStorage
  const [ackTick, setAckTick] = useState(0)
  const acked = useMemo(() => loadAcked(), [ackTick]) // eslint-disable-line react-hooks/exhaustive-deps
  const handleAckChange = useCallback(() => setAckTick(t => t + 1), [])

  // Consume the preset once on mount, then clear it so navigating back doesn't re-apply
  useEffect(() => {
    if (alertPreset) setAlertPreset(null)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Persist threshold to localStorage
  const updateStaleHours = useCallback((v: number) => {
    setStaleHours(v)
    try { localStorage.setItem(STALE_LS_KEY, String(v)) } catch {}
  }, [])

  useEffect(() => {
    // Don't auto-refresh while a resolve operation is running
    if (resolvingRef.current) return
    let cancelled = false
    async function load() {
      if (isFirstLoad.current) {
        setLoading(true)
      } else {
        setRefreshing(true)
      }
      try {
        const [active, history] = await Promise.all([api.alerts.active(), api.alerts.history()])
        if (!cancelled) { setActiveAlerts(active); setHistoryAlerts(history); setLoadError(null) }
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message ?? 'Failed to load alerts')
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
          isFirstLoad.current = false
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [customFrom, customTo, refreshKey])

  const allAlerts = useMemo(() => {
    const map = new Map<number, Alert>()
    activeAlerts.forEach((a) => map.set(a.id, a))
    historyAlerts.forEach((a) => { if (!map.has(a.id)) map.set(a.id, a) })
    return Array.from(map.values()).sort((a, b) => b.created_at - a.created_at)
  }, [activeAlerts, historyAlerts])

  const categories = useMemo(() => [...new Set(allAlerts.map((a) => a.category))].sort(), [allAlerts])
  const alertTypes = useMemo(() => [...new Set(allAlerts.map((a) => a.title))].sort(), [allAlerts])
  const instanceNames = useMemo(() => [...new Set([...cachedInstances, ...allAlerts.map((a) => a.instance)])].sort(), [cachedInstances, allAlerts])

  // Reset flat page when filters change
  const prevFilterKey = `${filterInstance}${filterSeverity}${filterCategory}${filterType}${filterStatus}`
  const [lastFilterKey, setLastFilterKey] = useState(prevFilterKey)
  if (prevFilterKey !== lastFilterKey) {
    setLastFilterKey(prevFilterKey)
    setFlatPage(0)
  }

  const filtered = useMemo(() => {
    return allAlerts.filter((a) => {
      if (filterInstance !== 'all' && a.instance !== filterInstance) return false
      if (filterSeverity !== 'all' && a.severity !== filterSeverity) return false
      if (filterCategory !== 'all' && a.category !== filterCategory) return false
      if (filterType !== 'all' && a.title !== filterType) return false
      if (filterStatus === 'firing') {
        if (a.resolved || isStale(a, staleHours)) return false
        if (isSnoozed(a.dedup_key, snoozed)) return false // hide snoozed from "firing" view
      }
      if (filterStatus === 'stale' && !isStale(a, staleHours)) return false
      if (filterStatus === 'resolved' && !a.resolved) return false
      // Time range filter: show alerts created in range, plus always show active unresolved
      if (customFrom && customTo) {
        const inRange = a.created_at >= customFrom && a.created_at <= customTo
        const isActive = !a.resolved && !isStale(a, staleHours)
        if (!inRange && !isActive) return false
      }
      return true
    })
  }, [allAlerts, filterInstance, filterSeverity, filterCategory, filterType, filterStatus, staleHours, customFrom, customTo, snoozed])

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
      if (next.has(key)) { next.delete(key) } else { next.add(key) }
      return next
    })
  }

  const firingAlerts = filtered.filter((a) => !a.resolved && !isStale(a, staleHours))
  const firing = firingAlerts.length
  const critFiring = firingAlerts.filter((a) => a.severity === 'critical').length
  const warnFiring = firingAlerts.filter((a) => a.severity === 'warn').length
  const infoFiring = firingAlerts.filter((a) => a.severity !== 'critical' && a.severity !== 'warn').length
  // Firing stat card color: worst severity
  const firingColor = firing > 0
    ? (critFiring > 0 ? '#ef4444' : warnFiring > 0 ? '#eab308' : '#3b82f6')
    : undefined
  // Build breakdown sub-label
  const firingParts: string[] = []
  if (critFiring > 0) firingParts.push(`${critFiring} crit`)
  if (warnFiring > 0) firingParts.push(`${warnFiring} warn`)
  if (infoFiring > 0) firingParts.push(`${infoFiring} info`)
  const firingSub = firing > 0 ? firingParts.join(' · ') : undefined
  const staleCount = filtered.filter((a) => isStale(a, staleHours)).length
  const resolved = filtered.filter((a) => a.resolved).length
  const snoozedCount = useMemo(
    () => allAlerts.filter((a) => !a.resolved && isSnoozed(a.dedup_key, snoozed)).length,
    [allAlerts, snoozed],
  )

  // Total stale across ALL (unfiltered) for the dismiss button
  const totalStaleUnfiltered = useMemo(
    () => allAlerts.filter((a) => isStale(a, staleHours)).length,
    [allAlerts, staleHours],
  )

  const handleResolveAlert = useCallback(async (dedupKey: string) => {
    try {
      await api.alerts.resolve(dedupKey)
      const [active, history] = await Promise.all([api.alerts.active(), api.alerts.history()])
      setActiveAlerts(active)
      setHistoryAlerts(history)
      flashToast('Alert resolved', 'done')
    } catch (e: any) {
      flashToast(e.message ?? 'Resolve failed', 'error')
    }
  }, [])

  const handleResolveStale = useCallback(async () => {
    if (!totalStaleUnfiltered) return
    resolvingRef.current = true
    setResolving(true)
    try {
      const { resolved: n } = await api.alerts.resolveStale(staleHours)
      const [active, history] = await Promise.all([api.alerts.active(), api.alerts.history()])
      setActiveAlerts(active)
      setHistoryAlerts(history)
      flashToast(`${n} stale alert${n !== 1 ? 's' : ''} resolved`, 'done')
    } catch (e: any) {
      flashToast(e.message ?? 'Resolve stale failed', 'error')
    } finally {
      resolvingRef.current = false
      setResolving(false)
    }
  }, [staleHours, totalStaleUnfiltered])

  // Saved views handlers
  const saveCurrentView = useCallback(() => {
    const name = saveViewName.trim()
    if (!name) return
    const view: SavedView = { name, instance: filterInstance, severity: filterSeverity, category: filterCategory, type: filterType, status: filterStatus }
    const next = [...savedViews.filter(v => v.name !== name), view]
    setSavedViews(next)
    persistSavedViews(next)
    setSavingView(false)
    setSaveViewName('')
  }, [saveViewName, filterInstance, filterSeverity, filterCategory, filterType, filterStatus, savedViews])

  const deleteSavedView = useCallback((name: string) => {
    const next = savedViews.filter(v => v.name !== name)
    setSavedViews(next)
    persistSavedViews(next)
  }, [savedViews])

  const applySavedView = useCallback((sv: SavedView) => {
    setFilterInstance(sv.instance)
    setFilterSeverity(sv.severity)
    setFilterCategory(sv.category)
    setFilterType(sv.type)
    setFilterStatus(sv.status)
  }, [])

  // Bulk action handlers
  const toggleSelectAlert = useCallback((id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(filtered.map(a => a.id)))
  }, [filtered])

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const bulkResolveSelected = useCallback(async () => {
    if (!selectedIds.size) return
    setBulkResolving(true)
    const keys = filtered.filter(a => selectedIds.has(a.id) && a.dedup_key).map(a => a.dedup_key)
    try {
      await Promise.all(keys.map(k => api.alerts.resolve(k)))
      const [active, history] = await Promise.all([api.alerts.active(), api.alerts.history()])
      setActiveAlerts(active)
      setHistoryAlerts(history)
      setSelectedIds(new Set())
      flashToast(`${keys.length} alert${keys.length !== 1 ? 's' : ''} resolved`, 'done')
    } catch (e: any) {
      flashToast(e.message ?? 'Bulk resolve failed', 'error')
    } finally { setBulkResolving(false) }
  }, [selectedIds, filtered])

  const bulkSnoozeSelected = useCallback((hours: number) => {
    const items = filtered.filter(a => selectedIds.has(a.id) && a.dedup_key)
    items.forEach(a => snoozeAlert(a.dedup_key, hours))
    handleSnoozeChange()
    setSelectedIds(new Set())
    flashToast(`${items.length} alert${items.length !== 1 ? 's' : ''} snoozed for ${hours}h`, 'done')
  }, [selectedIds, filtered, handleSnoozeChange])

  const Select = ({ value, onChange, options, label }: {
    value: string; onChange: (v: string) => void
    options: { value: string; label: string }[]; label: string
  }) => (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-[var(--dim)] uppercase tracking-wider">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--accent)]"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 animate-pulse">
          {[...Array(3)].map((_, i) => (
            <Card key={i}>
              <div className="h-8 bg-[var(--hover)] rounded w-1/3 mb-2" />
              <div className="h-3 bg-[var(--hover)] rounded w-1/2" />
            </Card>
          ))}
        </div>
        <div className="flex items-center gap-2 text-sm text-[var(--dim)] animate-pulse">
          <RefreshCw size={14} className="animate-spin" />
          Loading alerts…
        </div>
        <div className="space-y-2 animate-pulse">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-10 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-4 flex items-center gap-3">
              <div className="w-14 h-5 bg-[var(--hover)] rounded-full" />
              <div className="w-24 h-3 bg-[var(--hover)] rounded" />
              <div className="flex-1 h-3 bg-[var(--hover)] rounded" style={{ maxWidth: `${40 + i * 7}%` }} />
              <div className="w-20 h-3 bg-[var(--hover)] rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const maintInstances = cachedInstances.filter((inst: any) => inst.in_maintenance)

  return (
    <div className="space-y-6">
      {/* ---- Load error banner ---- */}
      {loadError && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-400">
          <AlertCircle size={14} className="shrink-0" />
          <span className="flex-1">{loadError}</span>
          <button onClick={() => setLoadError(null)} className="text-xs hover:underline opacity-70">Dismiss</button>
        </div>
      )}
      {/* ---- Maintenance banners ---- */}
      {maintInstances.length > 0 && (
        <div className="space-y-2">
          {maintInstances.map((inst: any) => {
            const until = inst.maintenance_until
              ? new Date(inst.maintenance_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : null
            return (
              <div key={inst.name} className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-orange-500/30 bg-orange-500/10 text-sm text-orange-400">
                <Wrench size={14} className="shrink-0" />
                <span className="font-medium font-mono">{inst.name}</span>
                <span className="text-orange-400/70">is in maintenance — alerts suppressed</span>
                {inst.maintenance_reason && (
                  <span className="text-orange-400/60 italic">· {inst.maintenance_reason}</span>
                )}
                {until && <span className="ml-auto text-orange-400/70 text-xs shrink-0">until {until}</span>}
              </div>
            )
          })}
        </div>
      )}
      {/* ---- Stat cards + actions ---- */}
      <div className="flex items-start gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 flex-1">
          <StatCard label="Active" value={firing} color={firingColor} sub={firingSub} />
          <StatCard
            label="Stale"
            value={staleCount}
            color={staleCount > 0 ? '#9ca3af' : undefined}
            sub={`>${staleHours}h without update`}
          />
          <StatCard label="Resolved" value={resolved} color="#22c55e" />
          {snoozedCount > 0 && (
            <StatCard
              label="Snoozed"
              value={snoozedCount}
              color="#f59e0b"
              sub="hidden from active view"
            />
          )}
        </div>

        {/* Action buttons */}
        <div className="flex flex-col gap-2 shrink-0 pt-1">
          <button
            onClick={handleForcePoll}
            disabled={forcingPoll}
            title="Runs all collectors immediately through the full pipeline — stores to DB, sends to Slack, updates this page. Different from Refresh which only re-reads the database."
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-orange-400 hover:bg-orange-500/15 border border-orange-500/25 transition-colors disabled:opacity-50"
          >
            <Zap size={14} className={forcingPoll ? 'animate-pulse' : ''} />
            {forcingPoll ? 'Polling…' : 'Force Poll Now'}
          </button>
          {forcePollMsg && (
            <p className="text-xs text-green-400">{forcePollMsg}</p>
          )}
          <button
            onClick={() => setView('analyzer')}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25 transition-colors"
          >
            <Brain size={14} />
            Analyze with AI
          </button>
          <button
            onClick={() => handleAnalyzeAll(filtered)}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-purple-400 hover:bg-purple-500/15 border border-purple-500/20 transition-colors disabled:opacity-30"
          >
            <Sparkles size={14} />
            Analyze filtered
          </button>
          {totalStaleUnfiltered > 0 && (
            <button
              onClick={handleResolveStale}
              disabled={resolving}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-[var(--border)] text-[var(--dim)] hover:bg-[var(--hover)] transition-colors disabled:opacity-50"
            >
              <Trash2 size={14} />
              {resolving ? 'Resolving...' : `Dismiss stale (${totalStaleUnfiltered})`}
            </button>
          )}
        </div>
      </div>

      {/* ---- View mode + staleness threshold ---- */}
      <div className="flex items-center gap-4 flex-wrap">
        {refreshing && (
          <div className="flex items-center gap-1.5 text-xs text-[var(--dim)]">
            <RefreshCw size={11} className="animate-spin" />
            Refreshing…
          </div>
        )}
        <div className="flex gap-1 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-1">
          {(['grouped', 'flat', 'timeline'] as ViewMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={cn(
                'px-4 py-1.5 text-sm font-medium rounded-md transition-colors capitalize',
                viewMode === m
                  ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                  : 'text-[var(--dim)] hover:text-[var(--text)]',
              )}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <Clock size={13} className="text-[var(--dim)]" />
          <label className="text-xs text-[var(--dim)]">Stale after</label>
          <select
            value={staleHours}
            onChange={(e) => updateStaleHours(Number(e.target.value))}
            className="bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1 text-sm focus:outline-none focus:border-[var(--accent)]"
          >
            {STALE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {/* ---- Filters ---- */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <Select label="Instance" value={filterInstance} onChange={setFilterInstance}
          options={[{ value: 'all', label: 'All instances' }, ...instanceNames.map((n) => ({ value: n, label: n }))]} />
        <Select label="Severity" value={filterSeverity} onChange={setFilterSeverity}
          options={[{ value: 'all', label: 'All severities' }, { value: 'critical', label: 'Critical' }, { value: 'warn', label: 'Warning' }, { value: 'info', label: 'Info' }]} />
        <Select label="Category" value={filterCategory} onChange={setFilterCategory}
          options={[{ value: 'all', label: 'All categories' }, ...categories.map((c) => ({ value: c, label: c }))]} />
        <Select label="Alert Type" value={filterType} onChange={setFilterType}
          options={[{ value: 'all', label: 'All types' }, ...alertTypes.map((t) => ({ value: t, label: t }))]} />
        <Select label="Status" value={filterStatus} onChange={setFilterStatus}
          options={[
            { value: 'all', label: 'All' },
            { value: 'firing', label: 'Firing (fresh)' },
            { value: 'stale', label: 'Stale' },
            { value: 'resolved', label: 'Resolved' },
          ]} />
      </div>

      {/* ---- Saved filter views ---- */}
      <div className="flex items-center gap-2 flex-wrap">
        {savedViews.map(sv => (
          <span key={sv.name} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent)]/20">
            <button onClick={() => applySavedView(sv)} className="hover:underline">{sv.name}</button>
            <button onClick={() => deleteSavedView(sv.name)} className="text-[var(--dim)] hover:text-red-400 transition-colors"><X size={10} /></button>
          </span>
        ))}
        {savingView ? (
          <span className="inline-flex items-center gap-1">
            <input
              autoFocus
              value={saveViewName}
              onChange={e => setSaveViewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveCurrentView(); if (e.key === 'Escape') setSavingView(false) }}
              placeholder="View name…"
              className="bg-[var(--surface)] border border-[var(--accent)]/40 rounded px-2 py-0.5 text-[11px] focus:outline-none w-28"
            />
            <button onClick={saveCurrentView} className="text-[11px] text-[var(--accent)] hover:underline">Save</button>
            <button onClick={() => setSavingView(false)} className="text-[11px] text-[var(--dim)] hover:text-[var(--text)]">Cancel</button>
          </span>
        ) : (
          <button onClick={() => setSavingView(true)} className="inline-flex items-center gap-1 text-[11px] text-[var(--dim)] hover:text-[var(--accent)] transition-colors">
            <Bookmark size={11} /> Save view
          </button>
        )}
      </div>

      {/* ---- Bulk action bar (shown when items are selected) ---- */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-[var(--accent-subtle)] border border-[var(--accent)]/20">
          <CheckCheck size={14} className="text-[var(--accent)] shrink-0" />
          <span className="text-[12px] font-medium text-[var(--accent)]">{selectedIds.size} selected</span>
          <div className="flex-1" />
          <button onClick={bulkResolveSelected} disabled={bulkResolving} className="flex items-center gap-1 px-3 py-1.5 rounded text-[11px] font-medium text-green-400 bg-green-500/10 hover:bg-green-500/20 border border-green-500/20 transition-colors disabled:opacity-50">
            {bulkResolving ? <RefreshCw size={10} className="animate-spin" /> : <CheckCheck size={10} />}
            Resolve selected
          </button>
          <button onClick={() => bulkSnoozeSelected(4)} className="flex items-center gap-1 px-3 py-1.5 rounded text-[11px] font-medium text-yellow-400 bg-yellow-500/10 hover:bg-yellow-500/20 border border-yellow-500/20 transition-colors">
            <BellOff size={10} /> Snooze 4h
          </button>
          <button onClick={clearSelection} className="text-[11px] text-[var(--dim)] hover:text-[var(--text)] transition-colors">Clear</button>
        </div>
      )}

      {/* ---- Alert list ---- */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-[var(--dim)]">
          <Bell size={20} className="opacity-30" />
          <span className="text-sm">No alerts match the current filters</span>
          {(filterInstance !== 'all' || filterSeverity !== 'all' || filterCategory !== 'all' || filterType !== 'all' || filterStatus !== 'all') && (
            <button
              onClick={() => { setFilterInstance('all'); setFilterSeverity('all'); setFilterCategory('all'); setFilterType('all'); setFilterStatus('all') }}
              className="text-xs text-[var(--accent)] hover:underline mt-1"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : viewMode === 'timeline' ? (
        <TimelineView alerts={filtered} staleHours={staleHours} onSelect={setSelectedAlert} />
      ) : viewMode === 'flat' ? (
        <Card className="!p-0">
          {/* Select all header */}
          <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)]/50">
            <button
              onClick={() => selectedIds.size === filtered.length ? clearSelection() : selectAll()}
              className="text-[var(--dim)] hover:text-[var(--accent)] transition-colors"
            >
              {selectedIds.size === filtered.length && filtered.length > 0 ? <CheckSquare size={13} className="text-[var(--accent)]" /> : <Square size={13} />}
            </button>
            <span className="text-[10px] text-[var(--dim)] uppercase tracking-wider">
              {selectedIds.size > 0 ? `${selectedIds.size} of ${filtered.length} selected` : `${filtered.length} alerts`}
            </span>
          </div>
          {filtered.slice(flatPage * FLAT_PAGE_SIZE, (flatPage + 1) * FLAT_PAGE_SIZE).map((alert) => (
            <div key={alert.id} className="flex items-start gap-2 pr-2">
              <button
                onClick={() => toggleSelectAlert(alert.id)}
                className="mt-3 ml-4 text-[var(--dim)] hover:text-[var(--accent)] transition-colors shrink-0"
              >
                {selectedIds.has(alert.id) ? <CheckSquare size={12} className="text-[var(--accent)]" /> : <Square size={12} />}
              </button>
              <div className="flex-1 min-w-0">
                <AlertRow alert={alert} showMeta staleHours={staleHours} snoozed={snoozed} acked={acked} onSelect={setSelectedAlert} />
              </div>
            </div>
          ))}
          {filtered.length > FLAT_PAGE_SIZE && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-[var(--border)]">
              <span className="text-xs text-[var(--dim)]">
                {flatPage * FLAT_PAGE_SIZE + 1}–{Math.min((flatPage + 1) * FLAT_PAGE_SIZE, filtered.length)} of {filtered.length}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setFlatPage(p => Math.max(0, p - 1))}
                  disabled={flatPage === 0}
                  className="p-1 rounded hover:bg-[var(--hover)] disabled:opacity-30 transition-colors"
                >
                  <ChevronLeft size={14} />
                </button>
                <span className="text-xs text-[var(--dim)] px-1">{flatPage + 1} / {Math.ceil(filtered.length / FLAT_PAGE_SIZE)}</span>
                <button
                  onClick={() => setFlatPage(p => Math.min(Math.ceil(filtered.length / FLAT_PAGE_SIZE) - 1, p + 1))}
                  disabled={flatPage >= Math.ceil(filtered.length / FLAT_PAGE_SIZE) - 1}
                  className="p-1 rounded hover:bg-[var(--hover)] disabled:opacity-30 transition-colors"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map(([key, groupAlerts]) => {
            const [inst, cat] = key.split('::')
            const isCollapsed = collapsedGroups.has(key)
            const groupFiringAlerts = groupAlerts.filter((a) => !a.resolved && !isStale(a, staleHours))
            const groupFiring = groupFiringAlerts.length
            const groupStale = groupAlerts.filter((a) => isStale(a, staleHours)).length
            const groupResolved = groupAlerts.filter((a) => a.resolved).length
            const worstSev = groupAlerts.some((a) => a.severity === 'critical' && !isStale(a, staleHours) && !a.resolved)
              ? 'critical'
              : groupAlerts.some((a) => a.severity === 'warn' && !isStale(a, staleHours) && !a.resolved)
                ? 'warn'
                : 'info'
            // Color "X active" text by worst severity of actually-firing alerts
            const hasCritFiring = groupFiringAlerts.some((a) => a.severity === 'critical')
            const hasWarnFiring = groupFiringAlerts.some((a) => a.severity === 'warn')
            const firingTextColor = hasCritFiring ? 'text-red-400' : hasWarnFiring ? 'text-yellow-400' : 'text-blue-400'

            return (
              <Card key={key} className="!p-0">
                <button
                  onClick={() => toggleGroup(key)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--hover)] transition-colors"
                >
                  {isCollapsed ? <ChevronRight size={16} className="shrink-0 text-[var(--dim)]" /> : <ChevronDown size={16} className="shrink-0 text-[var(--dim)]" />}
                  <span className="font-medium">{inst}</span>
                  <span className="text-[var(--dim)]">/</span>
                  <span className="text-sm">{cat}</span>
                  <Badge severity={worstSev} />
                  <div className="flex-1" />
                  {groupFiring > 0 && <span className={`text-xs ${firingTextColor}`}>{groupFiring} active</span>}
                  {groupStale > 0 && <span className="text-xs text-[var(--dim)] ml-2">{groupStale} stale</span>}
                  {groupResolved > 0 && <span className="text-xs text-green-400 ml-2">{groupResolved} resolved</span>}
                </button>
                {!isCollapsed && (
                  <div className="border-t border-[var(--border)]">
                    {groupAlerts.map((alert) => <AlertRow key={alert.id} alert={alert} staleHours={staleHours} snoozed={snoozed} acked={acked} onSelect={setSelectedAlert} />)}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {selectedAlert && (
        <AlertDetailPanel
          alert={selectedAlert}
          staleHours={staleHours}
          onClose={() => setSelectedAlert(null)}
          onResolve={!selectedAlert.resolved ? handleResolveAlert : undefined}
          onSnoozeChange={handleSnoozeChange}
          onAckChange={handleAckChange}
          onAnalyze={alert => { handleAnalyzeAlert(alert); setSelectedAlert(null) }}
          onNavToInstance={name => { navToDetail(name); setSelectedAlert(null) }}
        />
      )}
    </div>
  )
}
