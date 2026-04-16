import type { ReactNode } from 'react'
import { cn, sevColor } from '../lib/utils'

interface BadgeProps {
  severity?: string
  children?: ReactNode
  className?: string
  dot?: boolean
}

export function Badge({ severity, children, className, dot }: BadgeProps) {
  const colorClass = severity ? sevColor(severity) : ''
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold border',
        colorClass,
        className,
      )}
    >
      {dot && (
        <span className={cn(
          'w-1.5 h-1.5 rounded-full shrink-0',
          severity === 'critical' ? 'bg-red-400' : severity === 'warn' ? 'bg-yellow-400' : 'bg-blue-400',
        )} />
      )}
      {children ?? severity}
    </span>
  )
}
