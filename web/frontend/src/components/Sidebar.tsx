import { useEffect, useState, useCallback } from 'react'
import {
  LayoutDashboard, Bell, BellDot, Search, GitCompareArrows, Lightbulb, TerminalSquare, FileText, Database,
  Sun, Moon, ChevronsLeft, ChevronsRight, Sparkles, RefreshCw, ScanSearch, DollarSign, Shield, PlayCircle,
  Rows3, Command, Copy, ClipboardList, SlidersHorizontal, ChevronLeft,
} from 'lucide-react'
import { useStore, type View } from '../hooks/useStore'
import { cn, scoreColor } from '../lib/utils'
import { api } from '../lib/api'
import { flashToast } from '../lib/notify'
import type { Instance } from '../types/api'

interface NavItem { view: View; label: string; icon: typeof LayoutDashboard }

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Monitoring',
    items: [
      { view: 'overview', label: 'Overview', icon: LayoutDashboard },
      { view: 'alerts', label: 'Alerts', icon: Bell },
      { view: 'history', label: 'Alert History', icon: BellDot },
      { view: 'audit', label: 'Audit Log', icon: ClipboardList },
    ],
  },
  {
    label: 'Query Analytics',
    items: [
      { view: 'explore', label: 'Explore', icon: Search },
      { view: 'compare', label: 'Compare', icon: GitCompareArrows },
      { view: 'advisor', label: 'Advisor', icon: Lightbulb },
      { view: 'scanner', label: 'Table Scanner', icon: ScanSearch },
    ],
  },
  {
    label: 'Operations',
    items: [
      { view: 'terminal', label: 'Terminal', icon: TerminalSquare },
      { view: 'runcheck', label: 'Run Checks', icon: PlayCircle },
      { view: 'maintenance', label: 'Maintenance', icon: Shield },
      { view: 'thresholds', label: 'Thresholds', icon: SlidersHorizontal },
    ],
  },
  {
    label: 'AI',
    items: [
      { view: 'analyzer', label: 'AI Analyzer', icon: Sparkles },
    ],
  },
  {
    label: 'Logs & Cost',
    items: [
      { view: 'cost', label: 'Cost Explorer', icon: DollarSign },
      { view: 'logs', label: 'App Logs', icon: FileText },
      { view: 'chlogs', label: 'CH Logs', icon: Database },
    ],
  },
]

const REFRESH_OPTIONS = [
  { label: '10s', value: 10 },
  { label: '30s', value: 30 },
  { label: '60s', value: 60 },
  { label: '5m', value: 300 },
  { label: 'Off', value: 0 },
]

interface SidebarProps {
  mobileOpen?: boolean
  onMobileClose?: () => void
}

export function Sidebar({ mobileOpen = false, onMobileClose, onOpenPalette }: SidebarProps & { onOpenPalette?: () => void }) {
  const {
    view, setView, sidebarCollapsed, setSidebarCollapsed,
    theme, toggleTheme, refreshInterval, setRefreshInterval,
    navToDetail, chatSessions, denseMode, setDenseMode,
    viewHistory, goBack,
  } = useStore()

  const hasActiveAnalysis = chatSessions.some(s =>
    s.messages.some(m => m.status === 'streaming')
  )

  const [instances, setInstances] = useState<Instance[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [copiedInst, setCopiedInst] = useState<string | null>(null)

  const fetchInstances = useCallback(async () => {
    try {
      const data = await api.overview()
      setInstances(data)
    } catch {
      setInstances([])
    }
  }, [])

  useEffect(() => { fetchInstances() }, [fetchInstances])

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

  const handleNavClick = (v: typeof view) => {
    setView(v)
    onMobileClose?.()
  }

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={onMobileClose}
        />
      )}
      <aside
        className={cn(
          'fixed top-0 left-0 h-full bg-[var(--card)] border-r border-[var(--border)] flex flex-col z-40 transition-all duration-200',
          'w-[220px]',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          collapsed ? 'md:w-14 md:translate-x-0' : 'md:w-[220px] md:translate-x-0',
        )}
      >
        {/* Logo + collapse toggle */}
        <div className={cn(
          'flex items-center gap-2.5 px-4 h-12 shrink-0 border-b border-[var(--border)]',
          collapsed && 'justify-center px-0',
        )}>
          <Database size={18} className="text-[var(--accent)] shrink-0" />
          {!collapsed && (
            <span className="font-semibold text-[13px] tracking-tight flex-1 text-[var(--text)]">
              CH Analyzer
            </span>
          )}
          <button
            onClick={() => setSidebarCollapsed(!collapsed)}
            className={cn(
              'rounded-md p-1.5 text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors shrink-0',
            )}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
          </button>
        </div>

        {/* Nav groups */}
        <nav className="flex-1 py-2 overflow-y-auto">
          {/* Back button */}
          {viewHistory.length > 0 && (
            <div className="px-2 mb-1">
              <button
                onClick={goBack}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)] rounded-lg transition-colors text-sm',
                  collapsed && 'justify-center',
                )}
                title="Go back"
              >
                <ChevronLeft size={14} className="shrink-0" />
                {!collapsed && <span className="text-xs">Back</span>}
              </button>
            </div>
          )}

          {NAV_GROUPS.map(group => (
            <div key={group.label} className="mb-1">
              {/* Group label */}
              {!collapsed && (
                <div className="px-4 pt-3 pb-1">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--dim)] opacity-70">
                    {group.label}
                  </span>
                </div>
              )}
              {collapsed && <div className="mt-2" />}

              {/* Items */}
              <div className="space-y-0.5 px-2">
                {group.items.map(item => {
                  const Icon = item.icon
                  const active = view === item.view
                  return (
                    <a
                      key={item.view}
                      href={`?view=${item.view}`}
                      onClick={e => { e.preventDefault(); handleNavClick(item.view) }}
                      className={cn(
                        'w-full flex items-center gap-2.5 rounded-md text-[12px] transition-all duration-100 no-underline',
                        collapsed ? 'justify-center px-0 py-2' : 'px-3 py-1.5',
                        active
                          ? 'bg-[var(--accent-subtle)] text-[var(--accent)] font-medium scale-[0.98]'
                          : 'text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)]',
                      )}
                      title={collapsed ? item.label : undefined}
                    >
                      <span className="relative shrink-0">
                        <Icon size={16} />
                        {item.view === 'analyzer' && hasActiveAnalysis && (
                          <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />
                        )}
                      </span>
                      {!collapsed && (
                        <span>{item.label}</span>
                      )}
                    </a>
                  )
                })}
              </div>
            </div>
          ))}

          {/* Onboarding nudge when no instances */}
          {instances.length === 0 && !collapsed && (
            <div className="mx-2 mb-2 px-3 py-2 rounded-lg border border-[var(--accent)]/20 bg-[var(--accent)]/5 text-xs text-[var(--text-muted)]">
              <div className="font-medium text-[var(--accent)] mb-0.5">No instances configured</div>
              <div className="text-[var(--dim)] leading-relaxed">
                Add ClickHouse instances to your config file and restart.
              </div>
            </div>
          )}

          {/* Instances section */}
          {instances.length > 0 && (
            <div className="mt-3 px-2">
              {!collapsed && (
                <div className="px-2 pb-1.5 flex items-center gap-1.5">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--dim)] opacity-70">Instances</span>
                  <button
                    onClick={manualRefresh}
                    className="ml-0.5 text-[var(--dim)] hover:text-[var(--text)] transition-colors"
                    title="Refresh health scores"
                  >
                    <RefreshCw size={9} className={refreshing ? 'animate-spin' : ''} />
                  </button>
                  <span className="text-[9px] text-[var(--dim)] ml-auto opacity-60">health</span>
                </div>
              )}
              {collapsed && <div className="mt-2" />}
              <div className="space-y-0.5">
                {instances.map(inst => (
                  <div key={inst.name} className="group relative">
                    <button
                      onClick={() => { navToDetail(inst.name); onMobileClose?.() }}
                      className={cn(
                        'w-full flex items-center gap-2 rounded-md text-[12px] transition-colors',
                        collapsed ? 'justify-center px-0 py-1.5' : 'px-3 py-1.5',
                        'text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)]',
                      )}
                      title={collapsed ? `${inst.name} (${inst.health_score})` : undefined}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: scoreColor(inst.health_score) }}
                      />
                      {!collapsed && (
                        <>
                          <span className="truncate flex-1 text-left" title={inst.name}>{inst.name}</span>
                          <span className="text-[11px] font-mono" style={{ color: scoreColor(inst.health_score) }}>
                            {Math.round(inst.health_score)}
                          </span>
                        </>
                      )}
                    </button>
                    {!collapsed && (
                      <button
                        onClick={e => {
                          e.stopPropagation()
                          navigator.clipboard.writeText(inst.name).then(() => {
                            setCopiedInst(inst.name)
                            flashToast('Copied', 'done', inst.name)
                            setTimeout(() => setCopiedInst(null), 1500)
                          })
                        }}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded opacity-0 group-hover:opacity-100 text-[var(--dim)] hover:text-[var(--text)] transition-opacity"
                        title="Copy name"
                      >
                        <Copy size={10} className={copiedInst === inst.name ? 'text-green-400' : ''} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </nav>

        {/* Footer */}
        <div className={cn(
          'border-t border-[var(--border)] p-2 space-y-1 shrink-0',
          collapsed && 'flex flex-col items-center gap-1',
        )}>
          {/* Refresh interval */}
          {!collapsed ? (
            <div className="flex items-center gap-1 px-1">
              <span className="text-[9px] text-[var(--dim)] uppercase tracking-wider opacity-70">Refresh</span>
              {refreshInterval > 0 && (
                <span className="flex items-center gap-1 text-[9px] text-green-400 font-medium ml-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse shrink-0" />
                  LIVE
                </span>
              )}
              <div className="flex-1" />
              {REFRESH_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setRefreshInterval(opt.value)}
                  className={cn(
                    'px-1.5 py-0.5 rounded text-[9px] transition-colors',
                    refreshInterval === opt.value
                      ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                      : 'text-[var(--dim)] hover:text-[var(--text)]',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          ) : null}

          {/* Dense mode + Cmd+K */}
          {!collapsed ? (
            <div className="flex items-center gap-1 px-1">
              <button
                onClick={() => setDenseMode(!denseMode)}
                title={denseMode ? 'Switch to comfortable layout' : 'Switch to dense layout'}
                className={cn(
                  'flex items-center gap-1.5 px-2 py-1 rounded text-[10px] transition-colors flex-1',
                  denseMode
                    ? 'text-[var(--accent)] bg-[var(--accent-subtle)]'
                    : 'text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)]',
                )}
              >
                <Rows3 size={11} /> Dense
              </button>
              <button
                onClick={onOpenPalette}
                title="Open command palette (⌘K)"
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
              >
                <Command size={11} />
                <span className="text-[9px] opacity-60">⌘K</span>
              </button>
            </div>
          ) : null}

          {/* Theme toggle */}
          {!collapsed ? (
            <button
              onClick={toggleTheme}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-[12px] text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
            >
              {theme === 'dark' ? <Sun size={14} className="shrink-0" /> : <Moon size={14} className="shrink-0" />}
              <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
          ) : (
            <button
              onClick={toggleTheme}
              className="p-2 rounded-md text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          )}
        </div>
      </aside>
    </>
  )
}
