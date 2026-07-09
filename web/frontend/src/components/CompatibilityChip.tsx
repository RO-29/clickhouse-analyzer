import { useEffect, useState } from 'react'
import { Cloud, Server, ChevronDown, Check, X } from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import type { Capabilities } from '../types/api'

/**
 * CompatibilityChip shows the detected ClickHouse version + edition for an
 * instance, and (on click) which version/edition-sensitive features are
 * available vs not — with the reason. This is how the dashboard surfaces
 * "not supported on this version/edition" instead of silently showing empty
 * panels.
 */
export function CompatibilityChip({ instance }: { instance: string }) {
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setCaps(null)
    api.capabilities(instance).then(c => { if (!cancelled) setCaps(c) }).catch(() => {})
    return () => { cancelled = true }
  }, [instance])

  if (!caps) return null

  const isCloud = caps.edition === 'cloud'
  const feats = Object.entries(caps.features).sort(([a], [b]) => a.localeCompare(b))
  const unavailable = feats.filter(([, v]) => !v.available)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 py-1.5 text-[11px] text-[var(--dim)] hover:text-[var(--text)] hover:border-[var(--accent)]/40 transition-colors"
        title="ClickHouse version & feature compatibility"
      >
        {isCloud ? <Cloud size={12} className="text-sky-400" /> : <Server size={12} className="text-emerald-400" />}
        <span className="font-mono text-[var(--text)]">{caps.version.Raw || `${caps.version.Major}.${caps.version.Minor}`}</span>
        <span className="uppercase tracking-wide">{caps.edition}</span>
        {caps.replicas > 1 && <span className="text-[var(--dim)]">· {caps.replicas} nodes</span>}
        {unavailable.length > 0 && (
          <span className="rounded bg-amber-500/15 text-amber-400 border border-amber-500/25 px-1 text-[10px]">
            {unavailable.length} n/a
          </span>
        )}
        <ChevronDown size={11} className={cn('transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-[360px] max-h-[70vh] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-2xl">
            <div className="px-3 py-2.5 border-b border-[var(--border)] bg-[var(--surface)]">
              <div className="flex items-center gap-2 text-[12px]">
                {isCloud ? <Cloud size={13} className="text-sky-400" /> : <Server size={13} className="text-emerald-400" />}
                <span className="font-mono text-[var(--text)]">ClickHouse {caps.version.Raw}</span>
                <span className="uppercase text-[10px] tracking-wide text-[var(--dim)]">{caps.edition}</span>
                {caps.replicas > 1 && <span className="text-[10px] text-[var(--dim)]">{caps.replicas} replicas</span>}
              </div>
              <div className="text-[10px] text-[var(--dim)] mt-1">
                Feature availability is detected per instance. Unavailable features are hidden or shown as “not supported” in the relevant tabs.
              </div>
            </div>
            <ul className="divide-y divide-[var(--border)]">
              {feats.map(([key, v]) => (
                <li key={key} className="flex items-start gap-2 px-3 py-2 text-[11px]">
                  {v.available
                    ? <Check size={13} className="text-emerald-400 shrink-0 mt-0.5" />
                    : <X size={13} className="text-amber-400 shrink-0 mt-0.5" />}
                  <div className="min-w-0">
                    <div className="font-mono text-[var(--text)] truncate">{key}</div>
                    {!v.available && <div className="text-[var(--dim)] leading-snug">{v.reason}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
