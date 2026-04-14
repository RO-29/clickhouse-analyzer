import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { Brain, ChevronDown, ChevronLeft, ChevronRight, Clock, RefreshCw, Sparkles, Table2, Trash2 } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { fmtTime, cn } from '../lib/utils'
import { Card } from '../components/Card'
import { Badge } from '../components/Badge'
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

function isStale(a: Alert, staleHours: number): boolean {
  if (a.resolved) return false
  const updatedAt = a.updated_at ?? a.created_at
  return (Date.now() / 1000 - updatedAt) > staleHours * 3600
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
/*  AlertRow (expandable)                                             */
/* ------------------------------------------------------------------ */
function AlertRow({ alert, showMeta, staleHours, onAnalyze, onResolve }: { alert: Alert; showMeta?: boolean; staleHours: number; onAnalyze?: (alert: Alert) => void; onResolve?: (dedupKey: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion | null>(null)
  const [loadingSugg, setLoadingSugg] = useState(false)
  const { openTableDetail } = useStore()
  const stale = isStale(alert, staleHours)

  const handleExpand = useCallback(() => {
    const next = !expanded
    setExpanded(next)
    if (next && !suggestions && !loadingSugg) {
      setLoadingSugg(true)
      api.suggestions(alert.category).then(setSuggestions).catch(() => {}).finally(() => setLoadingSugg(false))
    }
  }, [expanded, suggestions, loadingSugg, alert.category])

  const invSql = useMemo(() => investigationSql(alert), [alert])
  const tableInfo = useMemo(() => parseTableFromAlert(alert), [alert])

  return (
    <div className={cn('border-b border-[var(--border)] last:border-0', stale && 'opacity-60')}>
      <button
        onClick={handleExpand}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-[var(--hover)] transition-colors"
      >
        {expanded ? <ChevronDown size={14} className="shrink-0 text-[var(--dim)]" /> : <ChevronRight size={14} className="shrink-0 text-[var(--dim)]" />}
        {stale
          ? <Badge className="bg-gray-500/10 text-gray-400 border border-gray-500/20 text-xs shrink-0">stale</Badge>
          : <Badge severity={alert.severity} />
        }
        {showMeta && (
          <>
            <span className="text-xs text-[var(--dim)] shrink-0">{alert.instance}</span>
            <span className="text-xs text-[var(--dim)] shrink-0">{alert.category}</span>
          </>
        )}
        <span className="font-medium truncate flex-1">{alert.title}</span>
        <span className="text-[var(--dim)] text-xs shrink-0">{fmtTime(alert.created_at)}</span>
        {alert.resolved && <Badge className="bg-green-500/10 text-green-400 border-green-500/20">resolved</Badge>}
      </button>

      {expanded && (
        <div className="px-3 pb-4 pl-10 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-sm">
            <div><span className="text-[var(--dim)]">Instance: </span>{alert.instance}</div>
            <div><span className="text-[var(--dim)]">Category: </span>{alert.category}</div>
            <div><span className="text-[var(--dim)]">Dedup Key: </span><span className="font-mono text-xs">{alert.dedup_key}</span></div>
            <div><span className="text-[var(--dim)]">Created: </span>{fmtTime(alert.created_at)}</div>
            {stale && (
              <div><span className="text-[var(--dim)]">Last seen: </span><span className="text-yellow-400">{fmtTime(alert.updated_at ?? alert.created_at)}</span></div>
            )}
            {alert.resolved_at && <div><span className="text-[var(--dim)]">Resolved: </span>{fmtTime(alert.resolved_at)}</div>}
          </div>

          {alert.message && <AlertMessageRenderer message={alert.message} instance={alert.instance} />}

          {loadingSugg && <div className="text-sm text-[var(--dim)]">Loading suggestions...</div>}
          {suggestions && suggestions.suggestions.length > 0 && (
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-[var(--dim)] mb-2">Suggestions</div>
              <div className="space-y-2">
                {suggestions.suggestions.map((tip, i) => {
                  const backtickMatch = tip.match(/^([\s\S]*?)```(?:\w+)?\n?([\s\S]+?)```([\s\S]*)$/s)
                  if (backtickMatch) {
                    const before = backtickMatch[1].trim(), sql = backtickMatch[2].trim(), after = backtickMatch[3].trim()
                    return (
                      <div key={i} className="space-y-1">
                        {before && <div className="text-sm pl-2 border-l-2 border-[var(--border)]">{before}</div>}
                        {looksLikeSql(sql) ? <SqlBlock sql={sql} instance={alert.instance} /> : <pre className="text-sm bg-[var(--hover)] rounded p-2 border border-[var(--border)] font-mono">{sql}</pre>}
                        {after && <div className="text-sm pl-2 border-l-2 border-[var(--border)]">{after}</div>}
                      </div>
                    )
                  }
                  const sqlMatch = tip.match(/^(.*?):\s*(SELECT\s|SHOW\s|SYSTEM\s|OPTIMIZE\s|KILL\s)(.*)/is)
                  if (sqlMatch) {
                    return (
                      <div key={i} className="space-y-1">
                        <div className="text-sm pl-2 border-l-2 border-[var(--border)]">{sqlMatch[1].trim()}</div>
                        <SqlBlock sql={(sqlMatch[2] + sqlMatch[3]).trim()} instance={alert.instance} />
                      </div>
                    )
                  }
                  if (looksLikeSql(tip)) return <SqlBlock key={i} sql={tip} instance={alert.instance} />
                  return <div key={i} className="text-sm pl-2 border-l-2 border-[var(--border)]">{tip}</div>
                })}
              </div>
            </div>
          )}

          {tableInfo && (
            <button
              onClick={() => openTableDetail(alert.instance, tableInfo.database, tableInfo.table)}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25 transition-colors"
            >
              <Table2 size={14} />
              Explore Table: {tableInfo.database}.{tableInfo.table}
            </button>
          )}

          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-[var(--dim)] mb-2">Investigation Queries</div>
            <div className="space-y-2">
              {invSql.map((sql, i) => <SqlBlock key={i} sql={sql} instance={alert.instance} />)}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onAnalyze && (
              <button
                onClick={() => onAnalyze(alert)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-purple-400 hover:bg-purple-500/15 border border-purple-500/20 transition-colors"
              >
                <Sparkles size={11} />
                Analyze with AI
              </button>
            )}
            {onResolve && !alert.resolved && (
              <button
                onClick={() => onResolve(alert.dedup_key)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium text-green-400 hover:bg-green-500/15 border border-green-500/20 transition-colors"
              >
                Mark resolved
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Timeline view                                                      */
/* ------------------------------------------------------------------ */
function TimelineView({ alerts, staleHours }: { alerts: Alert[]; staleHours: number }) {
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
                  <div className={cn(
                    'flex-1 rounded-lg border p-3 mb-2',
                    stale
                      ? 'border-[var(--border)] bg-[var(--hover)]'
                      : a.resolved
                        ? 'border-green-500/20 bg-green-500/5'
                        : a.severity === 'critical'
                          ? 'border-red-500/20 bg-red-500/5'
                          : a.severity === 'warn'
                            ? 'border-yellow-500/20 bg-yellow-500/5'
                            : 'border-[var(--border)] bg-[var(--surface)]',
                  )}>
                    <div className="flex items-start gap-2">
                      {stale
                        ? <Badge className="bg-gray-500/10 text-gray-400 border border-gray-500/20 text-xs shrink-0">stale</Badge>
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
                          <div className="text-xs text-[var(--dim)] mt-1 truncate">{a.message.slice(0, 120)}</div>
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
  const { instances: cachedInstances, customFrom, customTo, setView, selectedInstance, alertPreset, setAlertPreset } = useStore()
  const { analyze } = useAIAnalysis(selectedInstance)
  const handleAnalyzeAlert = useCallback((alert: Alert) => {
    analyze(`Alert: ${alert.title}`, { alert }, { contextType: 'row', tab: 'alerts', elementId: String(alert.id) })
  }, [analyze])
  const handleAnalyzeAll = useCallback((alerts: Alert[]) => {
    analyze('Active Alerts', { alerts }, { contextType: 'tab', tab: 'alerts' })
  }, [analyze])
  const [activeAlerts, setActiveAlerts] = useState<Alert[]>([])
  const [historyAlerts, setHistoryAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
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
        if (!cancelled) { setActiveAlerts(active); setHistoryAlerts(history) }
      } catch {
        // keep empty
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
      if (filterStatus === 'firing' && (a.resolved || isStale(a, staleHours))) return false
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
  }, [allAlerts, filterInstance, filterSeverity, filterCategory, filterType, filterStatus, staleHours, customFrom, customTo])

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
    } catch (e: any) {
      console.error('[CH-Analyzer] Resolve alert failed:', e.message)
    }
  }, [])

  const handleResolveStale = useCallback(async () => {
    if (!totalStaleUnfiltered) return
    resolvingRef.current = true
    setResolving(true)
    try {
      const { resolved: n } = await api.alerts.resolveStale(staleHours)
      // Refresh data after resolving
      const [active, history] = await Promise.all([api.alerts.active(), api.alerts.history()])
      setActiveAlerts(active)
      setHistoryAlerts(history)
      console.info(`[CH-Analyzer] Resolved ${n} stale alerts`)
    } catch (e: any) {
      console.error('[CH-Analyzer] Resolve stale failed:', e.message)
    } finally {
      resolvingRef.current = false
      setResolving(false)
    }
  }, [staleHours, totalStaleUnfiltered])

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
        <div className="grid grid-cols-3 gap-4 animate-pulse">
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

  return (
    <div className="space-y-6">
      {/* ---- Stat cards + actions ---- */}
      <div className="flex items-start gap-4">
        <div className="grid grid-cols-3 gap-4 flex-1">
          <StatCard label="Active" value={firing} color={firingColor} sub={firingSub} />
          <StatCard
            label="Stale"
            value={staleCount}
            color={staleCount > 0 ? '#9ca3af' : undefined}
            sub={`>${staleHours}h without update`}
          />
          <StatCard label="Resolved" value={resolved} color="#22c55e" />
        </div>

        {/* Action buttons */}
        <div className="flex flex-col gap-2 shrink-0 pt-1">
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
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-gray-500/10 text-gray-400 hover:bg-gray-500/20 transition-colors disabled:opacity-50"
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
      <div className="grid grid-cols-5 gap-4">
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

      {/* ---- Alert list ---- */}
      {filtered.length === 0 ? (
        <div className="text-sm text-[var(--dim)] text-center py-12">No alerts match the current filters</div>
      ) : viewMode === 'timeline' ? (
        <TimelineView alerts={filtered} staleHours={staleHours} />
      ) : viewMode === 'flat' ? (
        <Card className="!p-0">
          {filtered.slice(flatPage * FLAT_PAGE_SIZE, (flatPage + 1) * FLAT_PAGE_SIZE).map((alert) => (
            <AlertRow key={alert.id} alert={alert} showMeta staleHours={staleHours} onAnalyze={handleAnalyzeAlert} onResolve={!alert.resolved ? handleResolveAlert : undefined} />
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
                  {groupStale > 0 && <span className="text-xs text-gray-400 ml-2">{groupStale} stale</span>}
                  {groupResolved > 0 && <span className="text-xs text-green-400 ml-2">{groupResolved} resolved</span>}
                </button>
                {!isCollapsed && (
                  <div className="border-t border-[var(--border)]">
                    {groupAlerts.map((alert) => <AlertRow key={alert.id} alert={alert} staleHours={staleHours} onAnalyze={handleAnalyzeAlert} onResolve={!alert.resolved ? handleResolveAlert : undefined} />)}
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
