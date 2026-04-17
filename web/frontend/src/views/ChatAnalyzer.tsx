import { useState, useEffect, useRef, useCallback } from 'react'
import { SquarePen } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { ChatSessionList } from '../components/chat/ChatSessionList'
import { ChatWelcome } from '../components/chat/ChatWelcome'
import { ChatMessage } from '../components/chat/ChatMessage'
import { ChatInput } from '../components/chat/ChatInput'
import { notifyDone, notifyError, requestNotifPermission } from '../lib/notify'
import type { ChatSession, ChatMessage as ChatMessageType, StepInfo, ThinkingLine, ChatLogEntry } from '../types/api'

/* ─── Starter questions ───────────────────────────────────────────────────── */

const STARTER_QUESTIONS = [
  "What are the slowest queries in the last hour?",
  "Are there any memory pressure issues right now?",
  "Which tables are consuming the most storage?",
  "Show me insert failures in the last 24 hours",
  "Are there any failed merges or mutations?",
  "What's causing the most disk I/O?",
  "Are there replication lag issues?",
  "What's the health score trend for this instance?",
]

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
  // Track message start time for log entry offsets
  const msgStartMsRef = useRef<number>(0)

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
        logs: [],
      }
      msgStartMsRef.current = now + 1

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

          // Helper: append a log entry to the active message
          const appendLog = (entry: ChatLogEntry) => {
            setChatSessions(prev =>
              prev.map(s =>
                s.id === sessionId
                  ? {
                      ...s,
                      messages: s.messages.map(m =>
                        m.id === assistantMsgId
                          ? { ...m, logs: [...(m.logs ?? []), entry] }
                          : m
                      ),
                    }
                  : s
              )
            )
          }

          const mkLog = (partial: Omit<ChatLogEntry, 'ts' | 'offsetMs'>): ChatLogEntry => {
            const ts = Date.now()
            return { ...partial, ts, offsetMs: ts - msgStartMsRef.current }
          }

          // Track tool id → label for log entry text in tool_done
          const toolLabelMap = new Map<string, string>()

          const processLine = (line: string) => {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              const raw = line.slice(6)

              if (currentEvent === 'debug') {
                try {
                  const dbg = JSON.parse(raw)
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
                  appendLog(mkLog({
                    kind: 'debug',
                    text: `Prompt ready — ${(dbg.prompt_kb ?? 0).toFixed(1)} KB${dbg.truncated ? ' (truncated)' : ''} · mode: ${dbg.mode ?? '?'}`,
                    promptKb: dbg.prompt_kb,
                    truncated: dbg.truncated,
                    mode: dbg.mode,
                  }))
                } catch { /* ignore */ }

              } else if (currentEvent === 'status') {
                try {
                  const payload = JSON.parse(raw) as { phase: string }
                  updateAssistantMsg(sessionId, assistantMsgId, {
                    phase: payload.phase as ChatMessageType['phase'],
                  })
                  const phaseLabel: Record<string, string> = {
                    planning: 'Planning queries…',
                    collecting: 'Collecting data…',
                    streaming: 'Writing response…',
                    done: 'Done',
                    error: 'Error',
                  }
                  appendLog(mkLog({
                    kind: 'phase',
                    text: phaseLabel[payload.phase] ?? payload.phase,
                    phase: payload.phase,
                  }))
                } catch {
                  // ignore
                }

              } else if (currentEvent === 'thinking') {
                try {
                  const payload = JSON.parse(raw) as { text: string }
                  const thinkLine: ThinkingLine = { kind: 'plan', text: payload.text }
                  setChatSessions(prev =>
                    prev.map(s =>
                      s.id === sessionId
                        ? {
                            ...s,
                            messages: s.messages.map(m =>
                              m.id === assistantMsgId
                                ? {
                                    ...m,
                                    thinkingLines: [...(m.thinkingLines ?? []), thinkLine],
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
                  const label = payload.label ?? payload.name
                  toolLabelMap.set(payload.id, label)
                  const step: StepInfo = {
                    id: payload.id,
                    label,
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
                  appendLog(mkLog({
                    kind: 'tool_start',
                    text: label,
                    sql: payload.sql,
                  }))
                } catch {
                  // ignore
                }

              } else if (currentEvent === 'tool_done') {
                try {
                  // Backend sends: { id, elapsed_ms, rows }
                  const payload = JSON.parse(raw) as {
                    id: string
                    elapsed_ms?: number
                    rows?: number
                  }
                  const rowCount = payload.rows
                  const elapsedMs = payload.elapsed_ms
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
                                            rowCount,
                                            elapsedMs,
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
                  appendLog(mkLog({
                    kind: 'tool_done',
                    text: toolLabelMap.get(payload.id) ?? payload.id,
                    rowCount,
                    elapsedMs,
                  }))
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
                  appendLog(mkLog({ kind: 'error', text: errMsg }))
                } catch {
                  updateAssistantMsg(sessionId, assistantMsgId, {
                    status: 'error',
                    phase: 'error',
                    content: raw,
                  })
                  appendLog(mkLog({ kind: 'error', text: raw }))
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
          const totalMs = Date.now() - msgStartMsRef.current
          appendLog(mkLog({
            kind: 'done',
            text: `Response complete in ${totalMs < 1000 ? `${totalMs}ms` : `${(totalMs / 1000).toFixed(1)}s`}`,
          }))
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
              <span className="truncate text-sm font-medium text-[var(--fg)] flex-1 min-w-0" title={activeSession.name || 'Untitled'}>
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
              {activeSession.messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full gap-6 px-6">
                  <div className="text-center">
                    <div className="text-lg font-semibold mb-1">What would you like to analyze?</div>
                    <div className="text-sm text-[var(--dim)]">Ask anything about this ClickHouse instance</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 max-w-lg w-full">
                    {STARTER_QUESTIONS.map(q => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => handleSend(q)}
                        className="text-left px-3 py-2 text-xs rounded-lg border border-[var(--border)] hover:border-[var(--accent)]/50 hover:bg-[var(--accent)]/5 transition-colors text-[var(--text)]"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {activeSession.messages.map((msg, i) => {
                const isLast = i === activeSession.messages.length - 1
                const lastUserMsg = isLast && msg.role === 'assistant' && msg.status === 'error'
                  ? [...activeSession.messages].reverse().find(m => m.role === 'user')
                  : undefined
                return (
                  <ChatMessage
                    key={msg.id}
                    message={msg}
                    isLast={isLast}
                    onRetry={lastUserMsg ? () => handleSend(lastUserMsg.content) : undefined}
                  />
                )
              })}
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
