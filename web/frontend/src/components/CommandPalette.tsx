import { useState, useEffect, useRef, useMemo, type ReactNode } from 'react'
import {
  Search, LayoutDashboard, Bell, BellDot, GitCompareArrows, Lightbulb, TerminalSquare,
  FileText, Database, Sparkles, ScanSearch, DollarSign, Shield, PlayCircle, Compass,
  ChevronRight, Zap, Moon, Sun, Rows3,
} from 'lucide-react'
import { useStore, type View } from '../hooks/useStore'
import { cn } from '../lib/utils'

interface PaletteItem {
  id: string
  label: string
  sublabel?: string
  category: string
  action: () => void
  icon: ReactNode
  keywords?: string
}

const VIEW_ITEMS: Array<{ view: View; label: string; icon: ReactNode; category?: string }> = [
  { view: 'overview',    label: 'Overview',          icon: <LayoutDashboard size={14} /> },
  { view: 'alerts',      label: 'Alerts',             icon: <Bell size={14} /> },
  { view: 'history',     label: 'Alert History',      icon: <BellDot size={14} /> },
  { view: 'explore',     label: 'Explore Queries',    icon: <Search size={14} /> },
  { view: 'compare',     label: 'Compare Nodes',      icon: <GitCompareArrows size={14} /> },
  { view: 'advisor',     label: 'Advisor',            icon: <Lightbulb size={14} /> },
  { view: 'scanner',     label: 'Table Scanner',      icon: <ScanSearch size={14} /> },
  { view: 'terminal',    label: 'Terminal',           icon: <TerminalSquare size={14} /> },
  { view: 'runcheck',    label: 'Run Checks',         icon: <PlayCircle size={14} /> },
  { view: 'maintenance', label: 'Maintenance',        icon: <Shield size={14} /> },
  { view: 'analyzer',   label: 'AI Analyzer',        icon: <Sparkles size={14} /> },
  { view: 'cost',        label: 'Cost Explorer',      icon: <DollarSign size={14} /> },
  { view: 'logs',        label: 'App Logs',           icon: <FileText size={14} /> },
  { view: 'chlogs',      label: 'ClickHouse Logs',    icon: <Database size={14} /> },
  { view: 'discover',    label: 'Feature Guide',      icon: <Compass size={14} /> },
]

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    setView, navToDetail, instances, refreshInterval, setRefreshInterval,
    theme, toggleTheme, denseMode, setDenseMode,
  } = useStore()

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const allItems = useMemo<PaletteItem[]>(() => [
    // Views
    ...VIEW_ITEMS.map(v => ({
      id: `view-${v.view}`,
      label: v.label,
      sublabel: 'Navigate',
      category: 'Views',
      action: () => setView(v.view),
      icon: v.icon,
    })),
    // Instances
    ...instances.map(name => ({
      id: `inst-${name}`,
      label: name,
      sublabel: 'Go to instance detail',
      category: 'Instances',
      action: () => navToDetail(name),
      icon: <Database size={14} />,
    })),
    // Quick actions
    {
      id: 'refresh-off', label: 'Auto-refresh: Off', sublabel: refreshInterval === 0 ? '● active' : '',
      category: 'Actions', action: () => setRefreshInterval(0), icon: <Zap size={14} />, keywords: 'refresh interval',
    },
    {
      id: 'refresh-30', label: 'Auto-refresh: 30s', sublabel: refreshInterval === 30 ? '● active' : '',
      category: 'Actions', action: () => setRefreshInterval(30), icon: <Zap size={14} />, keywords: 'refresh interval',
    },
    {
      id: 'refresh-60', label: 'Auto-refresh: 60s', sublabel: refreshInterval === 60 ? '● active' : '',
      category: 'Actions', action: () => setRefreshInterval(60), icon: <Zap size={14} />, keywords: 'refresh interval',
    },
    {
      id: 'refresh-5m', label: 'Auto-refresh: 5m', sublabel: refreshInterval === 300 ? '● active' : '',
      category: 'Actions', action: () => setRefreshInterval(300), icon: <Zap size={14} />, keywords: 'refresh interval',
    },
    {
      id: 'theme', label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`,
      category: 'Actions', action: toggleTheme,
      icon: theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />, keywords: 'theme dark light',
    },
    {
      id: 'dense', label: denseMode ? 'Switch to comfortable layout' : 'Switch to dense layout',
      category: 'Actions', action: () => setDenseMode(!denseMode),
      icon: <Rows3 size={14} />, keywords: 'dense compact layout rows',
    },
  ], [setView, navToDetail, instances, refreshInterval, setRefreshInterval, theme, toggleTheme, denseMode, setDenseMode])

  const filtered = useMemo(() => {
    if (!query.trim()) return allItems
    const q = query.trim().toLowerCase()
    return allItems.filter(item =>
      item.label.toLowerCase().includes(q) ||
      item.sublabel?.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q) ||
      item.keywords?.toLowerCase().includes(q)
    )
  }, [allItems, query])

  // Group by category
  const grouped = useMemo(() => {
    const map = new Map<string, PaletteItem[]>()
    for (const item of filtered) {
      const arr = map.get(item.category) ?? []
      arr.push(item)
      map.set(item.category, arr)
    }
    return map
  }, [filtered])

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [open])

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // Keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!open) return
      if (e.key === 'ArrowDown' || (e.key === 'j' && !e.metaKey && !e.ctrlKey && !(e.target instanceof HTMLInputElement))) {
        e.preventDefault(); setActiveIndex(i => Math.min(filtered.length - 1, i + 1))
      } else if (e.key === 'ArrowUp' || (e.key === 'k' && !e.metaKey && !e.ctrlKey && !(e.target instanceof HTMLInputElement))) {
        e.preventDefault(); setActiveIndex(i => Math.max(0, i - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = filtered[activeIndex]
        if (item) { item.action(); onClose() }
      } else if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, filtered, activeIndex, onClose])

  if (!open) return null

  let globalIdx = 0

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] px-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-lg bg-[var(--card)] rounded-xl border border-[var(--border)] shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
          <Search size={15} className="text-[var(--dim)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIndex(0) }}
            placeholder="Search views, instances, actions…"
            className="flex-1 bg-transparent text-[13px] placeholder-[var(--dim)] focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-[var(--dim)] hover:text-[var(--text)] text-[10px]">✕</button>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[min(360px,60vh)] overflow-y-auto">
          {filtered.length === 0 && (
            <div className="text-center py-10 text-[var(--dim)] text-sm">No results for "{query}"</div>
          )}
          {[...grouped.entries()].map(([cat, items]) => (
            <div key={cat}>
              <div className="px-4 pt-3 pb-1 text-[10px] font-semibold text-[var(--dim)] uppercase tracking-[0.1em]">
                {cat}
              </div>
              {items.map(item => {
                const idx = globalIdx++
                const active = idx === activeIndex
                return (
                  <button
                    key={item.id}
                    data-idx={idx}
                    onClick={() => { item.action(); onClose() }}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={cn(
                      'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
                      active ? 'bg-[var(--accent-subtle)]' : 'hover:bg-[var(--hover)]',
                    )}
                  >
                    <span className={cn('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--dim)]')}>
                      {item.icon}
                    </span>
                    <span className={cn('flex-1 text-[13px]', active ? 'text-[var(--accent)]' : 'text-[var(--text)]')}>
                      {item.label}
                    </span>
                    {item.sublabel && item.sublabel !== 'Navigate' && (
                      <span className="text-[11px] text-[var(--dim)] shrink-0">{item.sublabel}</span>
                    )}
                    {active && <ChevronRight size={12} className="text-[var(--accent)] shrink-0" />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 px-4 py-2.5 border-t border-[var(--border)] text-[10px] text-[var(--dim)]">
          <span className="flex items-center gap-1">
            <kbd className="bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5">↑↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5">↵</kbd>
            select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5">Esc</kbd>
            close
          </span>
          <span className="ml-auto flex items-center gap-1">
            <kbd className="bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5">⌘K</kbd>
          </span>
        </div>
      </div>
    </div>
  )
}
