import { useState, useEffect } from 'react'
import { PlayCircle, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, XCircle, BarChart2, Clock, Loader2 } from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../hooks/useStore'
import { cn } from '../lib/utils'
import type { CollectorMeta, RunCheckResult, RunCheckAlert } from '../types/api'

// ── helpers ────────────────────────────────────────────────────────────────────

function severityColor(s: string) {
  switch (s) {
    case 'critical': return 'text-red-500'
    case 'warn':     return 'text-yellow-500'
    case 'info':     return 'text-blue-400'
    default:         return 'text-[var(--dim)]'
  }
}

function severityBg(s: string) {
  switch (s) {
    case 'critical': return 'bg-red-500/15 text-red-400 border-red-500/30'
    case 'warn':     return 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'
    case 'info':     return 'bg-blue-500/15 text-blue-400 border-blue-500/30'
    default:         return 'bg-[var(--surface)] text-[var(--dim)]'
  }
}

function alertSummary(alerts: RunCheckAlert[]): { critical: number; warn: number; info: number } {
  return alerts.reduce((acc, a) => {
    if (a.severity === 'critical') acc.critical++
    else if (a.severity === 'warn') acc.warn++
    else acc.info++
    return acc
  }, { critical: 0, warn: 0, info: 0 })
}

// Group collectors by category
function groupByCategory(metas: CollectorMeta[]): Record<string, CollectorMeta[]> {
  return metas.reduce((acc, m) => {
    ;(acc[m.category] ??= []).push(m)
    return acc
  }, {} as Record<string, CollectorMeta[]>)
}

const CATEGORY_LABELS: Record<string, string> = {
  system:      'System',
  queries:     'Queries',
  tables:      'Tables',
  storage:     'Storage',
  inserts:     'Inserts',
  mvs:         'Materialized Views',
  dictionaries:'Dictionaries',
  replication: 'Replication',
  errors:      'Errors',
  background:  'Background Pool',
  cache:       'Cache',
  latency:     'Latency',
  freshness:   'Freshness',
  schema:      'Schema',
  projections: 'Projections',
}

// ── Result row ────────────────────────────────────────────────────────────────

function ResultRow({ result }: { result: RunCheckResult }) {
  const [expanded, setExpanded] = useState(false)
  const [expandedAlert, setExpandedAlert] = useState<number | null>(null)

  const summary = alertSummary(result.alerts)
  const hasAlerts = result.alerts.length > 0
  const hasError = !!result.error

  return (
    <div className={cn('border border-[var(--border)] rounded-lg overflow-hidden',
      hasError ? 'border-red-500/30' : hasAlerts ? 'border-yellow-500/20' : '')}>
      {/* Header row */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[var(--surface)] transition-colors text-left"
      >
        <span className="text-[var(--dim)]">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>

        {/* Instance + collector */}
        <span className="font-mono text-xs bg-[var(--surface)] px-2 py-0.5 rounded text-[var(--accent)]">{result.instance}</span>
        <span className="text-sm font-medium text-[var(--text)]">{result.display_name}</span>

        <span className="ml-auto flex items-center gap-2 shrink-0">
          {/* Duration */}
          <span className="flex items-center gap-1 text-xs text-[var(--dim)]">
            <Clock size={11} />
            {result.duration_ms}ms
          </span>

          {/* Metrics count */}
          {result.metrics.length > 0 && (
            <span className="flex items-center gap-1 text-xs text-[var(--dim)]">
              <BarChart2 size={11} />
              {result.metrics.length} metrics
            </span>
          )}

          {/* Alert badges */}
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
          {summary.info > 0 && (
            <span className={cn('text-xs px-2 py-0.5 rounded-full border font-medium', severityBg('info'))}>
              {summary.info} info
            </span>
          )}

          {/* Status icon */}
          {hasError ? (
            <XCircle size={15} className="text-red-400" />
          ) : hasAlerts ? (
            <AlertTriangle size={15} className="text-yellow-400" />
          ) : (
            <CheckCircle2 size={15} className="text-green-500" />
          )}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-[var(--border)] px-4 py-3 space-y-4 bg-[var(--bg)]">
          {/* Error */}
          {hasError && (
            <div className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 rounded-lg p-3">
              <XCircle size={14} className="shrink-0 mt-0.5" />
              <span className="font-mono text-xs">{result.error}</span>
            </div>
          )}

          {/* Alerts */}
          {result.alerts.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)]">Alerts</p>
              {result.alerts.map((a, i) => (
                <div key={i} className={cn('rounded-lg border overflow-hidden', severityBg(a.severity))}>
                  <button
                    onClick={() => setExpandedAlert(expandedAlert === i ? null : i)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:opacity-80 transition-opacity"
                  >
                    <span className={cn('text-xs font-bold uppercase', severityColor(a.severity))}>{a.severity}</span>
                    <span className="text-xs font-medium flex-1">{a.title}</span>
                    <span className="text-[10px] text-[var(--dim)]">{a.category}</span>
                    {expandedAlert === i ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                  {expandedAlert === i && (
                    <div className="px-3 pb-3">
                      <pre className="text-xs whitespace-pre-wrap text-[var(--text)] opacity-80 font-mono leading-relaxed">{a.message}</pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* No alerts */}
          {!hasError && result.alerts.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-green-500">
              <CheckCircle2 size={14} />
              <span>No alerts — all checks passed</span>
            </div>
          )}

          {/* Metrics */}
          {result.metrics.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)]">Metrics ({result.metrics.length})</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1 max-h-48 overflow-y-auto">
                {result.metrics.map((m, i) => {
                  const labelStr = Object.entries(m.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')
                  return (
                    <div key={i} className="flex items-center justify-between bg-[var(--surface)] rounded px-2 py-1 text-xs">
                      <span className="text-[var(--dim)] truncate flex-1 mr-2">
                        {m.name}
                        {labelStr && <span className="text-[var(--dim)] opacity-60 ml-1">{'{' + labelStr + '}'}</span>}
                      </span>
                      <span className="font-mono font-medium text-[var(--text)] shrink-0">{m.value.toFixed(2)}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function RunCheck() {
  const { instances } = useStore() as any
  const [collectorMetas, setCollectorMetas] = useState<CollectorMeta[]>([])
  const [selectedCollectors, setSelectedCollectors] = useState<Set<string>>(new Set())
  const [selectedInstances, setSelectedInstances] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<RunCheckResult[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [instanceList, setInstanceList] = useState<string[]>([])

  // Load collector metadata + instances
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
      setResults(resp.results)
    } catch (e: any) {
      setError(e.message ?? 'Run failed')
    } finally {
      setRunning(false)
    }
  }

  const grouped = groupByCategory(collectorMetas)
  const categories = Object.keys(grouped).sort()

  const resultSummary = results.length > 0 ? {
    total: results.length,
    alerts: results.reduce((n, r) => n + r.alerts.length, 0),
    errors: results.filter(r => !!r.error).length,
    clean: results.filter(r => !r.error && r.alerts.length === 0).length,
  } : null

  // Sort results: errors first, then by alert count desc, then clean
  const sortedResults = [...results].sort((a, b) => {
    if (!!a.error !== !!b.error) return a.error ? -1 : 1
    return b.alerts.length - a.alerts.length
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--text)]">Run Checks</h1>
        <p className="text-sm text-[var(--dim)] mt-1">
          Pick any collector type and run it on-demand against one or more instances. Results show immediately — no waiting for the next poll cycle.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Collector picker */}
        <div className="lg:col-span-2 bg-[var(--card)] border border-[var(--border)] rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[var(--text)]">Select Checks</h2>
            <div className="flex gap-2 text-xs">
              <button onClick={selectAllCollectors} className="text-[var(--accent)] hover:opacity-70">All</button>
              <span className="text-[var(--border)]">·</span>
              <button onClick={clearCollectors} className="text-[var(--dim)] hover:opacity-70">None</button>
              <span className="text-[var(--dim)] ml-1">({selectedCollectors.size} selected)</span>
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
                          <span className="block text-[11px] text-[var(--dim)] leading-tight mt-0.5 truncate">{m.description}</span>
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
              <h2 className="text-sm font-semibold text-[var(--text)]">Instances</h2>
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

          {/* Run button */}
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
        <div className="space-y-3">
          {/* Summary bar */}
          {resultSummary && (
            <div className="flex items-center gap-4 flex-wrap">
              <h2 className="text-sm font-semibold text-[var(--text)]">Results</h2>
              <div className="flex items-center gap-3 text-xs ml-auto flex-wrap">
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
            </div>
          )}

          <div className="space-y-2">
            {sortedResults.map((r, i) => (
              <ResultRow key={`${r.instance}-${r.collector}-${i}`} result={r} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
