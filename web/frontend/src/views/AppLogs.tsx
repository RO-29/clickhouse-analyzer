import { useState, useEffect, useCallback, useRef } from 'react'
import { RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import type { LogEntry } from '../types/api'

const LEVELS = ['All', 'DEBUG', 'INFO', 'WARN', 'ERROR'] as const
const LIMITS = [100, 250, 500, 1000] as const

const LEVEL_COLOR: Record<string, string> = {
  DEBUG: 'text-gray-400',
  INFO: 'text-blue-400',
  WARN: 'text-yellow-400',
  ERROR: 'text-red-400',
}

const LEVEL_BG: Record<string, string> = {
  DEBUG: 'bg-gray-500/10 text-gray-400',
  INFO: 'bg-blue-500/10 text-blue-400',
  WARN: 'bg-yellow-500/10 text-yellow-400',
  ERROR: 'bg-red-500/10 text-red-400',
}

export default function AppLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState<string>('All')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [limit, setLimit] = useState(100)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null!)

  // Debounce search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [search])

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const lvl = level === 'All' ? undefined : level
      const data = await api.logs(lvl, debouncedSearch || undefined, limit)
      setLogs(Array.isArray(data) ? data : [])
      setExpanded(new Set())
    } catch (e: any) {
      setError(e.message)
      setLogs([])
    } finally {
      setLoading(false)
    }
  }, [level, debouncedSearch, limit])

  useEffect(() => { fetchLogs() }, [fetchLogs])

  const toggleExpand = useCallback((idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }, [])

  // Stats by level
  const stats = logs.reduce<Record<string, number>>((acc, l) => {
    const lv = l.level?.toUpperCase() ?? 'UNKNOWN'
    acc[lv] = (acc[lv] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search logs..."
          className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm text-[var(--fg)] w-64 focus:outline-none focus:border-[var(--accent)] placeholder:text-[var(--dim)]"
        />

        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
        >
          {LIMITS.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>

        <button
          onClick={fetchLogs}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)] hover:text-[var(--fg)] hover:border-[var(--accent)] transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-3">
        {Object.entries(stats).map(([lv, count]) => (
          <span
            key={lv}
            className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', LEVEL_BG[lv] ?? 'bg-gray-500/10 text-gray-400')}
          >
            {lv}: {count}
          </span>
        ))}
        <span className="text-xs text-[var(--dim)] ml-auto">
          {logs.length} entries
        </span>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Log entries */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
        {loading && logs.length === 0 ? (
          <div className="text-sm text-[var(--dim)] text-center py-8">Loading...</div>
        ) : logs.length === 0 ? (
          <div className="text-sm text-[var(--dim)] text-center py-8">No logs found</div>
        ) : (
          <div className="divide-y divide-[var(--border)] font-mono text-xs max-h-[600px] overflow-y-auto">
            {logs.map((entry, i) => {
              const lv = entry.level?.toUpperCase() ?? 'UNKNOWN'
              const hasAttrs = entry.attrs && Object.keys(entry.attrs).length > 0
              const isExpanded = expanded.has(i)

              return (
                <div key={i}>
                  <div
                    className={cn(
                      'flex items-start gap-2 px-4 py-1.5',
                      hasAttrs && 'cursor-pointer hover:bg-[var(--hover)]',
                    )}
                    onClick={() => hasAttrs && toggleExpand(i)}
                  >
                    {hasAttrs ? (
                      isExpanded
                        ? <ChevronDown size={12} className="shrink-0 mt-0.5 text-[var(--dim)]" />
                        : <ChevronRight size={12} className="shrink-0 mt-0.5 text-[var(--dim)]" />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <span className="text-[var(--dim)] shrink-0">{entry.time}</span>
                    <span className={cn('shrink-0 w-12 font-medium', LEVEL_COLOR[lv] ?? 'text-gray-400')}>
                      {lv}
                    </span>
                    <span className="text-[var(--fg)] break-all">{entry.msg}</span>
                  </div>
                  {isExpanded && entry.attrs && (
                    <div className="px-4 pb-2 pl-10">
                      <div className="rounded bg-[var(--hover)] p-2 text-xs">
                        {Object.entries(entry.attrs).map(([k, v]) => (
                          <div key={k} className="flex gap-2">
                            <span className="text-[var(--dim)] shrink-0">{k}:</span>
                            <span className="text-[var(--fg)] break-all">{String(v)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
