import type { ReactNode } from 'react'
import { cn } from '../lib/utils'

interface CardProps {
  title?: string
  children: ReactNode
  className?: string
  onClick?: () => void
}

export function Card({ title, children, className, onClick }: CardProps) {
  return (
    <div
      className={cn(
        'bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden',
        onClick && 'cursor-pointer hover:border-[var(--accent)] transition-colors',
        className,
      )}
      onClick={onClick}
    >
      {title && (
        <div className="px-5 pt-4 pb-2 text-xs font-semibold uppercase tracking-wider text-[var(--dim)]">
          {title}
        </div>
      )}
      <div className="px-5 pb-4 pt-3">{children}</div>
    </div>
  )
}
