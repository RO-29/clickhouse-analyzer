import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { presetToRange } from '../lib/utils'
import type { ChatSession } from '../types/api'

export type View = 'overview' | 'detail' | 'alerts' | 'history' | 'explore' | 'compare' | 'advisor' | 'terminal' | 'logs' | 'chlogs' | 'analyzer' | 'scanner' | 'cost' | 'maintenance' | 'runcheck'

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
  chatSessions: ChatSession[]
  activeChatId: string | null
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
  navToAlerts: (filters?: { severity?: string; instance?: string }) => void
  alertPreset: { severity?: string; instance?: string } | null
  setAlertPreset: (preset: { severity?: string; instance?: string } | null) => void
  navToTerminal: (query: string, instance: string) => void
  openTableDetail: (instance: string, database: string, table: string) => void
  closeTableDetail: () => void
  setChatSessions: (updater: ChatSession[] | ((prev: ChatSession[]) => ChatSession[])) => void
  setActiveChatId: (id: string | null) => void
  setAiPanelOpen: (v: boolean) => void
}

const StoreContext = createContext<Store | null>(null)

const defaultRange = presetToRange('1h')

export function StoreProvider({ children }: { children: ReactNode }) {
  const [view, setViewState] = useState<View>(() => {
    const params = new URLSearchParams(window.location.search)
    const v = params.get('view') as View | null
    const valid: View[] = ['overview','detail','alerts','explore','compare','advisor','terminal','logs','chlogs','analyzer','scanner','cost','maintenance']
    return v && valid.includes(v) ? v : 'overview'
  })
  const [selectedInstance, setSelectedInstance] = useState('')
  const [instances, setInstances] = useState<string[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('ch-theme')
    const t = (saved === 'light' ? 'light' : 'dark') as 'dark' | 'light'
    document.documentElement.setAttribute('data-theme', t)
    return t
  })
  const setView = useCallback((v: View) => {
    setViewState(v)
    const url = new URL(window.location.href)
    url.searchParams.set('view', v)
    window.history.pushState(null, '', url.toString())
  }, [])

  const [refreshInterval, setRefreshInterval] = useState(300)
  const [rangePreset, setRangePresetRaw] = useState('1h')
  const [from, setFrom] = useState(defaultRange[0])
  const [to, setTo] = useState(defaultRange[1])
  const [terminalQuery, setTerminalQuery] = useState('')
  const [terminalInstance, setTerminalInstance] = useState('')
  const [tableDetail, setTableDetail] = useState<{ instance: string; database: string; table: string } | null>(null)
  const [alertPreset, setAlertPreset] = useState<{ severity?: string; instance?: string } | null>(null)

  // Chat sessions — persisted to localStorage (replaces aiSessions + aiEntries)
  const [chatSessions, setChatSessionsState] = useState<ChatSession[]>(() => {
    try {
      const saved = localStorage.getItem('ch-chat-sessions')
      if (!saved) return []
      const sessions = JSON.parse(saved) as ChatSession[]
      // Any message still marked 'streaming' at load time lost its SSE connection on
      // the previous page unload — mark it done so the UI doesn't spin forever.
      return sessions.map(s => ({
        ...s,
        messages: s.messages.map(m =>
          m.status === 'streaming'
            ? { ...m, status: 'done' as const, phase: 'done' as const, content: m.content || '_(Analysis interrupted by page reload)_' }
            : m
        ),
      }))
    } catch { return [] }
  })
  const setChatSessions = useCallback((updater: ChatSession[] | ((prev: ChatSession[]) => ChatSession[])) => {
    setChatSessionsState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      const trimmed = next.slice(0, 100)
      try { localStorage.setItem('ch-chat-sessions', JSON.stringify(trimmed)) } catch {}
      return trimmed
    })
  }, [])

  const [activeChatId, setActiveChatIdState] = useState<string | null>(() => {
    return localStorage.getItem('ch-active-chat')
  })
  const setActiveChatId = useCallback((id: string | null) => {
    setActiveChatIdState(id)
    if (id) localStorage.setItem('ch-active-chat', id)
    else localStorage.removeItem('ch-active-chat')
  }, [])

  const [aiPanelOpen, setAiPanelOpen] = useState(false)

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

  const navToAlerts = useCallback((filters?: { severity?: string; instance?: string }) => {
    setAlertPreset(filters ?? null)
    setView('alerts')
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
    view, setView: setView as (v: View) => void,
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
    chatSessions, setChatSessions,
    activeChatId, setActiveChatId,
    aiPanelOpen, setAiPanelOpen,
    navToDetail, navToAlerts, alertPreset, setAlertPreset,
    navToTerminal,
    openTableDetail, closeTableDetail,
  }

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
