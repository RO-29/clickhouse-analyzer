/**
 * SqlEditor — CodeMirror 6-based SQL editor with:
 *   • SQL syntax highlighting (keywords, strings, comments, functions)
 *   • ClickHouse function & keyword autocompletion
 *   • Schema-aware completion (tables/columns passed as prop)
 *   • Line numbers, bracket matching, active-line highlight
 *   • Ctrl/Cmd+Enter to submit
 */
import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { basicSetup } from 'codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
  type Completion,
} from '@codemirror/autocomplete'

// ClickHouse-specific functions (on top of standard SQL keywords)
const CH_FUNCTIONS: Completion[] = [
  'toDate', 'toDateTime', 'toDateTime64',
  'toStartOfDay', 'toStartOfHour', 'toStartOfMinute', 'toStartOfSecond',
  'toStartOfInterval', 'toStartOfWeek', 'toStartOfMonth', 'toStartOfQuarter', 'toStartOfYear',
  'toYYYYMM', 'toYYYYMMDD', 'toDayOfWeek', 'toDayOfMonth', 'toHour', 'toMinute',
  'now', 'today', 'yesterday',
  'formatReadableSize', 'formatReadableQuantity', 'formatReadableTimeDelta',
  'quantile', 'quantileExact', 'quantileTDigest', 'quantilesTDigest',
  'median', 'medianExact',
  'arrayJoin', 'arrayAgg', 'arrayMap', 'arrayFilter', 'arraySort', 'arrayUniq', 'arrayLength',
  'groupArray', 'groupUniqArray', 'groupArrayInsertAt',
  'dictGet', 'dictGetOrDefault', 'dictHas',
  'if', 'multiIf', 'ifNull', 'isNull', 'isNotNull', 'nullIf', 'coalesce',
  'concat', 'substring', 'lower', 'upper', 'trim', 'trimLeft', 'trimRight',
  'splitByString', 'splitByChar', 'joinGet',
  'length', 'empty', 'notEmpty', 'startsWith', 'endsWith', 'match', 'extract',
  'sum', 'count', 'avg', 'min', 'max',
  'uniq', 'uniqExact', 'uniqCombined', 'uniqHLL12',
  'countIf', 'sumIf', 'avgIf', 'minIf', 'maxIf', 'countDistinctIf',
  'bar', 'sparkBar',
  'dateDiff', 'addDays', 'subtractDays', 'addHours', 'subtractHours',
  'addMinutes', 'subtractMinutes', 'addMonths', 'subtractMonths',
  'IPv4NumToString', 'IPv6NumToString', 'toIPv4', 'toIPv6',
  'runningDifference', 'runningAccumulate', 'neighbor',
  'any', 'anyLast', 'anyHeavy',
  'topK', 'topKWeighted',
  'entropy', 'skewSamp', 'skewPop', 'kurtSamp', 'kurtPop',
  'simpleLinearRegression', 'stochasticLinearRegression',
  'reinterpretAsFloat64', 'reinterpretAsUInt64',
  'JSONExtract', 'JSONExtractString', 'JSONExtractInt', 'JSONExtractFloat', 'JSONHas',
  'toTypeName', 'toColumnTypeName', 'getSetting',
  'hostName', 'currentUser', 'currentDatabase',
  'version', 'uptime',
].map(label => ({ label, type: 'function' as const, boost: 1 }))

const CH_SYSTEM_TABLES: Completion[] = [
  'system.query_log', 'system.processes', 'system.parts', 'system.parts_columns',
  'system.tables', 'system.columns', 'system.databases',
  'system.merges', 'system.replication_queue', 'system.replicas',
  'system.mutations', 'system.asynchronous_metric_log', 'system.metric_log',
  'system.trace_log', 'system.opentelemetry_span_log', 'system.text_log',
  'system.settings', 'system.build_options',
  'ch_analyzer.query_samples',
].map(label => ({ label, type: 'keyword' as const, boost: 2 }))

export interface SqlEditorHandle {
  focus: () => void
  getValue: () => string
}

export interface SchemaItem {
  label: string
  /** 'table' | 'column' */
  kind: 'table' | 'column'
  detail?: string   // e.g. column type or db name
}

interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  onSubmit?: () => void
  /** Extra completions — tables and columns from schema */
  schemaCompletions?: SchemaItem[]
  height?: string
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(
  ({ value, onChange, onSubmit, schemaCompletions = [], height = '200px' }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    // Use refs so callbacks in extensions don't go stale
    const onChangeRef = useRef(onChange)
    const onSubmitRef = useRef(onSubmit)
    onChangeRef.current = onChange
    onSubmitRef.current = onSubmit

    // Schema completions ref — updated when prop changes without recreating editor
    const schemaRef = useRef<Completion[]>([])

    useEffect(() => {
      schemaRef.current = schemaCompletions.map(item => ({
        label: item.label,
        // CodeMirror built-in icon types: 'class' = table icon, 'property' = field icon
        type: item.kind === 'table' ? ('class' as const) : ('property' as const),
        detail: item.detail,
        boost: item.kind === 'table' ? 4 : 3,
      }))
    }, [schemaCompletions])

    useImperativeHandle(ref, () => ({
      focus: () => viewRef.current?.focus(),
      getValue: () => viewRef.current?.state.doc.toString() ?? '',
    }))

    // Create editor once on mount
    useEffect(() => {
      if (!containerRef.current) return

      const customCompletion = (context: CompletionContext): CompletionResult | null => {
        const word = context.matchBefore(/[\w.]*/)
        if (!word || (word.from === word.to && !context.explicit)) return null
        const query = word.text.toLowerCase()

        const allOptions: Completion[] = [
          ...schemaRef.current,
          ...CH_SYSTEM_TABLES,
          ...CH_FUNCTIONS,
        ]

        return {
          from: word.from,
          options: allOptions.filter(o => o.label.toLowerCase().includes(query)),
          validFor: /^[\w.]*$/,
        }
      }

      const state = EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          sql(),
          oneDark,
          autocompletion({ override: [customCompletion], activateOnTyping: true, maxRenderedOptions: 20 }),
          // High-priority Ctrl/Cmd+Enter binding (beats basicSetup's Enter)
          Prec.highest(keymap.of([{
            key: 'Ctrl-Enter',
            mac: 'Cmd-Enter',
            run: () => { onSubmitRef.current?.(); return true },
          }])),
          EditorView.updateListener.of(update => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString())
            }
          }),
          EditorView.theme({
            '&': { height, borderRadius: '0.5rem' },
            '.cm-scroller': {
              overflow: 'auto',
              fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
              fontSize: '13px',
              lineHeight: '1.6',
            },
            '.cm-content': { padding: '8px 0', caretColor: '#60a5fa' },
            '.cm-focused': { outline: 'none' },
            '.cm-gutters': { borderRight: '1px solid rgba(255,255,255,0.06)', minWidth: '40px' },
            '.cm-lineNumbers .cm-gutterElement': { paddingRight: '12px', color: 'rgba(255,255,255,0.2)' },
            '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
            '.cm-cursor': { borderLeftColor: '#60a5fa' },
            '.cm-tooltip-autocomplete': { border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px' },
          }),
        ],
      })

      const view = new EditorView({ state, parent: containerRef.current })
      viewRef.current = view

      return () => {
        view.destroy()
        viewRef.current = null
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []) // mount only

    // Sync external value → editor (e.g. loading from history)
    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      const current = view.state.doc.toString()
      if (current !== value) {
        view.dispatch({
          changes: { from: 0, to: current.length, insert: value },
          // move cursor to end
          selection: { anchor: value.length },
        })
      }
    }, [value])

    return (
      <div
        ref={containerRef}
        className="rounded-lg border border-[var(--border)] overflow-hidden focus-within:border-[var(--accent)] transition-colors"
      />
    )
  },
)

SqlEditor.displayName = 'SqlEditor'
