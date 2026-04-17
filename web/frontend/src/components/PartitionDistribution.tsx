import { useState, useMemo } from 'react'
import { cn, fmtBytes } from '../lib/utils'
import type { PartitionDiskRow } from '../types/api'

interface PartitionDistributionProps {
  rows: PartitionDiskRow[]
}

interface DiskBreakdown {
  disk_name: string
  disk_type: string
  bytes: number
  parts: number
}

interface PartitionSummary {
  partition: string
  total_bytes: number
  total_parts: number
  total_rows: number
  compressed_bytes: number
  uncompressed_bytes: number
  by_disk: DiskBreakdown[]
  by_disk_type: Record<string, number>
}

// ── Color / label helpers ────────────────────────────────────────────────────

function diskTypeColor(dt: string): string {
  const l = dt?.toLowerCase() ?? ''
  if (l === 'local') return 'bg-blue-500'
  if (l === 's3' || l === 's3_plain' || l === 's3_plain_rewritable' || l.includes('object')) return 'bg-amber-500'
  if (l === 'hdfs') return 'bg-purple-500'
  return 'bg-slate-500'
}

function diskTypeDot(dt: string): string {
  const l = dt?.toLowerCase() ?? ''
  if (l === 'local') return 'bg-blue-400'
  if (l === 's3' || l === 's3_plain' || l === 's3_plain_rewritable' || l.includes('object')) return 'bg-amber-400'
  if (l === 'hdfs') return 'bg-purple-400'
  return 'bg-slate-400'
}

function diskTypeLabel(dt: string): string {
  const l = dt?.toLowerCase() ?? ''
  if (l === 'local') return 'Local'
  if (l === 's3' || l === 's3_plain' || l === 's3_plain_rewritable' || l.includes('object')) return 'S3'
  if (l === 'hdfs') return 'HDFS'
  return dt || 'Other'
}

function isS3Type(dt: string): boolean {
  const l = dt?.toLowerCase() ?? ''
  return l === 's3' || l === 's3_plain' || l === 's3_plain_rewritable' || l.includes('object')
}

// ── Partition name formatting ────────────────────────────────────────────────

function formatPartitionName(p: string): { primary: string; sub?: string; isDefault?: boolean } {
  if (!p || p === 'tuple()') return { primary: 'tuple()', sub: 'No partition key', isDefault: true }
  // YYYYMMDD → format as date
  if (/^\d{8}$/.test(p)) {
    try {
      const d = new Date(`${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)}`)
      if (!isNaN(d.getTime()))
        return { primary: p, sub: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }
    } catch {}
  }
  // YYYYMM → month label
  if (/^\d{6}$/.test(p)) {
    try {
      const d = new Date(`${p.slice(0, 4)}-${p.slice(4, 6)}-01`)
      if (!isNaN(d.getTime()))
        return { primary: p, sub: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) }
    } catch {}
  }
  // YYYY → year
  if (/^\d{4}$/.test(p)) return { primary: p, sub: `Year ${p}` }
  return { primary: p }
}

// ── Main component ───────────────────────────────────────────────────────────

export function PartitionDistribution({ rows }: PartitionDistributionProps) {
  const [sortMode, setSortMode] = useState<'largest' | 'name'>('largest')

  const partitions = useMemo<PartitionSummary[]>(() => {
    const map = new Map<string, PartitionSummary>()
    for (const row of rows) {
      const key = row.partition
      const existing = map.get(key)
      if (existing) {
        existing.total_bytes += row.bytes
        existing.total_parts += row.parts_count
        existing.total_rows += row.rows
        existing.compressed_bytes += row.compressed_bytes
        existing.uncompressed_bytes += row.uncompressed_bytes
        existing.by_disk_type[row.disk_type] = (existing.by_disk_type[row.disk_type] ?? 0) + row.bytes
        const di = existing.by_disk.findIndex(d => d.disk_name === row.disk_name)
        if (di >= 0) {
          existing.by_disk[di].bytes += row.bytes
          existing.by_disk[di].parts += row.parts_count
        } else {
          existing.by_disk.push({ disk_name: row.disk_name, disk_type: row.disk_type, bytes: row.bytes, parts: row.parts_count })
        }
      } else {
        map.set(key, {
          partition: key,
          total_bytes: row.bytes,
          total_parts: row.parts_count,
          total_rows: row.rows,
          compressed_bytes: row.compressed_bytes,
          uncompressed_bytes: row.uncompressed_bytes,
          by_disk_type: { [row.disk_type]: row.bytes },
          by_disk: [{ disk_name: row.disk_name, disk_type: row.disk_type, bytes: row.bytes, parts: row.parts_count }],
        })
      }
    }
    return Array.from(map.values())
  }, [rows])

  const totalBytes = partitions.reduce((s, p) => s + p.total_bytes, 0)
  const totalParts = partitions.reduce((s, p) => s + p.total_parts, 0)
  const avgBytes = totalBytes / Math.max(partitions.length, 1)

  const diskTotals = useMemo<Record<string, number>>(() => {
    const dt: Record<string, number> = {}
    for (const row of rows) dt[row.disk_type] = (dt[row.disk_type] ?? 0) + row.bytes
    return dt
  }, [rows])

  const localBytes = rows.filter(r => r.disk_type === 'local').reduce((s, r) => s + r.bytes, 0)
  const s3Bytes = rows.filter(r => isS3Type(r.disk_type)).reduce((s, r) => s + r.bytes, 0)

  const sorted = useMemo(() => {
    if (sortMode === 'name') return [...partitions].sort((a, b) => a.partition.localeCompare(b.partition))
    return [...partitions].sort((a, b) => b.total_bytes - a.total_bytes)
  }, [partitions, sortMode])

  if (rows.length === 0) {
    return <div className="text-xs text-[var(--dim)] py-4 text-center">No partition data available</div>
  }

  const diskTypeEntries = Object.entries(diskTotals).sort((a, b) => b[1] - a[1])
  const hasS3 = s3Bytes > 0

  return (
    <div className="space-y-3">

      {/* Summary strip */}
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs">
        <span className="font-medium text-[var(--fg)]">{partitions.length} partition{partitions.length !== 1 ? 's' : ''}</span>
        <span className="text-[var(--dim)]">·</span>
        <span className="text-[var(--dim)]">{totalParts.toLocaleString()} parts</span>
        {localBytes > 0 && (
          <>
            <span className="text-[var(--dim)]">·</span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-blue-500 shrink-0" />
              <span className="text-blue-400 font-mono">{fmtBytes(localBytes)}</span>
              <span className="text-[var(--dim)]">local</span>
            </span>
          </>
        )}
        {s3Bytes > 0 && (
          <>
            <span className="text-[var(--dim)]">·</span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-amber-500 shrink-0" />
              <span className="text-amber-400 font-mono">{fmtBytes(s3Bytes)}</span>
              <span className="text-[var(--dim)]">s3</span>
            </span>
          </>
        )}
      </div>

      {/* Disk type stacked bar with legend */}
      {totalBytes > 0 && diskTypeEntries.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex h-3 rounded-full overflow-hidden bg-[var(--surface)] border border-[var(--border)]">
            {diskTypeEntries.map(([dt, b]) => (
              <div
                key={dt}
                className={cn('h-full transition-all', diskTypeColor(dt))}
                style={{ width: `${(b / totalBytes * 100).toFixed(1)}%` }}
                title={`${diskTypeLabel(dt)}: ${fmtBytes(b)} (${(b / totalBytes * 100).toFixed(1)}%)`}
              />
            ))}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {diskTypeEntries.map(([dt, b]) => (
              <div key={dt} className="flex items-center gap-1 text-[10px]">
                <span className={cn('w-2 h-2 rounded-sm shrink-0', diskTypeColor(dt))} />
                <span className="text-[var(--dim)]">{diskTypeLabel(dt)}</span>
                <span className="font-mono tabular-nums">{fmtBytes(b)}</span>
                <span className="text-[var(--dim)]">({(b / totalBytes * 100).toFixed(1)}%)</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Partition table */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">
            Partitions
          </span>
          <div className="flex items-center gap-1 text-[10px]">
            <span className="text-[var(--dim)]">Sort:</span>
            {(['largest', 'name'] as const).map(m => (
              <button
                key={m}
                onClick={() => setSortMode(m)}
                className={cn(
                  'px-1.5 py-0.5 rounded capitalize transition-colors',
                  sortMode === m
                    ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                    : 'text-[var(--dim)] hover:text-[var(--fg)]',
                )}
              >
                {m === 'largest' ? 'Largest' : 'Name'}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          <div className="max-h-80 overflow-auto">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 bg-[var(--surface)] z-10">
                <tr className="border-b border-[var(--border)]">
                  <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">Partition</th>
                  <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">Parts</th>
                  <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">Rows</th>
                  <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">
                    Disk breakdown
                  </th>
                  <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">Total</th>
                  <th className="px-2 py-1.5 text-[10px]">&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(p => {
                  const comprRatio = p.compressed_bytes > 0
                    ? (p.uncompressed_bytes / p.compressed_bytes).toFixed(1)
                    : null
                  const { primary, sub, isDefault } = formatPartitionName(p.partition)
                  const disksSorted = [...p.by_disk].sort((a, b) => b.bytes - a.bytes)

                  return (
                    <tr
                      key={p.partition}
                      className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)] transition-colors align-top"
                    >
                      {/* Partition name */}
                      <td className="px-2 py-1.5 font-mono text-xs min-w-[100px]">
                        <div className={cn('font-medium', isDefault ? 'text-[var(--dim)]' : 'text-[var(--fg)]')}>
                          {primary}
                        </div>
                        {sub && (
                          <div className="text-[9px] text-[var(--dim)] mt-0.5">{sub}</div>
                        )}
                        {comprRatio && (
                          <div className="text-[9px] text-[var(--dim)]">{comprRatio}× compr</div>
                        )}
                      </td>

                      {/* Parts */}
                      <td className="px-2 py-1.5 text-xs text-right tabular-nums text-[var(--dim)] align-top">
                        {p.total_parts.toLocaleString()}
                      </td>

                      {/* Rows */}
                      <td className="px-2 py-1.5 text-xs text-right tabular-nums text-[var(--dim)] align-top">
                        {p.total_rows >= 1e9
                          ? (p.total_rows / 1e9).toFixed(1) + 'B'
                          : p.total_rows >= 1e6
                            ? (p.total_rows / 1e6).toFixed(1) + 'M'
                            : p.total_rows >= 1e3
                              ? (p.total_rows / 1e3).toFixed(1) + 'K'
                              : p.total_rows.toLocaleString()}
                      </td>

                      {/* Disk breakdown — per disk name + type */}
                      <td className="px-2 py-1.5 min-w-[180px]">
                        {/* Mini stacked bar */}
                        {p.total_bytes > 0 && (
                          <div className="flex h-1.5 rounded-full overflow-hidden w-full mb-1.5 bg-[var(--surface)] border border-[var(--border)]">
                            {Object.entries(p.by_disk_type).map(([dt, b]) => (
                              <div
                                key={dt}
                                style={{ width: `${(b / p.total_bytes * 100).toFixed(1)}%` }}
                                className={diskTypeColor(dt)}
                                title={`${diskTypeLabel(dt)}: ${fmtBytes(b)}`}
                              />
                            ))}
                          </div>
                        )}
                        {/* Per-disk rows */}
                        <div className="space-y-0.5">
                          {disksSorted.map(d => {
                            const pct = p.total_bytes > 0 ? (d.bytes / p.total_bytes * 100) : 0
                            return (
                              <div key={d.disk_name} className="flex items-center gap-1.5 text-[10px]">
                                <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', diskTypeDot(d.disk_type))} />
                                <span className="font-mono text-[var(--fg)] truncate max-w-[80px]" title={d.disk_name}>
                                  {d.disk_name}
                                </span>
                                <span className={cn(
                                  'text-[9px] px-1 py-px rounded shrink-0',
                                  isS3Type(d.disk_type)
                                    ? 'bg-amber-500/15 text-amber-400'
                                    : 'bg-blue-500/15 text-blue-400',
                                )}>
                                  {diskTypeLabel(d.disk_type)}
                                </span>
                                <span className="font-mono tabular-nums text-[var(--fg)] ml-auto shrink-0">
                                  {fmtBytes(d.bytes)}
                                </span>
                                <span className="text-[var(--dim)] shrink-0 w-8 text-right">
                                  {pct.toFixed(0)}%
                                </span>
                                {hasS3 && (
                                  <span className="text-[var(--dim)] shrink-0">
                                    · {d.parts} parts
                                  </span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </td>

                      {/* Total */}
                      <td className="px-2 py-1.5 text-xs text-right tabular-nums font-medium align-top">
                        {fmtBytes(p.total_bytes)}
                      </td>

                      {/* Skew badge */}
                      <td className="px-2 py-1.5 text-xs align-top">
                        {p.total_bytes > avgBytes * 3 && partitions.length > 1 && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/30 whitespace-nowrap">
                            Skewed
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
