import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import { presetToRange } from '../lib/utils'
import type { ChatSession } from '../types/api'

export type View = 'overview' | 'detail' | 'alerts' | 'history' | 'explore' | 'compare' | 'advisor' | 'terminal' | 'logs' | 'chlogs' | 'analyzer' | 'scanner' | 'cost' | 'maintenance' | 'runcheck' | 'discover' | 'audit'

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
  denseMode: boolean
  scannerSearch: string

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
  navToExploreWithRange: (instance: string, from: number, to: number) => void
  navToScanner: (instance: string, search: string) => void
  openTableDetail: (instance: string, database: string, table: string) => void
  closeTableDetail: () => void
  setChatSessions: (updater: ChatSession[] | ((prev: ChatSession[]) => ChatSession[])) => void
  setActiveChatId: (id: string | null) => void
  setAiPanelOpen: (v: boolean) => void
  authExpired: boolean
  setAuthExpired: (v: boolean) => void
  setDenseMode: (v: boolean) => void
  setScannerSearch: (s: string) => void
}

const StoreContext = createContext<Store | null>(null)

const defaultRange = presetToRange('1h')

// Merge URL params without adding a new browser history entry.
function patchURL(patches: Record<string, string | null>) {
  const url = new URL(window.location.href)
  for (const [k, v] of Object.entries(patches)) {
    if (v === null || v === '') url.searchParams.delete(k)
    else url.searchParams.set(k, v)
  }
  window.history.replaceState(null, '', url.toString())
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [view, setViewState] = useState<View>(() => {
    const params = new URLSearchParams(window.location.search)
    const v = params.get('view') as View | null
    const valid: View[] = ['overview','detail','alerts','explore','compare','advisor','terminal','logs','chlogs','analyzer','scanner','cost','maintenance','audit']
    return v && valid.includes(v) ? v : 'overview'
  })
  const [selectedInstance, setSelectedInstanceRaw] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('instance') ?? ''
  })
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
    // pushState for view changes so the back button navigates between views.
    const url = new URL(window.location.href)
    url.searchParams.set('view', v)
    // Drop tab when switching views — it only makes sense within Explore.
    if (v !== 'explore') url.searchParams.delete('tab')
    window.history.pushState(null, '', url.toString())
  }, [])

  const [refreshInterval, setRefreshInterval] = useState(300)
  const [rangePreset, setRangePresetRaw] = useState(() => {
    const p = new URLSearchParams(window.location.search)
    return p.get('from') ? 'custom' : '1h'
  })
  const [from, setFrom] = useState(() => {
    const p = new URLSearchParams(window.location.search)
    const f = Number(p.get('from'))
    return f > 0 ? f : defaultRange[0]
  })
  const [to, setTo] = useState(() => {
    const p = new URLSearchParams(window.location.search)
    const t = Number(p.get('to'))
    return t > 0 ? t : defaultRange[1]
  })
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
  const [authExpired, setAuthExpired] = useState(false)
  const [denseMode, setDenseModeRaw] = useState(() => localStorage.getItem('ch-dense') === '1')
  const [scannerSearch, setScannerSearchState] = useState('')
  const setScannerSearch = useCallback((s: string) => setScannerSearchState(s), [])
  const setDenseMode = useCallback((v: boolean) => {
    setDenseModeRaw(v)
    localStorage.setItem('ch-dense', v ? '1' : '0')
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark'
      document.documentElement.setAttribute('data-theme', next)
      localStorage.setItem('ch-theme', next)
      return next
    })
  }, [])

  const setSelectedInstance = useCallback((name: string) => {
    setSelectedInstanceRaw(name)
    patchURL({ instance: name || null })
  }, [])

  const setRangePreset = useCallback((preset: string) => {
    setRangePresetRaw(preset)
    const [f, t] = presetToRange(preset)
    setFrom(f)
    setTo(t)
    // Always write absolute timestamps — shared URL shows the exact window
    // that was active when the link was generated (not a shifting "last Nh").
    patchURL({ from: String(f), to: String(t) })
  }, [])

  const setCustomRange = useCallback((f: number, t: number) => {
    setRangePresetRaw('custom')
    setFrom(f)
    setTo(t)
    patchURL({ from: String(f), to: String(t) })
  }, [])

  const getTimeRange = useCallback(() => {
    return { from, to }
  }, [from, to])

  const navToDetail = useCallback((instance: string) => {
    setSelectedInstanceRaw(instance)
    // pushState so browser back returns to previous view
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'detail')
    url.searchParams.set('instance', instance || '')
    url.searchParams.delete('tab')
    window.history.pushState(null, '', url.toString())
    setViewState('detail')
  }, [])

  const navToExploreWithRange = useCallback((instance: string, from: number, to: number) => {
    setSelectedInstanceRaw(instance)
    setFrom(from)
    setTo(to)
    setRangePresetRaw('custom')
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'explore')
    url.searchParams.set('instance', instance || '')
    url.searchParams.set('from', String(from))
    url.searchParams.set('to', String(to))
    url.searchParams.delete('tab')
    window.history.pushState(null, '', url.toString())
    setViewState('explore')
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

  const navToScanner = useCallback((instance: string, search: string) => {
    setSelectedInstanceRaw(instance)
    setScannerSearchState(search)
    setViewState('scanner')
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
    setSelectedInstanceRaw(name ?? '')
    patchURL({ instance: name ?? null })
  }, [])

  const store: Store = {
    view, setView: setView as (v: View) => void,
    selectedInstance,
    instance: selectedInstance,
    setSelectedInstance: setSelectedInstance,
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
    authExpired, setAuthExpired,
    navToDetail, navToAlerts, alertPreset, setAlertPreset,
    navToTerminal, navToExploreWithRange, navToScanner,
    openTableDetail, closeTableDetail,
    denseMode, setDenseMode,
    scannerSearch, setScannerSearch,
  }

  // ── Browser back/forward button support ──────────────────────────────────
  useEffect(() => {
    const handlePopState = () => {
      const p = new URLSearchParams(window.location.search)
      const v = p.get('view') as View | null
      const valid: View[] = ['overview','detail','alerts','history','explore','compare','advisor','terminal','logs','chlogs','analyzer','scanner','cost','maintenance','runcheck','discover','audit']
      if (v && valid.includes(v)) setViewState(v)
      setSelectedInstanceRaw(p.get('instance') ?? '')
      const f = Number(p.get('from'))
      const t = Number(p.get('to'))
      if (f > 0 && t > 0) {
        setFrom(f); setTo(t); setRangePresetRaw('custom')
      }
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
