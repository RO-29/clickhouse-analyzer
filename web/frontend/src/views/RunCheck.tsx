import { useState, useEffect, useRef } from 'react'
import {
  PlayCircle, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2,
  XCircle, BarChart2, Clock, Loader2, Code2, Database, Info, RefreshCw,
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

function groupByCategory(metas: CollectorMeta[]): Record<string, CollectorMeta[]> {
  return metas.reduce((acc, m) => {
    ;(acc[m.category] ??= []).push(m)
    return acc
  }, {} as Record<string, CollectorMeta[]>)
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
            <code className="text-xs font-mono">{result.error}</code>
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
  const [instanceList, setInstanceList] = useState<string[]>([])
  const [forcingPoll, setForcingPoll] = useState(false)
  const [forcePollStatus, setForcePollStatus] = useState('')
  const resultsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.collectors().then(setCollectorMetas).catch(() => {})
    api.overview().then(data => setInstanceList(data.map(d => d.name))).catch(() => {})
  }, [])

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
      const resp = await api.runCheck(
        Array.from(selectedCollectors),
        Array.from(selectedInstances),
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--text)]">Run Checks</h1>
        <p className="text-sm text-[var(--dim)] mt-1">
          Run any collector on-demand against specific instances and see results immediately.
        </p>
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
            <h2 className="text-sm font-semibold text-[var(--text)]">Select Checks</h2>
            <div className="flex gap-2 text-xs items-center">
              <button onClick={selectAllCollectors} className="text-[var(--accent)] hover:opacity-70">All</button>
              <span className="text-[var(--border)]">·</span>
              <button onClick={clearCollectors} className="text-[var(--dim)] hover:opacity-70">None</button>
              {selectedCollectors.size > 0 && (
                <span className="ml-1 text-[var(--dim)]">({selectedCollectors.size} selected)</span>
              )}
            </div>
          </div>

          <div className="space-y-4">
            {categories.map(cat => (
              <div key={cat}>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--dim)] mb-2">
                  {CATEGORY_LABELS[cat] ?? cat}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {grouped[cat].map(m => {
                    const checked = selectedCollectors.has(m.name)
                    return (
                      <button
                        key={m.name}
                        onClick={() => toggleCollector(m.name)}
                        className={cn(
                          'flex items-start gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-all',
                          checked
                            ? 'border-[var(--accent)]/50 bg-[var(--accent)]/10'
                            : 'border-[var(--border)] hover:border-[var(--accent)]/30 hover:bg-[var(--surface)]',
                        )}
                      >
                        <span className={cn(
                          'mt-0.5 w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center transition-colors',
                          checked ? 'bg-[var(--accent)] border-[var(--accent)]' : 'border-[var(--dim)]',
                        )}>
                          {checked && <span className="text-white text-[9px] font-bold leading-none">✓</span>}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-xs font-medium text-[var(--text)]">{m.display_name}</span>
                          <span className="block text-[11px] text-[var(--dim)] leading-tight mt-0.5">{m.description}</span>
                        </span>
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
              </h2>
              <div className="flex gap-2 text-xs">
                <button onClick={selectAllInstances} className="text-[var(--accent)] hover:opacity-70">All</button>
                <span className="text-[var(--border)]">·</span>
                <button onClick={clearInstances} className="text-[var(--dim)] hover:opacity-70">None</button>
              </div>
            </div>

            {instanceList.length === 0 ? (
              <p className="text-xs text-[var(--dim)]">No instances available</p>
            ) : (
              <div className="space-y-1">
                {instanceList.map(name => {
                  const checked = selectedInstances.has(name)
                  return (
                    <button
                      key={name}
                      onClick={() => toggleInstance(name)}
                      className={cn(
                        'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-all text-sm',
                        checked
                          ? 'border-[var(--accent)]/50 bg-[var(--accent)]/10'
                          : 'border-[var(--border)] hover:border-[var(--accent)]/30 hover:bg-[var(--surface)]',
                      )}
                    >
                      <span className={cn(
                        'w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center transition-colors',
                        checked ? 'bg-[var(--accent)] border-[var(--accent)]' : 'border-[var(--dim)]',
                      )}>
                        {checked && <span className="text-white text-[9px] font-bold leading-none">✓</span>}
                      </span>
                      <span className="font-mono text-xs text-[var(--text)] truncate">{name}</span>
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

      {/* Error */}
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
    </div>
  )
}
