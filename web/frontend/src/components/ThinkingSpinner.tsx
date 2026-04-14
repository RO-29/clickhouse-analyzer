import { cn } from '../lib/utils'

/* ─── keyframes injected once ─────────────────────────────────────────────── */

const SPINNER_STYLES = `
  @keyframes thinking-ray {
    0%   { transform: scaleY(0.5); opacity: 0.35; }
    100% { transform: scaleY(1);   opacity: 1;    }
  }
  @keyframes thinking-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
`

const RAY_COUNT = 10

interface ThinkingSpinnerProps {
  size?: number
  className?: string
}

export function ThinkingSpinner({ size = 20, className }: ThinkingSpinnerProps) {
  const center = size / 2
  const rayW = Math.max(1, size * 0.1)
  const rayH = size * 0.28
  const innerR = size * 0.18

  return (
    <>
      <style>{SPINNER_STYLES}</style>
      <div
        className={cn('inline-flex items-center justify-center shrink-0', className)}
        style={{
          width: size,
          height: size,
          animation: 'thinking-spin 6s linear infinite',
        }}
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {Array.from({ length: RAY_COUNT }, (_, i) => {
            const angle = (i / RAY_COUNT) * 360
            const delay = (i / RAY_COUNT) * 1.2

            return (
              <rect
                key={i}
                x={center - rayW / 2}
                y={center - innerR - rayH}
                width={rayW}
                height={rayH}
                rx={rayW / 2}
                fill="currentColor"
                transform={`rotate(${angle} ${center} ${center})`}
                style={{
                  transformOrigin: `${center}px ${center}px`,
                  animation: `thinking-ray 1.2s ease-in-out ${delay.toFixed(3)}s infinite alternate`,
                }}
              />
            )
          })}
        </svg>
      </div>
    </>
  )
}
