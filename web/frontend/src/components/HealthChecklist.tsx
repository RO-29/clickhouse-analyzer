import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle, AlertTriangle, ChevronDown, ChevronRight, Play } from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../hooks/useStore'
import { cn } from '../lib/utils'
import type { HealthCheck, Suggestion } from '../types/api'

const statusIcon = (status: string) => {
  if (status === 'ok' || status === 'pass')
    return <CheckCircle2 size={16} className="text-green-400 shrink-0" />
  if (status === 'warn')
    return <AlertTriangle size={16} className="text-yellow-400 shrink-0" />
  return <XCircle size={16} className="text-red-400 shrink-0" />
}

const statusBorder = (status: string) => {
  if (status === 'ok' || status === 'pass') return 'border-green-500/20'
  if (status === 'warn') return 'border-yellow-500/20'
  return 'border-red-500/20'
}

function HealthCard({ check, instance }: { check: HealthCheck; instance: string }) {
  const { navToTerminal } = useStore()
  const [expanded, setExpanded] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [loadingSuggestions, setLoadingSuggestions] = useState(false)

  const handleExpand = () => {
    const next = !expanded
    setExpanded(next)
    if (next && suggestions.length === 0 && !loadingSuggestions) {
      setLoadingSuggestions(true)
      api.suggestions(check.category)
        .then((data: Suggestion) => setSuggestions(data.suggestions ?? []))
        .catch(() => setSuggestions([]))
        .finally(() => setLoadingSuggestions(false))
    }
  }

  const hasSql = (text: string) => /\b(SELECT|INSERT|ALTER|CREATE|DROP|SYSTEM|OPTIMIZE)\b/i.test(text)

  return (
    <div
      className={cn(
        'border rounded-lg bg-[var(--surface)] transition-colors',
        statusBorder(check.status),
      )}
    >
      <button
        onClick={handleExpand}
        className="w-full flex items-start gap-2.5 p-3 text-left"
      >
        {statusIcon(check.status)}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{check.name}</div>
          <div className="text-xs text-[var(--dim)] mt-0.5 font-mono">{check.value}</div>
        </div>
        {expanded
          ? <ChevronDown size={14} className="text-[var(--dim)] shrink-0 mt-0.5" />
          : <ChevronRight size={14} className="text-[var(--dim)] shrink-0 mt-0.5" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t border-[var(--border)]">
          {check.threshold && (
            <div className="text-xs text-[var(--dim)] pt-2">
              <span className="font-medium">Threshold:</span> {check.threshold}
            </div>
          )}
          {check.detail && (
            <div className="text-xs text-[var(--dim)]">
              <span className="font-medium">Detail:</span> {check.detail}
            </div>
          )}

          {loadingSuggestions && (
            <div className="text-xs text-[var(--dim)] italic">Loading suggestions...</div>
          )}

          {suggestions.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider">
                Suggestions
              </div>
              {suggestions.map((s, i) => (
                <div key={i} className="text-xs text-[var(--text)]">
                  {hasSql(s) ? (
                    <div className="space-y-1">
                      <div>{s}</div>
                      <button
                        onClick={(e) => { e.stopPropagation(); navToTerminal(s, instance) }}
                        className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
                      >
                        <Play size={10} />
                        Run on {instance}
                      </button>
                    </div>
                  ) : (
                    <span>{s}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface HealthChecklistProps {
  instance: string
  refreshTrigger?: number
}

export function HealthChecklist({ instance, refreshTrigger }: HealthChecklistProps) {
  const [checks, setChecks] = useState<HealthCheck[]>([])
  const [loading, setLoading] = useState(true)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.healthCheck(instance)
      .then(data => { if (!cancelled) { setChecks(data); setLastChecked(new Date()) } })
      .catch(() => { if (!cancelled) setChecks([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [instance, refreshTrigger])

  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="animate-pulse border border-[var(--border)] rounded-lg p-3">
            <div className="h-4 bg-[var(--border)] rounded w-2/3 mb-2" />
            <div className="h-3 bg-[var(--border)] rounded w-1/2" />
          </div>
        ))}
      </div>
    )
  }

  if (checks.length === 0) return null

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {checks.map(c => (
          <HealthCard key={c.id} check={c} instance={instance} />
        ))}
      </div>
      {lastChecked && (
        <div className="mt-2 text-[10px] text-[var(--dim)] text-right">
          <span className="px-1.5 py-0.5 rounded bg-[var(--hover)] border border-[var(--border)]">
            current state
          </span>
          {' '}as of {lastChecked.toLocaleTimeString()}
        </div>
      )}
    </div>
  )
}
