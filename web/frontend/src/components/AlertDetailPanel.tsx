import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  X, Bell, BellOff, BookOpen, Sparkles, Table2, ChevronRight,
  AlertTriangle, Clock, Hash, Server, Tag, Search,
} from 'lucide-react'
import { cn, fmtTime } from '../lib/utils'
import { api } from '../lib/api'
import { Badge } from './Badge'
import { SqlBlock } from './SqlBlock'
import { useStore } from '../hooks/useStore'
import type { Alert, Suggestion } from '../types/api'

/* ------------------------------------------------------------------ */
/*  Snooze helpers (mirrored from Alerts.tsx — localStorage-based)    */
/* ------------------------------------------------------------------ */
const SNOOZE_LS_KEY = 'ch-snoozed-alerts'
const ACK_LS_KEY = 'ch-acked-alerts'

function loadSnoozed(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SNOOZE_LS_KEY) ?? '{}') } catch { return {} }
}
function loadAcked(): Record<string, { by: string; note: string; at: number }> {
  try { return JSON.parse(localStorage.getItem(ACK_LS_KEY) ?? '{}') } catch { return {} }
}
function snoozeAlert(dedupKey: string, hours: number) {
  const snoozed = loadSnoozed()
  snoozed[dedupKey] = Math.floor(Date.now() / 1000) + hours * 3600
  const now = Math.floor(Date.now() / 1000)
  Object.keys(snoozed).forEach(k => { if (snoozed[k] < now) delete snoozed[k] })
  try { localStorage.setItem(SNOOZE_LS_KEY, JSON.stringify(snoozed)) } catch {}
}
function unsnoozeAlert(dedupKey: string) {
  const s = loadSnoozed(); delete s[dedupKey]
  try { localStorage.setItem(SNOOZE_LS_KEY, JSON.stringify(s)) } catch {}
}
function ackAlert(dedupKey: string, by: string, note: string) {
  const a = loadAcked()
  a[dedupKey] = { by, at: Math.floor(Date.now() / 1000), note }
  try { localStorage.setItem(ACK_LS_KEY, JSON.stringify(a)) } catch {}
}
function unackAlert(dedupKey: string) {
  const a = loadAcked(); delete a[dedupKey]
  try { localStorage.setItem(ACK_LS_KEY, JSON.stringify(a)) } catch {}
}
function snoozeUntil(dedupKey: string, snoozed: Record<string, number>): number | null {
  const exp = snoozed[dedupKey]
  return (exp != null && exp > Math.floor(Date.now() / 1000)) ? exp : null
}

/* ------------------------------------------------------------------ */
/*  Runbooks                                                           */
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

/* ------------------------------------------------------------------ */
/*  Investigation SQL                                                  */
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
      return [`SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric IN ('OSCPUVirtualTimeMicroseconds', 'OSCPUWaitMicroseconds', 'CPUFrequencyMHz_0')\nORDER BY event_time DESC\nLIMIT 50`]
    }
    if (metricLower.includes('part')) {
      return [`SELECT database, table, count() as part_count,\n  sum(rows) as total_rows,\n  formatReadableSize(sum(bytes_on_disk)) as size\nFROM system.parts\nWHERE active\nGROUP BY database, table\nORDER BY part_count DESC\nLIMIT 20`]
    }
    if (metricLower.includes('merge')) {
      return [`SELECT database, table, elapsed, progress, num_parts, result_part_name, is_mutation\nFROM system.merges\nORDER BY elapsed DESC`]
    }
    if (metric) {
      return [`SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric = '${metric}'\nORDER BY event_time\nLIMIT 100`]
    }
  }
  if (cat.includes('memory') || title.includes('memory')) {
    return [`SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric LIKE '%Memory%'\nORDER BY event_time DESC\nLIMIT 100`]
  }
  if (cat.includes('cpu') || title.includes('cpu')) {
    return [`SELECT event_time, metric, value\nFROM system.asynchronous_metric_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\n  AND metric IN ('OSCPUVirtualTimeMicroseconds', 'OSCPUWaitMicroseconds')\nORDER BY event_time DESC\nLIMIT 100`]
  }
  if (cat.includes('part') || cat.includes('merge') || title.includes('part') || title.includes('merge')) {
    return [`SELECT event_time, database, table, event_type, rows_read, size_compressed\nFROM system.part_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\nORDER BY event_time DESC\nLIMIT 50`]
  }
  if (cat.includes('quer') || title.includes('quer') || title.includes('failure') || title.includes('failed')) {
    return [`SELECT exception_code, count() as cnt, any(exception) as sample_msg\nFROM system.query_log\nWHERE type = 'ExceptionWhileProcessing'\n  AND event_time BETWEEN '${from}' AND '${to}'\nGROUP BY exception_code\nORDER BY cnt DESC`]
  }
  if (cat.includes('disk') || title.includes('disk')) {
    return [`SELECT name, path, formatReadableSize(free_space) as free,\n  formatReadableSize(total_space) as total,\n  round(100 - (free_space / total_space * 100), 1) as used_pct\nFROM system.disks`]
  }
  return [`SELECT event_time, type, query_duration_ms, read_rows, memory_usage,\n  substring(query, 1, 200) as q\nFROM system.query_log\nWHERE event_time BETWEEN '${from}' AND '${to}'\nORDER BY event_time DESC\nLIMIT 50`]
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
          <div key={i} className="text-xs bg-[var(--hover)] rounded-md p-3 border border-[var(--border)] space-y-0.5">
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
/*  Table parser                                                       */
/* ------------------------------------------------------------------ */
function parseTableFromAlert(alert: Alert): { database: string; table: string } | null {
  const dedupMatch = alert.dedup_key?.match(/^[^:]+:tables:[^:]+:([^.]+)\.(.+)$/)
  if (dedupMatch) return { database: dedupMatch[1], table: dedupMatch[2] }
  const msgMatch = alert.message?.match(/`?(\w+)`?\.`?(\w+)`?/)
  if (msgMatch) return { database: msgMatch[1], table: msgMatch[2] }
  return null
}

/* ------------------------------------------------------------------ */
/*  Runbook panel (all steps visible)                                  */
/* ------------------------------------------------------------------ */
function RunbookSteps({ runbook }: { runbook: Runbook }) {
  return (
    <div className="space-y-2">
      {runbook.steps.map((step, i) => {
        const sqlMatch = step.indexOf(': SELECT') > 0 || step.indexOf(': KILL') > 0 || step.indexOf(': OPTIMIZE') > 0 || step.indexOf(': SYSTEM') > 0
        if (sqlMatch) {
          const colonIdx = step.indexOf(': ')
          const label = step.slice(0, colonIdx)
          const sql = step.slice(colonIdx + 2)
          return (
            <div key={i} className="space-y-1">
              <div className="text-[11px] text-[var(--dim)]"><span className="text-blue-400 font-medium">{i + 1}.</span> {label}</div>
              <div className="font-mono text-[11px] bg-[var(--hover)] rounded p-2 border border-[var(--border)] overflow-x-auto whitespace-pre">{sql}</div>
            </div>
          )
        }
        return (
          <div key={i} className="text-[11px] text-[var(--dim)]">
            <span className="text-blue-400 font-medium">{i + 1}.</span> {step}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Severity colors                                                    */
/* ------------------------------------------------------------------ */
const SEV_BG: Record<string, string> = {
  critical: 'bg-red-500/10 border-red-500/30',
  warn: 'bg-yellow-500/10 border-yellow-500/30',
  info: 'bg-blue-500/10 border-blue-500/30',
}
const SEV_TEXT: Record<string, string> = {
  critical: 'text-red-400',
  warn: 'text-yellow-400',
  info: 'text-blue-400',
}

/* ------------------------------------------------------------------ */
/*  AlertDetailPanel                                                   */
/* ------------------------------------------------------------------ */
type PanelTab = 'details' | 'runbook' | 'investigate' | 'actions'

export interface AlertDetailPanelProps {
  alert: Alert
  staleHours?: number
  onClose: () => void
  onResolve?: (dedupKey: string) => void
  onSnoozeChange?: () => void
  onAckChange?: () => void
  onAnalyze?: (alert: Alert) => void
  onNavToInstance?: (instance: string) => void
}

export function AlertDetailPanel({
  alert,
  staleHours = 24,
  onClose,
  onResolve,
  onSnoozeChange,
  onAckChange,
  onAnalyze,
  onNavToInstance,
}: AlertDetailPanelProps) {
  const { openTableDetail, navToExploreWithRange } = useStore()
  const [tab, setTab] = useState<PanelTab>('details')
  const [suggestions, setSuggestions] = useState<Suggestion | null>(null)
  const [loadingSugg, setLoadingSugg] = useState(false)
  const [showAckForm, setShowAckForm] = useState(false)
  const [ackBy, setAckBy] = useState('user')
  const [ackNote, setAckNote] = useState('')
  const [snoozeTick, setSnoozeTick] = useState(0)
  const [ackTick, setAckTick] = useState(0)
  const snoozed = useMemo(() => loadSnoozed(), [snoozeTick]) // eslint-disable-line react-hooks/exhaustive-deps
  const acked = useMemo(() => loadAcked(), [ackTick]) // eslint-disable-line react-hooks/exhaustive-deps

  const snoozedUntil = snoozeUntil(alert.dedup_key, snoozed)
  const alertIsAcked = !!acked[alert.dedup_key]
  const ackedInfo = acked[alert.dedup_key] as { by: string; note: string; at: number } | undefined

  const runbook = useMemo(() => getRunbook(alert), [alert])
  const invSql = useMemo(() => investigationSql(alert), [alert])
  const tableInfo = useMemo(() => parseTableFromAlert(alert), [alert])

  const isStale = useMemo(() => {
    if (alert.resolved) return false
    const updatedAt = alert.updated_at ?? alert.created_at
    return (Date.now() / 1000 - updatedAt) > staleHours * 3600
  }, [alert, staleHours])

  // Load suggestions when details tab is active
  useEffect(() => {
    if (!suggestions && !loadingSugg) {
      setLoadingSugg(true)
      api.suggestions(alert.category).then(setSuggestions).catch(() => {}).finally(() => setLoadingSugg(false))
    }
  }, [alert.category]) // eslint-disable-line react-hooks/exhaustive-deps

  // Esc key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSnooze = useCallback((hours: number) => {
    snoozeAlert(alert.dedup_key, hours)
    setSnoozeTick(t => t + 1)
    onSnoozeChange?.()
  }, [alert.dedup_key, onSnoozeChange])

  const handleUnsnooze = useCallback(() => {
    unsnoozeAlert(alert.dedup_key)
    setSnoozeTick(t => t + 1)
    onSnoozeChange?.()
  }, [alert.dedup_key, onSnoozeChange])

  const handleAck = useCallback(() => {
    ackAlert(alert.dedup_key, ackBy || 'user', ackNote)
    setShowAckForm(false)
    setAckTick(t => t + 1)
    onAckChange?.()
  }, [alert.dedup_key, ackBy, ackNote, onAckChange])

  const handleUnack = useCallback(() => {
    unackAlert(alert.dedup_key)
    setAckTick(t => t + 1)
    onAckChange?.()
  }, [alert.dedup_key, onAckChange])

  const TABS: { id: PanelTab; label: string }[] = [
    { id: 'details', label: 'Details' },
    ...(runbook ? [{ id: 'runbook' as PanelTab, label: 'Runbook' }] : []),
    { id: 'investigate', label: 'Investigate' },
    { id: 'actions', label: 'Actions' },
  ]

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full z-50 w-[45vw] min-w-[480px] max-w-[95vw] bg-[var(--card)] border-l border-[var(--border)] flex flex-col shadow-2xl">

        {/* Header */}
        <div className={cn(
          'flex items-start gap-3 px-4 py-3 border-b border-[var(--border)] shrink-0',
          'border-l-4',
          alert.severity === 'critical' ? 'border-l-red-500' : alert.severity === 'warn' ? 'border-l-yellow-500' : 'border-l-blue-500',
        )}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <Badge severity={alert.severity} />
              {alert.resolved && (
                <span className="text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 rounded px-1.5 py-0.5">resolved</span>
              )}
              {isStale && !alert.resolved && (
                <span className="text-[10px] text-[var(--dim)] bg-[var(--border)] border border-[var(--border)] rounded px-1.5 py-0.5">stale</span>
              )}
              {snoozedUntil && (
                <span className="inline-flex items-center gap-1 text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5">
                  <BellOff size={9} /> snoozed
                </span>
              )}
              {alertIsAcked && (
                <span className="text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 rounded px-1.5 py-0.5">investigating</span>
              )}
            </div>
            <div className="text-[13px] font-semibold text-[var(--text)] leading-snug">{alert.title}</div>
            <div className="flex items-center gap-3 mt-1.5 text-[11px] text-[var(--dim)]">
              <span className="flex items-center gap-1"><Server size={10} />{alert.instance}</span>
              <span className="flex items-center gap-1"><Tag size={10} />{alert.category}</span>
              <span className="flex items-center gap-1"><Clock size={10} />{fmtTime(alert.created_at)}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-[var(--hover)] text-[var(--dim)] hover:text-[var(--text)] transition-colors shrink-0"
          >
            <X size={14} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[var(--border)] shrink-0 px-2">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'px-3 py-2 text-[11px] font-medium transition-colors relative',
                tab === t.id
                  ? 'text-[var(--accent)] after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:bg-[var(--accent)]'
                  : 'text-[var(--dim)] hover:text-[var(--text)]',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {/* --- Details tab --- */}
          {tab === 'details' && (
            <>
              {/* Metadata grid */}
              <div className={cn('rounded-lg border p-3 grid grid-cols-2 gap-x-4 gap-y-2', SEV_BG[alert.severity] ?? 'border-[var(--border)]')}>
                <div>
                  <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-0.5">Instance</div>
                  <div className="text-[11px] font-medium">{alert.instance}</div>
                </div>
                <div>
                  <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-0.5">Category</div>
                  <div className="text-[11px] font-medium">{alert.category}</div>
                </div>
                <div>
                  <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-0.5">Fired</div>
                  <div className="text-[11px]">{fmtTime(alert.created_at)}</div>
                </div>
                {(alert.updated_at && alert.updated_at !== alert.created_at) && (
                  <div>
                    <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-0.5">Last seen</div>
                    <div className={cn('text-[11px]', isStale ? 'text-yellow-400' : '')}>{fmtTime(alert.updated_at)}</div>
                  </div>
                )}
                {alert.resolved_at && (
                  <div>
                    <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-0.5">Resolved</div>
                    <div className="text-[11px] text-green-400">{fmtTime(alert.resolved_at)}</div>
                  </div>
                )}
                <div className="col-span-2">
                  <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-0.5">Dedup Key</div>
                  <div className="text-[10px] font-mono text-[var(--dim)] truncate">{alert.dedup_key}</div>
                </div>
              </div>

              {/* Message */}
              {alert.message && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-2">Alert Message</div>
                  <AlertMessageRenderer message={alert.message} instance={alert.instance} />
                </div>
              )}

              {/* Suggestions */}
              {loadingSugg && <div className="text-[11px] text-[var(--dim)] italic">Loading suggestions…</div>}
              {suggestions && suggestions.suggestions.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-2">Suggestions</div>
                  <div className="space-y-2">
                    {suggestions.suggestions.map((tip, i) => {
                      const backtickMatch = tip.match(/^([\s\S]*?)```(?:\w+)?\n?([\s\S]+?)```([\s\S]*)$/s)
                      if (backtickMatch) {
                        const before = backtickMatch[1].trim(), sql = backtickMatch[2].trim(), after = backtickMatch[3].trim()
                        return (
                          <div key={i} className="space-y-1">
                            {before && <div className="text-xs pl-2 border-l-2 border-[var(--border)]">{before}</div>}
                            {looksLikeSql(sql) ? <SqlBlock sql={sql} instance={alert.instance} /> : <pre className="text-xs bg-[var(--hover)] rounded p-2 border border-[var(--border)] font-mono">{sql}</pre>}
                            {after && <div className="text-xs pl-2 border-l-2 border-[var(--border)]">{after}</div>}
                          </div>
                        )
                      }
                      const sqlMatch = tip.match(/^(.*?):\s*(SELECT\s|SHOW\s|SYSTEM\s|OPTIMIZE\s|KILL\s)(.*)/is)
                      if (sqlMatch) {
                        return (
                          <div key={i} className="space-y-1">
                            <div className="text-xs pl-2 border-l-2 border-[var(--border)]">{sqlMatch[1].trim()}</div>
                            <SqlBlock sql={(sqlMatch[2] + sqlMatch[3]).trim()} instance={alert.instance} />
                          </div>
                        )
                      }
                      if (looksLikeSql(tip)) return <SqlBlock key={i} sql={tip} instance={alert.instance} />
                      return <div key={i} className="text-xs pl-2 border-l-2 border-[var(--border)]">{tip}</div>
                    })}
                  </div>
                </div>
              )}

              {/* Table explore */}
              {tableInfo && (
                <button
                  onClick={() => openTableDetail(alert.instance, tableInfo.database, tableInfo.table)}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25 transition-colors"
                >
                  <Table2 size={12} />
                  Explore Table: {tableInfo.database}.{tableInfo.table}
                </button>
              )}

              {/* Nav to instance */}
              {onNavToInstance && (
                <button
                  onClick={() => onNavToInstance(alert.instance)}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--hover)] border border-[var(--border)] transition-colors"
                >
                  <ChevronRight size={12} />
                  Instance detail →
                </button>
              )}
            </>
          )}

          {/* --- Runbook tab --- */}
          {tab === 'runbook' && runbook && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <BookOpen size={13} className="text-blue-400" />
                <div className="text-[12px] font-semibold text-blue-400">{runbook.title}</div>
              </div>
              <RunbookSteps runbook={runbook} />
            </div>
          )}

          {/* --- Investigate tab --- */}
          {tab === 'investigate' && (
            <div className="space-y-4">
              {/* Open in Explore at alert time ±10m */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const alertTime = alert.created_at
                    navToExploreWithRange(alert.instance, alertTime - 600, alertTime + 600)
                    onClose()
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 transition-colors"
                >
                  <Search size={11} />
                  Open Explore at alert time ±10m
                </button>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)] mb-3">Investigation Queries</div>
                <div className="space-y-3">
                  {invSql.map((sql, i) => <SqlBlock key={i} sql={sql} instance={alert.instance} />)}
                </div>
              </div>
            </div>
          )}

          {/* --- Actions tab --- */}
          {tab === 'actions' && (
            <div className="space-y-3">
              {/* AI Analyze */}
              {onAnalyze && (
                <div className="rounded-lg border border-[var(--border)] p-3">
                  <div className="text-[11px] font-semibold text-[var(--text)] mb-1">AI Analysis</div>
                  <div className="text-[11px] text-[var(--dim)] mb-2">Get AI-powered root cause analysis and remediation steps for this alert.</div>
                  <button
                    onClick={() => { onAnalyze(alert); onClose() }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 transition-colors"
                  >
                    <Sparkles size={11} />
                    Analyze with AI
                  </button>
                </div>
              )}

              {/* Resolve */}
              {onResolve && !alert.resolved && (
                <div className="rounded-lg border border-[var(--border)] p-3">
                  <div className="text-[11px] font-semibold text-[var(--text)] mb-1">Resolve</div>
                  <div className="text-[11px] text-[var(--dim)] mb-2">Mark this alert as resolved. It will no longer appear in the active alerts list.</div>
                  <button
                    onClick={() => { onResolve(alert.dedup_key); onClose() }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-green-400 bg-green-500/10 hover:bg-green-500/20 border border-green-500/20 transition-colors"
                  >
                    Mark resolved
                  </button>
                </div>
              )}

              {/* Snooze */}
              {!alert.resolved && (
                <div className="rounded-lg border border-[var(--border)] p-3">
                  <div className="text-[11px] font-semibold text-[var(--text)] mb-1">Snooze</div>
                  {snoozedUntil ? (
                    <div className="space-y-2">
                      <div className="text-[11px] text-amber-400 flex items-center gap-1.5">
                        <BellOff size={11} /> Snoozed until {fmtTime(snoozedUntil)}
                      </div>
                      <button
                        onClick={handleUnsnooze}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 transition-colors"
                      >
                        <Bell size={11} /> Unsnooze
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="text-[11px] text-[var(--dim)] mb-2">Temporarily hide this alert for the selected duration.</div>
                      <div className="flex gap-2 flex-wrap">
                        {[{ label: '4h', hours: 4 }, { label: '24h', hours: 24 }, { label: '7d', hours: 168 }].map(opt => (
                          <button
                            key={opt.hours}
                            onClick={() => handleSnooze(opt.hours)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 transition-colors"
                          >
                            <BellOff size={11} /> Snooze {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Acknowledge */}
              {!alert.resolved && (
                <div className="rounded-lg border border-[var(--border)] p-3">
                  <div className="text-[11px] font-semibold text-[var(--text)] mb-1">Acknowledge</div>
                  {alertIsAcked && ackedInfo ? (
                    <div className="space-y-2">
                      <div className="text-[11px] text-green-400">
                        Acknowledged by <strong>{ackedInfo.by}</strong>
                        {ackedInfo.note && <span className="text-[var(--dim)]"> — {ackedInfo.note}</span>}
                      </div>
                      <button
                        onClick={handleUnack}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-green-400 bg-green-500/10 hover:bg-green-500/20 border border-green-500/20 transition-colors"
                      >
                        Unacknowledge
                      </button>
                    </div>
                  ) : showAckForm ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          type="text"
                          value={ackBy}
                          onChange={e => setAckBy(e.target.value)}
                          placeholder="By"
                          className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[11px] w-24 focus:outline-none focus:border-[var(--accent)]"
                        />
                        <input
                          type="text"
                          value={ackNote}
                          onChange={e => setAckNote(e.target.value)}
                          placeholder="Note (optional)"
                          className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[11px] w-40 focus:outline-none focus:border-[var(--accent)]"
                        />
                        <button
                          onClick={handleAck}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-green-400 bg-green-500/10 hover:bg-green-500/20 border border-green-500/20 transition-colors"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setShowAckForm(false)}
                          className="text-[11px] text-[var(--dim)] hover:text-[var(--text)] transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="text-[11px] text-[var(--dim)] mb-2">Mark that you are actively investigating this alert.</div>
                      <button
                        onClick={() => setShowAckForm(true)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium text-green-400 bg-green-500/10 hover:bg-green-500/20 border border-green-500/20 transition-colors"
                      >
                        Acknowledge
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="shrink-0 border-t border-[var(--border)] px-4 py-2 flex items-center justify-between">
          <span className="text-[10px] text-[var(--dim)]">Press Esc to close</span>
          {alert.severity && (
            <span className={cn('text-[10px] font-medium uppercase tracking-wider', SEV_TEXT[alert.severity] ?? 'text-[var(--dim)]')}>
              {alert.severity}
            </span>
          )}
        </div>
      </div>
    </>
  )
}
