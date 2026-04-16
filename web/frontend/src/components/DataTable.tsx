import { useState, type ReactNode } from 'react'
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight as ChevronRightIcon, Sparkles } from 'lucide-react'
import { cn } from '../lib/utils'

interface Column {
  key: string
  label: string
  format?: (v: any, row: Record<string, any>) => ReactNode
  className?: string
  tooltip?: string
}

interface DataTableProps {
  columns: Column[]
  data: Record<string, any>[]
  maxHeight?: string
  onRowClick?: (row: Record<string, any>, i: number) => void
  onRowAnalyze?: (row: Record<string, any>) => void
  /** @deprecated use data instead */
  rows?: Record<string, any>[]
  maxRows?: number
  pageSize?: number
  emptyText?: string
}

export function DataTable({
  columns,
  data,
  maxHeight,
  onRowClick,
  onRowAnalyze,
  rows,
  maxRows,
  pageSize,
  emptyText = 'No data',
}: DataTableProps) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortAsc, setSortAsc] = useState(true)
  const [hoveredRow, setHoveredRow] = useState<number | null>(null)
  const [page, setPage] = useState(0)

  const source = Array.isArray(data) ? data : Array.isArray(rows) ? rows : []

  const handleSort = (key: string) => {
    setPage(0)
    if (sortKey === key) {
      setSortAsc(!sortAsc)
    } else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  let sorted = [...source]
  if (sortKey) {
    sorted.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return sortAsc ? av - bv : bv - av
      const sa = String(av).toLowerCase()
      const sb = String(bv).toLowerCase()
      return sortAsc ? sa.localeCompare(sb) : sb.localeCompare(sa)
    })
  }

  const totalPages = pageSize ? Math.ceil(sorted.length / pageSize) : 1
  const clampedPage = Math.min(page, Math.max(0, totalPages - 1))
  const visible = pageSize
    ? sorted.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize)
    : maxRows ? sorted.slice(0, maxRows) : sorted

  if (source.length === 0) {
    return <div className="text-sm text-[var(--dim)] py-6 text-center">{emptyText}</div>
  }

  return (
    <div className="overflow-auto" style={{ maxHeight: maxHeight ?? undefined }}>
      <table className="w-full min-w-[500px] text-sm">
        <thead className="sticky top-0 bg-[var(--surface)]">
          <tr className="border-b border-[var(--border)]">
            {columns.map(col => (
              <th
                key={col.key}
                title={col.tooltip}
                className={cn(
                  'text-left py-2 px-3 text-xs font-medium uppercase tracking-wider text-[var(--dim)] cursor-pointer select-none hover:text-[var(--text)] transition-colors',
                  col.className,
                  col.tooltip && 'underline decoration-dotted decoration-[var(--dim)]',
                )}
                onClick={() => handleSort(col.key)}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {sortKey === col.key && (
                    sortAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />
                  )}
                </span>
              </th>
            ))}
            {/* Spacer column for the analyze button */}
            {onRowAnalyze && <th className="w-8" />}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, i) => (
            <tr
              key={i}
              className={cn(
                'border-b border-[var(--border)] last:border-0 transition-colors relative',
                (onRowClick || onRowAnalyze) && 'cursor-pointer hover:bg-[var(--accent)]/5',
              )}
              onClick={() => onRowClick?.(row, i)}
              onMouseEnter={() => setHoveredRow(i)}
              onMouseLeave={() => setHoveredRow(null)}
            >
              {columns.map(col => (
                <td key={col.key} className={cn('py-2 px-3 font-mono text-xs', col.className)}>
                  {col.format ? col.format(row[col.key], row) : String(row[col.key] ?? '')}
                </td>
              ))}
              {onRowAnalyze && (
                <td className="py-2 px-1 w-8 text-right">
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      onRowAnalyze(row)
                    }}
                    className={cn(
                      'p-1 rounded text-purple-400 hover:bg-purple-500/20 transition-all',
                      hoveredRow === i ? 'opacity-100' : 'opacity-0',
                    )}
                    title="Analyze with AI"
                  >
                    <Sparkles size={12} />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {pageSize && totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-[var(--border)]">
          <span className="text-xs text-[var(--dim)]">
            {clampedPage * pageSize + 1}–{Math.min((clampedPage + 1) * pageSize, sorted.length)} of {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={clampedPage === 0}
              className="p-1 rounded hover:bg-[var(--hover)] disabled:opacity-30 transition-colors"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-xs text-[var(--dim)] px-1">{clampedPage + 1} / {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={clampedPage >= totalPages - 1}
              className="p-1 rounded hover:bg-[var(--hover)] disabled:opacity-30 transition-colors"
            >
              <ChevronRightIcon size={14} />
            </button>
          </div>
        </div>
      )}
      {maxRows && !pageSize && source.length > maxRows && (
        <div className="text-xs text-[var(--dim)] py-2 text-center">
          Showing {maxRows} of {source.length} rows
        </div>
      )}
    </div>
  )
}
