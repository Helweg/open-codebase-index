use crate::{
    community, db, CallEdgeData, CentralityData, CommunityData, PathHopData, ReachabilityData,
    SymbolData,
};
use napi::bindgen_prelude::{Buffer, Error, Result};
use napi_derive::napi;

#[napi]
pub struct Database {
    conn: std::sync::Mutex<Option<rusqlite::Connection>>,
}

#[napi(object)]
pub struct ChunkData {
    pub chunk_id: String,
    pub content_hash: String,
    pub file_path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub node_type: Option<String>,
    pub name: Option<String>,
    pub language: String,
    pub blame_sha: Option<String>,
    pub blame_author: Option<String>,
    pub blame_author_email: Option<String>,
    pub blame_committed_at: Option<i64>,
    pub blame_summary: Option<String>,
}

#[napi(object)]
pub struct BranchDelta {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

#[napi(object)]
pub struct EmbeddingBatchItem {
    pub content_hash: String,
    pub embedding: Buffer,
    pub chunk_text: String,
    pub model: String,
}

#[napi(object)]
pub struct DatabaseStats {
    pub embedding_count: u32,
    pub chunk_count: u32,
    pub branch_chunk_count: u32,
    pub branch_count: u32,
    pub symbol_count: u32,
    pub call_edge_count: u32,
}

#[napi]
impl Database {
    fn from_connection(conn: rusqlite::Connection) -> Self {
        Self {
            conn: std::sync::Mutex::new(Some(conn)),
        }
    }

    #[napi(constructor)]
    pub fn new(db_path: String) -> Result<Self> {
        let conn = db::init_db(std::path::Path::new(&db_path))
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Self::from_connection(conn))
    }

    #[napi(factory)]
    pub fn open_read_only(db_path: String) -> Result<Self> {
        let conn = db::open_db_read_only(std::path::Path::new(&db_path))
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Self::from_connection(conn))
    }

    #[napi(factory)]
    pub fn create_empty_read_only() -> Result<Self> {
        let conn =
            db::create_empty_read_only_db().map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Self::from_connection(conn))
    }

    fn closed_error() -> Error {
        Error::from_reason("Database is closed")
    }

    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Option<rusqlite::Connection>>> {
        self.conn
            .lock()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    fn with_conn<T, F>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&rusqlite::Connection) -> Result<T>,
    {
        let conn = self.lock_conn()?;
        let conn = conn.as_ref().ok_or_else(Self::closed_error)?;
        f(conn)
    }

    fn with_conn_mut<T, F>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut rusqlite::Connection) -> Result<T>,
    {
        let mut conn = self.lock_conn()?;
        let conn = conn.as_mut().ok_or_else(Self::closed_error)?;
        f(conn)
    }

    #[napi]
    pub fn begin_write_transaction(&self) -> Result<()> {
        self.with_conn_mut(|conn| {
            db::begin_write_transaction(conn).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn commit_write_transaction(&self) -> Result<()> {
        self.with_conn_mut(|conn| {
            db::commit_write_transaction(conn).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn rollback_write_transaction(&self) -> Result<()> {
        self.with_conn_mut(|conn| {
            db::rollback_write_transaction(conn).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn close(&self) -> Result<()> {
        // Best-effort, idempotent shutdown: once the connection is taken, all
        // future calls fail fast with `Database is closed` and repeated close()
        // calls are harmless.
        let mut conn = self.lock_conn()?;
        let old = conn.take();
        drop(old);
        Ok(())
    }

    #[napi]
    pub fn embedding_exists(&self, content_hash: String) -> Result<bool> {
        self.with_conn(|conn| {
            db::embedding_exists(conn, &content_hash).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn get_embedding(&self, content_hash: String) -> Result<Option<Buffer>> {
        self.with_conn(|conn| {
            let result = db::get_embedding(conn, &content_hash)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(result.map(Buffer::from))
        })
    }

    #[napi]
    pub fn upsert_embedding(
        &self,
        content_hash: String,
        embedding: Buffer,
        chunk_text: String,
        model: String,
    ) -> Result<()> {
        self.with_conn(|conn| {
            db::upsert_embedding(conn, &content_hash, &embedding, &chunk_text, &model)
                .map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn get_missing_embeddings(&self, content_hashes: Vec<String>) -> Result<Vec<String>> {
        self.with_conn(|conn| {
            db::get_missing_embeddings(conn, &content_hashes)
                .map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn upsert_chunk(&self, chunk: ChunkData) -> Result<()> {
        self.with_conn(|conn| {
            db::upsert_chunk_with_blame(
                conn,
                &chunk.chunk_id,
                &chunk.content_hash,
                &chunk.file_path,
                chunk.start_line,
                chunk.end_line,
                chunk.node_type.as_deref(),
                chunk.name.as_deref(),
                &chunk.language,
                chunk.blame_sha.as_deref(),
                chunk.blame_author.as_deref(),
                chunk.blame_author_email.as_deref(),
                chunk.blame_committed_at,
                chunk.blame_summary.as_deref(),
            )
            .map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn get_chunk(&self, chunk_id: String) -> Result<Option<ChunkData>> {
        self.with_conn(|conn| {
            let result =
                db::get_chunk(conn, &chunk_id).map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(result.map(|row| ChunkData {
                chunk_id: row.chunk_id,
                content_hash: row.content_hash,
                file_path: row.file_path,
                start_line: row.start_line,
                end_line: row.end_line,
                node_type: row.node_type,
                name: row.name,
                language: row.language,
                blame_sha: row.blame_sha,
                blame_author: row.blame_author,
                blame_author_email: row.blame_author_email,
                blame_committed_at: row.blame_committed_at,
                blame_summary: row.blame_summary,
            }))
        })
    }

    #[napi]
    pub fn get_chunks_by_file(&self, file_path: String) -> Result<Vec<ChunkData>> {
        self.with_conn(|conn| {
            let rows = db::get_chunks_by_file(conn, &file_path)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(rows
                .into_iter()
                .map(|row| ChunkData {
                    chunk_id: row.chunk_id,
                    content_hash: row.content_hash,
                    file_path: row.file_path,
                    start_line: row.start_line,
                    end_line: row.end_line,
                    node_type: row.node_type,
                    name: row.name,
                    language: row.language,
                    blame_sha: row.blame_sha,
                    blame_author: row.blame_author,
                    blame_author_email: row.blame_author_email,
                    blame_committed_at: row.blame_committed_at,
                    blame_summary: row.blame_summary,
                })
                .collect())
        })
    }

    #[napi]
    pub fn get_chunks_by_name(&self, name: String) -> Result<Vec<ChunkData>> {
        self.with_conn(|conn| {
            let rows = db::get_chunks_by_name(conn, &name)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(rows
                .into_iter()
                .map(|row| ChunkData {
                    chunk_id: row.chunk_id,
                    content_hash: row.content_hash,
                    file_path: row.file_path,
                    start_line: row.start_line,
                    end_line: row.end_line,
                    node_type: row.node_type,
                    name: row.name,
                    language: row.language,
                    blame_sha: row.blame_sha,
                    blame_author: row.blame_author,
                    blame_author_email: row.blame_author_email,
                    blame_committed_at: row.blame_committed_at,
                    blame_summary: row.blame_summary,
                })
                .collect())
        })
    }

    #[napi]
    pub fn get_chunks_by_name_ci(&self, name: String) -> Result<Vec<ChunkData>> {
        self.with_conn(|conn| {
            let rows = db::get_chunks_by_name_ci(conn, &name)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(rows
                .into_iter()
                .map(|row| ChunkData {
                    chunk_id: row.chunk_id,
                    content_hash: row.content_hash,
                    file_path: row.file_path,
                    start_line: row.start_line,
                    end_line: row.end_line,
                    node_type: row.node_type,
                    name: row.name,
                    language: row.language,
                    blame_sha: row.blame_sha,
                    blame_author: row.blame_author,
                    blame_author_email: row.blame_author_email,
                    blame_committed_at: row.blame_committed_at,
                    blame_summary: row.blame_summary,
                })
                .collect())
        })
    }

    #[napi]
    pub fn delete_chunks_by_file(&self, file_path: String) -> Result<u32> {
        self.with_conn(|conn| {
            let count = db::delete_chunks_by_file(conn, &file_path)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    #[napi]
    pub fn delete_chunks_by_ids(&self, chunk_ids: Vec<String>) -> Result<u32> {
        self.with_conn(|conn| {
            let count = db::delete_chunks_by_ids(conn, &chunk_ids)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    #[napi]
    pub fn add_chunks_to_branch(&self, branch: String, chunk_ids: Vec<String>) -> Result<()> {
        self.with_conn(|conn| {
            db::add_chunks_to_branch(conn, &branch, &chunk_ids)
                .map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn upsert_embeddings_batch(&self, items: Vec<EmbeddingBatchItem>) -> Result<()> {
        let batch: Vec<(String, Vec<u8>, String, String)> = items
            .into_iter()
            .map(|item| {
                (
                    item.content_hash,
                    item.embedding.to_vec(),
                    item.chunk_text,
                    item.model,
                )
            })
            .collect();
        self.with_conn_mut(|conn| {
            db::upsert_embeddings_batch(conn, &batch).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn upsert_chunks_batch(&self, chunks: Vec<ChunkData>) -> Result<()> {
        let batch: Vec<db::ChunkRow> = chunks
            .into_iter()
            .map(|c| db::ChunkRow {
                chunk_id: c.chunk_id,
                content_hash: c.content_hash,
                file_path: c.file_path,
                start_line: c.start_line,
                end_line: c.end_line,
                node_type: c.node_type,
                name: c.name,
                language: c.language,
                blame_sha: c.blame_sha,
                blame_author: c.blame_author,
                blame_author_email: c.blame_author_email,
                blame_committed_at: c.blame_committed_at,
                blame_summary: c.blame_summary,
            })
            .collect();
        self.with_conn_mut(|conn| {
            db::upsert_chunks_batch(conn, &batch).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn add_chunks_to_branch_batch(&self, branch: String, chunk_ids: Vec<String>) -> Result<()> {
        self.with_conn_mut(|conn| {
            db::add_chunks_to_branch_batch(conn, &branch, &chunk_ids)
                .map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn clear_branch(&self, branch: String) -> Result<u32> {
        self.with_conn(|conn| {
            let count =
                db::clear_branch(conn, &branch).map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    #[napi]
    pub fn delete_branch_chunks_by_chunk_ids(&self, chunk_ids: Vec<String>) -> Result<u32> {
        self.with_conn(|conn| {
            let count = db::delete_branch_chunks_by_chunk_ids(conn, &chunk_ids)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    #[napi]
    pub fn delete_branch_chunks_for_branch(
        &self,
        branch: String,
        chunk_ids: Vec<String>,
    ) -> Result<u32> {
        self.with_conn(|conn| {
            let count = db::delete_branch_chunks_for_branch(conn, &branch, &chunk_ids)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    #[napi]
    pub fn get_branch_chunk_ids(&self, branch: String) -> Result<Vec<String>> {
        self.with_conn(|conn| {
            db::get_branch_chunk_ids(conn, &branch).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn get_branch_delta(&self, branch: String, base_branch: String) -> Result<BranchDelta> {
        self.with_conn(|conn| {
            let delta = db::get_branch_delta(conn, &branch, &base_branch)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(BranchDelta {
                added: delta.added,
                removed: delta.removed,
            })
        })
    }

    #[napi]
    pub fn get_referenced_chunk_ids(&self, chunk_ids: Vec<String>) -> Result<Vec<String>> {
        self.with_conn(|conn| {
            db::get_referenced_chunk_ids(conn, &chunk_ids)
                .map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn chunk_exists_on_branch(&self, branch: String, chunk_id: String) -> Result<bool> {
        self.with_conn(|conn| {
            db::chunk_exists_on_branch(conn, &branch, &chunk_id)
                .map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn get_all_branches(&self) -> Result<Vec<String>> {
        self.with_conn(|conn| {
            db::get_all_branches(conn).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn get_metadata(&self, key: String) -> Result<Option<String>> {
        self.with_conn(|conn| {
            db::get_metadata(conn, &key).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn set_metadata(&self, key: String, value: String) -> Result<()> {
        self.with_conn(|conn| {
            db::set_metadata(conn, &key, &value).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn delete_metadata(&self, key: String) -> Result<bool> {
        self.with_conn(|conn| {
            db::delete_metadata(conn, &key).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn clear_all_indexed_data(&self) -> Result<()> {
        self.with_conn(|conn| {
            db::clear_all_indexed_data(conn).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn clear_call_edge_targets_for_symbols(&self, symbol_ids: Vec<String>) -> Result<u32> {
        self.with_conn(|conn| {
            let count = db::clear_call_edge_targets_for_symbols(conn, &symbol_ids)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    #[napi]
    pub fn gc_orphan_embeddings(&self) -> Result<u32> {
        self.with_conn(|conn| {
            let count =
                db::gc_orphan_embeddings(conn).map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    #[napi]
    pub fn gc_orphan_chunks(&self) -> Result<u32> {
        self.with_conn(|conn| {
            let count =
                db::gc_orphan_chunks(conn).map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    #[napi]
    pub fn get_stats(&self) -> Result<DatabaseStats> {
        self.with_conn(|conn| {
            let stats = db::get_stats(conn).map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(DatabaseStats {
                embedding_count: stats.embedding_count as u32,
                chunk_count: stats.chunk_count as u32,
                branch_chunk_count: stats.branch_chunk_count as u32,
                branch_count: stats.branch_count as u32,
                symbol_count: stats.symbol_count as u32,
                call_edge_count: stats.call_edge_count as u32,
            })
        })
    }

    // ── Symbol methods ──────────────────────────────────────────────

    #[napi]
    pub fn upsert_symbol(&self, symbol: SymbolData) -> Result<()> {
        let row = db::SymbolRow {
            id: symbol.id,
            file_path: symbol.file_path,
            name: symbol.name,
            kind: symbol.kind,
            start_line: symbol.start_line,
            start_col: symbol.start_col,
            end_line: symbol.end_line,
            end_col: symbol.end_col,
            language: symbol.language,
        };
        self.with_conn(|conn| {
            db::upsert_symbol(conn, &row).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn upsert_symbols_batch(&self, symbols: Vec<SymbolData>) -> Result<()> {
        let rows: Vec<db::SymbolRow> = symbols
            .into_iter()
            .map(|s| db::SymbolRow {
                id: s.id,
                file_path: s.file_path,
                name: s.name,
                kind: s.kind,
                start_line: s.start_line,
                start_col: s.start_col,
                end_line: s.end_line,
                end_col: s.end_col,
                language: s.language,
            })
            .collect();
        self.with_conn_mut(|conn| {
            db::upsert_symbols_batch(conn, &rows).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn get_symbols_by_file(&self, file_path: String) -> Result<Vec<SymbolData>> {
        self.with_conn(|conn| {
            let rows = db::get_symbols_by_file(conn, &file_path)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(rows
                .into_iter()
                .map(|r| SymbolData {
                    id: r.id,
                    file_path: r.file_path,
                    name: r.name,
                    kind: r.kind,
                    start_line: r.start_line,
                    start_col: r.start_col,
                    end_line: r.end_line,
                    end_col: r.end_col,
                    language: r.language,
                })
                .collect())
        })
    }

    #[napi]
    pub fn get_symbol_by_name(
        &self,
        name: String,
        file_path: String,
    ) -> Result<Option<SymbolData>> {
        self.with_conn(|conn| {
            let row = db::get_symbol_by_name(conn, &name, &file_path)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(row.map(|r| SymbolData {
                id: r.id,
                file_path: r.file_path,
                name: r.name,
                kind: r.kind,
                start_line: r.start_line,
                start_col: r.start_col,
                end_line: r.end_line,
                end_col: r.end_col,
                language: r.language,
            }))
        })
    }

    #[napi]
    pub fn get_symbols_by_name(&self, name: String) -> Result<Vec<SymbolData>> {
        self.with_conn(|conn| {
            let rows = db::get_symbols_by_name(conn, &name)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(rows
                .into_iter()
                .map(|r| SymbolData {
                    id: r.id,
                    file_path: r.file_path,
                    name: r.name,
                    kind: r.kind,
                    start_line: r.start_line,
                    start_col: r.start_col,
                    end_line: r.end_line,
                    end_col: r.end_col,
                    language: r.language,
                })
                .collect())
        })
    }

    #[napi]
    pub fn get_symbols_by_name_ci(&self, name: String) -> Result<Vec<SymbolData>> {
        self.with_conn(|conn| {
            let rows = db::get_symbols_by_name_ci(conn, &name)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(rows
                .into_iter()
                .map(|r| SymbolData {
                    id: r.id,
                    file_path: r.file_path,
                    name: r.name,
                    kind: r.kind,
                    start_line: r.start_line,
                    start_col: r.start_col,
                    end_line: r.end_line,
                    end_col: r.end_col,
                    language: r.language,
                })
                .collect())
        })
    }
    #[napi]
    pub fn get_symbols_for_branch(&self, branch: String) -> Result<Vec<SymbolData>> {
        self.with_conn(|conn| {
            let rows = db::get_symbols_for_branch(conn, &branch)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(rows
                .into_iter()
                .map(|r| SymbolData {
                    id: r.id,
                    file_path: r.file_path,
                    name: r.name,
                    kind: r.kind,
                    start_line: r.start_line,
                    start_col: r.start_col,
                    end_line: r.end_line,
                    end_col: r.end_col,
                    language: r.language,
                })
                .collect())
        })
    }

    #[napi]
    pub fn get_symbols_for_files(
        &self,
        file_paths: Vec<String>,
        branch: String,
    ) -> Result<Vec<SymbolData>> {
        self.with_conn(|conn| {
            let rows = db::get_symbols_for_files(conn, &file_paths, &branch)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(rows
                .into_iter()
                .map(|r| SymbolData {
                    id: r.id,
                    file_path: r.file_path,
                    name: r.name,
                    kind: r.kind,
                    start_line: r.start_line,
                    start_col: r.start_col,
                    end_line: r.end_line,
                    end_col: r.end_col,
                    language: r.language,
                })
                .collect())
        })
    }

    #[napi]
    pub fn delete_symbols_by_file(&self, file_path: String) -> Result<u32> {
        self.with_conn(|conn| {
            let count = db::delete_symbols_by_file(conn, &file_path)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    // ── Call Edge methods ────────────────────────────────────────────

    #[napi]
    pub fn upsert_call_edge(&self, edge: CallEdgeData) -> Result<()> {
        let row = db::CallEdgeRow {
            id: edge.id,
            from_symbol_id: edge.from_symbol_id,
            target_name: edge.target_name,
            to_symbol_id: edge.to_symbol_id,
            call_type: edge.call_type,
            confidence: edge.confidence,
            line: edge.line,
            col: edge.col,
            is_resolved: edge.is_resolved,
        };
        self.with_conn(|conn| {
            db::upsert_call_edge(conn, &row).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn upsert_call_edges_batch(&self, edges: Vec<CallEdgeData>) -> Result<()> {
        let rows: Vec<db::CallEdgeRow> = edges
            .into_iter()
            .map(|e| db::CallEdgeRow {
                id: e.id,
                from_symbol_id: e.from_symbol_id,
                target_name: e.target_name,
                to_symbol_id: e.to_symbol_id,
                call_type: e.call_type,
                confidence: e.confidence,
                line: e.line,
                col: e.col,
                is_resolved: e.is_resolved,
            })
            .collect();
        self.with_conn_mut(|conn| {
            db::upsert_call_edges_batch(conn, &rows).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn get_callers(
        &self,
        symbol_name: String,
        branch: String,
        call_type_filter: Option<String>,
    ) -> Result<Vec<CallEdgeData>> {
        self.with_conn(|conn| {
            let rows = db::get_callers(conn, &symbol_name, &branch, call_type_filter.as_deref())
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(rows
                .into_iter()
                .map(|r| CallEdgeData {
                    id: r.id,
                    from_symbol_id: r.from_symbol_id,
                    from_symbol_name: None,
                    from_symbol_file_path: None,
                    target_name: r.target_name,
                    to_symbol_id: r.to_symbol_id,
                    call_type: r.call_type,
                    confidence: r.confidence,
                    line: r.line,
                    col: r.col,
                    is_resolved: r.is_resolved,
                })
                .collect())
        })
    }

    #[napi]
    pub fn get_callees(
        &self,
        symbol_id: String,
        branch: String,
        call_type_filter: Option<String>,
    ) -> Result<Vec<CallEdgeData>> {
        self.with_conn(|conn| {
            let rows = db::get_callees(conn, &symbol_id, &branch, call_type_filter.as_deref())
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(rows
                .into_iter()
                .map(|r| CallEdgeData {
                    id: r.id,
                    from_symbol_id: r.from_symbol_id,
                    from_symbol_name: None,
                    from_symbol_file_path: None,
                    target_name: r.target_name,
                    to_symbol_id: r.to_symbol_id,
                    call_type: r.call_type,
                    confidence: r.confidence,
                    line: r.line,
                    col: r.col,
                    is_resolved: r.is_resolved,
                })
                .collect())
        })
    }

    #[napi]
    pub fn get_callers_with_context(
        &self,
        symbol_name: String,
        branch: String,
        call_type_filter: Option<String>,
    ) -> Result<Vec<CallEdgeData>> {
        self.with_conn(|conn| {
            let rows = db::get_callers_with_context(
                conn,
                &symbol_name,
                &branch,
                call_type_filter.as_deref(),
            )
            .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(rows
                .into_iter()
                .map(|r| CallEdgeData {
                    id: r.id,
                    from_symbol_id: r.from_symbol_id,
                    from_symbol_name: Some(r.from_symbol_name),
                    from_symbol_file_path: Some(r.from_symbol_file_path),
                    target_name: r.target_name,
                    to_symbol_id: r.to_symbol_id,
                    call_type: r.call_type,
                    confidence: r.confidence,
                    line: r.line,
                    col: r.col,
                    is_resolved: r.is_resolved,
                })
                .collect())
        })
    }

    #[napi]
    pub fn delete_call_edges_by_file(&self, file_path: String) -> Result<u32> {
        self.with_conn(|conn| {
            let count = db::delete_call_edges_by_file(conn, &file_path)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    #[napi]
    pub fn resolve_call_edge(&self, edge_id: String, to_symbol_id: String) -> Result<()> {
        self.with_conn(|conn| {
            db::resolve_call_edge(conn, &edge_id, &to_symbol_id)
                .map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn find_shortest_path(
        &self,
        from_name: String,
        to_name: String,
        branch: String,
        max_depth: Option<u32>,
    ) -> Result<Vec<PathHopData>> {
        self.with_conn(|conn| {
            let depth = max_depth.unwrap_or(10);
            let hops = db::find_shortest_path(conn, &from_name, &to_name, &branch, depth)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(hops
                .into_iter()
                .map(|h| PathHopData {
                    symbol_id: h.symbol_id,
                    symbol_name: h.symbol_name,
                    file_path: h.file_path,
                    line: h.line,
                    call_type: h.call_type,
                })
                .collect())
        })
    }

    // ── Branch Symbol methods ────────────────────────────────────────

    #[napi]
    pub fn add_symbols_to_branch(&self, branch: String, symbol_ids: Vec<String>) -> Result<()> {
        self.with_conn(|conn| {
            db::add_symbols_to_branch(conn, &branch, &symbol_ids)
                .map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn add_symbols_to_branch_batch(
        &self,
        branch: String,
        symbol_ids: Vec<String>,
    ) -> Result<()> {
        self.with_conn_mut(|conn| {
            db::add_symbols_to_branch_batch(conn, &branch, &symbol_ids)
                .map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn get_branch_symbol_ids(&self, branch: String) -> Result<Vec<String>> {
        self.with_conn(|conn| {
            db::get_branch_symbol_ids(conn, &branch).map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn clear_branch_symbols(&self, branch: String) -> Result<u32> {
        self.with_conn(|conn| {
            let count = db::clear_branch_symbols(conn, &branch)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    #[napi]
    pub fn get_referenced_symbol_ids(&self, symbol_ids: Vec<String>) -> Result<Vec<String>> {
        self.with_conn(|conn| {
            db::get_referenced_symbol_ids(conn, &symbol_ids)
                .map_err(|e| Error::from_reason(e.to_string()))
        })
    }

    #[napi]
    pub fn delete_branch_symbols_by_symbol_ids(&self, symbol_ids: Vec<String>) -> Result<u32> {
        self.with_conn(|conn| {
            let count = db::delete_branch_symbols_by_symbol_ids(conn, &symbol_ids)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    #[napi]
    pub fn delete_branch_symbols_for_branch(
        &self,
        branch: String,
        symbol_ids: Vec<String>,
    ) -> Result<u32> {
        self.with_conn(|conn| {
            let count = db::delete_branch_symbols_for_branch(conn, &branch, &symbol_ids)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    // ── GC methods for symbols/edges ─────────────────────────────────

    #[napi]
    pub fn gc_orphan_symbols(&self) -> Result<u32> {
        self.with_conn(|conn| {
            let count =
                db::gc_orphan_symbols(conn).map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    #[napi]
    pub fn gc_orphan_call_edges(&self) -> Result<u32> {
        self.with_conn(|conn| {
            let count =
                db::gc_orphan_call_edges(conn).map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(count as u32)
        })
    }

    #[napi]
    pub fn get_transitive_reachability(
        &self,
        root_symbol_ids: Vec<String>,
        branch: String,
        direction: String,
        max_depth: Option<u32>,
    ) -> Result<Vec<ReachabilityData>> {
        self.with_conn(|conn| {
            let depth = max_depth.unwrap_or(10);
            let rows = community::get_transitive_reachability(
                conn,
                &root_symbol_ids,
                &branch,
                &direction,
                depth,
            )
            .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(rows
                .into_iter()
                .map(|r| ReachabilityData {
                    symbol_id: r.symbol_id,
                    symbol_name: r.symbol_name,
                    file_path: r.file_path,
                    depth: r.depth,
                })
                .collect())
        })
    }

    #[napi]
    pub fn detect_communities(
        &self,
        branch: String,
        symbol_ids: Option<Vec<String>>,
    ) -> Result<Vec<CommunityData>> {
        self.with_conn(|conn| {
            let rows = community::detect_communities(conn, &branch, symbol_ids.as_deref())
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(rows
                .into_iter()
                .map(|r| CommunityData {
                    symbol_id: r.symbol_id,
                    symbol_name: r.symbol_name,
                    file_path: r.file_path,
                    community_id: r.community_id,
                    community_label: r.community_label,
                })
                .collect())
        })
    }

    #[napi]
    pub fn compute_centrality(&self, branch: String) -> Result<Vec<CentralityData>> {
        self.with_conn(|conn| {
            let rows = community::compute_centrality(conn, &branch)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            Ok(rows
                .into_iter()
                .map(|r| CentralityData {
                    symbol_id: r.symbol_id,
                    symbol_name: r.symbol_name,
                    file_path: r.file_path,
                    caller_count: r.caller_count,
                    callee_count: r.callee_count,
                    total_connections: r.total_connections,
                })
                .collect())
        })
    }
}
