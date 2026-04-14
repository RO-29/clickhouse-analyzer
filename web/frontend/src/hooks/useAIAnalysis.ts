import { useCallback } from 'react'
import { useStore } from './useStore'
import { notifyDone, notifyError, requestNotifPermission } from '../lib/notify'
import type { AnalysisEntry, AnalyzeOptions, AISession } from '../types/api'

// Re-export so existing imports from this module keep working
export type { AnalysisEntry, AnalyzeOptions }

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
    aiSessions, setAiSessions,
    activeSessionId, setActiveSessionId,
    aiPanelOpen: isOpen, setAiPanelOpen: setIsOpen,
  } = useStore()

  // Update a specific entry within a specific session
  const updateEntry = useCallback((
    sessionId: string,
    entryId: string,
    updater: (e: AnalysisEntry) => AnalysisEntry,
  ) => {
    setAiSessions(prev => prev.map(s =>
      s.id === sessionId
        ? { ...s, updatedAt: Date.now(), entries: s.entries.map(e => e.id === entryId ? updater(e) : e) }
        : s
    ))
  }, [setAiSessions])

  const analyze = useCallback(async (
    label: string,
    visibleData: Record<string, any>,
    options: AnalyzeOptions,
  ) => {
    const entryId = generateId()
    const now = Date.now()

    const newEntry: AnalysisEntry = {
      id: entryId,
      label,
      contextType: options.contextType,
      tab: options.tab,
      elementId: options.elementId,
      status: 'streaming',
      output: '',
      timestamp: now,
    }

    // Find or create session; create new one if instance changed
    let sessionId = activeSessionId
    const existingSession = aiSessions.find(s => s.id === sessionId)
    const instanceMismatch = instance && existingSession?.instance && existingSession.instance !== instance

    if (!sessionId || !existingSession || instanceMismatch) {
      const session: AISession = {
        id: generateId(),
        name: label,
        instance: instance || '',
        createdAt: now,
        updatedAt: now,
        entries: [newEntry],
      }
      setAiSessions(prev => [session, ...prev])
      setActiveSessionId(session.id)
      sessionId = session.id
    } else {
      setAiSessions(prev => prev.map(s =>
        s.id === sessionId
          ? { ...s, updatedAt: now, entries: [newEntry, ...s.entries] }
          : s
      ))
    }

    setIsOpen(true)
    requestNotifPermission()

    let notified = false
    const fireNotifyDone = () => { if (!notified) { notified = true; notifyDone(label) } }
    const fireNotifyError = () => { if (!notified) { notified = true; notifyError(label) } }

    try {
      const resp = await fetch(`/api/instances/${instance}/analyze-element`, {
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
        updateEntry(sessionId!, entryId, e => ({ ...e, status: 'error', output: `Error: ${msg}` }))
        fireNotifyError()
        return
      }

      let doneSignaled = false
      await readStream(
        resp,
        text => updateEntry(sessionId!, entryId, e => ({ ...e, output: e.output + text })),
        msg => {
          updateEntry(sessionId!, entryId, e => ({ ...e, status: 'error', output: e.output + `\n\n**Error:** ${msg}` }))
          fireNotifyError()
        },
        () => {
          doneSignaled = true
          updateEntry(sessionId!, entryId, e => ({ ...e, status: 'done' }))
        },
      )
      if (!doneSignaled) updateEntry(sessionId!, entryId, e => e.status === 'streaming' ? { ...e, status: 'done' } : e)
      fireNotifyDone()
    } catch (err: any) {
      updateEntry(sessionId!, entryId, e => ({ ...e, status: 'error', output: `Error: ${err.message}` }))
      fireNotifyError()
    }
  }, [instance, aiSessions, activeSessionId, setAiSessions, setActiveSessionId, setIsOpen, updateEntry])

  const followUp = useCallback(async (question: string) => {
    if (!question.trim() || !activeSessionId) return

    const session = aiSessions.find(s => s.id === activeSessionId)
    if (!session) return

    // Build history context (up to 5 most recent completed entries)
    const history = session.entries
      .filter(e => e.status !== 'streaming')
      .slice(0, 5)
      .map(e => ({ label: e.label, output: e.output.slice(0, 2000) }))

    const lastEntry = session.entries[0]
    const tab = lastEntry?.tab ?? 'advisor'

    const trimmed = question.trim()
    const label = `Q: ${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}`
    const entryId = generateId()
    const now = Date.now()

    const newEntry: AnalysisEntry = {
      id: entryId,
      label,
      contextType: 'followup',
      tab,
      status: 'streaming',
      output: '',
      timestamp: now,
      question: trimmed,
    }

    setAiSessions(prev => prev.map(s =>
      s.id === activeSessionId
        ? { ...s, updatedAt: now, entries: [newEntry, ...s.entries] }
        : s
    ))
    setIsOpen(true)
    requestNotifPermission()

    const instanceForReq = instance || session.instance

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
        updateEntry(activeSessionId, entryId, e => ({ ...e, status: 'error', output: `Error: ${msg}` }))
        fireNotifyError()
        return
      }

      let doneSignaled = false
      await readStream(
        resp,
        text => updateEntry(activeSessionId, entryId, e => ({ ...e, output: e.output + text })),
        msg => {
          updateEntry(activeSessionId, entryId, e => ({ ...e, status: 'error', output: e.output + `\n\n**Error:** ${msg}` }))
          fireNotifyError()
        },
        () => {
          doneSignaled = true
          updateEntry(activeSessionId, entryId, e => ({ ...e, status: 'done' }))
        },
      )
      if (!doneSignaled) updateEntry(activeSessionId, entryId, e => e.status === 'streaming' ? { ...e, status: 'done' } : e)
      fireNotifyDone()
    } catch (err: any) {
      updateEntry(activeSessionId, entryId, e => ({ ...e, status: 'error', output: `Error: ${err.message}` }))
      fireNotifyError()
    }
  }, [instance, aiSessions, activeSessionId, setAiSessions, setIsOpen, updateEntry])

  const newSession = useCallback(() => {
    setActiveSessionId(null)
  }, [setActiveSessionId])

  const deleteSession = useCallback((sessionId: string) => {
    setAiSessions(prev => prev.filter(s => s.id !== sessionId))
    if (activeSessionId === sessionId) setActiveSessionId(null)
  }, [setAiSessions, activeSessionId, setActiveSessionId])

  // Backward compat: expose active session entries
  const activeSession = aiSessions.find(s => s.id === activeSessionId)
  const entries = activeSession?.entries ?? []

  return {
    sessions: aiSessions,
    entries,
    activeSessionId,
    setActiveSessionId,
    isOpen,
    setIsOpen,
    analyze,
    followUp,
    newSession,
    deleteSession,
  }
}
