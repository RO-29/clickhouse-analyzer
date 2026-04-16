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
import Discover from './views/Discover'
import { TableDetail } from './components/TableDetail'
import { AIAnalysisPanel } from './components/AIAnalysisPanel'
import { NotificationToasts } from './components/NotificationToasts'
import { useAIAnalysis, PANEL_EXPANDED_HEIGHT, PANEL_COLLAPSED_HEIGHT } from './hooks/useAIAnalysis'
import { cn } from './lib/utils'
import { api } from './lib/api'

function Layout() {
  const { view, refreshInterval, sidebarCollapsed, setInstances, tableDetail, closeTableDetail, selectedInstance } = useStore()
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

  // Cmd+K → open command palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen(o => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
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

  // Load instances on mount
  useEffect(() => {
    api.overview().then(data => setInstances(data.map(i => i.name))).catch(() => {})
  }, [setInstances])

  // Mount chat analyzer on first visit, keep forever after
  useEffect(() => {
    if (view === 'analyzer') setAnalyzerMounted(true)
  }, [view])

  // Auto-refresh
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (refreshInterval > 0) {
      intervalRef.current = window.setInterval(() => setTick(t => t + 1), refreshInterval * 1000)
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [refreshInterval])

  const views: Record<string, React.ReactNode> = {
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
    terminal: <Terminal />,
    logs: <AppLogs refreshKey={tick} />,
    chlogs: <CHLogs refreshKey={tick} />,
  }

  return (
    <div className="flex min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <Sidebar mobileOpen={mobileSidebarOpen} onMobileClose={() => setMobileSidebarOpen(false)} onOpenPalette={() => setPaletteOpen(true)} />
      <div className={cn("flex-1 flex flex-col transition-all duration-200", sidebarCollapsed ? "md:ml-14" : "md:ml-[220px]")}>
        <TopBar onMobileMenuClick={() => setMobileSidebarOpen(o => !o)} />
        <main className={cn(
          'flex-1 w-full',
          view === 'analyzer' || view === 'terminal'
            ? 'overflow-hidden flex flex-col'
            : 'p-3 sm:p-6 max-w-[1600px] mx-auto overflow-auto',
        )}>
          {/* Chat Analyzer: mount once and keep alive (hidden when inactive) to preserve session */}
          {analyzerMounted && (
            <div className={cn('flex-1 flex flex-col min-h-0 overflow-hidden', view !== 'analyzer' && 'hidden')}>
              <ChatAnalyzer />
            </div>
          )}
          {/* All other views */}
          {view !== 'analyzer' && (views[view] || <Overview />)}
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
