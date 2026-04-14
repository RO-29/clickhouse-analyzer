import { useCallback } from 'react'
import { useStore } from './useStore'
import { notifyDone, notifyError, requestNotifPermission } from '../lib/notify'
import type { ChatSession, ChatMessage, AnalyzeOptions } from '../types/api'

// Re-export so existing imports from this module keep working
export type { AnalyzeOptions }

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9)
}

export const PANEL_EXPANDED_HEIGHT = 'calc(70vh + 8px)'
export const PANEL_COLLAPSED_HEIGHT = '36px'

// Shared SSE stream reader — calls onChunk/onError/onDone as events arrive
async function readStream(
  resp: Response,
  onChunk: (text: string) => void,
  onError: (msg: string) => void,
  onDone: () => void,
  onDebug?: (payload: any) => void,
): Promise<void> {
  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''
  let currentData = ''

  const flush = () => {
    if (currentEvent === 'chunk' && currentData) {
      try { onChunk(JSON.parse(currentData) as string) } catch {}
    } else if (currentEvent === 'error' && currentData) {
      try { onError(JSON.parse(currentData) as string) } catch {}
    } else if (currentEvent === 'status' && currentData) {
      try {
        const s = JSON.parse(currentData) as { phase: string }
        if (s.phase === 'done') onDone()
      } catch {}
    } else if (currentEvent === 'debug' && currentData && onDebug) {
      try { onDebug(JSON.parse(currentData)) } catch {}
    }
    currentEvent = ''
    currentData = ''
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line === '') flush()
      else if (line.startsWith('event: ')) currentEvent = line.slice(7).trim()
      else if (line.startsWith('data: ')) currentData = line.slice(6)
    }
  }
}

export function useAIAnalysis(instance: string) {
  const {
    chatSessions, setChatSessions,
    activeChatId, setActiveChatId,
    aiPanelOpen: isOpen, setAiPanelOpen: setIsOpen,
    instances: storeInstances,
  } = useStore()

  // Resolve which instance to use for API calls.
  // Falls back to the first known instance when the prop is empty (e.g. Compare view).
  const resolveInstance = useCallback((override?: string): string => {
    return override || instance || storeInstances[0] || ''
  }, [instance, storeInstances])

  // Update a specific message within a specific session
  const updateMessage = useCallback((
    sessionId: string,
    msgId: string,
    updater: (m: ChatMessage) => ChatMessage,
  ) => {
    setChatSessions(prev => prev.map(s =>
      s.id === sessionId
        ? { ...s, updatedAt: Date.now(), messages: s.messages.map(m => m.id === msgId ? updater(m) : m) }
        : s
    ))
  }, [setChatSessions])

  const analyze = useCallback(async (
    label: string,
    visibleData: Record<string, any>,
    options: AnalyzeOptions,
  ) => {
    const now = Date.now()
    const userMsgId = generateId()
    const assistantMsgId = generateId()

    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: label,
      status: 'done',
      timestamp: now,
    }

    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      phase: 'planning',
      timestamp: now,
      thinkingLines: [],
      steps: [],
    }

    // Find or create session; create new one if instance changed
    let sessionId = activeChatId
    const existingSession = chatSessions.find(s => s.id === sessionId)
    const instanceMismatch = instance && existingSession?.instance && existingSession.instance !== instance

    if (!sessionId || !existingSession || instanceMismatch) {
      const session: ChatSession = {
        id: generateId(),
        name: label,
        instance: instance || '',
        createdAt: now,
        updatedAt: now,
        timeWindowMins: 60,
        messages: [userMsg, assistantMsg],
      }
      setChatSessions(prev => [session, ...prev])
      setActiveChatId(session.id)
      sessionId = session.id
    } else {
      setChatSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, updatedAt: now, messages: [...s.messages, userMsg, assistantMsg] }
          : s
      ))
    }

    setIsOpen(true)
    requestNotifPermission()

    let notified = false
    const fireNotifyDone = () => { if (!notified) { notified = true; notifyDone(label) } }
    const fireNotifyError = () => { if (!notified) { notified = true; notifyError(label) } }

    const instForReq = resolveInstance()
    if (!instForReq) {
      updateMessage(sessionId!, assistantMsgId, m => ({ ...m, status: 'error', content: 'Error: No instance selected. Pick an instance from the sidebar first.' }))
      return
    }

    try {
      const resp = await fetch(`/api/instances/${instForReq}/analyze-element`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context_type: options.contextType,
          context_label: label,
          tab: options.tab,
          visible_data: visibleData,
          mode: options.mode ?? 'quick',
          deep_queries: options.deepQueries,
        }),
      })

      if (!resp.ok || !resp.body) {
        let msg = `HTTP ${resp.status}`
        try { const j = await resp.json(); if (j?.error) msg = j.error } catch {}
        updateMessage(sessionId!, assistantMsgId, m => ({ ...m, status: 'error', content: `Error: ${msg}` }))
        fireNotifyError()
        return
      }

      let doneSignaled = false
      await readStream(
        resp,
        text => updateMessage(sessionId!, assistantMsgId, m => ({ ...m, content: m.content + text })),
        msg => {
          updateMessage(sessionId!, assistantMsgId, m => ({ ...m, status: 'error', content: m.content + `\n\n**Error:** ${msg}` }))
          fireNotifyError()
        },
        () => {
          doneSignaled = true
          updateMessage(sessionId!, assistantMsgId, m => ({ ...m, status: 'done', phase: 'done' }))
        },
        (dbg: any) => {
          updateMessage(sessionId!, assistantMsgId, m => ({
            ...m,
            evidence: {
              promptBytes: dbg.prompt_bytes ?? 0,
              promptKb: dbg.prompt_kb ?? 0,
              truncated: dbg.truncated ?? false,
              promptHead: dbg.prompt_head ?? '',
              rowCounts: dbg.row_counts ?? {},
              collectionErrors: dbg.collection_errors ?? [],
              mode: dbg.mode ?? '',
              instance: dbg.instance ?? '',
            },
          }))
        },
      )
      if (!doneSignaled) updateMessage(sessionId!, assistantMsgId, m => m.status === 'streaming' ? { ...m, status: 'done', phase: 'done' } : m)
      fireNotifyDone()
    } catch (err: any) {
      updateMessage(sessionId!, assistantMsgId, m => ({ ...m, status: 'error', content: `Error: ${err.message}` }))
      fireNotifyError()
    }
  }, [instance, chatSessions, activeChatId, setChatSessions, setActiveChatId, setIsOpen, updateMessage, resolveInstance])

  const followUp = useCallback(async (question: string) => {
    if (!question.trim() || !activeChatId) return

    const session = chatSessions.find(s => s.id === activeChatId)
    if (!session) return

    // Build history context from completed assistant messages (up to 5 most recent)
    const history = session.messages
      .filter(m => m.role === 'assistant' && m.status !== 'streaming')
      .slice(-5)
      .map(m => ({ label: m.content.slice(0, 60), output: m.content.slice(0, 2000) }))

    // Derive tab from session name or use 'advisor' as fallback
    const tab = 'advisor'

    const trimmed = question.trim()
    const label = `Q: ${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}`
    const now = Date.now()
    const userMsgId = generateId()
    const assistantMsgId = generateId()

    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: trimmed,
      status: 'done',
      timestamp: now,
    }

    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      phase: 'planning',
      timestamp: now,
      thinkingLines: [],
      steps: [],
    }

    setChatSessions(prev => prev.map(s =>
      s.id === activeChatId
        ? { ...s, updatedAt: now, messages: [...s.messages, userMsg, assistantMsg] }
        : s
    ))
    setIsOpen(true)
    requestNotifPermission()

    const instanceForReq = resolveInstance(session.instance)

    let notified = false
    const fireNotifyDone = () => { if (!notified) { notified = true; notifyDone(label) } }
    const fireNotifyError = () => { if (!notified) { notified = true; notifyError(label) } }

    try {
      const resp = await fetch(`/api/instances/${instanceForReq}/analyze-element`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context_type: 'followup',
          context_label: label,
          tab,
          visible_data: { history, question: trimmed },
          mode: 'quick',
        }),
      })

      if (!resp.ok || !resp.body) {
        let msg = `HTTP ${resp.status}`
        try { const j = await resp.json(); if (j?.error) msg = j.error } catch {}
        updateMessage(activeChatId, assistantMsgId, m => ({ ...m, status: 'error', content: `Error: ${msg}` }))
        fireNotifyError()
        return
      }

      let doneSignaled = false
      await readStream(
        resp,
        text => updateMessage(activeChatId, assistantMsgId, m => ({ ...m, content: m.content + text })),
        msg => {
          updateMessage(activeChatId, assistantMsgId, m => ({ ...m, status: 'error', content: m.content + `\n\n**Error:** ${msg}` }))
          fireNotifyError()
        },
        () => {
          doneSignaled = true
          updateMessage(activeChatId, assistantMsgId, m => ({ ...m, status: 'done', phase: 'done' }))
        },
        (dbg: any) => {
          updateMessage(activeChatId, assistantMsgId, m => ({
            ...m,
            evidence: {
              promptBytes: dbg.prompt_bytes ?? 0,
              promptKb: dbg.prompt_kb ?? 0,
              truncated: dbg.truncated ?? false,
              promptHead: dbg.prompt_head ?? '',
              rowCounts: dbg.row_counts ?? {},
              collectionErrors: dbg.collection_errors ?? [],
              mode: dbg.mode ?? '',
              instance: dbg.instance ?? '',
            },
          }))
        },
      )
      if (!doneSignaled) updateMessage(activeChatId, assistantMsgId, m => m.status === 'streaming' ? { ...m, status: 'done', phase: 'done' } : m)
      fireNotifyDone()
    } catch (err: any) {
      updateMessage(activeChatId, assistantMsgId, m => ({ ...m, status: 'error', content: `Error: ${err.message}` }))
      fireNotifyError()
    }
  }, [instance, chatSessions, activeChatId, setChatSessions, setIsOpen, updateMessage])

  const newSession = useCallback(() => {
    setActiveChatId(null)
  }, [setActiveChatId])

  const deleteSession = useCallback((sessionId: string) => {
    setChatSessions(prev => prev.filter(s => s.id !== sessionId))
    if (activeChatId === sessionId) setActiveChatId(null)
  }, [setChatSessions, activeChatId, setActiveChatId])

  return {
    sessions: chatSessions,
    activeChatId,
    setActiveChatId,
    // Aliases for backward compat with App.tsx destructuring
    activeSessionId: activeChatId,
    setActiveSessionId: setActiveChatId,
    isOpen,
    setIsOpen,
    analyze,
    followUp,
    newSession,
    deleteSession,
  }
}
