import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { RefreshCw, ChevronDown, ChevronRight, Sparkles, Search, X } from 'lucide-react'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import type { LogEntry } from '../types/api'

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const

const LEVEL_COLOR: Record<string, string> = {
  DEBUG: 'text-gray-400',
  INFO:  'text-blue-400',
  WARN:  'text-yellow-400',
  ERROR: 'text-red-400',
}

const LEVEL_BG: Record<string, string> = {
  DEBUG: 'bg-gray-500/10  text-gray-400  border-gray-500/20',
  INFO:  'bg-blue-500/10  text-blue-400  border-blue-500/20',
  WARN:  'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  ERROR: 'bg-red-500/10   text-red-400   border-red-500/20',
}

const LEVEL_ROW_BG: Record<string, string> = {
  ERROR: 'bg-red-500/[0.03]',
  WARN:  'bg-yellow-500/[0.03]',
}

// Fetch everything in the ring buffer — filter client-side for instant response.
const FETCH_LIMIT = 5000

function fmtLogTime(raw: string): string {
  try {
    const d = new Date(raw)
    const today = new Date().toDateString() === d.toDateString()
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    if (today) return t
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t
  } catch {
    return raw
  }
}

export default function AppLogs({ refreshKey }: { refreshKey?: number }) {
  const { analyze } = useAIAnalysis('')
  const [allLogs, setAllLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters — applied client-side on the loaded set
  const [level, setLevel] = useState<string | null>(null)   // null = all
  const [search, setSearch] = useState('')

  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.logs(undefined, undefined, FETCH_LIMIT)
      setAllLogs(Array.isArray(data) ? data : [])
      setExpanded(new Set())
    } catch (e: any) {
      setError(e.message)
      setAllLogs([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => { fetchLogs() }, [fetchLogs])

  // Auto-refresh: re-fetch when tick fires, preserve level/search filters
  const autoRefreshMounted = useRef(false)
  useEffect(() => {
    if (!autoRefreshMounted.current) { autoRefreshMounted.current = true; return }
    fetchLogs()
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Client-side filter — instant, no API round-trip per keystroke
  const filtered = useMemo(() => {
    let rows = allLogs
    if (level) {
      rows = rows.filter((l) => l.level?.toUpperCase() === level)
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      rows = rows.filter(
        (l) =>
          l.msg?.toLowerCase().includes(q) ||
          Object.values(l.attrs ?? {}).some((v) =>
            String(v).toLowerCase().includes(q),
          ),
      )
    }
    return rows
  }, [allLogs, level, search])

  const toggleExpand = useCallback((idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }, [])

  // Level counts over full unfiltered set
  const stats = useMemo(
    () =>
      allLogs.reduce<Record<string, number>>((acc, l) => {
        const lv = l.level?.toUpperCase() ?? 'UNKNOWN'
        acc[lv] = (acc[lv] ?? 0) + 1
        return acc
      }, {}),
    [allLogs],
  )

  const isFiltered = level !== null || search.trim() !== ''

  return (
    <div className="space-y-4">

      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">

        {/* Level buttons */}
        <div className="flex rounded-lg border border-[var(--border)] overflow-hidden text-xs">
          <button
            onClick={() => setLevel(null)}
            className={cn(
              'px-3 py-1.5 font-medium border-r border-[var(--border)] transition-colors',
              level === null
                ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                : 'text-[var(--dim)] hover:bg-[var(--hover)]',
            )}
          >
            All
          </button>
          {LEVELS.map((l) => (
            <button
              key={l}
              onClick={() => setLevel(level === l ? null : l)}
              className={cn(
                'px-3 py-1.5 font-medium border-r border-[var(--border)] last:border-0 transition-colors',
                level === l
                  ? LEVEL_BG[l]
                  : 'text-[var(--dim)] hover:bg-[var(--hover)]',
              )}
            >
              {l}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search
            size={13}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--dim)] pointer-events-none"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search message, attrs…"
            className="w-full pl-8 pr-7 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] text-sm text-[var(--fg)] focus:outline-none focus:border-[var(--accent)] placeholder:text-[var(--dim)] transition-colors"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--dim)] hover:text-[var(--fg)]"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {isFiltered && (
            <button
              onClick={() => { setLevel(null); setSearch('') }}
              className="text-xs text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
            >
              Clear filters
            </button>
          )}
          <button
            onClick={fetchLogs}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)] hover:text-[var(--fg)] hover:border-[var(--accent)] transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={() =>
              analyze(
                'App Logs',
                { logs: filtered.slice(0, 50), level, search, stats },
                { contextType: 'tab', tab: 'applogs' },
              )
            }
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-purple-400 hover:bg-purple-500/15 border border-purple-500/20 transition-colors disabled:opacity-30"
          >
            <Sparkles size={13} />
            Analyze
          </button>
        </div>
      </div>

      {/* ── Level count badges (clickable to filter) ─────────────────── */}
      <div className="flex items-center gap-2">
        {LEVELS.filter((l) => stats[l]).map((lv) => (
          <button
            key={lv}
            onClick={() => setLevel(level === lv ? null : lv)}
            className={cn(
              'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors',
              LEVEL_BG[lv],
              level === lv && 'ring-1 ring-current',
            )}
          >
            {lv} {stats[lv]}
          </button>
        ))}
        <span className="text-xs text-[var(--dim)] ml-auto tabular-nums">
          {isFiltered
            ? `${filtered.length} of ${allLogs.length} entries`
            : `${allLogs.length} entries`}
        </span>
      </div>

      {/* ── Error ────────────────────────────────────────────────────── */}
      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* ── Log list ─────────────────────────────────────────────────── */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
        {loading && allLogs.length === 0 ? (
          <div className="text-sm text-[var(--dim)] text-center py-10">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="text-sm text-[var(--dim)] text-center py-10">
            {allLogs.length === 0 ? 'No logs captured yet' : 'No entries match'}
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)] font-mono text-xs max-h-[72vh] overflow-y-auto">
            {filtered.map((entry, i) => {
              const lv = entry.level?.toUpperCase() ?? 'UNKNOWN'
              const hasAttrs = entry.attrs && Object.keys(entry.attrs).length > 0
              const isExpanded = expanded.has(i)

              return (
                <div key={i} className={LEVEL_ROW_BG[lv]}>
                  <div
                    className={cn(
                      'flex items-start gap-2 px-4 py-1.5 select-text',
                      hasAttrs && 'cursor-pointer hover:bg-[var(--hover)]',
                    )}
                    onClick={() => hasAttrs && toggleExpand(i)}
                  >
                    {hasAttrs ? (
                      isExpanded
                        ? <ChevronDown  size={11} className="shrink-0 mt-0.5 text-[var(--dim)]" />
                        : <ChevronRight size={11} className="shrink-0 mt-0.5 text-[var(--dim)]" />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <span className="text-[var(--dim)] shrink-0 tabular-nums w-24">
                      {fmtLogTime(entry.time)}
                    </span>
                    <span className={cn('shrink-0 w-11 font-semibold', LEVEL_COLOR[lv] ?? 'text-gray-400')}>
                      {lv}
                    </span>
                    <span className="text-[var(--fg)] break-all">{entry.msg}</span>
                  </div>

                  {isExpanded && entry.attrs && (
                    <div className="px-4 pb-2 ml-5 pl-9">
                      <div className="rounded-lg bg-[var(--hover)] p-2.5 space-y-0.5">
                        {Object.entries(entry.attrs).map(([k, v]) => (
                          <div key={k} className="flex gap-2">
                            <span className="text-[var(--dim)] shrink-0 min-w-[80px]">{k}</span>
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
