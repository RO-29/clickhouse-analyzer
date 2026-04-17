import { type LucideIcon } from 'lucide-react'
import { cn } from '../lib/utils'

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
  className?: string
  size?: 'sm' | 'md' | 'lg'
}

export function EmptyState({ icon: Icon, title, description, action, className, size = 'md' }: EmptyStateProps) {
  const iconSize = size === 'sm' ? 20 : size === 'lg' ? 48 : 32
  return (
    <div className={cn(
      'flex flex-col items-center justify-center text-center',
      size === 'sm' ? 'py-6 gap-2' : size === 'lg' ? 'py-20 gap-4' : 'py-12 gap-3',
      className,
    )}>
      {Icon && <Icon size={iconSize} className="text-[var(--dim)] opacity-40" />}
      <div>
        <div className={cn('font-medium text-[var(--text)]', size === 'sm' ? 'text-xs' : 'text-sm')}>{title}</div>
        {description && <div className={cn('text-[var(--dim)] mt-0.5', size === 'sm' ? 'text-[10px]' : 'text-xs')}>{description}</div>}
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs hover:opacity-90 transition-opacity"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
