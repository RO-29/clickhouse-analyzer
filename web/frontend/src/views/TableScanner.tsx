import { useState, useEffect, useCallback } from 'react'
import {
  Search, RefreshCw, ChevronDown, ChevronRight,
  Database, HardDrive, Activity, Code, AlertTriangle,
} from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import type { TableScanResult, TableScanEntry, DiskUsageEntry } from '../types/api'

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function fmtBytes(b: number): string {
  if (b === 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.floor(Math.log(b) / Math.log(1024))
  return (b / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}

function fmtRows(n: number): string {
  if (n === 0) return '—'
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function fmtCount(n: number): string {
  if (n === 0) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

/** Returns a relative-time string for a ClickHouse datetime string, or '' if invalid/epoch. */
function fmtActivityTs(s: string | undefined): string {
  if (!s || s === '' || s.startsWith('1970-01-01') || s.startsWith('0000-00-00')) return ''
  // ClickHouse datetimes come as "YYYY-MM-DD HH:MM:SS" in server local time.
  // Treat as local to avoid timezone gymnastics.
  const d = new Date(s.replace(' ', 'T'))
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** Abbreviate long engine names so they fit in a compact column. */
function abbrevEngine(e: string): string {
  return e
    .replace('VersionedCollapsingMergeTree', 'VersionedCMT')
    .replace('ReplacingMergeTree', 'ReplacingMT')
    .replace('CollapsingMergeTree', 'CollapsingMT')
    .replace('SummingMergeTree', 'SummingMT')
    .replace('AggregatingMergeTree', 'AggMT')
    .replace('GraphiteMergeTree', 'GraphiteMT')
    .replace('ReplicatedVersionedCollapsingMergeTree', 'RepVersionedCMT')
    .replace('ReplicatedReplacingMergeTree', 'RepReplacingMT')
    .replace('ReplicatedCollapsingMergeTree', 'RepCollapsingMT')
    .replace('ReplicatedMergeTree', 'RepMT')
    .replace('ReplicatedSummingMergeTree', 'RepSummingMT')
    .replace('ReplicatedAggregatingMergeTree', 'RepAggMT')
}

const DISK_TYPE_COLORS: Record<string, string> = {
  local: 'text-blue-400',
  s3: 'text-yellow-400',
  hdfs: 'text-purple-400',
  azure_blob_storage: 'text-cyan-400',
}

/* ─── Time range presets ──────────────────────────────────────────────────── */

const RANGE_PRESETS = [
  { label: '1h',  secs: 3600 },
  { label: '6h',  secs: 21600 },
  { label: '24h', secs: 86400 },
  { label: '7d',  secs: 604800 },
  { label: '30d', secs: 2592000 },
]

/* ─── Expanded detail panel ───────────────────────────────────────────────── */

function TableDetail({ entry }: { entry: TableScanEntry }) {
  const [showQuery, setShowQuery] = useState(false)
  const act = entry.query_activity
  const lastSel = fmtActivityTs(act.last_select)
  const lastIns = fmtActivityTs(act.last_insert)

  const keys = [
    { label: 'Sorting Key',    value: entry.sorting_key },
    { label: 'Primary Key',   value: entry.primary_key },
    { label: 'Partition Key', value: entry.partition_key },
    { label: 'Sampling Key',  value: entry.sampling_key },
    { label: 'Storage Policy',value: entry.storage_policy },
  ].filter(k => k.value)

  return (
    <div className="px-4 py-3 border-t border-[var(--border)] bg-[var(--surface)]/30 space-y-3 text-xs">
      {/* Keys + Activity side by side */}
      <div className="flex gap-6">
        {/* Keys */}
        {keys.length > 0 && (
          <div className="flex-1 min-w-0 grid grid-cols-2 gap-x-6 gap-y-1.5">
            {keys.map(({ label, value }) => (
              <div key={label} className="min-w-0">
                <span className="text-[9px] text-[var(--dim)] uppercase tracking-widest">{label}</span>
                <p className="font-mono text-[10px] text-[var(--fg)] truncate">{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Activity */}
        <div className="shrink-0 space-y-1 text-right min-w-[140px]">
          <p className="text-[9px] text-[var(--dim)] uppercase tracking-widest mb-1">Activity (window)</p>
          <div className="flex items-center justify-end gap-2">
            <span className="text-blue-400 font-mono font-medium">
              {act.select_count > 0 ? fmtCount(act.select_count) : '—'}
            </span>
            <span className="text-[var(--dim)]">SELECTs</span>
            {lastSel && act.select_count > 0 && (
              <span className="text-[9px] text-[var(--dim)]">{lastSel}</span>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <span className="text-green-400 font-mono font-medium">
              {act.insert_count > 0 ? fmtCount(act.insert_count) : '—'}
            </span>
            <span className="text-[var(--dim)]">INSERTs</span>
            {lastIns && act.insert_count > 0 && (
              <span className="text-[9px] text-[var(--dim)]">{lastIns}</span>
            )}
          </div>
        </div>
      </div>

      {/* Disk breakdown */}
      {entry.disk_usage && entry.disk_usage.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <span className="text-[9px] text-[var(--dim)] uppercase tracking-widest self-center mr-1">Disks</span>
          {entry.disk_usage.map((d: DiskUsageEntry) => (
            <span
              key={d.disk_name}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-[var(--border)] bg-[var(--hover)] text-[10px]"
            >
              <HardDrive size={9} className="text-[var(--dim)] shrink-0" />
              <span className="font-mono text-[var(--fg)]">{d.disk_name}</span>
              <span className={cn('uppercase', DISK_TYPE_COLORS[d.disk_type?.toLowerCase()] ?? 'text-[var(--dim)]')}>
                {d.disk_type || 'local'}
              </span>
              <span className="text-[var(--dim)]">{d.readable_size}</span>
              <span className="text-[var(--dim)]">{d.parts.toLocaleString()} parts</span>
            </span>
          ))}
        </div>
      )}

      {/* CREATE TABLE */}
      {entry.create_query && (
        <div>
          <button
            onClick={() => setShowQuery(v => !v)}
            className="inline-flex items-center gap-1 text-[10px] text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
          >
            <Code size={10} />
            {showQuery ? 'Hide' : 'Show'} CREATE TABLE
            {showQuery ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
          </button>
          {showQuery && (
            <pre className="mt-1.5 text-[10px] font-mono bg-[var(--code-bg,var(--hover))] border border-[var(--border)] rounded p-2.5 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed max-h-48">
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
  const act = entry.query_activity

  const f = filter.toLowerCase()
  if (f && !entry.database.toLowerCase().includes(f)
        && !entry.table.toLowerCase().includes(f)
        && !entry.engine.toLowerCase().includes(f)) {
    return null
  }

  const lastSel = fmtActivityTs(act.last_select)
  const lastIns = fmtActivityTs(act.last_insert)

  return (
    <>
      <tr
        className={cn(
          'border-b border-[var(--border)] cursor-pointer group transition-colors',
          expanded ? 'bg-[var(--surface)]' : 'hover:bg-[var(--hover)]',
        )}
        onClick={() => setExpanded(v => !v)}
      >
        {/* Expand */}
        <td className="w-7 pl-2 pr-0">
          {expanded
            ? <ChevronDown size={11} className="text-[var(--dim)]" />
            : <ChevronRight size={11} className="text-[var(--dim)] opacity-0 group-hover:opacity-100 transition-opacity" />
          }
        </td>

        {/* Table name */}
        <td className="px-2 py-1.5 text-xs max-w-[220px]">
          <span className="text-[var(--dim)] text-[10px]">{entry.database}.</span>
          <span className="font-medium text-[var(--fg)]">{entry.table}</span>
        </td>

        {/* Engine */}
        <td className="px-2 py-1.5 text-[10px] font-mono text-[var(--dim)] max-w-[130px] truncate">
          {abbrevEngine(entry.engine)}
        </td>

        {/* Rows */}
        <td className="px-2 py-1.5 text-[11px] font-mono text-right tabular-nums text-[var(--fg)]">
          {fmtRows(entry.total_rows)}
        </td>

        {/* Size */}
        <td className="px-2 py-1.5 text-[11px] font-mono text-right tabular-nums text-[var(--fg)]">
          {fmtBytes(entry.total_bytes)}
        </td>

        {/* Parts */}
        <td className="px-2 py-1.5 text-[11px] font-mono text-right tabular-nums text-[var(--dim)]">
          {entry.parts_count > 0 ? entry.parts_count.toLocaleString() : '—'}
        </td>

        {/* Activity badge */}
        <td className="px-2 py-1.5 text-center">
          {act.is_active ? (
            <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/25 whitespace-nowrap">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              active
            </span>
          ) : (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--surface)] text-[var(--dim)] border border-[var(--border)]">
              idle
            </span>
          )}
        </td>

        {/* SELECTs */}
        <td className="px-2 py-1.5 text-right">
          {act.select_count > 0 ? (
            <div>
              <span className="text-[11px] font-mono text-blue-400 tabular-nums">{fmtCount(act.select_count)}</span>
              {lastSel && <div className="text-[9px] text-[var(--dim)]">{lastSel}</div>}
            </div>
          ) : (
            <span className="text-[10px] text-[var(--dim)]">—</span>
          )}
        </td>

        {/* INSERTs */}
        <td className="px-2 py-1.5 text-right">
          {act.insert_count > 0 ? (
            <div>
              <span className="text-[11px] font-mono text-green-400 tabular-nums">{fmtCount(act.insert_count)}</span>
              {lastIns && <div className="text-[9px] text-[var(--dim)]">{lastIns}</div>}
            </div>
          ) : (
            <span className="text-[10px] text-[var(--dim)]">—</span>
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
  const [rangePreset, setRangePreset] = useState(604800)
  const [sortCol, setSortCol] = useState<'bytes' | 'rows' | 'parts' | 'selects' | 'inserts'>('bytes')
  const [activityFilter, setActivityFilter] = useState<'all' | 'active' | 'idle'>('all')

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

  const filtered = tables.filter(t => {
    if (activityFilter === 'active') return t.query_activity.is_active
    if (activityFilter === 'idle') return !t.query_activity.is_active
    return true
  }).filter(t => {
    const f = filter.toLowerCase()
    return !f || t.database.toLowerCase().includes(f) || t.table.toLowerCase().includes(f) || t.engine.toLowerCase().includes(f)
  })

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
    <div className="flex flex-col gap-3 h-full">

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        {/* Instance selector */}
        <select
          value={instance}
          onChange={e => { setInstance(e.target.value); setResult(null) }}
          className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-xs focus:outline-none focus:border-[var(--accent)] transition-colors"
        >
          {instances.length === 0 && <option value="">No instances</option>}
          {instances.map(n => <option key={n} value={n}>{n}</option>)}
        </select>

        {/* Search */}
        <div className="relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--dim)]" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter tables…"
            className="pl-6 pr-3 py-1 rounded border border-[var(--border)] bg-[var(--surface)] text-xs focus:outline-none focus:border-[var(--accent)] transition-colors w-44"
          />
        </div>

        {/* Divider */}
        <span className="h-4 w-px bg-[var(--border)]" />

        {/* Activity filter */}
        <div className="flex items-center gap-0.5">
          {(['all', 'active', 'idle'] as const).map(f => (
            <button
              key={f}
              onClick={() => setActivityFilter(f)}
              className={cn(
                'px-2 py-0.5 rounded text-xs capitalize transition-colors',
                activityFilter === f
                  ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                  : 'text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)]',
              )}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Divider */}
        <span className="h-4 w-px bg-[var(--border)]" />

        {/* Sort */}
        <div className="flex items-center gap-0.5 text-xs text-[var(--dim)]">
          <span className="mr-0.5">Sort:</span>
          {(['bytes', 'rows', 'parts', 'selects', 'inserts'] as const).map(col => (
            <button
              key={col}
              onClick={() => setSortCol(col)}
              className={cn(
                'px-1.5 py-0.5 rounded transition-colors capitalize',
                sortCol === col ? 'text-[var(--accent)] bg-[var(--accent)]/10' : 'hover:text-[var(--fg)] hover:bg-[var(--hover)]',
              )}
            >
              {col}
            </button>
          ))}
        </div>

        {/* Divider */}
        <span className="h-4 w-px bg-[var(--border)]" />

        {/* Time range */}
        <div className="flex items-center gap-0.5">
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
          className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded border border-[var(--border)] text-xs text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)] transition-colors disabled:opacity-50"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Scanning…' : 'Refresh'}
        </button>
      </div>

      {/* ── Stats bar ── */}
      {result && (
        <div className="flex items-center gap-3 text-[10px] text-[var(--dim)] shrink-0">
          <span>{tables.length} tables</span>
          <span className="w-px h-3 bg-[var(--border)]" />
          <span>{fmtBytes(totalBytes)} total</span>
          <span className="w-px h-3 bg-[var(--border)]" />
          <span className="text-green-400">{activeTables} active</span>
          <span className="w-px h-3 bg-[var(--border)]" />
          <span>{result.activity_rows} qlog rows</span>
          <span className="w-px h-3 bg-[var(--border)]" />
          <span>scanned {new Date(result.scanned_at).toLocaleTimeString()}</span>
          {sorted.length !== tables.length && (
            <>
              <span className="w-px h-3 bg-[var(--border)]" />
              <span className="text-[var(--accent)]">{sorted.length} shown</span>
            </>
          )}
        </div>
      )}

      {/* ── Warnings ── */}
      {result?.warnings && result.warnings.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 rounded border border-yellow-500/30 bg-yellow-500/10 text-xs text-yellow-300 shrink-0">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            {result.warnings.map((w, i) => <p key={i}>{w}</p>)}
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="px-3 py-2 rounded border border-red-500/30 bg-red-500/10 text-xs text-red-400 shrink-0">
          {error}
        </div>
      )}

      {/* ── No instance ── */}
      {!instance && (
        <div className="flex-1 flex items-center justify-center gap-2 text-sm text-[var(--dim)]">
          <Database size={16} />
          Select an instance above
        </div>
      )}

      {/* ── Loading skeleton ── */}
      {loading && !result && (
        <div className="flex-1 space-y-px">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="h-8 rounded bg-[var(--surface)] animate-pulse" style={{ opacity: 1 - i * 0.07 }} />
          ))}
        </div>
      )}

      {/* ── Table ── */}
      {sorted.length > 0 && (
        <div className="flex-1 rounded-lg border border-[var(--border)] overflow-hidden min-h-0">
          <div className="overflow-auto h-full">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-[var(--card)] border-b border-[var(--border)]">
                <tr>
                  <th className="w-7" />
                  <th className="px-2 py-2 text-left text-[10px] font-semibold text-[var(--dim)] uppercase tracking-wider">Table</th>
                  <th className="px-2 py-2 text-left text-[10px] font-semibold text-[var(--dim)] uppercase tracking-wider">Engine</th>
                  <th className="px-2 py-2 text-right text-[10px] font-semibold text-[var(--dim)] uppercase tracking-wider">Rows</th>
                  <th className="px-2 py-2 text-right text-[10px] font-semibold text-[var(--dim)] uppercase tracking-wider">Size</th>
                  <th className="px-2 py-2 text-right text-[10px] font-semibold text-[var(--dim)] uppercase tracking-wider">Parts</th>
                  <th className="px-2 py-2 text-center text-[10px] font-semibold text-[var(--dim)] uppercase tracking-wider">Status</th>
                  <th className="px-2 py-2 text-right text-[10px] font-semibold text-blue-400/70 uppercase tracking-wider">SELECTs</th>
                  <th className="px-2 py-2 text-right text-[10px] font-semibold text-green-400/70 uppercase tracking-wider">INSERTs</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(t => (
                  <TableRow
                    key={`${t.database}.${t.table}`}
                    entry={t}
                    filter=""
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {result && sorted.length === 0 && !loading && instance && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[var(--dim)]">
          <Activity size={20} className="opacity-40" />
          <p className="text-xs">{filter || activityFilter !== 'all' ? 'No tables match your filters' : 'No tables found'}</p>
        </div>
      )}
    </div>
  )
}
