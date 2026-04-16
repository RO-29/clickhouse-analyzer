import { useEffect, useState } from 'react'
import { X, Database } from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../hooks/useStore'
import { fmtBytes, fmtNum, fmtDuration, cn } from '../lib/utils'
import { Card } from './Card'
import { Badge } from './Badge'
import { DataTable } from './DataTable'
import { SqlBlock } from './SqlBlock'

interface TableDetailProps {
  instance: string
  database: string
  table: string
  onClose: () => void
}

export function TableDetail({ instance, database, table, onClose }: TableDetailProps) {
  const { navToTerminal } = useStore()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    api.tableDetail(instance, database, table)
      .then(d => {
        if (!cancelled) setData(d)
      })
      .catch(err => {
        if (!cancelled) setError(err?.message ?? 'Failed to load table detail')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [instance, database, table])

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const partsByDiskCols = [
    { key: 'disk_name', label: 'Disk' },
    { key: 'parts', label: 'Parts', format: (v: any) => fmtNum(v) },
    { key: 'rows', label: 'Rows', format: (v: any) => fmtNum(v) },
    { key: 'size', label: 'Size', format: (v: any) => typeof v === 'number' ? fmtBytes(v) : String(v ?? '') },
  ]

  const mergeCols = [
    { key: 'event_type', label: 'Event' },
    { key: 'count', label: 'Count', format: (v: any) => fmtNum(v) },
    { key: 'avg_ms', label: 'Avg Duration', format: (v: any) => fmtDuration(v ?? 0) },
  ]

  const queryPatternCols = [
    { key: 'hash', label: 'Hash' },
    { key: 'count', label: 'Count', format: (v: any) => fmtNum(v) },
    { key: 'avg_ms', label: 'Avg ms', format: (v: any) => fmtDuration(v ?? 0) },
    { key: 'user', label: 'User' },
    {
      key: 'sample',
      label: 'Sample Query',
      format: (v: any) => (
        <span className="font-mono text-xs truncate block max-w-md" title={String(v ?? '')}>
          {String(v ?? '').slice(0, 120)}
        </span>
      ),
    },
  ]

  const otherNodesCols = [
    { key: 'instance', label: 'Node' },
    { key: 'rows', label: 'Rows', format: (v: any) => fmtNum(v) },
    { key: 'size', label: 'Size', format: (v: any) => typeof v === 'number' ? fmtBytes(v) : String(v ?? '') },
    {
      key: 'parts',
      label: 'Parts',
      format: (v: any) => {
        const n = v ?? 0
        return <span className={n > 300 ? 'text-red-400' : n > 100 ? 'text-yellow-400' : ''}>{fmtNum(n)}</span>
      },
    },
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-3xl bg-[var(--bg)] border-l border-[var(--border)] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[var(--bg)] border-b border-[var(--border)] px-6 py-4 flex items-center gap-3">
          <Database size={20} className="text-[var(--accent)] shrink-0" />
          <h2 className="text-lg font-bold truncate flex-1" title={`${database}.${table}`}>
            {database}.{table}
          </h2>
          {data?.engine && (
            <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/20">{data.engine}</Badge>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-[var(--hover)] text-[var(--dim)] hover:text-[var(--text)] transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Loading */}
          {loading && (
            <div className="space-y-4 animate-pulse">
              {[...Array(4)].map((_, i) => (
                <Card key={i}>
                  <div className="h-16 bg-[var(--hover)] rounded" />
                </Card>
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <Card>
              <div className="text-red-400 text-sm">{error}</div>
            </Card>
          )}

          {/* Content */}
          {data && !loading && (
            <>
              {/* Metadata */}
              <Card title="Metadata">
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  {data.engine_full && (
                    <div>
                      <span className="text-[var(--dim)]">Engine: </span>
                      <span className="font-mono text-xs">{data.engine_full}</span>
                    </div>
                  )}
                  {data.partition_key && (
                    <div>
                      <span className="text-[var(--dim)]">Partition Key: </span>
                      <span className="font-mono text-xs">{data.partition_key}</span>
                    </div>
                  )}
                  {data.sorting_key && (
                    <div>
                      <span className="text-[var(--dim)]">Sorting Key: </span>
                      <span className="font-mono text-xs">{data.sorting_key}</span>
                    </div>
                  )}
                  {data.storage_policy && (
                    <div>
                      <span className="text-[var(--dim)]">Storage Policy: </span>
                      <span className="font-mono text-xs">{data.storage_policy}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-[var(--dim)]">Rows: </span>
                    <span className="font-bold">{fmtNum(data.total_rows)}</span>
                  </div>
                  <div>
                    <span className="text-[var(--dim)]">Size: </span>
                    <span className="font-bold">{typeof data.size === 'number' ? fmtBytes(data.size) : String(data.size ?? '--')}</span>
                  </div>
                </div>
              </Card>

              {/* Parts by Disk */}
              {Array.isArray(data.parts_by_disk) && data.parts_by_disk.length > 0 && (
                <Card title="Parts by Disk">
                  <DataTable columns={partsByDiskCols} data={data.parts_by_disk} />
                </Card>
              )}

              {/* Memory */}
              {(data.pk_memory != null || data.marks_memory != null) && (
                <Card title="Memory">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <div className="text-xl font-bold">{fmtBytes(data.pk_memory ?? 0)}</div>
                      <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">PK Memory</div>
                    </div>
                    <div>
                      <div className="text-xl font-bold">{fmtBytes(data.marks_memory ?? 0)}</div>
                      <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Marks Memory</div>
                    </div>
                    <div>
                      <div className="text-xl font-bold">{fmtNum(data.mark_count)}</div>
                      <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Mark Count</div>
                    </div>
                  </div>
                </Card>
              )}

              {/* Compression */}
              {(data.compressed != null || data.uncompressed != null) && (
                <Card title="Compression">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <div className="text-xl font-bold">{fmtBytes(data.compressed ?? 0)}</div>
                      <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Compressed</div>
                    </div>
                    <div>
                      <div className="text-xl font-bold">{fmtBytes(data.uncompressed ?? 0)}</div>
                      <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Uncompressed</div>
                    </div>
                    <div>
                      <div className={cn(
                        'text-xl font-bold',
                        (data.ratio ?? 0) < 1.5 ? 'text-red-400' : (data.ratio ?? 0) < 2.0 ? 'text-yellow-400' : 'text-green-400',
                      )}>
                        {(data.ratio ?? 0).toFixed(2)}x
                      </div>
                      <div className="text-xs text-[var(--dim)] mt-1 uppercase tracking-wider">Ratio</div>
                    </div>
                  </div>
                </Card>
              )}

              {/* Partitions */}
              {data.partition_count != null && (
                <Card title="Partitions">
                  <div className="text-xl font-bold">{fmtNum(data.partition_count)}</div>
                  <div className="text-xs text-[var(--dim)] mt-1">Active partitions</div>
                </Card>
              )}

              {/* Recent Merges */}
              {Array.isArray(data.recent_merges) && data.recent_merges.length > 0 && (
                <Card title="Recent Merges (last 1h)">
                  <DataTable columns={mergeCols} data={data.recent_merges} />
                </Card>
              )}

              {/* Top Query Patterns */}
              {Array.isArray(data.top_queries) && data.top_queries.length > 0 && (
                <Card title="Top Query Patterns">
                  <DataTable
                    columns={queryPatternCols}
                    data={data.top_queries}
                    onRowClick={(row) => {
                      if (row.sample) {
                        navToTerminal(row.sample, instance)
                      }
                    }}
                  />
                </Card>
              )}

              {/* Other Nodes */}
              {Array.isArray(data.other_nodes) && data.other_nodes.length > 0 && (
                <Card title="Other Nodes">
                  <DataTable columns={otherNodesCols} data={data.other_nodes} />
                </Card>
              )}

              {/* Quick Queries */}
              <Card title="Quick Queries">
                <div className="space-y-2">
                  <SqlBlock
                    sql={`SELECT count() as rows, formatReadableSize(sum(bytes_on_disk)) as size,\n  count() as parts\nFROM system.parts\nWHERE database = '${database}' AND table = '${table}' AND active`}
                    instance={instance}
                  />
                  <SqlBlock
                    sql={`SELECT partition, count() as parts, sum(rows) as rows,\n  formatReadableSize(sum(bytes_on_disk)) as size\nFROM system.parts\nWHERE database = '${database}' AND table = '${table}' AND active\nGROUP BY partition\nORDER BY parts DESC\nLIMIT 20`}
                    instance={instance}
                  />
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
