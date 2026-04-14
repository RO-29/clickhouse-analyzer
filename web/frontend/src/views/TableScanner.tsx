import { useState, useEffect, useCallback } from 'react'
import { Search, RefreshCw, ChevronDown, ChevronRight, Database, HardDrive, Activity, Code } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import type { TableScanResult, TableScanEntry, DiskUsageEntry } from '../types/api'

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function fmtBytes(b: number): string {
  if (b === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.floor(Math.log(b) / Math.log(1024))
  return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}

function fmtRows(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

const DISK_TYPE_COLORS: Record<string, string> = {
  local: 'text-blue-400',
  s3: 'text-yellow-400',
  hdfs: 'text-purple-400',
  azure_blob: 'text-cyan-400',
}

function DiskTypeBadge({ type }: { type: string }) {
  const color = DISK_TYPE_COLORS[type?.toLowerCase()] ?? 'text-[var(--dim)]'
  return (
    <span className={cn('text-[10px] font-mono uppercase', color)}>
      {type || 'local'}
    </span>
  )
}

function ActivityBadge({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/30">
      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
      active
    </span>
  ) : (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--surface)] text-[var(--dim)] border border-[var(--border)]">
      idle
    </span>
  )
}

/* ─── Time range presets ──────────────────────────────────────────────────── */

const RANGE_PRESETS = [
  { label: '1h',  secs: 3600 },
  { label: '6h',  secs: 21600 },
  { label: '24h', secs: 86400 },
  { label: '7d',  secs: 604800 },
  { label: '30d', secs: 2592000 },
]

/* ─── Expanded table detail ───────────────────────────────────────────────── */

function TableDetail({ entry }: { entry: TableScanEntry }) {
  const [showQuery, setShowQuery] = useState(false)

  return (
    <div className="px-4 pb-4 pt-2 border-t border-[var(--border)] bg-[var(--surface)]/40 space-y-3">
      {/* Keys */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        {[
          { label: 'Sorting Key', value: entry.sorting_key },
          { label: 'Primary Key', value: entry.primary_key },
          { label: 'Partition Key', value: entry.partition_key },
          { label: 'Sampling Key', value: entry.sampling_key },
          { label: 'Storage Policy', value: entry.storage_policy },
        ].map(({ label, value }) => value ? (
          <div key={label}>
            <span className="text-[10px] text-[var(--dim)] uppercase tracking-wider">{label}</span>
            <p className="font-mono text-[11px] text-[var(--fg)] mt-0.5 break-all">{value}</p>
          </div>
        ) : null)}
      </div>

      {/* Disk breakdown */}
      {entry.disk_usage && entry.disk_usage.length > 0 && (
        <div>
          <p className="text-[10px] text-[var(--dim)] uppercase tracking-wider mb-1.5">Disk Breakdown</p>
          <div className="flex flex-wrap gap-2">
            {entry.disk_usage.map((d: DiskUsageEntry) => (
              <div key={d.disk_name} className="flex items-center gap-1.5 px-2 py-1 rounded border border-[var(--border)] bg-[var(--hover)] text-xs">
                <HardDrive size={10} className="text-[var(--dim)] shrink-0" />
                <span className="font-mono text-[var(--fg)]">{d.disk_name}</span>
                <DiskTypeBadge type={d.disk_type} />
                <span className="text-[var(--dim)]">{d.readable_size}</span>
                <span className="text-[var(--dim)]">{d.parts.toLocaleString()} parts</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Query activity */}
      <div>
        <p className="text-[10px] text-[var(--dim)] uppercase tracking-wider mb-1.5">Query Activity (window)</p>
        <div className="flex flex-wrap gap-4 text-xs">
          <div>
            <span className="text-[var(--dim)]">SELECTs: </span>
            <span className="font-mono text-[var(--fg)]">{entry.query_activity.select_count.toLocaleString()}</span>
            {entry.query_activity.last_select && (
              <span className="text-[var(--dim)] ml-2">last {entry.query_activity.last_select}</span>
            )}
          </div>
          <div>
            <span className="text-[var(--dim)]">INSERTs: </span>
            <span className="font-mono text-[var(--fg)]">{entry.query_activity.insert_count.toLocaleString()}</span>
            {entry.query_activity.last_insert && (
              <span className="text-[var(--dim)] ml-2">last {entry.query_activity.last_insert}</span>
            )}
          </div>
        </div>
      </div>

      {/* CREATE TABLE toggle */}
      {entry.create_query && (
        <div>
          <button
            onClick={() => setShowQuery(v => !v)}
            className="flex items-center gap-1.5 text-[10px] text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
          >
            <Code size={10} />
            {showQuery ? 'Hide' : 'Show'} CREATE TABLE
            {showQuery ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
          {showQuery && (
            <pre className="mt-1.5 text-[10px] font-mono bg-[var(--code-bg)] border border-[var(--border)] rounded p-3 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
              {entry.create_query}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/* ─── Table row ───────────────────────────────────────────────────────────── */

function TableRow({ entry, filter }: { entry: TableScanEntry; filter: string }) {
  const [expanded, setExpanded] = useState(false)

  const f = filter.toLowerCase()
  if (f && !entry.database.toLowerCase().includes(f) && !entry.table.toLowerCase().includes(f) && !entry.engine.toLowerCase().includes(f)) {
    return null
  }

  return (
    <>
      <tr
        className={cn(
          'border-b border-[var(--border)] cursor-pointer',
          expanded ? 'bg-[var(--surface)]' : 'hover:bg-[var(--hover)]',
          'transition-colors',
        )}
        onClick={() => setExpanded(v => !v)}
      >
        <td className="px-3 py-2.5 w-5">
          {expanded
            ? <ChevronDown size={12} className="text-[var(--dim)]" />
            : <ChevronRight size={12} className="text-[var(--dim)]" />
          }
        </td>
        <td className="px-3 py-2.5 text-xs">
          <span className="text-[var(--dim)]">{entry.database}.</span>
          <span className="font-medium text-[var(--fg)]">{entry.table}</span>
        </td>
        <td className="px-3 py-2.5 text-xs font-mono text-[var(--dim)]">{entry.engine}</td>
        <td className="px-3 py-2.5 text-xs font-mono text-right tabular-nums">{fmtRows(entry.total_rows)}</td>
        <td className="px-3 py-2.5 text-xs font-mono text-right tabular-nums">{fmtBytes(entry.total_bytes)}</td>
        <td className="px-3 py-2.5 text-xs font-mono text-right tabular-nums">{entry.parts_count.toLocaleString()}</td>
        <td className="px-3 py-2.5 text-xs">
          <div className="flex flex-wrap gap-1">
            {entry.disk_usage?.map(d => (
              <span key={d.disk_name} className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--hover)] border border-[var(--border)] text-[10px]">
                <DiskTypeBadge type={d.disk_type} />
                <span className="text-[var(--dim)]">{d.disk_name}</span>
              </span>
            ))}
          </div>
        </td>
        <td className="px-3 py-2.5 text-right">
          <ActivityBadge active={entry.query_activity.is_active} />
        </td>
        <td className="px-3 py-2.5 text-xs text-right tabular-nums text-[var(--dim)]">
          {entry.query_activity.select_count > 0 && (
            <span className="text-blue-400 mr-2">↓{entry.query_activity.select_count.toLocaleString()}</span>
          )}
          {entry.query_activity.insert_count > 0 && (
            <span className="text-green-400">↑{entry.query_activity.insert_count.toLocaleString()}</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-[var(--border)]">
          <td colSpan={9} className="p-0">
            <TableDetail entry={entry} />
          </td>
        </tr>
      )}
    </>
  )
}

/* ─── Main view ───────────────────────────────────────────────────────────── */

interface TableScannerProps {
  refreshKey?: number
}

export default function TableScanner({ refreshKey }: TableScannerProps) {
  const { selectedInstance, instances } = useStore()
  const [instance, setInstance] = useState(() => selectedInstance || '')
  const [result, setResult] = useState<TableScanResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [rangePreset, setRangePreset] = useState(604800) // 7d default
  const [sortCol, setSortCol] = useState<'bytes' | 'rows' | 'parts' | 'selects' | 'inserts'>('bytes')
  const [activityFilter, setActivityFilter] = useState<'all' | 'active' | 'idle'>('all')

  // Auto-select: prefer global selectedInstance, fall back to first available instance
  useEffect(() => {
    if (!instance) {
      const target = selectedInstance || instances[0] || ''
      if (target) setInstance(target)
    }
  }, [selectedInstance, instances]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!instance) return
    setLoading(true)
    setError('')
    try {
      const now = Math.floor(Date.now() / 1000)
      const data = await api.tableScan(instance, now - rangePreset, now)
      setResult(data)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [instance, rangePreset])

  useEffect(() => { load() }, [load, refreshKey])

  const tables = result?.tables ?? []

  // Filter by activity
  const filtered = tables.filter(t => {
    if (activityFilter === 'active') return t.query_activity.is_active
    if (activityFilter === 'idle') return !t.query_activity.is_active
    return true
  })

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    switch (sortCol) {
      case 'rows':    return b.total_rows - a.total_rows
      case 'parts':   return b.parts_count - a.parts_count
      case 'selects': return b.query_activity.select_count - a.query_activity.select_count
      case 'inserts': return b.query_activity.insert_count - a.query_activity.insert_count
      default:        return b.total_bytes - a.total_bytes
    }
  })

  const totalBytes = tables.reduce((s, t) => s + t.total_bytes, 0)
  const activeTables = tables.filter(t => t.query_activity.is_active).length

  return (
    <div className="space-y-4">
      {/* Header stats */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[var(--fg)]">Table Scanner</h2>
            {/* Instance selector */}
            <select
              value={instance}
              onChange={e => { setInstance(e.target.value); setResult(null) }}
              className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-0.5 text-xs focus:outline-none focus:border-[var(--accent)] transition-colors"
            >
              {instances.length === 0 && <option value="">No instances</option>}
              {instances.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          {result && (
            <p className="text-xs text-[var(--dim)] mt-0.5">
              {tables.length} tables · {fmtBytes(totalBytes)} total · {activeTables} active
              · scanned {new Date(result.scanned_at).toLocaleTimeString()}
            </p>
          )}
        </div>

        {/* Time range */}
        <div className="flex items-center gap-1">
          {RANGE_PRESETS.map(p => (
            <button
              key={p.secs}
              onClick={() => setRangePreset(p.secs)}
              className={cn(
                'px-2 py-0.5 rounded text-xs transition-colors',
                rangePreset === p.secs
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)]',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)] transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Scanning…' : 'Refresh'}
        </button>
      </div>

      {/* Filters row */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--dim)]" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter by database, table, engine…"
            className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs focus:outline-none focus:border-[var(--accent)] transition-colors"
          />
        </div>

        {/* Activity filter */}
        <div className="flex items-center gap-1">
          {(['all', 'active', 'idle'] as const).map(f => (
            <button
              key={f}
              onClick={() => setActivityFilter(f)}
              className={cn(
                'px-2.5 py-1 rounded-lg text-xs capitalize transition-colors',
                activityFilter === f
                  ? 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30'
                  : 'text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)] border border-transparent',
              )}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-1 text-xs text-[var(--dim)]">
          <span>Sort:</span>
          {(['bytes', 'rows', 'parts', 'selects', 'inserts'] as const).map(col => (
            <button
              key={col}
              onClick={() => setSortCol(col)}
              className={cn(
                'px-2 py-0.5 rounded transition-colors capitalize',
                sortCol === col
                  ? 'text-[var(--accent)] bg-[var(--accent)]/10'
                  : 'hover:text-[var(--fg)] hover:bg-[var(--hover)]',
              )}
            >
              {col}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-3 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* No instance */}
      {!instance && (
        <div className="flex items-center justify-center h-40 text-sm text-[var(--dim)]">
          <Database size={16} className="mr-2" />
          Select an instance above to scan tables
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !result && (
        <div className="space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-10 rounded bg-[var(--surface)] animate-pulse" style={{ opacity: 1 - i * 0.1 }} />
          ))}
        </div>
      )}

      {/* Table */}
      {sorted.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[var(--surface)] border-b border-[var(--border)]">
                  <th className="w-5" />
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-[var(--dim)] uppercase tracking-wider">Table</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-[var(--dim)] uppercase tracking-wider">Engine</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-[var(--dim)] uppercase tracking-wider">Rows</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-[var(--dim)] uppercase tracking-wider">Size</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-[var(--dim)] uppercase tracking-wider">Parts</th>
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-[var(--dim)] uppercase tracking-wider">Disks</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-[var(--dim)] uppercase tracking-wider">Activity</th>
                  <th className="px-3 py-2.5 text-right text-xs font-semibold text-[var(--dim)] uppercase tracking-wider">Queries</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(t => (
                  <TableRow
                    key={`${t.database}.${t.table}`}
                    entry={t}
                    filter={filter}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {result && sorted.length === 0 && !loading && instance && (
        <div className="flex flex-col items-center justify-center h-40 gap-2 text-[var(--dim)]">
          <Activity size={24} className="opacity-50" />
          <p className="text-sm">{filter ? 'No tables match your filter' : 'No tables found'}</p>
        </div>
      )}
    </div>
  )
}
