import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../lib/utils'

interface CardProps {
  title?: string
  children: ReactNode
  className?: string
  onClick?: () => void
  noPad?: boolean
}

export function Card({ title, children, className, onClick, noPad }: CardProps) {
  return (
    <div
      className={cn(
        'bg-[var(--card)] border border-[var(--border)] rounded-lg overflow-hidden',
        onClick && 'cursor-pointer hover:border-[var(--accent)]/40 transition-colors',
        className,
      )}
      onClick={onClick}
    >
      {title && (
        <div className="px-4 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-widest text-[var(--dim)]">
          {title}
        </div>
      )}
      <div className={noPad ? '' : 'px-4 pb-4 pt-3'}>{children}</div>
    </div>
  )
}

/* ── Section ─────────────────────────────────────────────────────────────── */
/* Full-width separator with label, collapsible. Datadog-style section header */

interface SectionProps {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  collapsible?: boolean
  actions?: ReactNode
  className?: string
  badge?: ReactNode
}

export function Section({
  title,
  children,
  defaultOpen = true,
  collapsible = true,
  actions,
  className,
  badge,
}: SectionProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={cn('', className)}>
      {/* Header row */}
      <div
        className={cn(
          'flex items-center gap-3 py-2.5',
          collapsible && 'cursor-pointer group',
        )}
        onClick={() => collapsible && setOpen(o => !o)}
      >
        <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--dim)] shrink-0 select-none">
          — {title}
        </span>
        {badge && <span className="shrink-0">{badge}</span>}
        <div className="flex-1 h-px bg-[var(--border)]" />
        {actions && (
          <div
            className="shrink-0"
            onClick={e => e.stopPropagation()}
          >
            {actions}
          </div>
        )}
        {collapsible && (
          <ChevronDown
            size={13}
            className={cn(
              'text-[var(--dim)] transition-transform duration-150 shrink-0',
              collapsible && 'group-hover:text-[var(--text)]',
              !open && '-rotate-90',
            )}
          />
        )}
      </div>

      {/* Content */}
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}
