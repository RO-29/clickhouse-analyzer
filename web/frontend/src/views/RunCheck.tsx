import { useState, useEffect, useRef, useCallback } from 'react'
import {
  PlayCircle, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2,
  XCircle, BarChart2, Clock, Loader2, Code2, Database, Info, RefreshCw, CalendarRange,
  Timer, Plus, Trash2, ToggleLeft, ToggleRight, ListChecks,
} from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import type { CollectorMeta, RunCheckResult, RunCheckAlert } from '../types/api'

// ── helpers ────────────────────────────────────────────────────────────────────

function severityBg(s: string) {
  switch (s) {
    case 'critical': return 'bg-red-500/15 text-red-400 border-red-500/30'
    case 'warn':     return 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'
    case 'info':     return 'bg-blue-500/15 text-blue-400 border-blue-500/30'
    default:         return 'bg-[var(--surface)] text-[var(--dim)]'
  }
}

function alertSummary(alerts: RunCheckAlert[]) {
  return alerts.reduce((acc, a) => {
    if (a.severity === 'critical') acc.critical++
    else if (a.severity === 'warn') acc.warn++
    else acc.info++
    return acc
  }, { critical: 0, warn: 0, info: 0 })
}

function getCheckErrorHint(errorMsg: string): string | null {
  const e = errorMsg.toLowerCase()
  if (e.includes('connect') || e.includes('refused') || e.includes('timeout') || e.includes('unreachable')) {
    return 'Instance may be down or unreachable. Check network connectivity and firewall rules.'
  }
  if (e.includes('auth') || e.includes('403') || e.includes('401') || e.includes('password') || e.includes('access denied')) {
    return 'Authentication failed. Verify credentials in config file have read access to system tables.'
  }
  if (e.includes('system.') || e.includes('unknown table') || e.includes('no such table')) {
    return 'This check requires access to ClickHouse system tables. Ensure the user has sufficient privileges.'
  }
  if (e.includes('memory') || e.includes('quota')) {
    return 'Query hit a resource limit. Try running against a less loaded instance.'
  }
  return null
}

function groupByCategory(metas: CollectorMeta[]): Record<string, CollectorMeta[]> {
  return metas.reduce((acc, m) => {
    ;(acc[m.category] ??= []).push(m)
    return acc
  }, {} as Record<string, CollectorMeta[]>)
}

// Time range helpers
const PRESETS = [
  { label: 'Live', minutes: 0 },
  { label: '5m', minutes: 5 },
  { label: '15m', minutes: 15 },
  { label: '1h', minutes: 60 },
  { label: '6h', minutes: 360 },
  { label: '24h', minutes: 1440 },
  { label: 'Custom', minutes: -1 },
]

function toLocalDatetimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const CATEGORY_LABELS: Record<string, string> = {
  system:       'System',
  queries:      'Queries',
  tables:       'Tables',
  storage:      'Storage',
  inserts:      'Inserts',
  mvs:          'Materialized Views',
  dictionaries: 'Dictionaries',
  replication:  'Replication',
  errors:       'Errors',
}

// ── Result card (always expanded) ─────────────────────────────────────────────

function ResultCard({ result }: { result: RunCheckResult }) {
  const [showQueries, setShowQueries] = useState(false)
  const [expandedAlert, setExpandedAlert] = useState<number | null>(null)

  const summary = alertSummary(result.alerts)
  const hasAlerts = result.alerts.length > 0
  const hasError = !!result.error
  const hasMetrics = result.metrics.length > 0

  const borderColor = hasError
    ? 'border-red-500/40'
    : summary.critical > 0
      ? 'border-red-500/30'
      : summary.warn > 0
        ? 'border-yellow-500/30'
        : 'border-green-500/20'

  return (
    <div className={cn('bg-[var(--card)] border rounded-xl overflow-hidden', borderColor)}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--surface)]/40">
        {hasError ? (
          <XCircle size={15} className="text-red-400 shrink-0" />
        ) : hasAlerts ? (
          summary.critical > 0
            ? <AlertTriangle size={15} className="text-red-400 shrink-0" />
            : <AlertTriangle size={15} className="text-yellow-400 shrink-0" />
        ) : (
          <CheckCircle2 size={15} className="text-green-500 shrink-0" />
        )}

        <span className="font-mono text-xs bg-[var(--accent)]/10 text-[var(--accent)] px-2 py-0.5 rounded border border-[var(--accent)]/20">
          {result.instance}
        </span>
        <span className="text-sm font-semibold text-[var(--text)]">{result.display_name}</span>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {summary.critical > 0 && (
            <span className={cn('text-xs px-2 py-0.5 rounded-full border font-medium', severityBg('critical'))}>
              {summary.critical} critical
            </span>
          )}
          {summary.warn > 0 && (
            <span className={cn('text-xs px-2 py-0.5 rounded-full border font-medium', severityBg('warn'))}>
              {summary.warn} warn
            </span>
          )}
          {!hasError && !hasAlerts && (
            <span className="text-xs text-green-500 font-medium">clean</span>
          )}
          <span className="flex items-center gap-1 text-xs text-[var(--dim)]">
            <Clock size={10} />
            {result.duration_ms}ms
          </span>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Error */}
        {hasError && (
          <div className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 rounded-lg p-3 border border-red-500/20">
            <XCircle size={14} className="shrink-0 mt-0.5" />
            <div>
              <code className="text-xs font-mono">{result.error}</code>
              {getCheckErrorHint(result.error!) && (
                <div className="text-[11px] text-amber-400/80 mt-1 flex items-center gap-1">
                  <span>💡</span> {getCheckErrorHint(result.error!)}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Alerts */}
        {hasAlerts && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)] flex items-center gap-1.5">
              <AlertTriangle size={11} /> Alerts ({result.alerts.length})
            </p>
            {result.alerts.map((a, i) => (
              <div key={i} className={cn('rounded-lg border overflow-hidden', severityBg(a.severity))}>
                <button
                  onClick={() => setExpandedAlert(expandedAlert === i ? null : i)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:opacity-80 transition-opacity"
                >
                  <span className="text-[10px] font-bold uppercase opacity-70 w-12 shrink-0">{a.severity}</span>
                  <span className="text-xs font-medium flex-1 text-left">{a.title}</span>
                  <span className="text-[10px] opacity-60 shrink-0">{a.category}</span>
                  <span className="shrink-0 opacity-60">
                    {expandedAlert === i ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>
                </button>
                {expandedAlert === i && (
                  <div className="px-3 pb-3 border-t border-current/10">
                    <pre className="text-xs whitespace-pre-wrap font-mono leading-relaxed opacity-90 mt-2">{a.message}</pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Clean state */}
        {!hasError && !hasAlerts && (
          <div className="flex items-center gap-2 text-sm text-green-500 bg-green-500/10 rounded-lg px-3 py-2.5 border border-green-500/20">
            <CheckCircle2 size={14} />
            <span>All checks passed — no issues detected</span>
          </div>
        )}

        {/* Metrics table */}
        {hasMetrics && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)] flex items-center gap-1.5">
              <BarChart2 size={11} /> Metrics ({result.metrics.length})
            </p>
            <div className="rounded-lg border border-[var(--border)] overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[var(--surface)] border-b border-[var(--border)]">
                    <th className="text-left px-3 py-2 text-[var(--dim)] font-medium">Metric</th>
                    <th className="text-left px-3 py-2 text-[var(--dim)] font-medium">Labels</th>
                    <th className="text-right px-3 py-2 text-[var(--dim)] font-medium">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {result.metrics.map((m, i) => {
                    const labelPairs = Object.entries(m.labels ?? {})
                    return (
                      <tr key={i} className={cn('border-b border-[var(--border)] last:border-0', i % 2 === 0 ? '' : 'bg-[var(--surface)]/30')}>
                        <td className="px-3 py-2 font-mono text-[var(--text)] max-w-[220px]">
                          <span className="block truncate" title={m.name}>{m.name}</span>
                        </td>
                        <td className="px-3 py-2 text-[var(--dim)]">
                          {labelPairs.length > 0 ? (
                            <span className="flex flex-wrap gap-1">
                              {labelPairs.map(([k, v]) => (
                                <span key={k} className="bg-[var(--surface)] rounded px-1.5 py-0.5 text-[10px] font-mono">
                                  {k}=<span className="text-[var(--accent)]">{v}</span>
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span className="text-[var(--dim)] opacity-40">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold text-[var(--text)]">
                          {Number.isInteger(m.value) ? m.value : m.value.toFixed(3)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* SQL Queries */}
        {result.queries && result.queries.length > 0 && (
          <div className="space-y-2">
            <button
              onClick={() => setShowQueries(q => !q)}
              className="flex items-center gap-1.5 text-xs text-[var(--dim)] hover:text-[var(--text)] transition-colors"
            >
              <Code2 size={11} />
              <span className="font-semibold uppercase tracking-wider">
                SQL Queries ({result.queries.length})
              </span>
              {showQueries ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </button>
            {showQueries && (
              <div className="space-y-2">
                {result.queries.map((q, i) => (
                  <pre key={i} className="text-[11px] font-mono bg-[var(--surface)] rounded-lg p-3 overflow-x-auto text-[var(--text)] leading-relaxed border border-[var(--border)] whitespace-pre">
                    {q.trim()}
                  </pre>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function RunCheck() {
  const [collectorMetas, setCollectorMetas] = useState<CollectorMeta[]>([])
  const [selectedCollectors, setSelectedCollectors] = useState<Set<string>>(new Set())
  const [selectedInstances, setSelectedInstances] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<RunCheckResult[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [initError, setInitError] = useState<string | null>(null)
  const [instanceList, setInstanceList] = useState<string[]>([])
  const [forcingPoll, setForcingPoll] = useState(false)
  const [forcePollStatus, setForcePollStatus] = useState('')
  const resultsRef = useRef<HTMLDivElement>(null)

  // Advisor anti-pattern scan state
  const [advisorInst, setAdvisorInst] = useState('')
  const [advisorRunning, setAdvisorRunning] = useState(false)
  const [advisorData, setAdvisorData] = useState<{ queryAP: any[]; tableAP: any[] } | null>(null)
  const [advisorError, setAdvisorError] = useState('')

  // Schedule state
  const [schedules, setSchedules] = useState<any[]>([])
  const [newSchedInst, setNewSchedInst] = useState('')
  const [newSchedCollector, setNewSchedCollector] = useState('')
  const [newSchedInterval, setNewSchedInterval] = useState(5)
  const [schedFormOpen, setSchedFormOpen] = useState(false)
  const [schedError, setSchedError] = useState('')
  const [schedLoading, setSchedLoading] = useState(false)

  const loadSchedules = useCallback(async () => {
    try {
      const list = await api.schedules.list()
      setSchedules(list ?? [])
    } catch {
      // non-fatal
    }
  }, [])

  // Time range state
  const [preset, setPreset] = useState(0)          // minutes; 0 = live, -1 = custom
  const [customFrom, setCustomFrom] = useState(() => toLocalDatetimeInput(new Date(Date.now() - 3600_000)))
  const [customTo, setCustomTo]     = useState(() => toLocalDatetimeInput(new Date()))

  const timeRangeParams = useCallback((): { from?: number; to?: number } => {
    if (preset === 0) return {}  // live — no range, collectors use their natural windows
    if (preset === -1) {
      const f = new Date(customFrom).getTime() / 1000
      const t = new Date(customTo).getTime() / 1000
      if (!isNaN(f) && !isNaN(t) && t > f) return { from: Math.floor(f), to: Math.floor(t) }
      return {}
    }
    const to   = Math.floor(Date.now() / 1000)
    const from = to - preset * 60
    return { from, to }
  }, [preset, customFrom, customTo])

  useEffect(() => {
    Promise.all([
      api.collectors().catch((e: any) => { setInitError(e?.message ?? 'Failed to load collectors'); return [] }),
      api.overview().catch((e: any) => { setInitError(e?.message ?? 'Failed to load instances'); return [] }),
    ]).then(([collectors, overview]) => {
      setCollectorMetas(collectors as CollectorMeta[])
      setInstanceList((overview as any[]).map((d: any) => d.name))
    })
    loadSchedules()
  }, [loadSchedules])

  const toggleCollector = (name: string) => {
    setSelectedCollectors(prev => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }

  const toggleInstance = (name: string) => {
    setSelectedInstances(prev => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }

  const selectAllCollectors = () => setSelectedCollectors(new Set(collectorMetas.map(m => m.name)))
  const clearCollectors = () => setSelectedCollectors(new Set())
  const selectAllInstances = () => setSelectedInstances(new Set(instanceList))
  const clearInstances = () => setSelectedInstances(new Set())

  const handleForcePoll = async () => {
    setForcingPoll(true)
    setForcePollStatus('')
    try {
      const resp = await api.forcePoll()
      setForcePollStatus(resp.status === 'already_queued' ? 'Already queued — poll running soon' : 'Poll triggered — check Alerts in a few seconds')
    } catch {
      setForcePollStatus('Failed to trigger poll')
    } finally {
      setForcingPoll(false)
      setTimeout(() => setForcePollStatus(''), 5000)
    }
  }

  const handleRun = async () => {
    if (selectedCollectors.size === 0 || selectedInstances.size === 0) return
    setRunning(true)
    setError('')
    setResults([])
    try {
      const { from, to } = timeRangeParams()
      const resp = await api.runCheck(
        Array.from(selectedCollectors),
        Array.from(selectedInstances),
        from,
        to,
      )
      setResults(resp.results ?? [])
      // Scroll to results after a short tick so DOM has updated
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 50)
    } catch (e: any) {
      setError(e.message ?? 'Run failed')
    } finally {
      setRunning(false)
    }
  }

  const [activeTab, setActiveTab] = useState<'run' | 'scheduled'>('run')

  const grouped = groupByCategory(collectorMetas)
  const categories = Object.keys(grouped).sort()

  // Sort: errors first, then by alert count desc, then clean
  const sortedResults = [...results].sort((a, b) => {
    if (!!a.error !== !!b.error) return a.error ? -1 : 1
    return b.alerts.length - a.alerts.length
  })

  const resultSummary = results.length > 0 ? {
    total: results.length,
    alerts: results.reduce((n, r) => n + r.alerts.length, 0),
    errors: results.filter(r => !!r.error).length,
    clean:  results.filter(r => !r.error && r.alerts.length === 0).length,
  } : null

  const tabs = [
    { id: 'run' as const, label: 'Run Checks', icon: PlayCircle },
    { id: 'scheduled' as const, label: 'Scheduled', icon: ListChecks, badge: schedules.length || undefined },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--text)]">Run Checks</h1>
        <p className="text-sm text-[var(--dim)] mt-1">
          Run any collector on-demand against specific instances and see results immediately.
        </p>
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 border-b border-[var(--border)]">
        {tabs.map(tab => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px',
                activeTab === tab.id
                  ? 'border-[var(--accent)] text-[var(--accent)]'
                  : 'border-transparent text-[var(--dim)] hover:text-[var(--text)]',
              )}
            >
              <Icon size={14} />
              {tab.label}
              {tab.badge != null && tab.badge > 0 && (
                <span className="text-[10px] font-medium bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/20 rounded-full px-1.5 py-0.5 leading-none">
                  {tab.badge}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {activeTab === 'run' && (<>
      {/* Time range picker */}
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CalendarRange size={14} className="text-[var(--dim)]" />
          <span className="text-sm font-semibold text-[var(--text)]">Time Range</span>
          <span className="text-xs text-[var(--dim)] ml-1">— applies to query_log and text_log collectors</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map(p => (
            <button
              key={p.minutes}
              onClick={() => setPreset(p.minutes)}
              className={cn(
                'px-3 py-1 rounded-lg text-xs font-medium transition-colors border',
                preset === p.minutes
                  ? 'bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/40'
                  : 'border-[var(--border)] text-[var(--dim)] hover:text-[var(--text)] hover:border-[var(--accent)]/30',
              )}
            >{p.label}</button>
          ))}
        </div>
        {preset === -1 && (
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <label className="flex items-center gap-2 text-xs text-[var(--dim)]">
              <span className="w-6">From</span>
              <input
                type="datetime-local"
                value={customFrom}
                onChange={e => setCustomFrom(e.target.value)}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]/60"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-[var(--dim)]">
              <span className="w-6">To</span>
              <input
                type="datetime-local"
                value={customTo}
                onChange={e => setCustomTo(e.target.value)}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]/60"
              />
            </label>
          </div>
        )}
        {preset !== 0 && (
          <p className="text-[11px] text-[var(--dim)]">
            {preset === -1
              ? 'Custom window — collectors will scan the specified time range instead of their default intervals'
              : `Last ${PRESETS.find(p => p.minutes === preset)?.label} — collectors will scan this window instead of their default intervals`}
          </p>
        )}
        {preset === 0 && (
          <p className="text-[11px] text-[var(--dim)]">Live — collectors use their natural time windows (e.g. last 5 min for query failures)</p>
        )}
      </div>

      {/* Diagnostic-only disclaimer */}
      <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-blue-500/25 bg-blue-500/8 text-sm text-blue-400">
        <Info size={15} className="shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-medium">Diagnostic tool — results are not stored</p>
          <p className="text-blue-400/70 text-xs leading-relaxed">
            Run Check shows what collectors find <em>right now</em> but does <strong>not</strong> write to the database, update the Alerts tab, or send Slack/PagerDuty notifications.
            Those only come from the background polling loop.
            If a condition you see here is real and persists, it will automatically appear in Alerts after the next poll cycle.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Collector picker */}
        <div className="lg:col-span-2 bg-[var(--card)] border border-[var(--border)] rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[var(--text)]">Select Checks</h2>
              {selectedCollectors.size > 0 && (
                <span className="text-[11px] font-medium text-[var(--accent)] bg-[var(--accent)]/10 border border-[var(--accent)]/20 rounded-full px-2 py-0.5">
                  {selectedCollectors.size} selected
                </span>
              )}
            </div>
            <div className="flex gap-2 text-xs items-center">
              <button onClick={selectAllCollectors} className="text-[var(--accent)] hover:opacity-70 font-medium">All</button>
              <span className="text-[var(--border)]">·</span>
              <button onClick={clearCollectors} className="text-[var(--dim)] hover:text-[var(--text)]">None</button>
            </div>
          </div>

          <div className="space-y-5">
            {categories.map(cat => (
              <div key={cat}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--dim)]">
                    {CATEGORY_LABELS[cat] ?? cat}
                  </span>
                  <div className="flex-1 h-px bg-[var(--border)]" />
                  <button
                    onClick={() => {
                      const catNames = grouped[cat].map(m => m.name)
                      const allChecked = catNames.every(n => selectedCollectors.has(n))
                      setSelectedCollectors(prev => {
                        const next = new Set(prev)
                        catNames.forEach(n => allChecked ? next.delete(n) : next.add(n))
                        return next
                      })
                    }}
                    className="text-[10px] text-[var(--dim)] hover:text-[var(--accent)] transition-colors"
                  >
                    {grouped[cat].every(m => selectedCollectors.has(m.name)) ? 'deselect' : 'select all'}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {grouped[cat].map(m => {
                    const checked = selectedCollectors.has(m.name)
                    return (
                      <button
                        key={m.name}
                        onClick={() => toggleCollector(m.name)}
                        title={m.description}
                        className={cn(
                          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all',
                          checked
                            ? 'bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/40 hover:bg-[var(--accent)]/25'
                            : 'bg-[var(--surface)] text-[var(--dim)] border-[var(--border)] hover:text-[var(--text)] hover:border-[var(--accent)]/30',
                        )}
                      >
                        {checked && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" />}
                        {m.display_name}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Instance picker + run */}
        <div className="space-y-4">
          <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--text)] flex items-center gap-1.5">
                <Database size={13} /> Instances
                {selectedInstances.size > 0 && (
                  <span className="text-[11px] font-medium text-[var(--accent)] bg-[var(--accent)]/10 border border-[var(--accent)]/20 rounded-full px-2 py-0.5 ml-1">
                    {selectedInstances.size}
                  </span>
                )}
              </h2>
              <div className="flex gap-2 text-xs">
                <button onClick={selectAllInstances} className="text-[var(--accent)] hover:opacity-70 font-medium">All</button>
                <span className="text-[var(--border)]">·</span>
                <button onClick={clearInstances} className="text-[var(--dim)] hover:text-[var(--text)]">None</button>
              </div>
            </div>

            {instanceList.length === 0 ? (
              <p className="text-xs text-[var(--dim)]">No instances available</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {instanceList.map(name => {
                  const checked = selectedInstances.has(name)
                  return (
                    <button
                      key={name}
                      onClick={() => toggleInstance(name)}
                      className={cn(
                        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-mono text-[11px] border transition-all',
                        checked
                          ? 'bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/40 hover:bg-[var(--accent)]/25'
                          : 'bg-[var(--surface)] text-[var(--dim)] border-[var(--border)] hover:text-[var(--text)] hover:border-[var(--accent)]/30',
                      )}
                    >
                      {checked && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" />}
                      {name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <button
            onClick={handleRun}
            disabled={running || selectedCollectors.size === 0 || selectedInstances.size === 0}
            className={cn(
              'w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-semibold text-sm transition-all',
              running || selectedCollectors.size === 0 || selectedInstances.size === 0
                ? 'bg-[var(--surface)] text-[var(--dim)] cursor-not-allowed'
                : 'bg-[var(--accent)] text-white hover:opacity-90 active:scale-95',
            )}
          >
            {running ? (
              <><Loader2 size={16} className="animate-spin" /> Running…</>
            ) : (
              <><PlayCircle size={16} /> Run {selectedCollectors.size > 0 ? selectedCollectors.size : ''} Check{selectedCollectors.size !== 1 ? 's' : ''}</>
            )}
          </button>

          {selectedCollectors.size > 0 && selectedInstances.size > 0 && !running && (
            <p className="text-xs text-[var(--dim)] text-center">
              {selectedCollectors.size} checks × {selectedInstances.size} {selectedInstances.size === 1 ? 'instance' : 'instances'} = {selectedCollectors.size * selectedInstances.size} runs
            </p>
          )}
        </div>
      </div>

      {/* Init / run errors */}
      {initError && (
        <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
          <XCircle size={16} />
          <div className="flex-1">
            <div>Failed to load: {initError}</div>
            <div className="text-xs text-red-300/70 mt-0.5">
              {initError.toLowerCase().includes('connect') || initError.toLowerCase().includes('refused') || initError.toLowerCase().includes('timeout')
                ? 'Check that CH Analyzer backend is running and reachable.'
                : initError.toLowerCase().includes('auth') || initError.toLowerCase().includes('403') || initError.toLowerCase().includes('401')
                ? 'Authentication failed. Check your credentials in the config file.'
                : 'Try refreshing the page. If this persists, check the application logs.'}
            </div>
          </div>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
          <XCircle size={16} />
          {error}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-4" ref={resultsRef}>
          {/* Force Poll CTA */}
          {results.some(r => r.alerts.length > 0) && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-[var(--accent)]/25 bg-[var(--accent)]/8">
              <Info size={14} className="text-[var(--accent)] shrink-0" />
              <p className="text-sm text-[var(--dim)] flex-1">
                Alerts found above use your <strong className="text-[var(--text)]">real configured thresholds</strong>. To push them into the Alerts tab and Slack, trigger an immediate background poll:
              </p>
              <button
                onClick={handleForcePoll}
                disabled={forcingPoll}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs font-semibold hover:opacity-90 transition-all shrink-0 disabled:opacity-50"
              >
                <RefreshCw size={12} className={forcingPoll ? 'animate-spin' : ''} />
                {forcingPoll ? 'Polling…' : 'Force Poll Now'}
              </button>
            </div>
          )}
          {forcePollStatus && (
            <p className="text-xs text-green-400 font-medium">{forcePollStatus}</p>
          )}

        {/* Summary bar */}
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-sm font-semibold text-[var(--text)]">Results</h2>
            {resultSummary && (
              <div className="flex items-center gap-3 text-xs flex-wrap">
                <span className="text-[var(--dim)]">{resultSummary.total} runs</span>
                {resultSummary.errors > 0 && (
                  <span className={cn('px-2 py-0.5 rounded-full border font-medium', severityBg('critical'))}>
                    {resultSummary.errors} error{resultSummary.errors !== 1 ? 's' : ''}
                  </span>
                )}
                {resultSummary.alerts > 0 && (
                  <span className={cn('px-2 py-0.5 rounded-full border font-medium', severityBg('warn'))}>
                    {resultSummary.alerts} alert{resultSummary.alerts !== 1 ? 's' : ''}
                  </span>
                )}
                {resultSummary.clean > 0 && (
                  <span className="text-green-500 font-medium">
                    {resultSummary.clean} clean
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="space-y-4">
            {sortedResults.map((r, i) => (
              <ResultCard key={`${r.instance}-${r.collector}-${i}`} result={r} />
            ))}
          </div>
        </div>
      )}

      </>)}

      {activeTab === 'scheduled' && (<>
      {/* ── Advisor Anti-pattern Checks ─────────────────────────────────────── */}
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)] mb-1">Advisor Anti-pattern Scan</h2>
          <p className="text-xs text-[var(--dim)]">
            Runs query and table design anti-pattern checks. Results not stored, alerts not triggered.
            Data sources: <code className="font-mono">system.query_log</code>, <code className="font-mono">system.tables</code>, <code className="font-mono">system.parts</code>, <code className="font-mono">system.mutations</code>.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={advisorInst}
            onChange={e => setAdvisorInst(e.target.value)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
          >
            <option value="">Select instance…</option>
            {instanceList.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
          <button
            disabled={!advisorInst || advisorRunning}
            onClick={async () => {
              if (!advisorInst) return
              setAdvisorRunning(true); setAdvisorError(''); setAdvisorData(null)
              try {
                const [queryAP, tableAP] = await Promise.all([
                  api.advisor.queryAntiPatterns(advisorInst),
                  api.advisor.tableAntiPatterns(advisorInst),
                ])
                setAdvisorData({ queryAP, tableAP })
              } catch (e: any) {
                setAdvisorError(e?.message ?? 'Scan failed')
              } finally {
                setAdvisorRunning(false)
              }
            }}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all',
              !advisorInst || advisorRunning
                ? 'bg-[var(--surface)] text-[var(--dim)] cursor-not-allowed'
                : 'bg-[var(--accent)] text-white hover:opacity-90',
            )}
          >
            {advisorRunning ? <><Loader2 size={14} className="animate-spin" /> Scanning…</> : <><PlayCircle size={14} /> Run Advisor Scan</>}
          </button>
        </div>

        {advisorError && <div className="text-xs text-red-400">{advisorError}</div>}

        {advisorData && (() => {
          const allIssues = [
            ...advisorData.queryAP.filter(g => g.count > 0).map(g => ({ ...g, kind: 'Query' })),
            ...advisorData.tableAP.filter(g => g.count > 0).map(g => ({ ...g, kind: 'Table' })),
          ].sort((a, b) => {
            const sev = { critical: 0, warn: 1, info: 2 }
            return (sev[a.severity as keyof typeof sev] ?? 3) - (sev[b.severity as keyof typeof sev] ?? 3)
          })

          return (
            <div className="space-y-2">
              {allIssues.length === 0
                ? <div className="flex items-center gap-2 text-sm text-green-400 bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3">
                    <CheckCircle2 size={15} /> No anti-patterns detected on {advisorInst}
                  </div>
                : allIssues.map(group => (
                  <div key={group.type} className={cn(
                    'rounded-xl border px-4 py-3',
                    group.severity === 'critical' ? 'border-red-500/30 bg-red-500/5' : 'border-yellow-500/30 bg-yellow-500/5',
                  )}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={cn('text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border font-medium shrink-0',
                        group.severity === 'critical' ? 'bg-red-500/15 text-red-400 border-red-500/30' : 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
                      )}>{group.severity}</span>
                      <span className="text-xs text-[var(--dim)] px-1.5 py-0.5 rounded bg-[var(--hover)] border border-[var(--border)]">{group.kind}</span>
                      <span className="text-sm font-semibold text-[var(--text)]">{group.title}</span>
                      <span className="ml-auto text-xs text-[var(--dim)]">{group.count} affected</span>
                    </div>
                    <p className="text-xs text-[var(--dim)] mt-1.5 leading-relaxed">{group.description}</p>
                  </div>
                ))
              }
            </div>
          )
        })()}
      </div>

      {/* ── Schedules ──────────────────────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Timer size={14} className="text-[var(--dim)]" />
          <span className="text-sm font-semibold text-[var(--text)]">Scheduled Checks</span>
        </div>

        <div className="space-y-3">
            <p className="text-xs text-[var(--dim)]">
              Automatically run a collector against an instance at a fixed interval. The schedule runner checks every 30 seconds.
            </p>

            {/* Existing schedules */}
            {schedules.length === 0 ? (
              <p className="text-xs text-[var(--dim)] italic">No schedules configured.</p>
            ) : (
              <div className="rounded-xl border border-[var(--border)] overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-[var(--surface)] border-b border-[var(--border)]">
                      <th className="text-left px-3 py-2 text-[var(--dim)] font-medium">Instance</th>
                      <th className="text-left px-3 py-2 text-[var(--dim)] font-medium">Collector</th>
                      <th className="text-left px-3 py-2 text-[var(--dim)] font-medium">Interval</th>
                      <th className="text-left px-3 py-2 text-[var(--dim)] font-medium">Last Run</th>
                      <th className="text-right px-3 py-2 text-[var(--dim)] font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedules.map((sc, i) => (
                      <tr key={sc.id} className={cn('border-b border-[var(--border)] last:border-0', i % 2 === 0 ? '' : 'bg-[var(--surface)]/30')}>
                        <td className="px-3 py-2 font-mono text-[var(--text)]">{sc.instance}</td>
                        <td className="px-3 py-2 text-[var(--text)]">{sc.collector_name}</td>
                        <td className="px-3 py-2 text-[var(--dim)]">{sc.interval_mins}m</td>
                        <td className="px-3 py-2 text-[var(--dim)]">
                          {sc.last_run_at && sc.last_run_at !== '0001-01-01T00:00:00Z'
                            ? new Date(sc.last_run_at).toLocaleString()
                            : <span className="opacity-40">never</span>}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              title={sc.enabled ? 'Disable' : 'Enable'}
                              onClick={async () => {
                                try {
                                  await api.schedules.setEnabled(sc.id, !sc.enabled)
                                  await loadSchedules()
                                } catch {}
                              }}
                              className="text-[var(--dim)] hover:text-[var(--accent)] transition-colors"
                            >
                              {sc.enabled
                                ? <ToggleRight size={16} className="text-[var(--accent)]" />
                                : <ToggleLeft size={16} />}
                            </button>
                            <button
                              title="Delete"
                              onClick={async () => {
                                try {
                                  await api.schedules.delete(sc.id)
                                  await loadSchedules()
                                } catch {}
                              }}
                              className="text-[var(--dim)] hover:text-red-400 transition-colors"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* New schedule form */}
            {!schedFormOpen ? (
              <button
                onClick={() => setSchedFormOpen(true)}
                className="flex items-center gap-1.5 text-xs text-[var(--accent)] hover:opacity-70 font-medium"
              >
                <Plus size={13} /> New Schedule
              </button>
            ) : (
              <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4 space-y-3">
                <p className="text-xs font-semibold text-[var(--text)]">New Schedule</p>
                <div className="flex flex-wrap gap-3 items-end">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-[var(--dim)]">Instance</span>
                    <select
                      value={newSchedInst}
                      onChange={e => setNewSchedInst(e.target.value)}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs focus:outline-none focus:border-[var(--accent)]"
                    >
                      <option value="">Select…</option>
                      {instanceList.map(i => <option key={i} value={i}>{i}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-[var(--dim)]">Collector</span>
                    <select
                      value={newSchedCollector}
                      onChange={e => setNewSchedCollector(e.target.value)}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs focus:outline-none focus:border-[var(--accent)]"
                    >
                      <option value="">Select…</option>
                      {collectorMetas.map(m => <option key={m.name} value={m.name}>{m.display_name}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-[var(--dim)]">Interval</span>
                    <select
                      value={newSchedInterval}
                      onChange={e => setNewSchedInterval(Number(e.target.value))}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs focus:outline-none focus:border-[var(--accent)]"
                    >
                      <option value={5}>5m</option>
                      <option value={15}>15m</option>
                      <option value={30}>30m</option>
                      <option value={60}>1h</option>
                      <option value={360}>6h</option>
                      <option value={1440}>24h</option>
                    </select>
                  </label>
                  <button
                    disabled={!newSchedInst || !newSchedCollector || schedLoading}
                    onClick={async () => {
                      if (!newSchedInst || !newSchedCollector) return
                      setSchedLoading(true); setSchedError('')
                      try {
                        await api.schedules.create(newSchedInst, newSchedCollector, newSchedInterval)
                        await loadSchedules()
                        setSchedFormOpen(false)
                        setNewSchedInst('')
                        setNewSchedCollector('')
                        setNewSchedInterval(5)
                      } catch (e: any) {
                        setSchedError(e?.message ?? 'Failed to create schedule')
                      } finally {
                        setSchedLoading(false)
                      }
                    }}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all',
                      !newSchedInst || !newSchedCollector || schedLoading
                        ? 'bg-[var(--surface)] text-[var(--dim)] cursor-not-allowed'
                        : 'bg-[var(--accent)] text-white hover:opacity-90',
                    )}
                  >
                    {schedLoading ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                    Add
                  </button>
                  <button
                    onClick={() => { setSchedFormOpen(false); setSchedError('') }}
                    className="text-xs text-[var(--dim)] hover:text-[var(--text)]"
                  >
                    Cancel
                  </button>
                </div>
                {schedError && <p className="text-xs text-red-400">{schedError}</p>}
              </div>
            )}
          </div>
        </div>
      </div>
      </>)}
    </div>
  )
}
