import { useState, useEffect, useCallback } from 'react'
import {
  Search, RefreshCw, ChevronDown, ChevronRight,
  Database, HardDrive, Activity, Code, AlertTriangle,
  Sparkles, X,
} from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
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

function fmtActivityTs(s: string | undefined): string {
  if (!s || s.startsWith('1970-01-01') || s.startsWith('0000-00-00')) return ''
  const d = new Date(s.replace(' ', 'T'))
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function abbrevEngine(e: string): string {
  return e
    .replace('ReplicatedVersionedCollapsingMergeTree', 'Rep.VersionedCMT')
    .replace('ReplicatedReplacingMergeTree', 'Rep.ReplacingMT')
    .replace('ReplicatedCollapsingMergeTree', 'Rep.CollapsingMT')
    .replace('ReplicatedAggregatingMergeTree', 'Rep.AggMT')
    .replace('ReplicatedSummingMergeTree', 'Rep.SummingMT')
    .replace('ReplicatedMergeTree', 'Rep.MergeTree')
    .replace('VersionedCollapsingMergeTree', 'VersionedCMT')
    .replace('CollapsingMergeTree', 'CollapsingMT')
    .replace('ReplacingMergeTree', 'ReplacingMT')
    .replace('AggregatingMergeTree', 'AggMT')
    .replace('SummingMergeTree', 'SummingMT')
    .replace('GraphiteMergeTree', 'GraphiteMT')
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

/* ─── Sort types ──────────────────────────────────────────────────────────── */

type SortCol = 'table' | 'engine' | 'rows' | 'bytes' | 'parts' | 'selects' | 'inserts'
type SortDir = 'asc' | 'desc'

/* ─── Full detail modal ───────────────────────────────────────────────────── */

function TableDetailModal({
  entry,
  onClose,
  onAnalyze,
}: {
  entry: TableScanEntry
  onClose: () => void
  onAnalyze: (entry: TableScanEntry) => void
}) {
  const [showQuery, setShowQuery] = useState(false)
  const act = entry.query_activity
  const lastSel = fmtActivityTs(act.last_select)
  const lastIns = fmtActivityTs(act.last_insert)

  const keys = [
    ['Sort Key',      entry.sorting_key],
    ['Partition Key', entry.partition_key],
    ['Primary Key',   entry.primary_key],
    ['Sampling Key',  entry.sampling_key],
    ['Storage Policy',entry.storage_policy],
  ].filter(([, v]) => v) as [string, string][]

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative z-10 w-full max-w-4xl max-h-[90vh] flex flex-col rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-[var(--border)] shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1.5 flex-wrap">
              <span className="text-sm text-[var(--dim)]">{entry.database}.</span>
              <span className="text-base font-semibold text-[var(--fg)]">{entry.table}</span>
            </div>
            <div className="flex items-center gap-3 mt-1 flex-wrap text-xs text-[var(--dim)]">
              <span className="font-mono">{entry.engine}</span>
              <span className="text-[var(--border)]">·</span>
              <span>{fmtRows(entry.total_rows)} rows</span>
              <span className="text-[var(--border)]">·</span>
              <span>{fmtBytes(entry.total_bytes)}</span>
              <span className="text-[var(--border)]">·</span>
              <span>{entry.parts_count.toLocaleString()} parts</span>
              {act.is_active && (
                <>
                  <span className="text-[var(--border)]">·</span>
                  <span className="flex items-center gap-1 text-green-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                    active
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => onAnalyze(entry)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-purple-400 hover:bg-purple-500/15 border border-purple-500/20 transition-colors"
            >
              <Sparkles size={12} />
              Analyze with AI
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)] transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-auto p-5 space-y-5">

          {/* Keys — full text, no truncation */}
          {keys.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)]">Table Definition</div>
              <div className="grid gap-2">
                {keys.map(([label, value]) => (
                  <div key={label} className="flex gap-3 rounded-lg bg-[var(--surface)] px-3 py-2">
                    <span className="text-xs text-[var(--dim)] shrink-0 w-28">{label}</span>
                    <span className="font-mono text-xs text-[var(--fg)] break-all leading-relaxed">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Activity */}
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)]">Query Activity</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-[var(--surface)] px-4 py-3 space-y-0.5">
                <div className="text-xs text-[var(--dim)]">SELECTs</div>
                <div className="text-lg font-mono font-semibold text-blue-400">{fmtCount(act.select_count)}</div>
                {lastSel && act.select_count > 0 && (
                  <div className="text-xs text-[var(--dim)]">Last: {lastSel} ago</div>
                )}
              </div>
              <div className="rounded-lg bg-[var(--surface)] px-4 py-3 space-y-0.5">
                <div className="text-xs text-[var(--dim)]">INSERTs</div>
                <div className="text-lg font-mono font-semibold text-green-400">{fmtCount(act.insert_count)}</div>
                {lastIns && act.insert_count > 0 && (
                  <div className="text-xs text-[var(--dim)]">Last: {lastIns} ago</div>
                )}
              </div>
            </div>
          </div>

          {/* Disk breakdown */}
          {entry.disk_usage && entry.disk_usage.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)]">Storage</div>
              <div className="flex flex-wrap gap-2">
                {entry.disk_usage.map((d: DiskUsageEntry) => (
                  <div
                    key={d.disk_name}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                  >
                    <HardDrive size={12} className="text-[var(--dim)]" />
                    <span className="font-mono text-xs font-medium">{d.disk_name}</span>
                    <span className={cn('text-xs', DISK_TYPE_COLORS[d.disk_type?.toLowerCase()] ?? 'text-[var(--dim)]')}>
                      {d.disk_type || 'local'}
                    </span>
                    <span className="text-xs text-[var(--dim)]">{d.readable_size}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* CREATE TABLE DDL — full, no height limit */}
          {entry.create_query && (
            <div className="space-y-2">
              <button
                onClick={() => setShowQuery(v => !v)}
                className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
              >
                <Code size={12} />
                DDL
                {showQuery ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              </button>
              {showQuery && (
                <pre className="font-mono text-xs bg-[var(--code-bg,var(--hover))] border border-[var(--border)] rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-words leading-relaxed">
                  {entry.create_query}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─── Column header button ────────────────────────────────────────────────── */

function ColHeader({
  label, col, sortCol, sortDir, onSort, align = 'right', className,
}: {
  label: string
  col: SortCol
  sortCol: SortCol
  sortDir: SortDir
  onSort: (c: SortCol) => void
  align?: 'left' | 'right'
  className?: string
}) {
  const active = sortCol === col
  return (
    <th
      className={cn(
        'px-2 py-2 text-[10px] font-semibold uppercase tracking-wider cursor-pointer select-none',
        'hover:text-[var(--fg)] transition-colors',
        active ? 'text-[var(--accent)]' : 'text-[var(--dim)]',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
      onClick={() => onSort(col)}
    >
      {label}
      <span className="ml-0.5 opacity-60">
        {active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </th>
  )
}

/* ─── Table row ───────────────────────────────────────────────────────────── */

function TableRow({
  entry,
  sortCol,
  onOpenModal,
  onAnalyze,
}: {
  entry: TableScanEntry
  sortCol: SortCol
  onOpenModal: (entry: TableScanEntry) => void
  onAnalyze: (entry: TableScanEntry) => void
}) {
  const act = entry.query_activity
  const lastSel = fmtActivityTs(act.last_select)
  const lastIns = fmtActivityTs(act.last_insert)

  const hl = (col: SortCol) => col === sortCol ? 'bg-[var(--accent)]/5' : ''

  return (
    <tr
      className="border-b border-[var(--border)] cursor-pointer group transition-colors hover:bg-[var(--hover)]"
      onClick={() => onOpenModal(entry)}
    >
      {/* Expand chevron → opens modal */}
      <td className="w-6 pl-2">
        <ChevronRight size={10} className="text-[var(--dim)] opacity-0 group-hover:opacity-60 transition-opacity" />
      </td>

      {/* Table name */}
      <td className={cn('px-2 py-1.5 text-xs max-w-[200px]', hl('table'))}>
        <div className="flex items-baseline gap-0.5 min-w-0">
          <span className="text-[var(--dim)] text-[10px] shrink-0">{entry.database}.</span>
          <span className="font-medium text-[var(--fg)] truncate">{entry.table}</span>
        </div>
      </td>

      {/* Engine */}
      <td className={cn('px-2 py-1.5 text-[10px] font-mono text-[var(--dim)] max-w-[120px] truncate', hl('engine'))}>
        {abbrevEngine(entry.engine)}
      </td>

      {/* Rows */}
      <td className={cn('px-2 py-1.5 text-[11px] font-mono text-right tabular-nums', hl('rows'),
        entry.total_rows > 0 ? 'text-[var(--fg)]' : 'text-[var(--dim)]')}>
        {fmtRows(entry.total_rows)}
      </td>

      {/* Size */}
      <td className={cn('px-2 py-1.5 text-[11px] font-mono text-right tabular-nums', hl('bytes'),
        entry.total_bytes > 0 ? 'text-[var(--fg)]' : 'text-[var(--dim)]')}>
        {fmtBytes(entry.total_bytes)}
      </td>

      {/* Parts */}
      <td className={cn('px-2 py-1.5 text-[11px] font-mono text-right tabular-nums text-[var(--dim)]', hl('parts'))}>
        {entry.parts_count > 0 ? entry.parts_count.toLocaleString() : '—'}
      </td>

      {/* Status */}
      <td className="px-2 py-1.5 text-center">
        {act.is_active ? (
          <span className="inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/20 whitespace-nowrap">
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
      <td className={cn('px-2 py-1.5 text-right', hl('selects'))}>
        {act.select_count > 0 ? (
          <div>
            <span className="text-[11px] font-mono text-blue-400 tabular-nums">{fmtCount(act.select_count)}</span>
            {lastSel && <div className="text-[9px] text-[var(--dim)]">{lastSel} ago</div>}
          </div>
        ) : <span className="text-[10px] text-[var(--dim)]">—</span>}
      </td>

      {/* INSERTs */}
      <td className={cn('px-2 py-1.5 text-right', hl('inserts'))}>
        {act.insert_count > 0 ? (
          <div>
            <span className="text-[11px] font-mono text-green-400 tabular-nums">{fmtCount(act.insert_count)}</span>
            {lastIns && <div className="text-[9px] text-[var(--dim)]">{lastIns} ago</div>}
          </div>
        ) : <span className="text-[10px] text-[var(--dim)]">—</span>}
      </td>

      {/* AI Analyze — visible on row hover */}
      <td className="w-8 pr-2">
        <button
          onClick={(e) => { e.stopPropagation(); onAnalyze(entry) }}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-purple-400 hover:bg-purple-500/15"
          title="Analyze with AI"
        >
          <Sparkles size={11} />
        </button>
      </td>
    </tr>
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
  const [sortCol, setSortCol] = useState<SortCol>('bytes')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [activityFilter, setActivityFilter] = useState<'all' | 'active' | 'idle'>('all')
  const [modalEntry, setModalEntry] = useState<TableScanEntry | null>(null)

  const { analyze } = useAIAnalysis(instance)

  const handleAnalyze = useCallback((entry: TableScanEntry) => {
    const label = `Analyze table: ${entry.database}.${entry.table}`
    analyze(label, {
      database: entry.database,
      table: entry.table,
      engine: entry.engine,
      total_rows: entry.total_rows,
      total_bytes: entry.total_bytes,
      parts_count: entry.parts_count,
      sorting_key: entry.sorting_key,
      partition_key: entry.partition_key,
      primary_key: entry.primary_key,
      sampling_key: entry.sampling_key,
      storage_policy: entry.storage_policy,
      disk_usage: entry.disk_usage,
      select_count: entry.query_activity?.select_count,
      insert_count: entry.query_activity?.insert_count,
      is_active: entry.query_activity?.is_active,
      create_query: entry.create_query,
    }, { contextType: 'row', tab: 'scanner' })
    setModalEntry(null)
  }, [analyze])

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

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      setSortDir(col === 'table' || col === 'engine' ? 'asc' : 'desc')
    }
  }

  const tables = result?.tables ?? []

  const sorted = [...tables]
    .filter(t => {
      if (activityFilter === 'active') return t.query_activity.is_active
      if (activityFilter === 'idle') return !t.query_activity.is_active
      return true
    })
    .filter(t => {
      const f = filter.toLowerCase()
      return !f || t.database.toLowerCase().includes(f) || t.table.toLowerCase().includes(f) || t.engine.toLowerCase().includes(f)
    })
    .sort((a, b) => {
      let cmp = 0
      switch (sortCol) {
        case 'table':   cmp = `${a.database}.${a.table}`.localeCompare(`${b.database}.${b.table}`); break
        case 'engine':  cmp = a.engine.localeCompare(b.engine); break
        case 'rows':    cmp = a.total_rows - b.total_rows; break
        case 'bytes':   cmp = a.total_bytes - b.total_bytes; break
        case 'parts':   cmp = a.parts_count - b.parts_count; break
        case 'selects': cmp = a.query_activity.select_count - b.query_activity.select_count; break
        case 'inserts': cmp = a.query_activity.insert_count - b.query_activity.insert_count; break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

  const totalBytes = tables.reduce((s, t) => s + t.total_bytes, 0)
  const activeTables = tables.filter(t => t.query_activity.is_active).length

  return (
    <div className="flex flex-col gap-2 h-full">

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        {/* Instance */}
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
            placeholder="Filter…"
            className="pl-6 pr-2 py-1 rounded border border-[var(--border)] bg-[var(--surface)] text-xs focus:outline-none focus:border-[var(--accent)] transition-colors w-36"
          />
        </div>

        <span className="h-4 w-px bg-[var(--border)]" />

        {/* Activity filter */}
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

        <span className="h-4 w-px bg-[var(--border)]" />

        {/* Time range */}
        {RANGE_PRESETS.map(p => (
          <button
            key={p.secs}
            onClick={() => setRangePreset(p.secs)}
            className={cn(
              'px-2 py-0.5 rounded text-xs transition-colors',
              rangePreset === p.secs ? 'bg-[var(--accent)] text-white' : 'text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)]',
            )}
          >
            {p.label}
          </button>
        ))}

        <button
          onClick={load}
          disabled={loading}
          className="ml-auto flex items-center gap-1 px-2 py-1 rounded border border-[var(--border)] text-xs text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)] transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Scanning…' : 'Refresh'}
        </button>
      </div>

      {/* ── Stats bar ── */}
      {result && (
        <div className="flex items-center gap-2 text-[10px] text-[var(--dim)] shrink-0 flex-wrap">
          <span>{tables.length} tables</span>·
          <span>{fmtBytes(totalBytes)}</span>·
          <span className="text-green-400">{activeTables} active</span>·
          <span>{result.activity_rows} qlog rows</span>·
          {sorted.length !== tables.length && <><span className="text-[var(--accent)]">{sorted.length} shown</span>·</>}
          <span>scanned {new Date(result.scanned_at).toLocaleTimeString()}</span>
        </div>
      )}

      {/* ── Warnings ── */}
      {result?.warnings && result.warnings.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-1.5 rounded border border-yellow-500/30 bg-yellow-500/10 text-[10px] text-yellow-300 shrink-0">
          <AlertTriangle size={11} className="shrink-0 mt-0.5" />
          <span>{result.warnings.join(' · ')}</span>
        </div>
      )}

      {error && (
        <div className="px-3 py-1.5 rounded border border-red-500/30 bg-red-500/10 text-xs text-red-400 shrink-0">{error}</div>
      )}

      {!instance && (
        <div className="flex-1 flex items-center justify-center gap-2 text-sm text-[var(--dim)]">
          <Database size={16} />Select an instance above
        </div>
      )}

      {loading && !result && (
        <div className="flex-1 space-y-px">
          {Array.from({ length: 14 }).map((_, i) => (
            <div key={i} className="h-7 rounded bg-[var(--surface)] animate-pulse" style={{ opacity: 1 - i * 0.06 }} />
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
                  <th className="w-6" />
                  <ColHeader label="Table"   col="table"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="left" />
                  <ColHeader label="Engine"  col="engine"  sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="left" />
                  <ColHeader label="Rows"    col="rows"    sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                  <ColHeader label="Size"    col="bytes"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                  <ColHeader label="Parts"   col="parts"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                  <th className="px-2 py-2 text-[10px] font-semibold text-[var(--dim)] uppercase tracking-wider text-center">Status</th>
                  <ColHeader label="SELECTs" col="selects" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-blue-400/70" />
                  <ColHeader label="INSERTs" col="inserts" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-green-400/70" />
                  <th className="w-8" title="AI Analyze" />
                </tr>
              </thead>
              <tbody>
                {sorted.map(t => (
                  <TableRow
                    key={`${t.database}.${t.table}`}
                    entry={t}
                    sortCol={sortCol}
                    onOpenModal={setModalEntry}
                    onAnalyze={handleAnalyze}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && sorted.length === 0 && !loading && instance && (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[var(--dim)]">
          <Activity size={20} className="opacity-40" />
          <p className="text-xs">{filter || activityFilter !== 'all' ? 'No tables match your filters' : 'No tables found'}</p>
        </div>
      )}

      {/* ── Full detail modal ── */}
      {modalEntry && (
        <TableDetailModal
          entry={modalEntry}
          onClose={() => setModalEntry(null)}
          onAnalyze={handleAnalyze}
        />
      )}
    </div>
  )
}
