import { useRef, useState, useCallback, useEffect } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { cn } from '../../lib/utils'

/* ─── Constants ──────────────────────────────────────────────────────────── */

const TIME_WINDOWS = [
  { label: '15m', mins: 15 },
  { label: '1h',  mins: 60 },
  { label: '3h',  mins: 180 },
  { label: '6h',  mins: 360 },
  { label: '24h', mins: 1440 },
  { label: '3d',  mins: 4320 },
]

/* ─── Props ──────────────────────────────────────────────────────────────── */

interface ChatInputProps {
  instances: string[]
  instance: string
  onInstanceChange: (v: string) => void
  timeWindowMins: number
  onTimeWindowChange: (v: number) => void
  onSubmit: (text: string) => void
  onStop: () => void
  isRunning: boolean
  disabled?: boolean
}

/* ─── Component ──────────────────────────────────────────────────────────── */

export function ChatInput({
  instances,
  instance,
  onInstanceChange,
  timeWindowMins,
  onTimeWindowChange,
  onSubmit,
  onStop,
  isRunning,
  disabled,
}: ChatInputProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea (1–4 rows)
  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const lineHeight = 20 // approx px per line
    const minH = lineHeight + 20  // 1 row + padding
    const maxH = lineHeight * 4 + 20
    el.style.height = Math.min(maxH, Math.max(minH, el.scrollHeight)) + 'px'
  }, [])

  useEffect(() => {
    resize()
  }, [text, resize])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        const trimmed = text.trim()
        if (!trimmed || isRunning || disabled) return
        onSubmit(trimmed)
        setText('')
      }
    },
    [text, isRunning, disabled, onSubmit],
  )

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || isRunning || disabled) return
    onSubmit(trimmed)
    setText('')
  }, [text, isRunning, disabled, onSubmit])

  const canSend = text.trim().length > 0 && !isRunning && !disabled

  return (
    <div className="border-t border-[var(--border)] bg-[var(--card)] px-4 py-3 space-y-2.5">
      {/* Top row: instance select + time window pills */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Instance select */}
        <select
          value={instance}
          onChange={e => onInstanceChange(e.target.value)}
          disabled={disabled}
          className={cn(
            'bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2.5 py-1 text-xs',
            'focus:outline-none focus:border-[var(--accent)] transition-colors',
            disabled && 'opacity-50 cursor-not-allowed',
          )}
        >
          {instances.length === 0 && <option value="">No instances</option>}
          {instances.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>

        {/* Time window pills */}
        <div className="flex items-center gap-1">
          {TIME_WINDOWS.map(tw => (
            <button
              key={tw.mins}
              type="button"
              onClick={() => onTimeWindowChange(tw.mins)}
              disabled={disabled}
              className={cn(
                'px-2 py-0.5 rounded-md text-xs transition-colors',
                timeWindowMins === tw.mins
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--dim)] hover:text-[var(--fg)] hover:bg-[var(--hover)]',
                disabled && 'opacity-50 cursor-not-allowed',
              )}
            >
              {tw.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main row: textarea + action button */}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="Ask anything about your ClickHouse cluster…"
          rows={1}
          className={cn(
            'flex-1 resize-none rounded-xl border border-[var(--border)] bg-[var(--surface)]',
            'px-4 py-2.5 text-sm focus:outline-none focus:border-[var(--accent)]',
            'transition-colors placeholder:text-[var(--dim)]',
            disabled && 'opacity-50 cursor-not-allowed',
          )}
        />

        {isRunning ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-xl border border-red-500/50 text-red-400 hover:bg-red-500/10 px-3 py-2.5 transition-colors shrink-0"
            title="Stop"
          >
            <Square size={15} />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="rounded-xl bg-[var(--accent)] text-white px-3 py-2.5 hover:opacity-90 disabled:opacity-40 transition-opacity shrink-0"
            title="Send"
          >
            <ArrowUp size={15} />
          </button>
        )}
      </div>
    </div>
  )
}
