import { useEffect, useState, useCallback } from 'react'
import {
  LayoutDashboard, Bell, Search, GitCompareArrows, Lightbulb, TerminalSquare, FileText, Database,
  Sun, Moon, ChevronsLeft, ChevronsRight, Sparkles, RefreshCw, ScanSearch,
} from 'lucide-react'
import { useStore, type View } from '../hooks/useStore'
import { cn, scoreColor } from '../lib/utils'
import { api } from '../lib/api'
import type { Instance } from '../types/api'

const NAV_ITEMS: { view: View; label: string; icon: typeof LayoutDashboard }[] = [
  { view: 'overview', label: 'Overview', icon: LayoutDashboard },
  { view: 'alerts', label: 'Alerts', icon: Bell },
  { view: 'explore', label: 'Explore', icon: Search },
  { view: 'compare', label: 'Compare', icon: GitCompareArrows },
  { view: 'advisor', label: 'Advisor', icon: Lightbulb },
  { view: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { view: 'scanner', label: 'Table Scanner', icon: ScanSearch },
  { view: 'analyzer', label: 'AI Analyzer', icon: Sparkles },
  { view: 'logs', label: 'App Logs', icon: FileText },
  { view: 'chlogs', label: 'CH Logs', icon: Database },
]

const REFRESH_OPTIONS = [
  { label: '10s', value: 10 },
  { label: '30s', value: 30 },
  { label: '60s', value: 60 },
  { label: '5m', value: 300 },
  { label: 'Off', value: 0 },
]

export function Sidebar() {
  const {
    view, setView, sidebarCollapsed, setSidebarCollapsed,
    theme, toggleTheme, refreshInterval, setRefreshInterval,
    navToDetail, chatSessions,
  } = useStore()

  const hasActiveAnalysis = chatSessions.some(s =>
    s.messages.some(m => m.status === 'streaming')
  )

  const [instances, setInstances] = useState<Instance[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const fetchInstances = useCallback(async () => {
    try {
      const data = await api.overview()
      setInstances(data)
    } catch {
      setInstances([])
    }
  }, [])

  // Initial load
  useEffect(() => { fetchInstances() }, [fetchInstances])

  // Always auto-refresh health scores every 60s (independent of global refresh setting)
  useEffect(() => {
    const id = setInterval(fetchInstances, 60_000)
    return () => clearInterval(id)
  }, [fetchInstances])

  const manualRefresh = useCallback(async () => {
    setRefreshing(true)
    await fetchInstances()
    setRefreshing(false)
  }, [fetchInstances])

  const collapsed = sidebarCollapsed

  return (
    <aside
      className={cn(
        'fixed top-0 left-0 h-full bg-[var(--card)] border-r border-[var(--border)] flex flex-col z-40 transition-all duration-200',
        collapsed ? 'w-14' : 'w-[220px]',
      )}
    >
      {/* Logo + collapse toggle */}
      <div className={cn('flex items-center gap-2 px-4 h-14 shrink-0 border-b border-[var(--border)]', collapsed && 'justify-center px-0')}>
        <Database size={20} className="text-[var(--accent)] shrink-0" />
        {!collapsed && <span className="font-semibold text-sm tracking-tight flex-1">CH Analyzer</span>}
        <button
          onClick={() => setSidebarCollapsed(!collapsed)}
          className={cn(
            'rounded-lg p-1.5 text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors shrink-0',
            collapsed && 'mt-0',
          )}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronsRight size={15} /> : <ChevronsLeft size={15} />}
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-2 overflow-y-auto">
        <div className="space-y-0.5 px-2">
          {NAV_ITEMS.map(item => {
            const Icon = item.icon
            const active = view === item.view
            return (
              <a
                key={item.view}
                href={`?view=${item.view}`}
                onClick={(e) => { e.preventDefault(); setView(item.view) }}
                className={cn(
                  'w-full flex items-center gap-2.5 rounded-lg text-sm transition-colors no-underline',
                  collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2',
                  active
                    ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                    : 'text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)]',
                )}
                title={collapsed ? item.label : undefined}
              >
                <span className="relative shrink-0">
                  <Icon size={18} />
                  {item.view === 'analyzer' && hasActiveAnalysis && (
                    <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
                  )}
                </span>
                {!collapsed && <span>{item.label}</span>}
              </a>
            )
          })}
        </div>

        {/* Instances */}
        {instances.length > 0 && (
          <div className="mt-4 px-2">
            {!collapsed && (
              <div className="px-3 pb-1.5 flex items-center gap-1">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--dim)]">Instances</span>
                <button
                  onClick={manualRefresh}
                  className="ml-1 text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
                  title="Refresh health scores"
                >
                  <RefreshCw size={9} className={refreshing ? 'animate-spin' : ''} />
                </button>
                <span className="text-[10px] text-[var(--dim)] ml-auto">health</span>
              </div>
            )}
            <div className="space-y-0.5">
              {instances.map(inst => (
                <button
                  key={inst.name}
                  onClick={() => navToDetail(inst.name)}
                  className={cn(
                    'w-full flex items-center gap-2 rounded-lg text-sm transition-colors',
                    collapsed ? 'justify-center px-0 py-2' : 'px-3 py-1.5',
                    'text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)]',
                  )}
                  title={collapsed ? `${inst.name} (${inst.health_score})` : undefined}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: scoreColor(inst.health_score) }}
                  />
                  {!collapsed && (
                    <>
                      <span className="truncate flex-1 text-left">{inst.name}</span>
                      <span className="text-xs font-mono" style={{ color: scoreColor(inst.health_score) }}>
                        {Math.round(inst.health_score)}
                      </span>
                    </>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </nav>

      {/* Footer */}
      <div className={cn('border-t border-[var(--border)] p-2 space-y-1 shrink-0', collapsed && 'flex flex-col items-center gap-1')}>
        {/* Refresh interval */}
        {!collapsed ? (
          <div className="flex items-center gap-1 px-1">
            <span className="text-[10px] text-[var(--dim)] uppercase tracking-wider mr-auto">Refresh</span>
            {REFRESH_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setRefreshInterval(opt.value)}
                className={cn(
                  'px-1.5 py-0.5 rounded text-[10px] transition-colors',
                  refreshInterval === opt.value
                    ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                    : 'text-[var(--dim)] hover:text-[var(--text)]',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        ) : null}

        {/* Theme toggle — full-width button when expanded for discoverability */}
        {!collapsed ? (
          <button
            onClick={toggleTheme}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
          >
            {theme === 'dark' ? <Sun size={16} className="shrink-0" /> : <Moon size={16} className="shrink-0" />}
            <span className="text-xs">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>
        ) : (
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        )}

      </div>
    </aside>
  )
}
