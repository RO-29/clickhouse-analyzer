import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react'
import { RefreshCw, Sparkles } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import type { CHLogEntry } from '../types/api'

const CH_LEVELS = ['Fatal', 'Critical', 'Error', 'Warning', 'Notice', 'Information', 'Debug', 'Trace'] as const
type CHLevel = typeof CH_LEVELS[number]

const LEVEL_BG: Record<string, string> = {
  Fatal:       'bg-red-500/20 text-red-300 border-red-500/30',
  Critical:    'bg-red-500/15 text-red-400 border-red-500/20',
  Error:       'bg-red-500/10 text-red-400 border-red-500/20',
  Warning:     'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  Notice:      'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Information: 'bg-green-500/10 text-green-400 border-green-500/20',
  Debug:       'bg-[var(--border)] text-[var(--dim)] border-[var(--border)]',
  Trace:       'bg-[var(--border)] text-[var(--dim)] border-[var(--border)]',
}

const TIME_WINDOWS = [
  { label: '15m', minutes: 15 },
  { label: '1h', minutes: 60 },
  { label: '6h', minutes: 360 },
  { label: '24h', minutes: 1440 },
] as const
const LIMITS = [100, 250, 500, 1000, 0] as const

const LEVEL_COLOR: Record<string, string> = {
  Fatal: 'text-red-500 font-bold',
  Critical: 'text-red-400',
  Error: 'text-red-400',
  Warning: 'text-yellow-400',
  Notice: 'text-blue-400',
  Information: 'text-green-400',
  Debug: 'text-[var(--dim)]',
  Trace: 'text-[var(--dim)]',
}

function highlightSearch(text: string, search: string): ReactNode {
  if (!search.trim()) return text
  const parts = text.split(new RegExp(`(${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return parts.map((part, i) =>
    part.toLowerCase() === search.toLowerCase()
      ? <mark key={i} className="bg-yellow-500/30 text-yellow-200 rounded px-0.5">{part}</mark>
      : part
  )
}

export default function CHLogs({ refreshKey }: { refreshKey?: number }) {
  const { instances, selectedInstance, setSelectedInstance } = useStore()
  const { analyze } = useAIAnalysis(selectedInstance)

  const [inst, setInst] = useState(() => selectedInstance || instances[0] || '')
  const [selectedLevel, setSelectedLevel] = useState<CHLevel | null>(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [minutes, setMinutes] = useState(60)
  const [limit, setLimit] = useState(250)
  const [logs, setLogs] = useState<CHLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null!)

  // Keep inst in sync
  useEffect(() => {
    if (selectedInstance) setInst(selectedInstance)
  }, [selectedInstance])

  // Debounce search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [search])

  const fetchLogs = useCallback(async () => {
    if (!inst) return
    setLoading(true)
    setError(null)
    try {
      const effectiveLimit = limit === 0 ? 10000 : limit
      const data = await api.chLogs(inst, selectedLevel ?? undefined, debouncedSearch || undefined, minutes, effectiveLimit)
      setLogs(data)
      setLoadedAt(new Date())
    } catch (e: any) {
      setError(e.message)
      setLogs([])
    } finally {
      setLoading(false)
    }
  }, [inst, selectedLevel, debouncedSearch, minutes, limit])

  // Fetch when params change
  useEffect(() => { fetchLogs() }, [fetchLogs])

  // Auto-refresh: re-fetch on tick without disturbing filters or instance
  const autoRefreshMounted = useRef(false)
  useEffect(() => {
    if (!autoRefreshMounted.current) { autoRefreshMounted.current = true; return }
    fetchLogs()
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Stats by level
  const stats = useMemo(() => {
    const map: Record<string, number> = {}
    for (const l of logs) {
      const lv = l.level ?? 'Unknown'
      map[lv] = (map[lv] ?? 0) + 1
    }
    return map
  }, [logs])

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={inst}
          onChange={(e) => { setInst(e.target.value); setSelectedInstance(e.target.value) }}
          className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
        >
          {instances.map((i) => (
            <option key={i} value={i}>{i}</option>
          ))}
        </select>

        {/* Level pills */}
        <div className="flex rounded-lg border border-[var(--border)] overflow-hidden text-xs">
          <button
            onClick={() => setSelectedLevel(null)}
            className={cn(
              'px-3 py-1.5 font-medium border-r border-[var(--border)] transition-colors',
              selectedLevel === null
                ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                : 'text-[var(--dim)] hover:bg-[var(--hover)]',
            )}
          >
            All
          </button>
          {CH_LEVELS.map((l) => (
            <button
              key={l}
              onClick={() => setSelectedLevel(selectedLevel === l ? null : l)}
              className={cn(
                'px-2.5 py-1.5 font-medium border-r border-[var(--border)] last:border-0 transition-colors',
                selectedLevel === l
                  ? LEVEL_BG[l]
                  : 'text-[var(--dim)] hover:bg-[var(--hover)]',
              )}
            >
              {l}
            </button>
          ))}
        </div>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search logs..."
          className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm text-[var(--fg)] w-64 focus:outline-none focus:border-[var(--accent)] placeholder:text-[var(--dim)]"
        />

        <div className="flex gap-1">
          {TIME_WINDOWS.map((tw) => (
            <button
              key={tw.label}
              onClick={() => setMinutes(tw.minutes)}
              className={cn(
                'px-2.5 py-1 text-xs rounded-md transition-colors',
                minutes === tw.minutes
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--dim)] hover:text-[var(--fg)] border border-[var(--border)] hover:border-[var(--accent)]',
              )}
            >
              {tw.label}
            </button>
          ))}
        </div>

        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
        >
          {LIMITS.map((l) => (
            <option key={l} value={l}>{l === 0 ? 'All' : l}</option>
          ))}
        </select>

        {loadedAt && !loading && (
          <span className="text-[11px] text-[var(--dim)] hidden sm:block">
            Updated {loadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
        <button
          onClick={fetchLogs}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)] hover:text-[var(--fg)] hover:border-[var(--accent)] transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
        <button
          onClick={() => analyze('CH Logs', { logs, instance: inst, level: selectedLevel, search, timeWindow_minutes: minutes, stats }, { contextType: 'tab', tab: 'chlogs' })}
          disabled={logs.length === 0}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-purple-400 hover:bg-purple-500/15 border border-purple-500/20 transition-colors disabled:opacity-30"
        >
          <Sparkles size={13} />
          Analyze
        </button>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-2 flex-wrap">
        {Object.entries(stats).map(([lv, count]) => (
          <span
            key={lv}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
              lv === 'Fatal' || lv === 'Critical' || lv === 'Error'
                ? 'bg-red-500/10 text-red-400'
                : lv === 'Warning'
                  ? 'bg-yellow-500/10 text-yellow-400'
                  : 'bg-blue-500/10 text-blue-400',
            )}
          >
            {lv}: {count}
          </span>
        ))}
        <span className="text-xs text-[var(--dim)] ml-auto">{logs.length} entries</span>
      </div>

      {/* Log entries */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
        {loading && logs.length === 0 ? (
          <div className="divide-y divide-[var(--border)] font-mono text-xs">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 px-4 py-1.5">
                <div className="h-3 rounded bg-[var(--hover)] animate-pulse w-36 shrink-0" />
                <div className="h-3 rounded bg-[var(--hover)] animate-pulse w-16 shrink-0" />
                <div className="h-3 rounded bg-[var(--hover)] animate-pulse w-24 shrink-0" />
                <div className={`h-3 rounded bg-[var(--hover)] animate-pulse flex-1`} style={{ width: `${40 + (i * 13) % 40}%`, animationDelay: `${i * 60}ms` }} />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-10 px-4">
            <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 w-full max-w-lg">
              <svg className="shrink-0 w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
              <span className="flex-1">{error}</span>
            </div>
            <button onClick={fetchLogs} className="text-xs text-[var(--accent)] hover:underline">Retry</button>
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-[var(--dim)]">
            <svg className="w-8 h-8 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            <span className="text-sm">No logs found for the current filters</span>
            <span className="text-xs opacity-60">Try expanding the time window or changing the level filter</span>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)] font-mono text-xs max-h-[600px] overflow-y-auto">
            {logs.map((entry, i) => (
              <div key={i} className="flex items-start gap-2 px-4 py-1.5 hover:bg-[var(--hover)]">
                <span className="text-[var(--dim)] shrink-0 w-36">{entry.event_time}</span>
                <span className={cn('shrink-0 w-20', LEVEL_COLOR[entry.level] ?? 'text-gray-400')}>
                  {entry.level}
                </span>
                <span className="text-[var(--accent)] shrink-0 max-w-32 truncate" title={entry.logger_name}>
                  {entry.logger_name}
                </span>
                <span className="text-[var(--fg)] break-all flex-1 min-w-0">
                  {highlightSearch(entry.message, debouncedSearch)}
                </span>
                {entry.query_id && (
                  <span className="text-[var(--dim)] shrink-0 max-w-24 truncate" title={entry.query_id}>
                    {entry.query_id}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
