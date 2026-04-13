import { useState } from 'react'
import { Copy, Check, Play } from 'lucide-react'
import { useStore } from '../hooks/useStore'

interface SqlBlockProps {
  sql: string
  instance: string
}

export function SqlBlock({ sql, instance }: SqlBlockProps) {
  const { navToTerminal } = useStore()
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(sql)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="relative group rounded-lg overflow-hidden border border-[var(--border)]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--border)] text-xs text-[var(--dim)]">
        <span>SQL</span>
        <div className="flex gap-1">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-[var(--surface)] transition-colors"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            onClick={() => navToTerminal(sql, instance)}
            className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-[var(--surface)] transition-colors text-[var(--accent)]"
          >
            <Play size={12} />
            Run on {instance}
          </button>
        </div>
      </div>
      <pre className="p-3 bg-[var(--code-bg)] text-sm font-mono overflow-x-auto whitespace-pre-wrap break-all text-[var(--text)]">
        <code>{sql}</code>
      </pre>
    </div>
  )
}
