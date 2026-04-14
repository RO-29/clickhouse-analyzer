import { useMemo, useRef, useEffect, useState } from 'react'
import { ChevronUp, ChevronDown, Sparkles, Zap, Trash2, Plus, Send, X } from 'lucide-react'
import { marked } from 'marked'
import { cn } from '../lib/utils'
import { useStore } from '../hooks/useStore'
import { QueryConfirmDialog } from './QueryConfirmDialog'
import { validateAllReadOnly } from '../lib/sqlValidator'
import type { ChatSession, ChatMessage, AnalyzeOptions } from '../types/api'

marked.use({ gfm: true, breaks: false })

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface DeepQueryInfo {
  tab: string
  elementId?: string
  queries: Array<{ sql: string; description: string }>
  description: string
  sessionName: string
}

interface AIAnalysisPanelProps {
  instance: string
  isOpen: boolean
  onToggle: () => void
  onAnalyze: (label: string, data: Record<string, any>, options: AnalyzeOptions) => void
  onFollowUp: (question: string) => void
  onNewSession: () => void
  onDeleteSession: (id: string) => void
  onSelectSession: (id: string) => void
  sessions: ChatSession[]
  activeSessionId: string | null
}

/* -------------------------------------------------------------------------- */
/*  Inline styles                                                             */
/* -------------------------------------------------------------------------- */

const PANEL_STYLES = `
  .analysis-output h1 { font-size: 1.1rem; font-weight: 700; margin: 1rem 0 0.5rem; }
  .analysis-output h2 { font-size: 1rem; font-weight: 600; margin: 0.875rem 0 0.4rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; }
  .analysis-output h3 { font-size: 0.875rem; font-weight: 600; margin: 0.75rem 0 0.3rem; }
  .analysis-output h4 { font-size: 0.8125rem; font-weight: 600; margin: 0.5rem 0 0.25rem; }
  .analysis-output p { margin: 0.3rem 0; }
  .analysis-output strong { font-weight: 600; }
  .analysis-output em { font-style: italic; }
  .analysis-output ul { padding-left: 1.25rem; margin: 0.3rem 0; list-style: disc; }
  .analysis-output ol { padding-left: 1.25rem; margin: 0.3rem 0; list-style: decimal; }
  .analysis-output li { margin: 0.15rem 0; }
  .analysis-output li > p { margin: 0; }
  .analysis-output hr { border: none; border-top: 1px solid var(--border); margin: 0.75rem 0; }
  .analysis-output pre { font-family: monospace; font-size: 0.75rem; background: var(--code-bg, var(--hover)); border: 1px solid var(--border); border-radius: 0.375rem; padding: 0.625rem; margin: 0.35rem 0; white-space: pre; overflow-x: auto; }
  .analysis-output code { font-family: monospace; font-size: 0.75rem; background: var(--hover); border-radius: 0.2rem; padding: 0.1rem 0.25rem; }
  .analysis-output pre code { background: none; padding: 0; border-radius: 0; }
  .analysis-output table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; font-size: 0.75rem; }
  .analysis-output th, .analysis-output td { border: 1px solid var(--border); padding: 0.3rem 0.6rem; text-align: left; }
  .analysis-output th { background: var(--hover); font-weight: 600; }
  .analysis-output blockquote { border-left: 3px solid var(--accent); padding-left: 0.75rem; margin: 0.4rem 0; color: var(--dim); }
  .analysis-output .sev-critical { color: #ef4444; font-weight: 700; }
  .analysis-output .sev-warning  { color: #f97316; font-weight: 700; }
  .analysis-output .sev-info     { color: #eab308; font-weight: 700; }
  .streaming-cursor { display: inline-block; width: 8px; height: 14px; background: currentColor; opacity: 0.6; margin-left: 2px; vertical-align: middle; animation: blink 1s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
`

/* -------------------------------------------------------------------------- */
/*  Markdown renderer                                                         */
/* -------------------------------------------------------------------------- */

function renderMd(text: string, isStreaming: boolean): string {
  let out = marked.parse(text) as string
  out = out
    .replace(/🔴\s*<strong>CRITICAL<\/strong>/g, '<span class="sev-critical">🔴 CRITICAL</span>')
    .replace(/🟠\s*<strong>WARNING<\/strong>/g, '<span class="sev-warning">🟠 WARNING</span>')
    .replace(/🟡\s*<strong>INFO<\/strong>/g, '<span class="sev-info">🟡 INFO</span>')
    .replace(/🔴 CRITICAL(?!<)/g, '<span class="sev-critical">🔴 CRITICAL</span>')
    .replace(/🟠 WARNING(?!<)/g, '<span class="sev-warning">🟠 WARNING</span>')
    .replace(/🟡 INFO(?!<)/g, '<span class="sev-info">🟡 INFO</span>')
  if (isStreaming) out += '<span class="streaming-cursor"></span>'
  return out
}

/* -------------------------------------------------------------------------- */
/*  Date formatter                                                            */
/* -------------------------------------------------------------------------- */

function fmtTs(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ' · ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/* -------------------------------------------------------------------------- */
/*  Session card (left sidebar)                                              */
/* -------------------------------------------------------------------------- */

function SessionCard({
  session,
  isActive,
  onClick,
  onDelete,
}: {
  session: ChatSession
  isActive: boolean
  onClick: () => void
  onDelete: () => void
}) {
  const isStreaming = session.messages.some(m => m.role === 'assistant' && m.status === 'streaming')
  const msgCount = session.messages.length

  return (
    <div
      className={cn(
        'group relative cursor-pointer px-3 py-2.5 border-b border-[var(--border)] transition-colors hover:bg-[var(--hover)]',
        isActive && 'bg-purple-500/10 border-l-2 border-l-purple-400',
      )}
      onClick={onClick}
    >
      {/* Delete button */}
      <button
        onClick={e => { e.stopPropagation(); onDelete() }}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--dim)] hover:text-red-400 transition-all"
        title="Delete session"
      >
        <X size={11} />
      </button>

      {/* Name */}
      <div className="text-xs font-medium text-[var(--text)] line-clamp-2 pr-4 leading-snug">
        {session.name}
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-2 mt-1">
        {isStreaming && <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse flex-none" />}
        {!isStreaming && <span className="w-1.5 h-1.5 rounded-full bg-green-400/60 flex-none" />}
        <span className="text-[10px] text-[var(--dim)] flex-1 truncate">{fmtTs(session.updatedAt)}</span>
        <span className="text-[10px] text-[var(--dim)] flex-none">{msgCount}</span>
      </div>

      {/* Instance badge */}
      {session.instance && (
        <div className="mt-1 text-[10px] text-purple-400/70 truncate">{session.instance}</div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  User message bubble                                                       */
/* -------------------------------------------------------------------------- */

function UserBubble({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end px-4 py-2">
      <div className="max-w-[80%] bg-purple-500/15 border border-purple-500/20 rounded-2xl rounded-tr-sm px-3 py-2">
        <p className="text-xs text-[var(--text)] leading-relaxed whitespace-pre-wrap">{message.content}</p>
        <p className="text-[10px] text-[var(--dim)] mt-1 text-right">{fmtTs(message.timestamp)}</p>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Assistant message                                                         */
/* -------------------------------------------------------------------------- */

function AssistantMessage({
  message,
  isLoadingDeep,
  onGoDeeper,
}: {
  message: ChatMessage
  isLoadingDeep: boolean
  onGoDeeper: () => void
}) {
  const isStreaming = message.status === 'streaming'

  const html = useMemo(
    () => (message.content ? renderMd(message.content, isStreaming) : ''),
    [message.content, isStreaming],
  )

  const statusDot = {
    streaming: 'bg-yellow-400 animate-pulse',
    done: 'bg-green-400',
    error: 'bg-red-400',
  }[message.status]

  return (
    <div className="px-4 py-4 space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Sparkles size={11} className="text-purple-400 flex-none" />
        <span className="flex items-center gap-1 text-[10px] text-[var(--dim)]">
          <span className={cn('inline-block w-1.5 h-1.5 rounded-full', statusDot)} />
          {isStreaming ? 'Analyzing…' : message.status === 'error' ? 'Error' : 'Done'}
        </span>
        <span className="text-[10px] text-[var(--dim)] ml-auto">{fmtTs(message.timestamp)}</span>
      </div>

      {/* Content */}
      {message.content ? (
        <div
          className="analysis-output text-sm leading-relaxed pl-[18px]"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : isStreaming ? (
        <div className="text-xs text-[var(--dim)] animate-pulse pl-[18px]">Thinking…</div>
      ) : null}

      {/* Go Deeper button — only for done assistant messages that have elementId context */}
      {message.status === 'done' && onGoDeeper && (
        <div className="pl-[18px]">
          <button
            onClick={onGoDeeper}
            disabled={isLoadingDeep}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-purple-500/15 text-purple-400 hover:bg-purple-500/25 border border-purple-500/20 transition-colors disabled:opacity-50"
          >
            <Zap size={9} />
            {isLoadingDeep ? 'Loading…' : 'Go Deeper'}
          </button>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Panel                                                                     */
/* -------------------------------------------------------------------------- */

export function AIAnalysisPanel({
  instance,
  isOpen,
  onToggle,
  onAnalyze,
  onFollowUp,
  onNewSession,
  onDeleteSession,
  onSelectSession,
  sessions,
  activeSessionId,
}: AIAnalysisPanelProps) {
  const { sidebarCollapsed } = useStore()
  const [confirmDialog, setConfirmDialog] = useState<DeepQueryInfo | null>(null)
  const [loadingDeep, setLoadingDeep] = useState<string | null>(null)
  const [followUpText, setFollowUpText] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const activeSession = sessions.find(s => s.id === activeSessionId) ?? null
  const totalSessions = sessions.length

  // Auto-scroll chat to bottom when new messages arrive while streaming
  useEffect(() => {
    if (isOpen && activeSession?.messages.some(m => m.status === 'streaming')) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [isOpen, activeSession?.messages])

  const handleGoDeeper = async (msg: ChatMessage) => {
    // Go Deeper requires an elementId — stored in message metadata isn't available
    // in the new model, so this is a no-op placeholder kept for compatibility
    void msg
  }

  const handleConfirmDeep = (info: DeepQueryInfo) => {
    setConfirmDialog(null)
    onAnalyze(`Deep: ${info.sessionName}`, {}, {
      contextType: 'row',
      tab: info.tab,
      elementId: info.elementId,
      mode: 'deep',
      deepQueries: info.queries.map(q => q.sql),
    })
  }

  const handleSendFollowUp = () => {
    const q = followUpText.trim()
    if (!q || !activeSessionId) return
    onFollowUp(q)
    setFollowUpText('')
    textareaRef.current?.focus()
  }

  const sidebarWidth = sidebarCollapsed ? '56px' : '220px'

  return (
    <>
      <style>{PANEL_STYLES}</style>

      <div
        className={cn(
          'fixed bottom-0 right-0 z-40 bg-[var(--surface)] border-t border-l border-[var(--border)] flex flex-col',
          'transition-[height] duration-200 ease-in-out',
          isOpen ? 'h-[70vh] min-h-[400px]' : 'h-9',
        )}
        style={{ left: sidebarWidth }}
      >
        {/* Header bar */}
        <div
          className="flex-none flex items-center gap-2 px-4 h-9 cursor-pointer select-none hover:bg-white/[0.02] transition-colors border-b border-[var(--border)]"
          onClick={onToggle}
        >
          <Sparkles size={13} className="text-purple-400 flex-none" />
          <span className="text-xs font-medium text-[var(--dim)] uppercase tracking-wider">AI Analysis</span>
          {totalSessions > 0 && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-500/20 text-purple-400">
              {totalSessions}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {isOpen && (
              <button
                onClick={e => { e.stopPropagation(); onNewSession() }}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium text-[var(--dim)] hover:text-[var(--text)] hover:bg-[var(--hover)] transition-colors border border-[var(--border)]"
                title="New session"
              >
                <Plus size={10} />
                New
              </button>
            )}
            {isOpen ? (
              <ChevronDown size={13} className="text-[var(--dim)]" />
            ) : (
              <ChevronUp size={13} className="text-[var(--dim)]" />
            )}
          </div>
        </div>

        {/* Body: two columns */}
        {isOpen && (
          <div className="flex-1 flex overflow-hidden">

            {/* Left: Sessions list */}
            <div className="w-52 flex-none border-r border-[var(--border)] flex flex-col overflow-hidden bg-[var(--card)]">
              {sessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center flex-1 gap-2 text-[var(--dim)] px-4 text-center">
                  <Sparkles size={18} className="opacity-25" />
                  <p className="text-xs">No sessions yet</p>
                  <p className="text-[10px] opacity-60">Click ✨ on any advisor section to analyze</p>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto">
                  {sessions.map(session => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      isActive={session.id === activeSessionId}
                      onClick={() => onSelectSession(session.id)}
                      onDelete={() => onDeleteSession(session.id)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Right: Chat view */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {!activeSession ? (
                <div className="flex flex-col items-center justify-center flex-1 gap-3 text-[var(--dim)] px-6 text-center">
                  <Sparkles size={24} className="opacity-20" />
                  <div>
                    <p className="text-sm font-medium">Start an analysis</p>
                    <p className="text-xs mt-1 opacity-60">Click ✨ on any advisor section, or select a session from the list</p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Session title bar */}
                  <div className="flex-none px-4 py-2 border-b border-[var(--border)] flex items-center gap-2 bg-[var(--card)]">
                    <Sparkles size={12} className="text-purple-400 flex-none" />
                    <span className="text-xs font-semibold text-[var(--text)] flex-1 truncate">{activeSession.name}</span>
                    {activeSession.instance && (
                      <span className="text-[10px] text-[var(--dim)] flex-none">{activeSession.instance}</span>
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); onDeleteSession(activeSession.id) }}
                      className="p-0.5 rounded text-[var(--dim)] hover:text-red-400 transition-colors ml-1"
                      title="Delete session"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>

                  {/* Messages — scrollable, oldest first (top to bottom) */}
                  <div className="flex-1 overflow-y-auto divide-y divide-[var(--border)]">
                    {activeSession.messages.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-xs text-[var(--dim)]">
                        No messages yet
                      </div>
                    ) : (
                      <>
                        {activeSession.messages.map(msg =>
                          msg.role === 'user' ? (
                            <UserBubble key={msg.id} message={msg} />
                          ) : (
                            <AssistantMessage
                              key={msg.id}
                              message={msg}
                              isLoadingDeep={loadingDeep === msg.id}
                              onGoDeeper={() => handleGoDeeper(msg)}
                            />
                          )
                        )}
                        <div ref={chatEndRef} />
                      </>
                    )}
                  </div>

                  {/* Follow-up input */}
                  <div className="flex-none border-t border-[var(--border)] px-4 py-3 bg-[var(--card)]">
                    <div className="flex gap-2 items-end">
                      <textarea
                        ref={textareaRef}
                        value={followUpText}
                        onChange={e => setFollowUpText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            handleSendFollowUp()
                          }
                        }}
                        placeholder="Ask a follow-up question… (Enter to send, Shift+Enter for newline)"
                        rows={2}
                        className="flex-1 resize-none rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm focus:outline-none focus:border-purple-500/50 placeholder:text-[var(--dim)] transition-colors"
                      />
                      <button
                        onClick={handleSendFollowUp}
                        disabled={!followUpText.trim() || !activeSessionId}
                        className="shrink-0 flex items-center justify-center rounded-lg bg-purple-500/20 border border-purple-500/30 px-3 py-2.5 text-purple-400 hover:bg-purple-500/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed self-end"
                        title="Send follow-up (Enter)"
                      >
                        <Send size={14} />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Confirmation dialog */}
      {confirmDialog && (
        <QueryConfirmDialog
          instance={instance}
          description={confirmDialog.description}
          queries={confirmDialog.queries}
          onConfirm={() => handleConfirmDeep(confirmDialog)}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </>
  )
}
