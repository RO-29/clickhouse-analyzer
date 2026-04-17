package web

import (
	"context"
	"net/http"
	"time"
)

// PartitionDiskRow holds per-partition per-disk storage breakdown for one table.
type PartitionDiskRow struct {
	Partition         string `json:"partition"`
	DiskName          string `json:"disk_name"`
	DiskType          string `json:"disk_type"` // "local", "s3", "hdfs", etc.
	PartsCount        uint64 `json:"parts_count"`
	Rows              uint64 `json:"rows"`
	Bytes             uint64 `json:"bytes"`
	CompressedBytes   uint64 `json:"compressed_bytes"`
	UncompressedBytes uint64 `json:"uncompressed_bytes"`
}

// handleTablePartitions handles:
// GET /api/instances/{name}/table-partitions?db=X&table=Y
func (s *Server) handleTablePartitions(w http.ResponseWriter, r *http.Request) {
	instance := r.PathValue("name")
	db := r.URL.Query().Get("db")
	table := r.URL.Query().Get("table")

	if db == "" || table == "" {
		writeErr(w, http.StatusBadRequest, "db and table query parameters are required")
		return
	}

	client := s.manager.Get(instance)
	if client == nil {
		writeErr(w, http.StatusNotFound, "instance not found: "+instance)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	safeDB := escapeSQLString(db)
	safeTable := escapeSQLString(table)

	queryRows, err := client.Query(ctx, `
SELECT
    p.partition,
    p.disk_name,
    COALESCE(d.type, 'local') AS disk_type,
    count() AS parts_count,
    sum(p.rows) AS rows,
    sum(p.bytes_on_disk) AS bytes,
    sum(p.data_compressed_bytes) AS compressed_bytes,
    sum(p.data_uncompressed_bytes) AS uncompressed_bytes
FROM system.parts AS p
LEFT JOIN system.disks AS d ON p.disk_name = d.name
WHERE p.database = '`+safeDB+`' AND p.table = '`+safeTable+`' AND p.active = 1
GROUP BY p.partition, p.disk_name, disk_type
ORDER BY p.partition DESC, bytes DESC
LIMIT 500
`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to query partitions: "+err.Error())
		return
	}

	rows := make([]PartitionDiskRow, 0, len(queryRows))
	for _, row := range queryRows {
		rows = append(rows, PartitionDiskRow{
			Partition:         strVal(row["partition"]),
			DiskName:          strVal(row["disk_name"]),
			DiskType:          strVal(row["disk_type"]),
			PartsCount:        uint64Val(row["parts_count"]),
			Rows:              uint64Val(row["rows"]),
			Bytes:             uint64Val(row["bytes"]),
			CompressedBytes:   uint64Val(row["compressed_bytes"]),
			UncompressedBytes: uint64Val(row["uncompressed_bytes"]),
		})
	}

	writeJSON(w, http.StatusOK, rows)
}
