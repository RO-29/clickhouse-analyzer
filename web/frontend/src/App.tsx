import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import { StoreProvider, useStore } from './hooks/useStore'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { CommandPalette } from './components/CommandPalette'
import Dashboard from './views/Dashboard'
import Overview from './views/Overview'
import Detail from './views/Detail'
import Alerts from './views/Alerts'
import Explore from './views/Explore'
import Compare from './views/Compare'
import Advisor from './views/Advisor'
import Terminal from './views/Terminal'
import AppLogs from './views/AppLogs'
import CHLogs from './views/CHLogs'
import ChatAnalyzer from './views/ChatAnalyzer'
import TableScanner from './views/TableScanner'
import CostExplorer from './views/CostExplorer'
import Maintenance from './views/Maintenance'
import AlertHistory from './views/AlertHistory'
import RunCheck from './views/RunCheck'
import Discover from './views/Discover'
import AuditLog from './views/AuditLog'
import ThresholdEditor from './views/ThresholdEditor'
import { TableDetail } from './components/TableDetail'
import { AIAnalysisPanel } from './components/AIAnalysisPanel'
import { NotificationToasts } from './components/NotificationToasts'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useAIAnalysis, PANEL_EXPANDED_HEIGHT, PANEL_COLLAPSED_HEIGHT } from './hooks/useAIAnalysis'
import { cn } from './lib/utils'
import { api } from './lib/api'

function Layout() {
  const { view, refreshInterval, sidebarCollapsed, setInstances, tableDetail, closeTableDetail, selectedInstance, setAuthExpired } = useStore()
  const intervalRef = useRef<number>(0)
  const [tick, setTick] = useState(0)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // Mount ChatAnalyzer once on first visit and keep it alive (preserves session state)
  const [analyzerMounted, setAnalyzerMounted] = useState(view === 'analyzer')
  const {
    sessions: aiSessions,
    activeSessionId: aiActiveSessionId,
    setActiveSessionId: setAiActiveSession,
    isOpen: aiOpen,
    setIsOpen: setAiOpen,
    analyze: aiAnalyze,
    followUp: aiFollowUp,
    newSession: aiNewSession,
    deleteSession: aiDeleteSession,
  } = useAIAnalysis(selectedInstance)
  const aiSpacerHeight = aiOpen ? PANEL_EXPANDED_HEIGHT : PANEL_COLLAPSED_HEIGHT

  // Cmd+K → open command palette; ? → shortcuts overlay
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen(o => !o)
      }
      if (
        e.key === '?' &&
        !e.ctrlKey && !e.metaKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault()
        setShortcutsOpen(o => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Listen for shortcuts-open event dispatched by TopBar ? button
  useEffect(() => {
    const handler = () => setShortcutsOpen(o => !o)
    window.addEventListener('ch-open-shortcuts', handler)
    return () => window.removeEventListener('ch-open-shortcuts', handler)
  }, [])

  // Warn before unload/refresh if any analysis is actively streaming
  const hasActiveAnalysis = aiSessions.some(s => s.messages.some(m => m.status === 'streaming'))
  const handleBeforeUnload = useCallback((e: BeforeUnloadEvent) => {
    if (hasActiveAnalysis) {
      e.preventDefault()
      e.returnValue = 'An analysis is still running — refreshing will abort it.'
    }
  }, [hasActiveAnalysis])
  useEffect(() => {
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [handleBeforeUnload])

  // Re-auth modal: listen for 401 events fired by api.ts
  useEffect(() => {
    const handler = () => setAuthExpired(true)
    window.addEventListener('ch:auth-expired', handler)
    return () => window.removeEventListener('ch:auth-expired', handler)
  }, [setAuthExpired])

  // On-mount auth check: show re-auth modal if session is already expired
  useEffect(() => {
    api.auth.status().then(s => {
      if (!s.logged_in) setAuthExpired(true)
    }).catch(() => {}) // ignore if endpoint unavailable
  }, [])

  // Periodic auth check every 5 minutes — detect token expiry while the app is open
  useEffect(() => {
    const id = window.setInterval(() => {
      api.auth.status().then(s => {
        if (!s.logged_in) setAuthExpired(true)
      }).catch(() => {})
    }, 300_000)
    return () => clearInterval(id)
  }, [setAuthExpired])

  // Load instances on mount
  useEffect(() => {
    api.overview().then(data => setInstances(data.map(i => i.name))).catch(() => {})
  }, [setInstances])

  // Mount chat analyzer on first visit, keep forever after
  useEffect(() => {
    if (view === 'analyzer') setAnalyzerMounted(true)
  }, [view])

  // Auto-refresh — only tick when the browser tab is visible
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (refreshInterval > 0) {
      intervalRef.current = window.setInterval(() => {
        if (document.visibilityState === 'visible') setTick(t => t + 1)
      }, refreshInterval * 1000)
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [refreshInterval])

  // When the tab becomes visible again, fire an immediate tick so data isn't stale
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible' && refreshInterval > 0) {
        setTick(t => t + 1)
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [refreshInterval])

  const views: Record<string, React.ReactNode> = {
    dashboard: <Dashboard />,
    discover: <Discover />,
    overview: <Overview refreshKey={tick} />,
    detail: <Detail refreshKey={tick} />,
    alerts: <Alerts refreshKey={tick} />,
    history: <AlertHistory refreshKey={tick} />,
    explore: <Explore refreshKey={tick} />,
    compare: <Compare />,
    advisor: <Advisor />,
    scanner: <TableScanner refreshKey={tick} />,
    cost: <CostExplorer />,
    maintenance: <Maintenance />,
    runcheck: <RunCheck />,
    audit: <AuditLog refreshKey={tick} />,
    thresholds: <ThresholdEditor />,
    terminal: <Terminal />,
    logs: <AppLogs refreshKey={tick} />,
    chlogs: <CHLogs refreshKey={tick} />,
  }

  return (
    <div className="flex min-h-screen overflow-x-hidden bg-[var(--bg)] text-[var(--text)]">
      <Sidebar mobileOpen={mobileSidebarOpen} onMobileClose={() => setMobileSidebarOpen(false)} onOpenPalette={() => setPaletteOpen(true)} />
      <div className={cn("flex-1 flex flex-col transition-all duration-200", sidebarCollapsed ? "md:ml-14" : "md:ml-[220px]")}>
        <TopBar onMobileMenuClick={() => setMobileSidebarOpen(o => !o)} />
        <main className={cn(
          'flex-1 w-full min-h-0',
          view === 'analyzer'
            ? 'overflow-hidden flex flex-col'
            : view === 'terminal' || view === 'scanner'
            ? 'overflow-hidden flex flex-col p-3 sm:p-4'
            : 'p-3 sm:p-6 max-w-[1600px] mx-auto overflow-y-auto overflow-x-hidden',
        )}>
          {/* Chat Analyzer: mount once and keep alive (hidden when inactive) to preserve session */}
          {analyzerMounted && (
            <div className={cn('flex-1 flex flex-col min-h-0 overflow-hidden', view !== 'analyzer' && 'hidden')}>
              <ErrorBoundary>
                <ChatAnalyzer />
              </ErrorBoundary>
            </div>
          )}
          {/* All other views */}
          {view !== 'analyzer' && (
            <ErrorBoundary>
              {views[view] || <Overview />}
            </ErrorBoundary>
          )}
          {/* Spacer so content doesn't hide behind the fixed AI panel */}
          {view !== 'analyzer' && view !== 'terminal' && (
            <div style={{ height: aiSpacerHeight }} aria-hidden />
          )}
        </main>
      </div>
      {tableDetail && (
        <TableDetail
          instance={tableDetail.instance}
          database={tableDetail.database}
          table={tableDetail.table}
          onClose={closeTableDetail}
        />
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      {/* Keyboard shortcuts overlay */}
      {shortcutsOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" onClick={() => setShortcutsOpen(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative z-10 bg-[var(--card)] border border-[var(--border)] rounded-xl p-6 w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold">Keyboard Shortcuts</h2>
              <button onClick={() => setShortcutsOpen(false)} className="text-[var(--dim)] hover:text-[var(--fg)] transition-colors"><X size={16} /></button>
            </div>
            <div className="space-y-1">
              {([
                ['Cmd/Ctrl + K', 'Command palette'],
                ['j / k', 'Navigate rows in tables'],
                ['Enter', 'Select focused row'],
                ['Esc', 'Close modal / panel'],
                ['?', 'Show this help'],
              ] as [string, string][]).map(([key, desc]) => (
                <div key={key} className="flex items-center justify-between py-1.5 border-b border-[var(--border)] last:border-0">
                  <span className="text-xs text-[var(--dim)]">{desc}</span>
                  <kbd className="text-[10px] px-2 py-0.5 rounded bg-[var(--surface)] border border-[var(--border)] font-mono">{key}</kbd>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-[var(--dim)] mt-3">Press <kbd className="font-mono px-1 bg-[var(--surface)] border border-[var(--border)] rounded">?</kbd> to toggle</p>
          </div>
        </div>
      )}

      {view !== 'analyzer' && (
        <AIAnalysisPanel
          instance={selectedInstance}
          isOpen={aiOpen}
          onToggle={() => setAiOpen(!aiOpen)}
          onAnalyze={aiAnalyze}
          onFollowUp={aiFollowUp}
          onNewSession={aiNewSession}
          onDeleteSession={aiDeleteSession}
          onSelectSession={setAiActiveSession}
          sessions={aiSessions}
          activeSessionId={aiActiveSessionId}
        />
      )}
    </div>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <Layout />
      <NotificationToasts />
    </StoreProvider>
  )
}
