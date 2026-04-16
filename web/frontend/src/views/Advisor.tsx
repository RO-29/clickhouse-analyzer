import { useState, useCallback } from 'react'
import { ChevronDown, ChevronRight, Play, AlertTriangle, Zap, Search, Sparkles } from 'lucide-react'
import { useStore } from '../hooks/useStore'
import { useAIAnalysis } from '../hooks/useAIAnalysis'
import { api } from '../lib/api'
import { fmtBytes, fmtNum, fmtDuration, cn } from '../lib/utils'
import { Card } from '../components/Card'
import { Badge } from '../components/Badge'
import { DataTable } from '../components/DataTable'
import { SqlBlock } from '../components/SqlBlock'

/* ------------------------------------------------------------------ */
/*  Types for section data                                            */
/* ------------------------------------------------------------------ */
interface SectionState<T> {
  data: T[] | null
  loading: boolean
  error: string | null
}

function emptySection<T>(): SectionState<T> {
  return { data: null, loading: false, error: null }
}

/* ------------------------------------------------------------------ */
/*  Collapsible section wrapper                                       */
/* ------------------------------------------------------------------ */
function Section({
  title,
  count,
  collapsed,
  onToggle,
  children,
  loading,
  error,
  onAnalyze,
}: {
  title: string
  count: number | null
  collapsed: boolean
  onToggle: () => void
  children: React.ReactNode
  loading: boolean
  error: string | null
  onAnalyze?: () => void
}) {
  return (
    <Card className="!p-0">
      <div className="flex items-center">
        <button
          onClick={onToggle}
          className="flex-1 flex items-center gap-3 px-5 py-4 text-left hover:bg-[var(--hover)] transition-colors"
        >
          {collapsed ? (
            <ChevronRight size={16} className="shrink-0 text-[var(--dim)]" />
          ) : (
            <ChevronDown size={16} className="shrink-0 text-[var(--dim)]" />
          )}
          <span className="font-semibold text-sm flex-1">{title}</span>
          {loading && (
            <span className="text-xs text-[var(--dim)]">Loading...</span>
          )}
          {count !== null && !loading && (
            <Badge className={cn(
              'border',
              count === 0
                ? 'bg-green-500/10 text-green-400 border-green-500/20'
                : count <= 3
                  ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                  : 'bg-red-500/10 text-red-400 border-red-500/20',
            )}>
              {count} {count === 1 ? 'issue' : 'issues'}
            </Badge>
          )}
          {error && (
            <Badge className="bg-red-500/10 text-red-400 border-red-500/20">error</Badge>
          )}
        </button>
        {onAnalyze && count !== null && count > 0 && !loading && (
          <button
            onClick={(e) => { e.stopPropagation(); onAnalyze() }}
            className="flex items-center gap-1 px-3 py-1 mr-3 rounded text-xs font-medium text-purple-400 hover:bg-purple-500/15 border border-transparent hover:border-purple-500/20 transition-colors shrink-0"
            title={`Analyze ${title} with AI`}
          >
            <Sparkles size={11} />
            Analyze
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="border-t border-[var(--border)] px-5 py-4">
          {error ? (
            <div className="text-sm text-red-400">{error}</div>
          ) : loading ? (
            <div className="animate-pulse space-y-2">
              <div className="h-4 bg-[var(--hover)] rounded w-3/4" />
              <div className="h-4 bg-[var(--hover)] rounded w-1/2" />
              <div className="h-4 bg-[var(--hover)] rounded w-2/3" />
            </div>
          ) : (
            children
          )}
        </div>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/*  Fix button                                                        */
/* ------------------------------------------------------------------ */
function FixButton({ sql, instance }: { sql: string; instance: string }) {
  const { navToTerminal } = useStore()
  return (
    <button
      title={sql}
      onClick={(e) => { e.stopPropagation(); navToTerminal(sql, instance) }}
      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25 transition-colors"
    >
      <Play size={10} />
      Fix
    </button>
  )
}

/* ------------------------------------------------------------------ */
/*  Extra columns per query anti-pattern type                         */
/* ------------------------------------------------------------------ */
function getAPExtraColumns(type: string) {
  switch (type) {
    case 'select_star':
      return [
        { key: 'avg_read_bytes', label: 'Avg Read', format: (v: any) => fmtBytes(Number(v) || 0) },
        { key: 'avg_read_rows',  label: 'Avg Rows',  format: (v: any) => fmtNum(Number(v) || 0) },
      ]
    case 'high_memory':
      return [
        { key: 'avg_memory',    label: 'Avg RAM',  format: (v: any) => fmtBytes(Number(v) || 0) },
        { key: 'avg_read_rows', label: 'Avg Rows', format: (v: any) => fmtNum(Number(v) || 0) },
      ]
    case 'full_scan':
      return [
        { key: 'avg_read_rows',   label: 'Read Rows',   format: (v: any) => fmtNum(Number(v) || 0) },
        { key: 'avg_result_rows', label: 'Result Rows', format: (v: any) => fmtNum(Number(v) || 0) },
        { key: 'scan_ratio', label: 'Ratio', format: (v: any) => <span className="text-red-400 font-mono">{fmtNum(Number(v) || 0)}×</span> },
      ]
    case 'no_limit':
    case 'order_no_limit':
      return [
        { key: 'avg_result_rows', label: 'Avg Result Rows', format: (v: any) => fmtNum(Number(v) || 0) },
        { key: 'avg_read_bytes',  label: 'Avg Read',        format: (v: any) => fmtBytes(Number(v) || 0) },
      ]
    case 'high_error_rate':
      return [
        { key: 'error_count',    label: 'Errors',     format: (v: any) => <span className="text-red-400">{fmtNum(Number(v) || 0)}</span> },
        { key: 'error_rate_pct', label: 'Error Rate', format: (v: any) => <span className="text-red-400">{(Number(v) || 0).toFixed(1)}%</span> },
      ]
    case 'low_mark_cache':
      return [
        { key: 'cache_hit_pct', label: 'Cache Hit %', format: (v: any) => {
          const pct = Number(v) || 0
          return <span className={pct < 30 ? 'text-red-400 font-mono' : 'text-yellow-400 font-mono'}>{pct.toFixed(1)}%</span>
        }},
        { key: 'avg_read_rows', label: 'Avg Rows', format: (v: any) => fmtNum(Number(v) || 0) },
      ]
    case 'high_frequency':
      return [
        { key: 'avg_memory', label: 'Avg RAM', format: (v: any) => fmtBytes(Number(v) || 0) },
      ]
    case 'uses_final':
      return [
        { key: 'avg_read_rows', label: 'Avg Rows', format: (v: any) => fmtNum(Number(v) || 0) },
        { key: 'avg_memory',    label: 'Avg RAM',  format: (v: any) => fmtBytes(Number(v) || 0) },
      ]
    case 'global_in_join':
      return [
        { key: 'avg_read_rows', label: 'Avg Rows', format: (v: any) => fmtNum(Number(v) || 0) },
        { key: 'avg_memory',    label: 'Avg RAM',  format: (v: any) => fmtBytes(Number(v) || 0) },
      ]
    default:
      return []
  }
}

/* ------------------------------------------------------------------ */
/*  Advisor view                                                      */
/* ------------------------------------------------------------------ */
export default function Advisor() {
  const { instances, navToTerminal, openTableDetail, selectedInstance } = useStore()
  const { analyze } = useAIAnalysis(selectedInstance)
  const [instance, setInstance] = useState('')
  const [hasRun, setHasRun] = useState(false)

  // Collapsed sections — all start collapsed after run
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const toggle = (key: string) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))

  // Row limiting — show top N rows by default per section
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const MAX_ROWS = 5
  const limitRows = (key: string, data: any[]) => expanded[key] ? data : data.slice(0, MAX_ROWS)
  const toggleExpand = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }))
  const ShowAllButton = ({ sectionKey, total }: { sectionKey: string; total: number }) => (
    total > MAX_ROWS ? (
      <button
        onClick={() => toggleExpand(sectionKey)}
        className="mt-2 text-xs text-[var(--accent)] hover:underline"
      >
        {expanded[sectionKey] ? 'Show less' : `Show all ${total} rows`}
      </button>
    ) : null
  )

  // Section states
  const [compression, setCompression] = useState<SectionState<any>>(emptySection())
  const [indexMemory, setIndexMemory] = useState<SectionState<any>>(emptySection())
  const [queryRegression, setQueryRegression] = useState<SectionState<any>>(emptySection())
  const [newPatterns, setNewPatterns] = useState<SectionState<any>>(emptySection())
  const [unusedTables, setUnusedTables] = useState<SectionState<any>>(emptySection())
  const [schema, setSchema] = useState<SectionState<any>>(emptySection())
  const [cardinality, setCardinality] = useState<SectionState<any>>(emptySection())
  const [storagePolicy, setStoragePolicy] = useState<SectionState<any>>(emptySection())
  const [queryAP, setQueryAP] = useState<SectionState<any>>(emptySection())
  const [tableAP, setTableAP] = useState<SectionState<any>>(emptySection())

  // Cardinality requires a separate button
  const [cardinalityRun, setCardinalityRun] = useState(false)

  const inst = instance || instances[0] || ''

  const runAnalysis = useCallback(async () => {
    if (!inst) return
    setHasRun(true)
    // Collapse all sections by default — user expands what they care about
    setCollapsed({
      compression: true, indexMemory: true, queryRegression: true,
      newPatterns: true, unusedTables: true, schema: true,
      cardinality: true, storagePolicy: true,
      queryAP: true, tableAP: true,
    })
    setExpanded({})

    // Helper to load a section
    const load = <T,>(
      setter: React.Dispatch<React.SetStateAction<SectionState<T>>>,
      fetcher: () => Promise<T[]>,
    ) => {
      setter({ data: null, loading: true, error: null })
      fetcher()
        .then(d => setter({ data: Array.isArray(d) ? d : [], loading: false, error: null }))
        .catch(e => setter({ data: null, loading: false, error: e?.message ?? 'Failed' }))
    }

    load(setCompression, () => api.advisor.compression(inst))
    load(setIndexMemory, () => api.tableMemory(inst))
    load(setQueryRegression, () => api.advisor.queryRegression(inst))
    load(setNewPatterns, () => api.advisor.newPatterns(inst))
    load(setUnusedTables, () => api.advisor.unusedTables(inst))
    load(setSchema, () => api.advisor.schema(inst))
    load(setStoragePolicy, () => api.advisor.storagePolicy(inst))
    load(setQueryAP, () => api.advisor.queryAntiPatterns(inst))
    load(setTableAP, () => api.advisor.tableAntiPatterns(inst))
  }, [inst])

  const runCardinality = useCallback(async () => {
    if (!inst) return
    setCardinalityRun(true)
    setCardinality({ data: null, loading: true, error: null })
    api.advisor.cardinality(inst)
      .then(d => setCardinality({ data: Array.isArray(d) ? d : [], loading: false, error: null }))
      .catch(e => setCardinality({ data: null, loading: false, error: e?.message ?? 'Failed' }))
  }, [inst])

  // Count helpers
  const count = (s: SectionState<any>) => s.data !== null ? s.data.length : null
  const indexMemoryIssues = indexMemory.data
    ? (Array.isArray(indexMemory.data) ? indexMemory.data : []).filter((r: any) => (r.pk_bytes ?? 0) > 5 * 1024 * 1024 * 1024)
    : null

  // Summary tiles
  const tiles = [
    { label: 'Compression', count: compression.data !== null ? compression.data.filter((r: any) => r.recommendations?.length > 0).length : null },
    { label: 'Index Memory', count: indexMemoryIssues ? indexMemoryIssues.length : null },
    { label: 'Query Regression', count: count(queryRegression) },
    { label: 'New Patterns', count: count(newPatterns) },
    { label: 'Unused Tables', count: count(unusedTables) },
    { label: 'Schema', count: schema.data !== null ? schema.data.reduce((s: number, r: any) => s + (r.recommendations?.length ?? 0), 0) : null },
    { label: 'Cardinality', count: count(cardinality) },
    { label: 'Storage Policy', count: count(storagePolicy) },
    { label: 'Query Anti-patterns', count: queryAP.data ? queryAP.data.filter((g: any) => g.count > 0).length : null },
    { label: 'Table Anti-patterns', count: tableAP.data ? tableAP.data.filter((g: any) => g.count > 0).length : null },
  ]

  /* ---- Compression ratio color ---- */
  const ratioColor = (r: number) =>
    r < 1.5 ? 'text-red-400' : r < 2.0 ? 'text-yellow-400' : 'text-green-400'

  return (
    <div className="space-y-6">
      {/* Top bar: instance selector + run button */}
      <div className="flex items-center gap-4">
        <select
          value={inst}
          onChange={e => setInstance(e.target.value)}
          className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
        >
          {instances.length === 0 && <option value="">No instances</option>}
          {instances.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <button
          onClick={runAnalysis}
          disabled={!inst}
          className={cn(
            'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            inst
              ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
              : 'bg-[var(--surface)] text-[var(--dim)] cursor-not-allowed',
          )}
        >
          <Zap size={16} />
          Run Analysis
        </button>
      </div>

      {/* Summary tiles */}
      {hasRun && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {tiles.map(t => (
            <Card key={t.label}>
              <div className={cn(
                'text-2xl font-bold',
                t.count === null
                  ? 'text-[var(--dim)]'
                  : t.count === 0
                    ? 'text-green-400'
                    : t.count <= 3
                      ? 'text-yellow-400'
                      : 'text-red-400',
              )}>
                {t.count ?? '--'}
              </div>
              <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">{t.label}</div>
            </Card>
          ))}
        </div>
      )}

      {!hasRun && (
        <div className="text-sm text-[var(--dim)] text-center py-16">
          <AlertTriangle size={32} className="mx-auto mb-3 opacity-40" />
          Select an instance and click "Run Analysis" to get recommendations
        </div>
      )}

      {/* ---- Section 1: Compression Analysis ---- */}
      {hasRun && (
        <Section
          title="Compression Analysis"
          count={compression.data !== null ? compression.data.filter((r: any) => r.recommendations?.length > 0).length : null}
          collapsed={!!collapsed['compression']}
          onToggle={() => toggle('compression')}
          loading={compression.loading}
          error={compression.error}
          onAnalyze={() => analyze('Compression Analysis', { issues: compression.data, instance: inst }, { contextType: 'tab', tab: 'advisor', elementId: 'compression' })}
        >
          {compression.data && compression.data.length === 0 && (
            <div className="text-sm text-[var(--dim)]">All tables have good compression ratios.</div>
          )}
          {compression.data && compression.data.length > 0 && (<>
            <DataTable
              columns={[
                { key: 'database', label: 'Database' },
                {
                  key: 'table_name',
                  label: 'Table',
                  format: (v: any) => (
                    <button
                      className="text-[var(--accent)] hover:underline text-left"
                      onClick={() => {
                        const row = compression.data?.find((r: any) => r.table_name === v)
                        if (row) openTableDetail(inst, row.database, v)
                      }}
                    >
                      {v}
                    </button>
                  ),
                },
                { key: 'compressed', label: 'Compressed' },
                { key: 'uncompressed', label: 'Uncompressed' },
                {
                  key: 'ratio',
                  label: 'Ratio',
                  format: (v: any) => <span className={ratioColor(v ?? 0)}>{(v ?? 0).toFixed(2)}x</span>,
                },
                { key: 'column_count', label: 'Columns', format: (v: any) => fmtNum(v) },
                {
                  key: 'fix_sql',
                  label: '',
                  format: (v: any) => v ? <FixButton sql={v} instance={inst} /> : null,
                },
              ]}
              data={limitRows('compression', [...compression.data].sort((a: any, b: any) => {
                // Issues (bad ratio) first, then sort by compressed size descending.
                const aIssue = a.recommendations?.length > 0 ? 1 : 0
                const bIssue = b.recommendations?.length > 0 ? 1 : 0
                if (bIssue !== aIssue) return bIssue - aIssue
                return (b.compressed_bytes ?? 0) - (a.compressed_bytes ?? 0)
              }))}
            />
            <ShowAllButton sectionKey="compression" total={compression.data.length} />
          </>)}
        </Section>
      )}

      {/* ---- Section 2: Index Memory ---- */}
      {hasRun && (
        <Section
          title="Index Memory"
          count={indexMemoryIssues ? indexMemoryIssues.length : null}
          collapsed={!!collapsed['indexMemory']}
          onToggle={() => toggle('indexMemory')}
          loading={indexMemory.loading}
          error={indexMemory.error}
          onAnalyze={() => analyze('Index Memory', { issues: indexMemoryIssues, instance: inst }, { contextType: 'tab', tab: 'advisor', elementId: 'indexMemory' })}
        >
          {indexMemory.data && (() => {
            const allData = Array.isArray(indexMemory.data) ? indexMemory.data : []
            const totalPk = allData.reduce((s: number, r: any) => s + (Number(r.pk_bytes) || 0), 0)
            const flagged = allData.filter((r: any) => (Number(r.pk_bytes) || 0) > 5 * 1024 * 1024 * 1024)

            return (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-xl font-bold">{fmtBytes(totalPk)}</div>
                    <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Total PK Memory</div>
                  </div>
                  <div>
                    <div className={cn('text-xl font-bold', flagged.length > 0 ? 'text-yellow-400' : 'text-green-400')}>
                      {flagged.length}
                    </div>
                    <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Tables &gt; 5GB PK Memory</div>
                  </div>
                </div>
                {flagged.length > 0 && (
                  <>
                    <div className="text-sm text-yellow-400 bg-yellow-500/10 rounded-lg px-3 py-2 border border-yellow-500/20">
                      Consider <code className="font-mono">index_granularity = 16384</code> for tables with &gt;5GB PK memory
                    </div>
                    <DataTable
                      columns={[
                        { key: 'database', label: 'Database' },
                        {
                          key: 'table_name',
                          label: 'Table',
                          format: (v: any) => (
                            <button
                              className="text-[var(--accent)] hover:underline text-left"
                              onClick={() => {
                                const row = flagged.find((r: any) => r.table_name === v)
                                if (row) openTableDetail(inst, row.database, v)
                              }}
                            >
                              {v}
                            </button>
                          ),
                        },
                        { key: 'pk_readable', label: 'PK Memory' },
                        { key: 'marks_readable', label: 'Marks Memory' },
                        { key: 'mark_count', label: 'Marks', format: (v: any) => fmtNum(v) },
                        { key: 'total_rows', label: 'Rows', format: (v: any) => fmtNum(v) },
                      ]}
                      data={flagged.sort((a: any, b: any) => (b.pk_bytes ?? 0) - (a.pk_bytes ?? 0))}
                    />
                  </>
                )}
                {flagged.length === 0 && (
                  <div className="text-sm text-[var(--dim)]">No tables exceed 5GB PK memory.</div>
                )}
              </div>
            )
          })()}
        </Section>
      )}

      {/* ---- Section 3: Query Regression ---- */}
      {hasRun && (
        <Section
          title="Query Regression"
          count={count(queryRegression)}
          collapsed={!!collapsed['queryRegression']}
          onToggle={() => toggle('queryRegression')}
          loading={queryRegression.loading}
          error={queryRegression.error}
          onAnalyze={() => analyze('Query Regression', { issues: queryRegression.data, instance: inst }, { contextType: 'tab', tab: 'advisor', elementId: 'queryRegression' })}
        >
          <div className="text-xs text-[var(--dim)] mb-3">
            Queries whose avg duration this hour is &gt;2× their 24h average or yesterday's same hour.
          </div>
          {queryRegression.data && queryRegression.data.length === 0 && (
            <div className="text-sm text-[var(--dim)]">No query regressions detected.</div>
          )}
          {queryRegression.data && queryRegression.data.length > 0 && (<>
            <DataTable
              columns={[
                { key: 'normalized_query_hash', label: 'Hash', format: (v: any) => { const s = String(v ?? ''); return s ? `0x${s.slice(0, 8).toUpperCase()}` : '—' } },
                {
                  key: 'sample_query',
                  label: 'Query',
                  format: (v: any) => (
                    <span className="font-mono text-xs truncate block max-w-sm" title={String(v ?? '')}>
                      {String(v ?? '').slice(0, 100)}
                    </span>
                  ),
                },
                { key: 'cnt', label: 'Count', format: (v: any) => fmtNum(v) },
                { key: 'avg_ms', label: 'Current Avg', format: (v: any) => fmtDuration(Number(v) || 0) },
                { key: 'yesterday_avg_ms', label: 'Yesterday', format: (v: any) => Number(v) ? fmtDuration(Number(v)) : 'N/A' },
                { key: 'rolling_24h_avg_ms', label: '24h Avg', format: (v: any) => Number(v) ? fmtDuration(Number(v)) : 'N/A' },
                {
                  key: 'regression_vs_24h',
                  label: 'Factor',
                  format: (v: any) => {
                    const f = Number(v) || 0
                    if (f === 0) return <span className="text-[var(--dim)]">—</span>
                    return (
                      <span className={f > 3 ? 'text-red-400 font-bold' : f > 2 ? 'text-yellow-400' : ''}>
                        {f.toFixed(1)}x
                      </span>
                    )
                  },
                },
              ]}
              data={limitRows('queryRegression', queryRegression.data)}
              onRowClick={(row) => {
                if (row.sample_query) navToTerminal(row.sample_query, inst)
              }}
            />
            <ShowAllButton sectionKey="queryRegression" total={queryRegression.data.length} />
          </>)}
        </Section>
      )}

      {/* ---- Section 4: New Query Patterns ---- */}
      {hasRun && (
        <Section
          title="New Query Patterns"
          count={count(newPatterns)}
          collapsed={!!collapsed['newPatterns']}
          onToggle={() => toggle('newPatterns')}
          loading={newPatterns.loading}
          error={newPatterns.error}
          onAnalyze={() => analyze('New Query Patterns', { issues: newPatterns.data, instance: inst }, { contextType: 'tab', tab: 'advisor', elementId: 'newPatterns' })}
        >
          {newPatterns.data && newPatterns.data.length === 0 && (
            <div className="text-sm text-[var(--dim)]">No new query patterns detected.</div>
          )}
          {newPatterns.data && newPatterns.data.length > 0 && (<>
            <DataTable
              columns={[
                {
                  key: 'normalized_query_hash',
                  label: 'Hash',
                  format: (v: any) => (
                    <span className="flex items-center gap-2">
                      <Badge className="bg-green-500/10 text-green-400 border-green-500/20">NEW</Badge>
                      <span className="font-mono text-xs">{String(v ?? '').slice(0, 12)}</span>
                    </span>
                  ),
                },
                { key: 'cnt', label: 'Count', format: (v: any) => fmtNum(v) },
                { key: 'avg_ms', label: 'Avg ms', format: (v: any) => fmtDuration(v ?? 0) },
                { key: 'user', label: 'User' },
                {
                  key: 'sample_query',
                  label: 'Sample',
                  format: (v: any) => (
                    <span className="font-mono text-xs truncate block max-w-sm" title={String(v ?? '')}>
                      {String(v ?? '').slice(0, 100)}
                    </span>
                  ),
                },
              ]}
              data={limitRows('newPatterns', newPatterns.data)}
            />
            <ShowAllButton sectionKey="newPatterns" total={newPatterns.data.length} />
          </>)}
        </Section>
      )}

      {/* ---- Section 5: Unused Tables ---- */}
      {hasRun && (
        <Section
          title="Unused Tables"
          count={count(unusedTables)}
          collapsed={!!collapsed['unusedTables']}
          onToggle={() => toggle('unusedTables')}
          loading={unusedTables.loading}
          error={unusedTables.error}
          onAnalyze={() => analyze('Unused Tables', { issues: unusedTables.data, instance: inst }, { contextType: 'tab', tab: 'advisor', elementId: 'unusedTables' })}
        >
          {unusedTables.data && unusedTables.data.length === 0 && (
            <div className="text-sm text-[var(--dim)]">No unused tables detected.</div>
          )}
          {unusedTables.data && unusedTables.data.length > 0 && (<>
            <DataTable
              columns={[
                { key: 'database', label: 'Database' },
                {
                  key: 'table_name',
                  label: 'Table',
                  format: (v: any) => (
                    <button
                      className="text-[var(--accent)] hover:underline text-left"
                      onClick={() => {
                        const row = unusedTables.data?.find((r: any) => r.table_name === v)
                        if (row) openTableDetail(inst, row.database, v)
                      }}
                    >
                      {v}
                    </button>
                  ),
                },
                { key: 'size_readable', label: 'Size' },
                { key: 'engine', label: 'Engine' },
                { key: 'metadata_modification_time', label: 'Last Modified' },
                {
                  key: '_drop',
                  label: '',
                  format: (v: any) => v ? <FixButton sql={v} instance={inst} /> : null,
                },
              ]}
              data={limitRows('unusedTables', unusedTables.data.map((r: any) => ({
                ...r,
                _drop: `DROP TABLE IF EXISTS \`${r.database}\`.\`${r.table_name}\``,
              })))}
              onRowClick={(row) => {
                if (row._drop) navToTerminal(row._drop, inst)
              }}
            />
            <ShowAllButton sectionKey="unusedTables" total={unusedTables.data.length} />
          </>)}
        </Section>
      )}

      {/* ---- Section 6: Schema Recommendations ---- */}
      {hasRun && (
        <Section
          title="Schema Recommendations"
          count={count(schema)}
          collapsed={!!collapsed['schema']}
          onToggle={() => toggle('schema')}
          loading={schema.loading}
          error={schema.error}
          onAnalyze={() => analyze('Schema Recommendations', { issues: schema.data, instance: inst }, { contextType: 'tab', tab: 'advisor', elementId: 'schema' })}
        >
          {schema.data && schema.data.length === 0 && (
            <div className="text-sm text-[var(--dim)]">No schema issues detected.</div>
          )}
          {schema.data && schema.data.length > 0 && (
            <div className="space-y-3">
              {limitRows('schema', schema.data).map((item: any, i: number) => (
                <div key={i} className="border border-[var(--border)] rounded-lg overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-3 bg-[var(--hover)]">
                    <button
                      className="text-[var(--accent)] hover:underline font-mono text-sm text-left"
                      onClick={() => openTableDetail(inst, item.database, item.table_name)}
                    >
                      {item.database}.{item.table_name}
                    </button>
                    <span className="text-xs text-[var(--dim)]">{item.engine}</span>
                    {item.recommendations?.length > 0 && (
                      <Badge className="bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                        {item.recommendations.length} {item.recommendations.length === 1 ? 'issue' : 'issues'}
                      </Badge>
                    )}
                  </div>
                  {item.recommendations?.length > 0 && (
                    <div className="px-4 py-3 space-y-2">
                      {item.recommendations.map((rec: any, j: number) => (
                        <div key={j} className="flex items-start gap-2">
                          <Badge className={cn(
                            'border shrink-0 mt-0.5',
                            rec.severity === 'critical' ? 'bg-red-500/10 text-red-400 border-red-500/20'
                              : rec.severity === 'warn' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                                : 'bg-blue-500/10 text-blue-400 border-blue-500/20',
                          )}>
                            {rec.severity}
                          </Badge>
                          <span className="text-sm">{rec.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <ShowAllButton sectionKey="schema" total={schema.data.length} />
            </div>
          )}
        </Section>
      )}

      {/* ---- Section 7: Column Cardinality ---- */}
      {hasRun && (
        <Section
          title="Column Cardinality"
          count={count(cardinality)}
          collapsed={!!collapsed['cardinality']}
          onToggle={() => toggle('cardinality')}
          loading={cardinality.loading}
          error={cardinality.error}
          onAnalyze={() => analyze('Column Cardinality', { issues: cardinality.data, instance: inst }, { contextType: 'tab', tab: 'advisor', elementId: 'cardinality' })}
        >
          {!cardinalityRun && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-[var(--dim)]">Cardinality analysis is expensive and samples data from tables.</span>
              <button
                onClick={runCardinality}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
              >
                <Search size={14} />
                Analyze Cardinality
              </button>
            </div>
          )}
          {cardinalityRun && cardinality.data && cardinality.data.length === 0 && (
            <div className="text-sm text-[var(--dim)]">No low-cardinality column candidates found.</div>
          )}
          {cardinalityRun && cardinality.data && cardinality.data.length > 0 && (<>
            <DataTable
              columns={[
                { key: 'database', label: 'Database' },
                {
                  key: 'table_name',
                  label: 'Table',
                  format: (v: any) => (
                    <button
                      className="text-[var(--accent)] hover:underline text-left"
                      onClick={() => {
                        const row = cardinality.data?.find((r: any) => r.table_name === v)
                        if (row) openTableDetail(inst, row.database, v)
                      }}
                    >
                      {v}
                    </button>
                  ),
                },
                { key: 'column_name', label: 'Column' },
                { key: 'type', label: 'Current Type' },
                { key: 'cardinality', label: 'Cardinality', format: (v: any) => fmtNum(v) },
                {
                  key: '_fix',
                  label: '',
                  format: (v: any) => v ? <FixButton sql={v} instance={inst} /> : null,
                },
              ]}
              data={limitRows('cardinality', cardinality.data.map((r: any) => ({
                ...r,
                _fix: `ALTER TABLE \`${r.database}\`.\`${r.table_name}\` MODIFY COLUMN \`${r.column_name}\` LowCardinality(${r.type})`,
              })))}
            />
            <ShowAllButton sectionKey="cardinality" total={cardinality.data.length} />
          </>)}
        </Section>
      )}

      {/* ---- Section 8: Storage Policy Review ---- */}
      {hasRun && (
        <Section
          title="Storage Policy Review"
          count={count(storagePolicy)}
          collapsed={!!collapsed['storagePolicy']}
          onToggle={() => toggle('storagePolicy')}
          loading={storagePolicy.loading}
          error={storagePolicy.error}
          onAnalyze={() => analyze('Storage Policy Review', { issues: storagePolicy.data, instance: inst }, { contextType: 'tab', tab: 'advisor', elementId: 'storagePolicy' })}
        >
          {storagePolicy.data && storagePolicy.data.length === 0 && (
            <div className="text-sm text-[var(--dim)]">No storage policy issues detected.</div>
          )}
          {storagePolicy.data && storagePolicy.data.length > 0 && (<>
            <DataTable
              columns={[
                { key: 'database', label: 'Database' },
                {
                  key: 'table_name',
                  label: 'Table',
                  format: (v: any) => (
                    <button
                      className="text-[var(--accent)] hover:underline text-left"
                      onClick={() => {
                        const row = storagePolicy.data?.find((r: any) => r.table_name === v)
                        if (row) openTableDetail(inst, row.database, v)
                      }}
                    >
                      {v}
                    </button>
                  ),
                },
                { key: 'size_readable', label: 'Size' },
                { key: 'storage_policy', label: 'Policy', format: (v: any) => v || <span className="text-[var(--dim)]">default</span> },
                {
                  key: 'has_ttl',
                  label: 'TTL',
                  format: (v: any) => (
                    <Badge className={cn(
                      'border',
                      v ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
                    )}>
                      {v ? 'Yes' : 'No'}
                    </Badge>
                  ),
                },
                {
                  key: 'recommendations',
                  label: 'Recommendation',
                  format: (v: any) => Array.isArray(v) && v.length > 0
                    ? <span className="text-sm">{v.map((r: any) => r.text).join('; ')}</span>
                    : null,
                },
              ]}
              data={limitRows('storagePolicy', storagePolicy.data)}
            />
            <ShowAllButton sectionKey="storagePolicy" total={storagePolicy.data.length} />
          </>)}
        </Section>
      )}

      {/* ---- Section 9: Query Anti-patterns ---- */}
      {hasRun && (
        <Section
          title="Query Anti-patterns"
          count={queryAP.data ? queryAP.data.filter((g: any) => g.count > 0).length : null}
          collapsed={!!collapsed['queryAP']}
          onToggle={() => toggle('queryAP')}
          loading={queryAP.loading}
          error={queryAP.error}
          onAnalyze={() => analyze('Query Anti-patterns', { issues: queryAP.data, instance: inst }, { contextType: 'tab', tab: 'advisor', elementId: 'queryAP' })}
        >
          {queryAP.data && queryAP.data.every((g: any) => g.count === 0) && (
            <div className="text-sm text-[var(--dim)]">No query anti-patterns detected in the last 24h.</div>
          )}
          {queryAP.data && queryAP.data.some((g: any) => g.count > 0) && (
            <div className="space-y-4">
              {queryAP.data.filter((g: any) => g.count > 0).map((group: any) => (
                <div key={group.type} className="border border-[var(--border)] rounded-lg overflow-hidden">
                  {/* Group header */}
                  <div className="flex items-center gap-3 px-4 py-3 bg-[var(--hover)]">
                    <Badge className={cn(
                      'border shrink-0',
                      group.severity === 'critical' ? 'bg-red-500/10 text-red-400 border-red-500/20'
                        : group.severity === 'warn' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                          : 'bg-blue-500/10 text-blue-400 border-blue-500/20',
                    )}>
                      {group.severity}
                    </Badge>
                    <span className="font-medium text-sm">{group.title}</span>
                    <Badge className="bg-[var(--border)] text-[var(--dim)] border border-[var(--border)] ml-auto">
                      {group.count} {group.count === 1 ? 'pattern' : 'patterns'}
                    </Badge>
                  </div>
                  {/* Description */}
                  <div className="px-4 py-2 text-xs text-[var(--dim)] border-b border-[var(--border)]">
                    {group.description}
                  </div>
                  {/* Queries table */}
                  <div className="px-4 py-3">
                    <DataTable
                      columns={[
                        {
                          key: 'hash',
                          label: 'Hash',
                          format: (v: any) => <span className="font-mono text-xs">{String(v ?? '').slice(0, 10)}</span>,
                        },
                        {
                          key: 'sample_query',
                          label: 'Query',
                          format: (v: any) => (
                            <span className="font-mono text-xs block max-w-xs truncate" title={String(v ?? '')}>
                              {String(v ?? '').slice(0, 120)}
                            </span>
                          ),
                        },
                        { key: 'exec_count', label: 'Runs', format: (v: any) => fmtNum(v) },
                        { key: 'avg_ms', label: 'Avg', format: (v: any) => fmtDuration(Number(v) || 0) },
                        ...getAPExtraColumns(group.type),
                      ]}
                      data={limitRows(`qap_${group.type}`, group.queries)}
                      onRowClick={(row) => row.sample_query && navToTerminal(row.sample_query, inst)}
                    />
                    <ShowAllButton sectionKey={`qap_${group.type}`} total={group.queries.length} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* ---- Section 10: Table Design Anti-patterns ---- */}
      {hasRun && (
        <Section
          title="Table Design Anti-patterns"
          count={tableAP.data ? tableAP.data.filter((g: any) => g.count > 0).length : null}
          collapsed={!!collapsed['tableAP']}
          onToggle={() => toggle('tableAP')}
          loading={tableAP.loading}
          error={tableAP.error}
          onAnalyze={() => analyze('Table Design Anti-patterns', { issues: tableAP.data, instance: inst }, { contextType: 'tab', tab: 'advisor', elementId: 'tableAP' })}
        >
          {tableAP.data && tableAP.data.every((g: any) => g.count === 0) && (
            <div className="text-sm text-[var(--dim)]">No table design anti-patterns detected.</div>
          )}
          {tableAP.data && tableAP.data.some((g: any) => g.count > 0) && (
            <div className="space-y-4">
              {tableAP.data.filter((g: any) => g.count > 0).map((group: any) => (
                <div key={group.type} className="border border-[var(--border)] rounded-lg overflow-hidden">
                  {/* Group header */}
                  <div className="flex items-center gap-3 px-4 py-3 bg-[var(--hover)]">
                    <Badge className={cn(
                      'border shrink-0',
                      group.severity === 'critical' ? 'bg-red-500/10 text-red-400 border-red-500/20'
                        : group.severity === 'warn' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                          : 'bg-blue-500/10 text-blue-400 border-blue-500/20',
                    )}>
                      {group.severity}
                    </Badge>
                    <span className="font-medium text-sm">{group.title}</span>
                    <Badge className="bg-[var(--border)] text-[var(--dim)] border border-[var(--border)] ml-auto">
                      {group.count} {group.count === 1 ? 'table' : 'tables'}
                    </Badge>
                  </div>
                  {/* Description */}
                  <div className="px-4 py-2 text-xs text-[var(--dim)] border-b border-[var(--border)]">
                    {group.description}
                  </div>
                  {/* Tables */}
                  <div className="px-4 py-3">
                    <DataTable
                      columns={[
                        { key: 'database', label: 'Database' },
                        {
                          key: 'table',
                          label: 'Table',
                          format: (v: any, row: any) => (
                            <button
                              className="text-[var(--accent)] hover:underline text-left"
                              onClick={() => openTableDetail(inst, row.database, v)}
                            >
                              {v}
                            </button>
                          ),
                        },
                        {
                          key: 'metric',
                          label: 'Value',
                          format: (v: any, row: any) => (
                            <span className={cn(
                              'font-mono text-sm font-medium',
                              row.severity === 'critical' ? 'text-red-400'
                                : row.severity === 'warn' ? 'text-yellow-400'
                                  : 'text-blue-400',
                            )}>
                              {fmtNum(Number(v) || 0)} {row.metric_label}
                            </span>
                          ),
                        },
                        { key: 'size_human', label: 'Size', format: (v: any) => v || '—' },
                        { key: 'detail', label: 'Detail', format: (v: any) => <span className="text-xs text-[var(--dim)]">{v}</span> },
                        {
                          key: 'fix_hint',
                          label: '',
                          format: (v: any) => v ? <FixButton sql={v} instance={inst} /> : null,
                        },
                      ]}
                      data={limitRows(`tap_${group.type}`, group.tables.map((t: any) => ({ ...t, severity: group.severity })))}
                      onRowClick={(row) => row.fix_hint && navToTerminal(row.fix_hint, inst)}
                    />
                    <ShowAllButton sectionKey={`tap_${group.type}`} total={group.tables.length} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}
    </div>
  )
}
