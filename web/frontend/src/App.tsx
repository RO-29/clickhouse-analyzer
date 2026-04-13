import { useState, useEffect, useRef } from 'react'
import { StoreProvider, useStore } from './hooks/useStore'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import Overview from './views/Overview'
import Detail from './views/Detail'
import Alerts from './views/Alerts'
import Explore from './views/Explore'
import Compare from './views/Compare'
import Advisor from './views/Advisor'
import Terminal from './views/Terminal'
import AppLogs from './views/AppLogs'
import CHLogs from './views/CHLogs'
import QueryAnalyzer from './views/QueryAnalyzer'
import { TableDetail } from './components/TableDetail'
import { cn } from './lib/utils'
import { api } from './lib/api'

function Layout() {
  const { view, refreshInterval, sidebarCollapsed, setInstances, tableDetail, closeTableDetail } = useStore()
  const intervalRef = useRef<number>(0)
  const [tick, setTick] = useState(0)

  // Load instances on mount
  useEffect(() => {
    api.overview().then(data => setInstances(data.map(i => i.name))).catch(() => {})
  }, [setInstances])

  // Auto-refresh
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    if (refreshInterval > 0) {
      intervalRef.current = window.setInterval(() => setTick(t => t + 1), refreshInterval * 1000)
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [refreshInterval])

  const views: Record<string, React.ReactNode> = {
    overview: <Overview key={tick} />,
    detail: <Detail key={tick} />,
    alerts: <Alerts key={tick} />,
    explore: <Explore key={tick} />,
    compare: <Compare key={tick} />,
    advisor: <Advisor key={tick} />,
    terminal: <Terminal />,
    analyzer: <QueryAnalyzer />,
    logs: <AppLogs key={tick} />,
    chlogs: <CHLogs key={tick} />,
  }

  return (
    <div className="flex min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <Sidebar />
      <div className={cn("flex-1 flex flex-col transition-all duration-200", sidebarCollapsed ? "ml-14" : "ml-[220px]")}>
        <TopBar />
        <main className={cn(
          'flex-1 w-full',
          view === 'analyzer' || view === 'terminal'
            ? 'overflow-hidden flex flex-col'
            : 'p-6 max-w-[1600px] mx-auto overflow-auto',
        )}>
          {views[view] || <Overview />}
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
    </div>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <Layout />
    </StoreProvider>
  )
}
