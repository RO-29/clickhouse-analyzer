import { useState, useEffect, useRef, useCallback } from 'react'
import { StoreProvider, useStore } from './hooks/useStore'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { CommandPalette } from './components/CommandPalette'
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
import AuditLog from './views/AuditLog'
import ThresholdEditor from './views/ThresholdEditor'
import FeatureGuide from './views/FeatureGuide'
import { TableDetail } from './components/TableDetail'
import { AIAnalysisPanel } from './components/AIAnalysisPanel'
import { NotificationToasts } from './components/NotificationToasts'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useAIAnalysis, PANEL_EXPANDED_HEIGHT, PANEL_COLLAPSED_HEIGHT } from './hooks/useAIAnalysis'
import { cn } from './lib/utils'
import { api } from './lib/api'

function Layout() {
  const { view, refreshInterval, sidebarCollapsed, setInstances, tableDetail, closeTableDetail, selectedInstance, setAuthExpired, setView } = useStore()
  const intervalRef = useRef<number>(0)
  const [tick, setTick] = useState(0)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
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

  // Cmd+K → open command palette; ? → Feature Guide page
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
        setView('guide')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setView])

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
    guide: <FeatureGuide />,
  }

  return (
    <div className="flex min-h-screen overflow-x-hidden bg-[var(--bg)] text-[var(--text)]">
      <Sidebar mobileOpen={mobileSidebarOpen} onMobileClose={() => setMobileSidebarOpen(false)} onOpenPalette={() => setPaletteOpen(true)} />
      {/* Sidebar is position:fixed (Sidebar.tsx), so flex-1 on this wrapper resolves to 100% viewport width.
          Using margin-left here would visually offset content right and overflow the viewport by the sidebar width.
          Padding-left keeps the box 100% wide (box-sizing: border-box) and shrinks the inner content area correctly. */}
      <div className={cn("flex-1 flex flex-col min-w-0 transition-all duration-200", sidebarCollapsed ? "md:pl-14" : "md:pl-[220px]")}>
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
