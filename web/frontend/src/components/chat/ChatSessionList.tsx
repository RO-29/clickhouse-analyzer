import { useState, useMemo } from 'react'
import { SquarePen, Search, Trash2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ChatSession } from '../../types/api'

/* ─── Props ──────────────────────────────────────────────────────────────── */

interface ChatSessionListProps {
  sessions: ChatSession[]
  activeChatId: string | null
  onNewChat: () => void
  onSelectChat: (id: string) => void
  onDeleteChat: (id: string) => void
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function getDateGroup(updatedAt: number): string {
  const now = new Date()
  const d = new Date(updatedAt)

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86_400_000
  const weekStart = todayStart - 6 * 86_400_000

  if (updatedAt >= todayStart) return 'Today'
  if (updatedAt >= yesterdayStart) return 'Yesterday'
  if (updatedAt >= weekStart) return 'This week'
  return 'Earlier'
}

const GROUP_ORDER = ['Today', 'Yesterday', 'This week', 'Earlier']

function fmtRelativeTime(updatedAt: number): string {
  const todayStart = new Date().setHours(0, 0, 0, 0)

  if (updatedAt >= todayStart) {
    // Show time HH:MM
    return new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  // Show date
  return new Date(updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function getSessionStatus(session: ChatSession): 'streaming' | 'error' | 'done' {
  if (!session.messages.length) return 'done'
  const last = session.messages[session.messages.length - 1]
  if (last.status === 'streaming') return 'streaming'
  if (last.status === 'error') return 'error'
  // Check if any message is streaming
  if (session.messages.some(m => m.status === 'streaming')) return 'streaming'
  return 'done'
}

function StatusDot({ status }: { status: 'streaming' | 'error' | 'done' }) {
  if (status === 'streaming') {
    return (
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse shrink-0" />
    )
  }
  if (status === 'error') {
    return (
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
    )
  }
  return (
    <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
  )
}

/* ─── Component ──────────────────────────────────────────────────────────── */

export function ChatSessionList({
  sessions,
  activeChatId,
  onNewChat,
  onSelectChat,
  onDeleteChat,
}: ChatSessionListProps) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter(s => s.name.toLowerCase().includes(q))
  }, [sessions, query])

  // Group into buckets
  const grouped = useMemo(() => {
    const buckets: Record<string, ChatSession[]> = {}
    for (const s of filtered) {
      const g = getDateGroup(s.updatedAt)
      if (!buckets[g]) buckets[g] = []
      buckets[g].push(s)
    }
    return buckets
  }, [filtered])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--dim)]">
          Chats
        </span>
        <button
          type="button"
          onClick={onNewChat}
          className="text-[var(--dim)] hover:text-[var(--fg)] transition-colors p-0.5 rounded"
          title="New chat"
        >
          <SquarePen size={14} />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2 shrink-0">
        <div className="relative">
          <Search
            size={12}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--dim)] pointer-events-none"
          />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search chats…"
            className={cn(
              'w-full bg-[var(--surface)] border border-[var(--border)] rounded-lg',
              'pl-7 pr-3 py-1.5 text-xs',
              'focus:outline-none focus:border-[var(--accent)] transition-colors',
              'placeholder:text-[var(--dim)]',
            )}
          />
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-3 min-h-0">
        {filtered.length === 0 && (
          <div className="text-xs text-[var(--dim)] text-center py-8">
            {sessions.length === 0 ? 'No chats yet' : 'No matches'}
          </div>
        )}

        {GROUP_ORDER.filter(g => grouped[g]?.length).map(group => (
          <div key={group}>
            {/* Date label */}
            <div className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--dim)]">
              {group}
            </div>

            <div className="space-y-0.5">
              {grouped[group].map(session => {
                const isActive = session.id === activeChatId
                const status = getSessionStatus(session)

                return (
                  <div
                    key={session.id}
                    className={cn(
                      'group relative border rounded-lg px-3 py-2 cursor-pointer transition-colors text-sm',
                      isActive
                        ? 'bg-[var(--accent)]/10 border-[var(--accent)]/20 text-[var(--accent)]'
                        : 'hover:bg-[var(--hover)] border-transparent text-[var(--fg)]',
                    )}
                    onClick={() => onSelectChat(session.id)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <StatusDot status={status} />
                      <span className="truncate flex-1 text-xs leading-snug">
                        {session.name || 'Untitled'}
                      </span>
                      <span
                        className={cn(
                          'text-[10px] shrink-0',
                          isActive ? 'text-[var(--accent)]/70' : 'text-[var(--dim)]',
                        )}
                      >
                        {fmtRelativeTime(session.updatedAt)}
                      </span>
                    </div>

                    {/* Delete button — appears on hover */}
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation()
                        onDeleteChat(session.id)
                      }}
                      className={cn(
                        'absolute right-1.5 top-1/2 -translate-y-1/2',
                        'p-1 rounded text-[var(--dim)] hover:text-red-400',
                        'opacity-0 group-hover:opacity-100 transition-opacity',
                        'bg-[var(--card)]',
                      )}
                      title="Delete chat"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
