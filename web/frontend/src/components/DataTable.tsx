import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight as ChevronRightIcon, Sparkles, Settings2 } from 'lucide-react'
import { cn } from '../lib/utils'

export interface Column {
  key: string
  label: string
  format?: (v: any, row: Record<string, any>) => ReactNode
  className?: string
  tooltip?: string
  /** If false, this column cannot be hidden (default: true) */
  hideable?: boolean
}

export interface ContextMenuItem {
  label: string
  icon?: ReactNode
  action: () => void
  danger?: boolean
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
  /** Compact row padding */
  dense?: boolean
  /** Show gear icon to toggle column visibility */
  showColumnToggle?: boolean
  /** localStorage key for persisting hidden columns and sort state (requires showColumnToggle for columns) */
  storageKey?: string
  /** Right-click context menu items per row */
  contextMenu?: (row: Record<string, any>) => ContextMenuItem[]
  /** Enable j/k keyboard navigation when container is focused */
  keyboardNav?: boolean
  /** Column keys to show on mobile (< 768px); all others are hidden */
  mobileColumns?: string[]
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
  dense = false,
  showColumnToggle = false,
  storageKey,
  contextMenu,
  keyboardNav = false,
  mobileColumns,
}: DataTableProps) {
  // Restore sort from localStorage on mount
  const [sortKey, setSortKey] = useState<string | null>(() => {
    if (storageKey) {
      try {
        const s = JSON.parse(localStorage.getItem(`${storageKey}-sort`) ?? 'null')
        if (s?.col) return s.col
      } catch {}
    }
    return null
  })
  const [sortAsc, setSortAsc] = useState<boolean>(() => {
    if (storageKey) {
      try {
        const s = JSON.parse(localStorage.getItem(`${storageKey}-sort`) ?? 'null')
        if (s?.dir) return s.dir === 'asc'
      } catch {}
    }
    return true
  })
  const [hoveredRow, setHoveredRow] = useState<number | null>(null)
  const [focusedRow, setFocusedRow] = useState<number | null>(null)
  const [page, setPage] = useState(0)
  const [showColMenu, setShowColMenu] = useState(false)
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    if (storageKey) {
      try {
        const s = localStorage.getItem(`ch-cols-${storageKey}`)
        if (s) return new Set(JSON.parse(s))
      } catch {}
    }
    return new Set<string>()
  })
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; row: Record<string, any> } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const colMenuRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLDivElement>(null)

  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768)

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  const source = Array.isArray(data) ? data : Array.isArray(rows) ? rows : []
  const visibleColumns = columns.filter(c => !hiddenCols.has(c.key))

  // Persist sort to localStorage whenever it changes
  const persistSort = useCallback((col: string | null, dir: 'asc' | 'desc') => {
    if (storageKey && col) {
      try { localStorage.setItem(`${storageKey}-sort`, JSON.stringify({ col, dir })) } catch {}
    }
  }, [storageKey])

  const handleSort = (key: string) => {
    setPage(0)
    if (sortKey === key) {
      const newDir = !sortAsc
      setSortAsc(newDir)
      persistSort(key, newDir ? 'asc' : 'desc')
    } else {
      setSortKey(key)
      setSortAsc(true)
      persistSort(key, 'asc')
    }
  }

  let sorted = [...source]
  if (sortKey) {
    sorted.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return sortAsc ? av - bv : bv - av
      return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
  }

  const totalPages = pageSize ? Math.ceil(sorted.length / pageSize) : 1
  const clampedPage = Math.min(page, Math.max(0, totalPages - 1))
  const visible = pageSize
    ? sorted.slice(clampedPage * pageSize, (clampedPage + 1) * pageSize)
    : maxRows ? sorted.slice(0, maxRows) : sorted

  // Keyboard navigation
  useEffect(() => {
    if (!keyboardNav) return
    const handler = (e: KeyboardEvent) => {
      if (document.activeElement && !containerRef.current?.contains(document.activeElement)) return
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusedRow(r => {
          const next = r === null ? 0 : Math.min(visible.length - 1, r + 1)
          return next
        })
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusedRow(r => r === null ? 0 : Math.max(0, r - 1))
      } else if (e.key === 'Enter' && focusedRow !== null) {
        e.preventDefault()
        onRowClick?.(visible[focusedRow], focusedRow)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [keyboardNav, visible, focusedRow, onRowClick])

  // Close column menu + context menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (showColMenu && colMenuRef.current && !colMenuRef.current.contains(e.target as Node)) {
        setShowColMenu(false)
      }
      if (ctxMenu) setCtxMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showColMenu, ctxMenu])

  const toggleColumn = useCallback((key: string) => {
    setHiddenCols(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      if (storageKey) {
        try { localStorage.setItem(`ch-cols-${storageKey}`, JSON.stringify([...next])) } catch {}
      }
      return next
    })
  }, [storageKey])

  const rowPy = dense ? 'py-1' : 'py-1.5'

  if (source.length === 0) {
    return <div className="text-xs text-[var(--dim)] py-8 text-center">{emptyText}</div>
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      tabIndex={keyboardNav ? 0 : undefined}
      onFocus={() => keyboardNav && focusedRow === null && setFocusedRow(0)}
    >
      <div className="relative">
        {isMobile && (
          <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-[var(--card)] to-transparent pointer-events-none z-10" />
        )}
      <div className="overflow-x-auto" ref={tableRef} style={{ maxHeight: maxHeight ?? undefined }}>
      <table className="w-full min-w-[500px]">
        <thead className="sticky top-0 bg-[var(--card)] z-10">
          <tr className="border-b border-[var(--border)]">
            {visibleColumns.map(col => {
              const isHidden = isMobile && mobileColumns != null && !mobileColumns.includes(col.key)
              return (
              <th
                key={col.key}
                title={col.tooltip}
                className={cn(
                  'text-left py-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-[var(--dim)] cursor-pointer select-none hover:text-[var(--text)] transition-colors whitespace-nowrap',
                  col.className,
                  col.tooltip && 'underline decoration-dotted decoration-[var(--dim)]',
                  isHidden && 'hidden',
                )}
                onClick={() => handleSort(col.key)}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {sortKey === col.key && (sortAsc ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
                </span>
              </th>
              )
            })}
            {/* Column toggle + analyze header */}
            {(onRowAnalyze || showColumnToggle) && (
              <th className="py-2 px-1 text-right">
                {showColumnToggle && (
                  <div className="relative inline-block" ref={colMenuRef}>
                    <button
                      onClick={e => { e.stopPropagation(); setShowColMenu(v => !v) }}
                      className="inline-flex items-center gap-0.5 px-1.5 py-1 rounded text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--hover)] transition-colors"
                      title="Toggle columns"
                    >
                      <Settings2 size={11} />
                      <span className="text-[10px] ml-0.5 hidden sm:inline">Columns</span>
                    </button>
                    {showColMenu && (
                      <div className="absolute right-0 top-7 z-20 bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-xl py-1 min-w-[160px]">
                        <div className="px-3 py-1.5 text-[10px] font-semibold text-[var(--dim)] uppercase tracking-wider border-b border-[var(--border)] mb-1">
                          Columns
                        </div>
                        {columns.filter(c => c.hideable !== false).map(col => {
                          const autoHiddenOnMobile = isMobile && mobileColumns != null && !mobileColumns.includes(col.key)
                          return (
                          <label
                            key={col.key}
                            className="flex items-center gap-2 px-3 py-1.5 text-[12px] cursor-pointer hover:bg-[var(--hover)] transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={!hiddenCols.has(col.key)}
                              onChange={() => toggleColumn(col.key)}
                              className="accent-[var(--accent)]"
                              disabled={autoHiddenOnMobile}
                            />
                            <span className={autoHiddenOnMobile ? 'text-[var(--dim)]' : ''}>
                              {col.label}
                              {autoHiddenOnMobile && <span className="ml-1 text-[10px] text-[var(--dim)]">(mobile)</span>}
                            </span>
                          </label>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, i) => {
            const isFocused = keyboardNav && focusedRow === i
            return (
              <tr
                key={i}
                className={cn(
                  'group/row border-b border-[var(--border)] last:border-0 transition-colors relative',
                  i % 2 === 1 && 'bg-[var(--surface)]/40',
                  (onRowClick || onRowAnalyze) && 'cursor-pointer hover:bg-[var(--accent-subtle)]',
                  isFocused && 'ring-1 ring-inset ring-[var(--accent)]/50 bg-[var(--accent-subtle)]',
                )}
                onClick={() => { onRowClick?.(row, i); setFocusedRow(i) }}
                onMouseEnter={() => setHoveredRow(i)}
                onMouseLeave={() => setHoveredRow(null)}
                onContextMenu={contextMenu ? (e) => {
                  e.preventDefault()
                  setCtxMenu({ x: e.clientX, y: e.clientY, row })
                } : undefined}
              >
                {visibleColumns.map(col => {
                  const isHidden = isMobile && mobileColumns != null && !mobileColumns.includes(col.key)
                  return (
                  <td key={col.key} className={cn(`${rowPy} px-3 font-mono text-[11px]`, col.className, isHidden && 'hidden')}>
                    {col.format ? col.format(row[col.key], row) : String(row[col.key] ?? '')}
                  </td>
                  )
                })}
                {(onRowAnalyze || showColumnToggle) && (
                  <td className={`${rowPy} px-1 w-8 text-right`}>
                    {onRowAnalyze && (
                      <button
                        onClick={e => { e.stopPropagation(); onRowAnalyze(row) }}
                        className={cn(
                          'p-1 rounded text-[var(--accent)] hover:bg-[var(--accent-subtle)] transition-all',
                          (hoveredRow === i || isFocused) ? 'opacity-100' : 'opacity-0',
                        )}
                        title="Analyze with AI"
                      >
                        <Sparkles size={11} />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>{/* end overflow-x-auto scroll wrapper */}
      </div>{/* end relative fade wrapper */}

      {/* Pagination */}
      {pageSize && totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-[var(--border)]">
          <span className="text-[11px] text-[var(--dim)]">
            {clampedPage * pageSize + 1}–{Math.min((clampedPage + 1) * pageSize, sorted.length)} of {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={clampedPage === 0}
              className="p-1 rounded hover:bg-[var(--hover)] disabled:opacity-30 transition-colors"
            >
              <ChevronLeft size={13} />
            </button>
            <span className="text-[11px] text-[var(--dim)] px-1.5">{clampedPage + 1} / {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={clampedPage >= totalPages - 1}
              className="p-1 rounded hover:bg-[var(--hover)] disabled:opacity-30 transition-colors"
            >
              <ChevronRightIcon size={13} />
            </button>
          </div>
        </div>
      )}

      {/* Row count footer — shown when no pagination is active */}
      {!pageSize && source.length > 0 && (
        <div className="flex items-center px-3 py-1.5 border-t border-[var(--border)] text-[10px] text-[var(--dim)] bg-[var(--surface)]">
          <span>
            {maxRows && source.length > maxRows
              ? `Showing ${maxRows} of ${source.length} rows`
              : `${source.length} row${source.length !== 1 ? 's' : ''}`
            }
          </span>
        </div>
      )}

      {/* Right-click context menu */}
      {ctxMenu && contextMenu && (() => {
        const items = contextMenu(ctxMenu.row)
        if (!items.length) return null
        return (
          <div
            className="fixed z-50 bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-2xl py-1 min-w-[180px]"
            style={{ top: ctxMenu.y, left: ctxMenu.x }}
            onClick={e => e.stopPropagation()}
          >
            {items.map((item, i) => (
              <div key={i}>
                {item.danger && i > 0 && <div className="my-1 border-t border-[var(--border)]" />}
                <button
                  onClick={() => { item.action(); setCtxMenu(null) }}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 text-[12px] text-left transition-colors',
                    item.danger
                      ? 'text-red-400 hover:bg-red-500/10'
                      : 'text-[var(--text)] hover:bg-[var(--hover)]',
                  )}
                >
                  {item.icon && <span className="text-[var(--dim)] shrink-0">{item.icon}</span>}
                  {item.label}
                </button>
              </div>
            ))}
          </div>
        )
      })()}
    </div>
  )
}
