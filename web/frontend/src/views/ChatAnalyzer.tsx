import { useState, useEffect, useRef, useCallback } from 'react'
import { SquarePen } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { ChatSessionList } from '../components/chat/ChatSessionList'
import { ChatWelcome } from '../components/chat/ChatWelcome'
import { ChatMessage } from '../components/chat/ChatMessage'
import { ChatInput } from '../components/chat/ChatInput'
import { notifyDone, notifyError, requestNotifPermission } from '../lib/notify'
import type { ChatSession, ChatMessage as ChatMessageType, StepInfo, ThinkingLine } from '../types/api'

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/* ─── Main component ─────────────────────────────────────────────────────── */

export default function ChatAnalyzer() {
  const {
    instances,
    selectedInstance,
    chatSessions,
    setChatSessions,
    activeChatId,
    setActiveChatId,
  } = useStore()

  const [instance, setInstance] = useState(() => selectedInstance || instances[0] || '')
  const [timeWindowMins, setTimeWindowMins] = useState(180)
  const [isRunning, setIsRunning] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Track the active assistant message id to update it during streaming
  const activeAssistantIdRef = useRef<string | null>(null)
  // Track the active session id for functional updaters
  const activeSessionIdRef = useRef<string | null>(null)

  // Sync instance when selectedInstance or instances list changes
  useEffect(() => {
    if (selectedInstance && !instance) setInstance(selectedInstance)
    else if (!instance && instances.length > 0) setInstance(instances[0])
  }, [selectedInstance, instances]) // eslint-disable-line react-hooks/exhaustive-deps

  // On mount: if activeChatId refers to a deleted session, clear it
  useEffect(() => {
    if (activeChatId && !chatSessions.find(s => s.id === activeChatId)) {
      setActiveChatId(null)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatSessions, activeChatId])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const activeSession = chatSessions.find(s => s.id === activeChatId) ?? null

  /* ─── Helpers for updating a specific assistant message ─────────────────── */

  const updateAssistantMsg = useCallback(
    (sessId: string, msgId: string, patch: Partial<ChatMessageType>) => {
      setChatSessions(prev =>
        prev.map(s =>
          s.id === sessId
            ? {
                ...s,
                updatedAt: Date.now(),
                messages: s.messages.map(m =>
                  m.id === msgId ? { ...m, ...patch } : m
                ),
              }
            : s
        )
      )
    },
    [setChatSessions]
  )

  /* ─── Delete chat ────────────────────────────────────────────────────────── */

  const handleDeleteChat = useCallback(
    (id: string) => {
      setChatSessions(prev => prev.filter(s => s.id !== id))
      if (activeChatId === id) {
        setActiveChatId(null)
      }
    },
    [activeChatId, setChatSessions, setActiveChatId]
  )

  /* ─── Stop stream ────────────────────────────────────────────────────────── */

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null

    const sessId = activeSessionIdRef.current
    const msgId = activeAssistantIdRef.current
    if (sessId && msgId) {
      updateAssistantMsg(sessId, msgId, { status: 'done', phase: 'done' })
    }
    setIsRunning(false)
  }, [updateAssistantMsg])

  /* ─── Send message ───────────────────────────────────────────────────────── */

  const handleSend = useCallback(
    (text: string) => {
      if (!text.trim() || !instance) return

      // Request browser notification permission when user sends a message
      requestNotifPermission()

      // Abort any running stream
      abortRef.current?.abort()
      abortRef.current = null

      const now = Date.now()

      const userMsg: ChatMessageType = {
        id: genId(),
        role: 'user',
        content: text.trim(),
        status: 'done',
        timestamp: now,
      }

      const assistantMsgId = genId()
      const assistantMsg: ChatMessageType = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        phase: 'planning',
        timestamp: now + 1,
        thinkingLines: [],
        steps: [],
      }

      let sessionId: string

      // Find existing active session or create new one
      const existingSession = activeChatId
        ? chatSessions.find(s => s.id === activeChatId)
        : null

      if (existingSession) {
        sessionId = existingSession.id
        setChatSessions(prev =>
          prev.map(s =>
            s.id === sessionId
              ? {
                  ...s,
                  updatedAt: now,
                  messages: [...s.messages, userMsg, assistantMsg],
                }
              : s
          )
        )
      } else {
        sessionId = genId()
        const newSession: ChatSession = {
          id: sessionId,
          name: text.slice(0, 60),
          instance,
          timeWindowMins,
          createdAt: now,
          updatedAt: now,
          messages: [userMsg, assistantMsg],
        }
        setChatSessions(prev => [newSession, ...prev])
      }

      activeSessionIdRef.current = sessionId
      activeAssistantIdRef.current = assistantMsgId
      setActiveChatId(sessionId)
      setIsRunning(true)

      // Build conversation history (last 10 messages, excluding the new ones)
      const history = (existingSession?.messages ?? [])
        .slice(-10)
        .map(m => ({ role: m.role, content: m.content }))

      const ctrl = new AbortController()
      abortRef.current = ctrl

      const body = JSON.stringify({
        question: text.trim(),
        history,
        time_window_mins: timeWindowMins,
      })

      fetch(`/api/instances/${instance}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      })
        .then(async res => {
          if (!res.ok) {
            const errText = await res.text().catch(() => 'Unknown error')
            updateAssistantMsg(sessionId, assistantMsgId, {
              status: 'error',
              phase: 'error',
              content: errText,
            })
            setIsRunning(false)
            return
          }

          const reader = res.body!.getReader()
          const decoder = new TextDecoder()
          let remainder = ''
          let currentEvent = ''

          const processLine = (line: string) => {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              const raw = line.slice(6)

              // Log every SSE event to the browser console for debugging
              // eslint-disable-next-line no-console
              console.debug('[CH-CHAT] event:', currentEvent, '|', raw.slice(0, 300))

              if (currentEvent === 'debug') {
                try {
                  const dbg = JSON.parse(raw)
                  // eslint-disable-next-line no-console
                  console.log('[CH-CHAT] ── Debug payload ──', dbg)
                  if (dbg.prompt_head) {
                    // eslint-disable-next-line no-console
                    console.log('[CH-CHAT] ── Prompt sent to Claude (first 5 KB) ──\n' + dbg.prompt_head)
                  }
                  // Store evidence in the message so EvidencePanel can show it
                  updateAssistantMsg(sessionId, assistantMsgId, {
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
                  })
                } catch { /* ignore */ }

              } else if (currentEvent === 'status') {
                try {
                  const payload = JSON.parse(raw) as { phase: string }
                  updateAssistantMsg(sessionId, assistantMsgId, {
                    phase: payload.phase as ChatMessageType['phase'],
                  })
                } catch {
                  // ignore
                }

              } else if (currentEvent === 'thinking') {
                try {
                  const payload = JSON.parse(raw) as { text: string }
                  const line: ThinkingLine = { kind: 'plan', text: payload.text }
                  setChatSessions(prev =>
                    prev.map(s =>
                      s.id === sessionId
                        ? {
                            ...s,
                            messages: s.messages.map(m =>
                              m.id === assistantMsgId
                                ? {
                                    ...m,
                                    thinkingLines: [...(m.thinkingLines ?? []), line],
                                  }
                                : m
                            ),
                          }
                        : s
                    )
                  )
                } catch {
                  // ignore
                }

              } else if (currentEvent === 'tool_start') {
                try {
                  const payload = JSON.parse(raw) as {
                    id: string
                    name: string
                    label: string
                    sql?: string
                  }
                  const step: StepInfo = {
                    id: payload.id,
                    label: payload.label ?? payload.name,
                    sql: payload.sql,
                    status: 'running',
                  }
                  setChatSessions(prev =>
                    prev.map(s =>
                      s.id === sessionId
                        ? {
                            ...s,
                            messages: s.messages.map(m =>
                              m.id === assistantMsgId
                                ? {
                                    ...m,
                                    steps: [...(m.steps ?? []), step],
                                  }
                                : m
                            ),
                          }
                        : s
                    )
                  )
                } catch {
                  // ignore
                }

              } else if (currentEvent === 'tool_done') {
                try {
                  const payload = JSON.parse(raw) as {
                    id: string
                    rowCount?: number
                    elapsedMs?: number
                  }
                  setChatSessions(prev =>
                    prev.map(s =>
                      s.id === sessionId
                        ? {
                            ...s,
                            messages: s.messages.map(m =>
                              m.id === assistantMsgId
                                ? {
                                    ...m,
                                    steps: (m.steps ?? []).map(step =>
                                      step.id === payload.id
                                        ? {
                                            ...step,
                                            status: 'done' as const,
                                            rowCount: payload.rowCount,
                                            elapsedMs: payload.elapsedMs,
                                          }
                                        : step
                                    ),
                                  }
                                : m
                            ),
                          }
                        : s
                    )
                  )
                } catch {
                  // ignore
                }

              } else if (currentEvent === 'chunk') {
                try {
                  const chunk = JSON.parse(raw) as string
                  setChatSessions(prev =>
                    prev.map(s =>
                      s.id === sessionId
                        ? {
                            ...s,
                            messages: s.messages.map(m =>
                              m.id === assistantMsgId
                                ? {
                                    ...m,
                                    content: m.content + chunk,
                                    phase: 'streaming',
                                  }
                                : m
                            ),
                          }
                        : s
                    )
                  )
                } catch {
                  // ignore
                }

              } else if (currentEvent === 'error') {
                try {
                  const errMsg = JSON.parse(raw) as string
                  updateAssistantMsg(sessionId, assistantMsgId, {
                    status: 'error',
                    phase: 'error',
                    content: errMsg,
                  })
                } catch {
                  updateAssistantMsg(sessionId, assistantMsgId, {
                    status: 'error',
                    phase: 'error',
                    content: raw,
                  })
                }
              }

              currentEvent = ''
            }
          }

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            const text = remainder + decoder.decode(value, { stream: true })
            const lines = text.split('\n')
            remainder = lines.pop() ?? ''
            for (const line of lines) processLine(line)
          }
          if (remainder) processLine(remainder)

          // Stream complete
          updateAssistantMsg(sessionId, assistantMsgId, {
            status: 'done',
            phase: 'done',
          })
          notifyDone(text.trim().slice(0, 60))
          setIsRunning(false)
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === 'AbortError') return
          const msg = err instanceof Error ? err.message : 'Stream error'
          updateAssistantMsg(sessionId, assistantMsgId, {
            status: 'error',
            phase: 'error',
            content: msg,
          })
          notifyError(text.trim().slice(0, 60))
          setIsRunning(false)
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instance, timeWindowMins, activeChatId, chatSessions, setChatSessions, setActiveChatId, updateAssistantMsg]
  )

  /* ─── Render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar */}
      <div className="w-64 shrink-0 border-r border-[var(--border)] flex flex-col bg-[var(--card)]">
        <ChatSessionList
          sessions={chatSessions}
          activeChatId={activeChatId}
          onNewChat={() => setActiveChatId(null)}
          onSelectChat={setActiveChatId}
          onDeleteChat={handleDeleteChat}
        />
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {!activeSession ? (
          <div className="flex-1 overflow-y-auto">
            <ChatWelcome onSend={handleSend} />
          </div>
        ) : (
          <>
            {/* Chat header bar */}
            <div className="px-6 py-3 border-b border-[var(--border)] shrink-0 bg-[var(--card)] flex items-center gap-3">
              <span className="truncate text-sm font-medium text-[var(--fg)] flex-1 min-w-0">
                {activeSession.name || 'Untitled'}
              </span>
              <span className="bg-[var(--surface)] border border-[var(--border)] text-xs px-2 py-0.5 rounded text-[var(--dim)] shrink-0">
                {activeSession.instance}
              </span>
              <button
                type="button"
                onClick={() => setActiveChatId(null)}
                title="New chat"
                className="shrink-0 text-[var(--dim)] hover:text-[var(--fg)] transition-colors p-1 rounded"
              >
                <SquarePen size={15} />
              </button>
            </div>

            {/* Message list */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
              {activeSession.messages.map((msg, i) => (
                <ChatMessage
                  key={msg.id}
                  message={msg}
                  isLast={i === activeSession.messages.length - 1}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          </>
        )}

        {/* Input always visible */}
        <ChatInput
          instances={instances}
          instance={instance}
          onInstanceChange={setInstance}
          timeWindowMins={timeWindowMins}
          onTimeWindowChange={setTimeWindowMins}
          onSubmit={handleSend}
          onStop={handleStop}
          isRunning={isRunning}
        />
      </div>
    </div>
  )
}
