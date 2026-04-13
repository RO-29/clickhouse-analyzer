import type { ReactNode } from 'react'
import { cn, sevColor } from '../lib/utils'

interface BadgeProps {
  severity?: string
  children?: ReactNode
  className?: string
}

export function Badge({ severity, children, className }: BadgeProps) {
  const colorClass = severity ? sevColor(severity) : ''
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        colorClass,
        className,
      )}
    >
      {children ?? severity}
    </span>
  )
}
