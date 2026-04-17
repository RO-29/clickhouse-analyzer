import { useState, useMemo } from 'react'
import { cn, fmtBytes } from '../lib/utils'
import type { PartitionDiskRow } from '../types/api'

interface PartitionDistributionProps {
  rows: PartitionDiskRow[]
}

interface PartitionSummary {
  partition: string
  total_bytes: number
  total_parts: number
  total_rows: number
  compressed_bytes: number
  uncompressed_bytes: number
  by_disk_type: Record<string, number>  // disk_type -> bytes
}

function diskTypeColor(dt: string): string {
  const l = dt?.toLowerCase() ?? ''
  if (l === 'local') return 'bg-blue-500'
  if (l === 's3' || l === 's3_plain' || l === 's3_plain_rewritable' || l.includes('object')) return 'bg-amber-500'
  if (l === 'hdfs') return 'bg-purple-500'
  return 'bg-slate-500'
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

export function PartitionDistribution({ rows }: PartitionDistributionProps) {
  const [sortMode, setSortMode] = useState<'largest' | 'name'>('largest')

  // Group rows by partition
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
      } else {
        map.set(key, {
          partition: key,
          total_bytes: row.bytes,
          total_parts: row.parts_count,
          total_rows: row.rows,
          compressed_bytes: row.compressed_bytes,
          uncompressed_bytes: row.uncompressed_bytes,
          by_disk_type: { [row.disk_type]: row.bytes },
        })
      }
    }
    return Array.from(map.values())
  }, [rows])

  const totalBytes = partitions.reduce((s, p) => s + p.total_bytes, 0)
  const totalParts = partitions.reduce((s, p) => s + p.total_parts, 0)
  const avgBytes = totalBytes / Math.max(partitions.length, 1)

  // Disk type totals (across all partitions)
  const diskTotals = useMemo<Record<string, number>>(() => {
    const dt: Record<string, number> = {}
    for (const row of rows) {
      dt[row.disk_type] = (dt[row.disk_type] ?? 0) + row.bytes
    }
    return dt
  }, [rows])

  const localBytes = rows
    .filter(r => r.disk_type === 'local')
    .reduce((s, r) => s + r.bytes, 0)
  const s3Bytes = rows
    .filter(r => isS3Type(r.disk_type))
    .reduce((s, r) => s + r.bytes, 0)

  const sorted = useMemo(() => {
    if (sortMode === 'name') {
      return [...partitions].sort((a, b) => a.partition.localeCompare(b.partition))
    }
    return [...partitions].sort((a, b) => b.total_bytes - a.total_bytes)
  }, [partitions, sortMode])

  if (rows.length === 0) {
    return (
      <div className="text-xs text-[var(--dim)] py-4 text-center">No partition data available</div>
    )
  }

  const diskTypeEntries = Object.entries(diskTotals).sort((a, b) => b[1] - a[1])

  return (
    <div className="space-y-3">
      {/* Summary strip */}
      <div className="text-xs text-[var(--dim)] flex flex-wrap gap-x-3 gap-y-1">
        <span className="text-[var(--fg)]">{partitions.length} partitions</span>
        <span>·</span>
        <span>{totalParts.toLocaleString()} parts</span>
        {localBytes > 0 && (
          <>
            <span>·</span>
            <span className="text-blue-400">{fmtBytes(localBytes)} local</span>
          </>
        )}
        {s3Bytes > 0 && (
          <>
            <span>·</span>
            <span className="text-amber-400">{fmtBytes(s3Bytes)} s3</span>
          </>
        )}
      </div>

      {/* Disk type stacked bar */}
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
            <button
              onClick={() => setSortMode('largest')}
              className={cn(
                'px-1.5 py-0.5 rounded transition-colors',
                sortMode === 'largest'
                  ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                  : 'text-[var(--dim)] hover:text-[var(--fg)]',
              )}
            >
              Largest
            </button>
            <button
              onClick={() => setSortMode('name')}
              className={cn(
                'px-1.5 py-0.5 rounded transition-colors',
                sortMode === 'name'
                  ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                  : 'text-[var(--dim)] hover:text-[var(--fg)]',
              )}
            >
              Name
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          <div className="max-h-64 overflow-auto">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 bg-[var(--surface)] z-10">
                <tr className="border-b border-[var(--border)]">
                  <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">
                    Partition
                  </th>
                  <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">
                    Parts
                  </th>
                  <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">
                    Rows
                  </th>
                  <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-blue-400/70">
                    Local
                  </th>
                  <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-amber-400/70">
                    S3
                  </th>
                  <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">
                    Total
                  </th>
                  <th className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">
                    &nbsp;
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(p => {
                  const comprRatio = p.compressed_bytes > 0
                    ? (p.uncompressed_bytes / p.compressed_bytes).toFixed(1)
                    : null

                  return (
                    <tr
                      key={p.partition}
                      className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)] transition-colors"
                    >
                      <td className="px-2 py-1 font-mono text-xs">
                        <div>{p.partition || '(default)'}</div>
                        {comprRatio && (
                          <div className="text-[9px] text-[var(--dim)]">{comprRatio}× compr</div>
                        )}
                      </td>
                      <td className="px-2 py-1 text-xs text-right tabular-nums text-[var(--dim)]">
                        {p.total_parts.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-xs text-right tabular-nums text-[var(--dim)]">
                        {p.total_rows >= 1e9
                          ? (p.total_rows / 1e9).toFixed(1) + 'B'
                          : p.total_rows >= 1e6
                            ? (p.total_rows / 1e6).toFixed(1) + 'M'
                            : p.total_rows >= 1e3
                              ? (p.total_rows / 1e3).toFixed(1) + 'K'
                              : p.total_rows.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-xs text-right tabular-nums text-blue-400">
                        {fmtBytes(p.by_disk_type['local'] ?? 0)}
                      </td>
                      <td className="px-2 py-1 text-xs text-right tabular-nums text-amber-400">
                        {(() => {
                          const s3 = Object.entries(p.by_disk_type)
                            .filter(([dt]) => isS3Type(dt))
                            .reduce((s, [, b]) => s + b, 0)
                          return s3 > 0 ? fmtBytes(s3) : <span className="text-[var(--dim)]">—</span>
                        })()}
                      </td>
                      <td className="px-2 py-1 text-xs text-right tabular-nums">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* mini stacked bar */}
                          {totalBytes > 0 && (
                            <div className="flex h-1.5 rounded-full overflow-hidden w-16 bg-[var(--surface)] border border-[var(--border)] shrink-0">
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
                          {fmtBytes(p.total_bytes)}
                        </div>
                      </td>
                      <td className="px-2 py-1 text-xs">
                        {p.total_bytes > avgBytes * 3 && (
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
