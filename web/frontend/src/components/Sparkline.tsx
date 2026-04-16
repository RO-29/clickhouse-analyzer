import type { FC } from 'react'

interface SparklineProps {
  data: number[]
  color?: string
  width?: number
  height?: number
  className?: string
  /** Show a baseline area fill */
  fill?: boolean
}

export const Sparkline: FC<SparklineProps> = ({
  data,
  color = 'var(--accent)',
  width = 60,
  height = 20,
  className,
  fill = false,
}) => {
  if (!data || data.length < 2) {
    return <span className={className} style={{ display: 'inline-block', width, height }} />
  }

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const pad = 2

  const toX = (i: number) => (i / (data.length - 1)) * (width - pad * 2) + pad
  const toY = (v: number) => height - pad - ((v - min) / range) * (height - pad * 2)

  const pts = data.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ')

  const fillPath = fill
    ? `M${toX(0).toFixed(1)},${height} ` +
      data.map((v, i) => `L${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ') +
      ` L${toX(data.length - 1).toFixed(1)},${height} Z`
    : ''

  return (
    <svg
      width={width}
      height={height}
      className={className}
      style={{ overflow: 'visible', display: 'inline-block', verticalAlign: 'middle' }}
    >
      {fill && (
        <path d={fillPath} fill={color} fillOpacity={0.12} />
      )}
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Last value dot */}
      <circle
        cx={toX(data.length - 1).toFixed(1)}
        cy={toY(data[data.length - 1]).toFixed(1)}
        r="2"
        fill={color}
      />
    </svg>
  )
}
