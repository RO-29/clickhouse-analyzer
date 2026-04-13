import { cn, scoreColor, sevColor } from '../lib/utils'
import { Card } from './Card'
import { Badge } from './Badge'
import type { Instance } from '../types/api'

const statusDot: Record<string, string> = {
  ok: 'bg-green-500',
  warn: 'bg-yellow-500',
  critical: 'bg-red-500',
}

const statusRing: Record<string, string> = {
  ok: '',
  warn: 'ring-1 ring-yellow-500/30',
  critical: 'ring-1 ring-red-500/40 animate-pulse',
}

export function NodeCard({
  instance,
  onClick,
  staleAlerts = 0,
}: {
  instance: Instance
  onClick: () => void
  staleAlerts?: number
}) {
  const areas = instance.area_status ?? []
  const topAlerts = instance.top_alerts ?? []
  const freshAlerts = Math.max(0, instance.active_alerts - staleAlerts)

  return (
    <Card onClick={onClick} className="cursor-pointer hover:border-[var(--accent)]/40 transition-colors">
      {/* Header: name + score */}
      <div className="flex items-center justify-between mb-3">
        <div className="font-medium truncate">{instance.name}</div>
        <div className="flex items-center gap-2">
          {freshAlerts > 0 && (
            <Badge className="bg-red-500/10 text-red-400 border border-red-500/20 text-xs">
              {freshAlerts}
            </Badge>
          )}
          {staleAlerts > 0 && freshAlerts === 0 && (
            <Badge className="bg-gray-500/10 text-gray-400 border border-gray-500/20 text-xs">
              {staleAlerts} stale
            </Badge>
          )}
          <span
            className="text-lg font-bold tabular-nums"
            style={{ color: scoreColor(instance.health_score) }}
          >
            {instance.health_score}
          </span>
        </div>
      </div>

      {/* Area pills */}
      <div className="flex items-center gap-2 mb-3">
        {areas.map((a) => (
          <div
            key={a.area}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--hover)] text-xs"
            title={`${a.label}: ${a.status}`}
          >
            <span className={cn('w-2 h-2 rounded-full', statusDot[a.status] ?? 'bg-gray-500', statusRing[a.status] ?? '')} />
            <span className="text-[var(--dim)]">{a.label}</span>
          </div>
        ))}
      </div>

      {/* Top issues */}
      {topAlerts.length > 0 ? (
        <div className="space-y-1.5">
          {topAlerts.map((a, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <Badge className={cn('border shrink-0', sevColor(a.severity))}>
                {a.severity === 'critical' ? 'CRIT' : a.severity === 'warn' ? 'WARN' : 'INFO'}
              </Badge>
              <span className="truncate">{a.title}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-green-400">All clear</div>
      )}
    </Card>
  )
}
