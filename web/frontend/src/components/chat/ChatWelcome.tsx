import { Database, Sparkles } from 'lucide-react'
import { cn } from '../../lib/utils'

/* ─── Data ───────────────────────────────────────────────────────────────── */

const MODES = [
  {
    icon: '🏥',
    label: 'Full Health Scan',
    desc: 'Complete diagnosis: disk, memory, queries, merges, parts, errors',
    prompt: 'Do a full health scan of the ClickHouse cluster. Cover disk, memory, active queries, merges, parts, and error patterns. Prioritize findings by severity.',
  },
  {
    icon: '🐢',
    label: 'Slow Query Hunter',
    desc: 'Rank expensive queries, get fix SQL',
    prompt: 'Find the top slow queries by duration and memory usage. For each pattern, explain why it is slow and provide optimized SQL.',
  },
  {
    icon: '🧩',
    label: 'Parts & Merges',
    desc: 'Diagnose part explosion and merge backlog',
    prompt: 'Analyze parts and merges health. Find tables with high part counts, slow merges, and mutation backlog.',
  },
  {
    icon: '📥',
    label: 'Insert Optimizer',
    desc: 'Analyze throughput and fragmentation risk',
    prompt: 'Analyze insert patterns: batch sizes, frequency, fragmentation risk. Recommend settings improvements.',
  },
  {
    icon: '🔴',
    label: 'Error Investigation',
    desc: 'Surface error patterns with root causes',
    prompt: 'Investigate recent ClickHouse errors. Categorize by type, show frequency, and provide root cause fixes.',
  },
]

const QUESTIONS = [
  "What's the status of current cluster?",
  "What are the slowest queries in the last hour?",
  "Show me recent error patterns",
  "Which tables have the most parts?",
  "How are my inserts performing?",
  "What's causing high disk usage?",
  "Show active merges",
  "Find queries consuming the most memory",
]

/* ─── Props ──────────────────────────────────────────────────────────────── */

interface ChatWelcomeProps {
  onSend: (text: string, autoRun?: boolean) => void
}

/* ─── Component ──────────────────────────────────────────────────────────── */

export function ChatWelcome({ onSend }: ChatWelcomeProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full w-full px-6 py-10 overflow-y-auto">
      <div className="w-full max-w-2xl flex flex-col items-center gap-6">

        {/* Icon + heading */}
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="relative">
            <Database size={40} className="text-[var(--accent)]" />
            <Sparkles
              size={16}
              className="absolute -top-1 -right-2 text-[var(--accent)] opacity-80"
            />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-[var(--fg)]">
              Good to see you! Ready to dive into your data?
            </h2>
            <p className="text-sm text-[var(--dim)] mt-1">
              Query your ClickHouse cluster with AI assistance
            </p>
          </div>
        </div>

        {/* Mode cards */}
        <div className="w-full grid grid-cols-2 sm:grid-cols-3 gap-3">
          {MODES.map(mode => (
            <button
              key={mode.label}
              type="button"
              onClick={() => onSend(mode.prompt, true)}
              className={cn(
                'border border-[var(--border)] rounded-xl p-4 cursor-pointer text-left',
                'hover:border-[var(--accent)]/50 hover:bg-[var(--accent)]/5 transition-all',
              )}
            >
              <div className="text-2xl mb-2">{mode.icon}</div>
              <div className="text-sm font-semibold text-[var(--fg)] leading-snug">
                {mode.label}
              </div>
              <div className="text-xs text-[var(--dim)] mt-1 leading-snug">
                {mode.desc}
              </div>
            </button>
          ))}
        </div>

        {/* Suggested question chips */}
        <div className="w-full flex flex-wrap gap-2 justify-center">
          {QUESTIONS.map(q => (
            <button
              key={q}
              type="button"
              onClick={() => onSend(q)}
              className={cn(
                'inline-flex rounded-full border border-[var(--border)]',
                'px-3 py-1.5 text-xs text-[var(--dim)]',
                'hover:text-[var(--fg)] hover:border-[var(--accent)]/50',
                'cursor-pointer transition-colors',
              )}
            >
              {q}
            </button>
          ))}
        </div>

      </div>
    </div>
  )
}
