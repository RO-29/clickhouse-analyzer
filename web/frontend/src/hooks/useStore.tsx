import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { presetToRange } from '../lib/utils'
import type { AnalysisEntry } from '../types/api'

export type View = 'overview' | 'detail' | 'alerts' | 'explore' | 'compare' | 'advisor' | 'terminal' | 'logs' | 'chlogs' | 'analyzer'

export interface Store {
  // State
  view: View
  selectedInstance: string
  /** Alias for selectedInstance (compat with views using `instance`) */
  instance: string
  instances: string[]
  sidebarCollapsed: boolean
  theme: 'dark' | 'light'
  refreshInterval: number
  rangePreset: string
  from: number
  to: number
  /** Alias for from (compat) */
  customFrom: number
  /** Alias for to (compat) */
  customTo: number
  terminalQuery: string
  terminalInstance: string
  tableDetail: { instance: string; database: string; table: string } | null
  aiEntries: AnalysisEntry[]
  aiPanelOpen: boolean

  // Actions
  setView: (v: View) => void
  setSelectedInstance: (name: string) => void
  /** Alias for setSelectedInstance (compat) */
  setInstance: (name: string | null) => void
  setInstances: (names: string[]) => void
  setSidebarCollapsed: (v: boolean) => void
  toggleTheme: () => void
  setRefreshInterval: (s: number) => void
  setRangePreset: (preset: string) => void
  setCustomRange: (from: number, to: number) => void
  /** Returns current {from, to} epoch seconds */
  getTimeRange: () => { from: number; to: number }
  navToDetail: (instance: string) => void
  navToTerminal: (query: string, instance: string) => void
  openTableDetail: (instance: string, database: string, table: string) => void
  closeTableDetail: () => void
  setAiEntries: (updater: AnalysisEntry[] | ((prev: AnalysisEntry[]) => AnalysisEntry[])) => void
  setAiPanelOpen: (v: boolean) => void
  clearAiEntries: () => void
}

const StoreContext = createContext<Store | null>(null)

const defaultRange = presetToRange('1h')

export function StoreProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>('overview')
  const [selectedInstance, setSelectedInstance] = useState('')
  const [instances, setInstances] = useState<string[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('ch-theme')
    const t = (saved === 'light' ? 'light' : 'dark') as 'dark' | 'light'
    document.documentElement.setAttribute('data-theme', t)
    return t
  })
  const [refreshInterval, setRefreshInterval] = useState(300)
  const [rangePreset, setRangePresetRaw] = useState('1h')
  const [from, setFrom] = useState(defaultRange[0])
  const [to, setTo] = useState(defaultRange[1])
  const [terminalQuery, setTerminalQuery] = useState('')
  const [terminalInstance, setTerminalInstance] = useState('')
  const [tableDetail, setTableDetail] = useState<{ instance: string; database: string; table: string } | null>(null)
  const [aiEntries, setAiEntries] = useState<AnalysisEntry[]>([])
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const clearAiEntries = useCallback(() => setAiEntries([]), [])

  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-theme', next)
      localStorage.setItem('ch-theme', next)
      return next
    })
  }, [])

  const setRangePreset = useCallback((preset: string) => {
    setRangePresetRaw(preset)
    const [f, t] = presetToRange(preset)
    setFrom(f)
    setTo(t)
  }, [])

  const setCustomRange = useCallback((f: number, t: number) => {
    setRangePresetRaw('custom')
    setFrom(f)
    setTo(t)
  }, [])

  const getTimeRange = useCallback(() => {
    return { from, to }
  }, [from, to])

  const navToDetail = useCallback((instance: string) => {
    setSelectedInstance(instance)
    setView('detail')
  }, [])

  const navToTerminal = useCallback((query: string, instance: string) => {
    setTerminalQuery(query)
    setTerminalInstance(instance)
    setView('terminal')
  }, [])

  const openTableDetail = useCallback((instance: string, database: string, table: string) => {
    // Skip system/internal tables and metric name false positives
    if (!database || !table || database === 'system' || database === 'INFORMATION_SCHEMA' || database === 'information_schema' || database === 'ch_analyzer') return
    setTableDetail({ instance, database, table })
  }, [])

  const closeTableDetail = useCallback(() => {
    setTableDetail(null)
  }, [])

  const setInstanceCompat = useCallback((name: string | null) => {
    setSelectedInstance(name ?? '')
  }, [])

  const store: Store = {
    view, setView,
    selectedInstance,
    instance: selectedInstance,
    setSelectedInstance,
    setInstance: setInstanceCompat,
    instances, setInstances,
    sidebarCollapsed, setSidebarCollapsed,
    theme, toggleTheme,
    refreshInterval, setRefreshInterval,
    rangePreset, setRangePreset, setCustomRange,
    from, to,
    customFrom: from,
    customTo: to,
    getTimeRange,
    terminalQuery, terminalInstance,
    tableDetail,
    aiEntries, aiPanelOpen,
    setAiEntries, setAiPanelOpen, clearAiEntries,
    navToDetail, navToTerminal,
    openTableDetail, closeTableDetail,
  }

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
