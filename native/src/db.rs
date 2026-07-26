use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::path::Path;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum DbError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Read-only database schema error: {0}")]
    ReadOnlySchema(String),
}

pub type DbResult<T> = Result<T, DbError>;

/// Schema version for migrations
const SCHEMA_VERSION: i32 = 6;

/// Maximum number of SQL bind parameters per query.
/// SQLite defaults to 999 (SQLITE_MAX_VARIABLE_NUMBER). We use 900 to stay safely under.
const SQL_BIND_PARAM_BATCH_SIZE: usize = 900;

/// Initialize the database with the required schema
pub fn init_db(db_path: &Path) -> DbResult<Connection> {
    // Ensure parent directory exists
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let conn = Connection::open(db_path)?;

    // Enable WAL mode for better concurrent read performance
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys = ON;",
    )?;

    let current_version: i32 = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None)
        .and_then(|v: String| v.parse().ok())
        .unwrap_or(0);

    if current_version < SCHEMA_VERSION {
        migrate_schema(&conn, current_version)?;
    }

    Ok(conn)
}

/// Ouvre une base publiée sans créer de fichier ni exécuter de migration.
pub fn open_db_read_only(db_path: &Path) -> DbResult<Connection> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    conn.execute_batch("PRAGMA query_only = ON; PRAGMA foreign_keys = ON;")?;

    let stored_version: String = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| {
            DbError::ReadOnlySchema(format!(
                "cannot read schema version (expected {SCHEMA_VERSION}): {error}"
            ))
        })?;
    let current_version = stored_version.parse::<i32>().map_err(|error| {
        DbError::ReadOnlySchema(format!(
            "invalid schema version {stored_version:?} (expected {SCHEMA_VERSION}): {error}"
        ))
    })?;

    if current_version != SCHEMA_VERSION {
        return Err(DbError::ReadOnlySchema(format!(
            "found version {current_version}, expected {SCHEMA_VERSION}; a writer must migrate the index"
        )));
    }

    Ok(conn)
}

/// Crée un catalogue vide en mémoire, puis le verrouille en lecture seule.
pub fn create_empty_read_only_db() -> DbResult<Connection> {
    let conn = Connection::open_in_memory()?;
    migrate_schema(&conn, 0)?;
    conn.execute_batch("PRAGMA query_only = ON; PRAGMA foreign_keys = ON;")?;
    Ok(conn)
}

/// Run schema migrations
fn migrate_schema(conn: &Connection, from_version: i32) -> DbResult<()> {
    if from_version < 1 {
        // Initial schema
        conn.execute_batch(
            r#"
            -- Metadata table (must be created first for schema_version)
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- Embeddings stored by content hash (deduplicated across branches)
            CREATE TABLE IF NOT EXISTS embeddings (
                content_hash TEXT PRIMARY KEY,
                embedding BLOB NOT NULL,
                chunk_text TEXT NOT NULL,
                model TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            -- Chunks table: stores chunk metadata
            CREATE TABLE IF NOT EXISTS chunks (
                chunk_id TEXT PRIMARY KEY,
                content_hash TEXT NOT NULL,
                file_path TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                node_type TEXT,
                name TEXT,
                language TEXT NOT NULL,
                blame_sha TEXT,
                blame_author TEXT,
                blame_author_email TEXT,
                blame_committed_at INTEGER,
                blame_summary TEXT
            );

            -- Branch catalog: which chunks exist on which branch
            CREATE TABLE IF NOT EXISTS branch_chunks (
                branch TEXT NOT NULL,
                chunk_id TEXT NOT NULL,
                PRIMARY KEY (branch, chunk_id)
            );

            -- Indexes for fast lookups
            CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
            CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
            CREATE INDEX IF NOT EXISTS idx_chunks_name ON chunks(name);
            CREATE INDEX IF NOT EXISTS idx_chunks_name_lower ON chunks(lower(name));
            CREATE INDEX IF NOT EXISTS idx_branch_chunks_branch ON branch_chunks(branch);
            CREATE INDEX IF NOT EXISTS idx_branch_chunks_chunk_id ON branch_chunks(chunk_id);
            "#,
        )?;

        // Set schema version
        conn.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)",
            params![SCHEMA_VERSION.to_string()],
        )?;
    }

    if from_version < 2 {
        // v2: Call graph tables
        conn.execute_batch(
            r#"
            -- Symbols table: function/class/method definitions extracted from source files
            CREATE TABLE IF NOT EXISTS symbols (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                start_line INTEGER NOT NULL,
                start_col INTEGER NOT NULL,
                end_line INTEGER NOT NULL,
                end_col INTEGER NOT NULL,
                language TEXT NOT NULL
            );

            -- Call edges: relationships between symbols (caller -> callee)
            CREATE TABLE IF NOT EXISTS call_edges (
                id TEXT PRIMARY KEY,
                from_symbol_id TEXT NOT NULL,
                target_name TEXT NOT NULL,
                to_symbol_id TEXT,
                call_type TEXT NOT NULL,
                confidence TEXT NOT NULL DEFAULT 'Direct',
                line INTEGER NOT NULL,
                col INTEGER NOT NULL,
                is_resolved INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (from_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
            );

            -- Branch-symbol catalog: which symbols exist on which branch
            CREATE TABLE IF NOT EXISTS branch_symbols (
                branch TEXT NOT NULL,
                symbol_id TEXT NOT NULL,
                PRIMARY KEY (branch, symbol_id)
            );

            -- Indexes
            CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
            CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
            CREATE INDEX IF NOT EXISTS idx_call_edges_from ON call_edges(from_symbol_id);
            CREATE INDEX IF NOT EXISTS idx_call_edges_to ON call_edges(to_symbol_id);
            CREATE INDEX IF NOT EXISTS idx_call_edges_target_name ON call_edges(target_name);
            CREATE INDEX IF NOT EXISTS idx_branch_symbols_branch ON branch_symbols(branch);
            CREATE INDEX IF NOT EXISTS idx_branch_symbols_symbol_id ON branch_symbols(symbol_id);
            "#,
        )?;

        // Update schema version
        conn.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)",
            params![SCHEMA_VERSION.to_string()],
        )?;
    }
    if from_version < 3 {
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = OFF;

            BEGIN;

            CREATE TABLE call_edges_new (
                id TEXT PRIMARY KEY,
                from_symbol_id TEXT NOT NULL,
                target_name TEXT NOT NULL,
                to_symbol_id TEXT,
                call_type TEXT NOT NULL,
                confidence TEXT NOT NULL DEFAULT 'Direct',
                line INTEGER NOT NULL,
                col INTEGER NOT NULL,
                is_resolved INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (from_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
            );

            INSERT INTO call_edges_new (id, from_symbol_id, target_name, to_symbol_id, call_type, confidence, line, col, is_resolved)
            SELECT id, from_symbol_id, target_name, to_symbol_id, call_type, 'Direct', line, col, is_resolved
            FROM call_edges;

            DROP TABLE call_edges;
            ALTER TABLE call_edges_new RENAME TO call_edges;

            CREATE INDEX IF NOT EXISTS idx_call_edges_from ON call_edges(from_symbol_id);
            CREATE INDEX IF NOT EXISTS idx_call_edges_to ON call_edges(to_symbol_id);
            CREATE INDEX IF NOT EXISTS idx_call_edges_target_name ON call_edges(target_name);

            COMMIT;

            PRAGMA foreign_keys = ON;
            "#,
        )?;

        conn.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)",
            params![SCHEMA_VERSION.to_string()],
        )?;
    }

    if from_version < 4 {
        conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_chunks_name ON chunks(name);
            CREATE INDEX IF NOT EXISTS idx_chunks_name_lower ON chunks(lower(name));
            "#,
        )?;

        conn.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)",
            params![SCHEMA_VERSION.to_string()],
        )?;
    }

    // v5: Add confidence column. Only needed for databases that already went
    // through the v3 migration with old code (which didn't include confidence).
    // Fresh installs and upgrades from v2 or below already have the column
    // from the modified v2/v3 CREATE TABLE statements above.
    if (3..5).contains(&from_version) {
        conn.execute_batch(
            r#"
            ALTER TABLE call_edges ADD COLUMN confidence TEXT NOT NULL DEFAULT 'Direct';
            "#,
        )?;

        conn.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)",
            params![SCHEMA_VERSION.to_string()],
        )?;
    }

    if (1..6).contains(&from_version) {
        conn.execute_batch(
            r#"
            ALTER TABLE chunks ADD COLUMN blame_sha TEXT;
            ALTER TABLE chunks ADD COLUMN blame_author TEXT;
            ALTER TABLE chunks ADD COLUMN blame_author_email TEXT;
            ALTER TABLE chunks ADD COLUMN blame_committed_at INTEGER;
            ALTER TABLE chunks ADD COLUMN blame_summary TEXT;
            "#,
        )?;

        conn.execute(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)",
            params![SCHEMA_VERSION.to_string()],
        )?;
    }

    Ok(())
}

// ============================================================================
// Embedding Operations
// ============================================================================

/// Check if an embedding exists for a content hash
pub fn embedding_exists(conn: &Connection, content_hash: &str) -> DbResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM embeddings WHERE content_hash = ?",
        params![content_hash],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Get embedding for a content hash
pub fn get_embedding(conn: &Connection, content_hash: &str) -> DbResult<Option<Vec<u8>>> {
    let result = conn
        .query_row(
            "SELECT embedding FROM embeddings WHERE content_hash = ?",
            params![content_hash],
            |row| row.get(0),
        )
        .optional()?;
    Ok(result)
}

/// Insert or update an embedding
pub fn upsert_embedding(
    conn: &Connection,
    content_hash: &str,
    embedding: &[u8],
    chunk_text: &str,
    model: &str,
) -> DbResult<()> {
    conn.execute(
        r#"
        INSERT INTO embeddings (content_hash, embedding, chunk_text, model, created_at)
        VALUES (?, ?, ?, ?, strftime('%s', 'now'))
        ON CONFLICT(content_hash) DO UPDATE SET
            embedding = excluded.embedding,
            model = excluded.model
        "#,
        params![content_hash, embedding, chunk_text, model],
    )?;
    Ok(())
}

/// Batch insert or update embeddings within a single transaction
pub fn upsert_embeddings_batch(
    conn: &mut Connection,
    embeddings: &[(String, Vec<u8>, String, String)],
) -> DbResult<()> {
    if embeddings.is_empty() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            r#"
            INSERT INTO embeddings (content_hash, embedding, chunk_text, model, created_at)
            VALUES (?, ?, ?, ?, strftime('%s', 'now'))
            ON CONFLICT(content_hash) DO UPDATE SET
                embedding = excluded.embedding,
                model = excluded.model
            "#,
        )?;

        for (content_hash, embedding, chunk_text, model) in embeddings {
            stmt.execute(params![content_hash, embedding, chunk_text, model])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Get multiple embeddings by content hashes
#[allow(dead_code)]
pub fn get_embeddings_batch(
    conn: &Connection,
    content_hashes: &[String],
) -> DbResult<Vec<(String, Vec<u8>)>> {
    if content_hashes.is_empty() {
        return Ok(vec![]);
    }
    let mut results = Vec::new();
    for chunk in content_hashes.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders: String = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let query = format!(
            "SELECT content_hash, embedding FROM embeddings WHERE content_hash IN ({})",
            placeholders
        );

        let mut stmt = conn.prepare(&query)?;
        let params: Vec<&dyn rusqlite::ToSql> =
            chunk.iter().map(|s| s as &dyn rusqlite::ToSql).collect();

        let rows = stmt.query_map(params.as_slice(), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;

        for row in rows {
            results.push(row?);
        }
    }
    Ok(results)
}

/// Get content hashes that don't have embeddings yet
pub fn get_missing_embeddings(
    conn: &Connection,
    content_hashes: &[String],
) -> DbResult<Vec<String>> {
    if content_hashes.is_empty() {
        return Ok(vec![]);
    }
    let mut existing = std::collections::HashSet::new();
    for chunk in content_hashes.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders: String = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let query = format!(
            "SELECT content_hash FROM embeddings WHERE content_hash IN ({})",
            placeholders
        );

        let mut stmt = conn.prepare(&query)?;
        let params: Vec<&dyn rusqlite::ToSql> =
            chunk.iter().map(|s| s as &dyn rusqlite::ToSql).collect();

        let batch_existing: std::collections::HashSet<String> = stmt
            .query_map(params.as_slice(), |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();

        existing.extend(batch_existing);
    }

    Ok(content_hashes
        .iter()
        .filter(|h| !existing.contains(*h))
        .cloned()
        .collect())
}

// ============================================================================
// Chunk Operations
// ============================================================================

/// Insert or update a chunk
#[allow(clippy::too_many_arguments)]
pub fn upsert_chunk_with_blame(
    conn: &Connection,
    chunk_id: &str,
    content_hash: &str,
    file_path: &str,
    start_line: u32,
    end_line: u32,
    node_type: Option<&str>,
    name: Option<&str>,
    language: &str,
    blame_sha: Option<&str>,
    blame_author: Option<&str>,
    blame_author_email: Option<&str>,
    blame_committed_at: Option<i64>,
    blame_summary: Option<&str>,
) -> DbResult<()> {
    conn.execute(
        r#"
        INSERT INTO chunks (chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language, blame_sha, blame_author, blame_author_email, blame_committed_at, blame_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chunk_id) DO UPDATE SET
            content_hash = excluded.content_hash,
            file_path = excluded.file_path,
            start_line = excluded.start_line,
            end_line = excluded.end_line,
            node_type = excluded.node_type,
            name = excluded.name,
            language = excluded.language,
            blame_sha = excluded.blame_sha,
            blame_author = excluded.blame_author,
            blame_author_email = excluded.blame_author_email,
            blame_committed_at = excluded.blame_committed_at,
            blame_summary = excluded.blame_summary
        "#,
        params![
            chunk_id,
            content_hash,
            file_path,
            start_line,
            end_line,
            node_type,
            name,
            language,
            blame_sha,
            blame_author,
            blame_author_email,
            blame_committed_at,
            blame_summary
        ],
    )?;
    Ok(())
}

/// Batch insert or update chunks within a single transaction
pub fn upsert_chunks_batch(conn: &mut Connection, chunks: &[ChunkRow]) -> DbResult<()> {
    if chunks.is_empty() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            r#"
            INSERT INTO chunks (chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language, blame_sha, blame_author, blame_author_email, blame_committed_at, blame_summary)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(chunk_id) DO UPDATE SET
                content_hash = excluded.content_hash,
                file_path = excluded.file_path,
                start_line = excluded.start_line,
                end_line = excluded.end_line,
                node_type = excluded.node_type,
                name = excluded.name,
                language = excluded.language,
                blame_sha = excluded.blame_sha,
                blame_author = excluded.blame_author,
                blame_author_email = excluded.blame_author_email,
                blame_committed_at = excluded.blame_committed_at,
                blame_summary = excluded.blame_summary
            "#,
        )?;

        for chunk in chunks {
            stmt.execute(params![
                chunk.chunk_id,
                chunk.content_hash,
                chunk.file_path,
                chunk.start_line,
                chunk.end_line,
                chunk.node_type,
                chunk.name,
                chunk.language,
                chunk.blame_sha,
                chunk.blame_author,
                chunk.blame_author_email,
                chunk.blame_committed_at,
                chunk.blame_summary
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Get chunk by ID
pub fn get_chunk(conn: &Connection, chunk_id: &str) -> DbResult<Option<ChunkRow>> {
    let result = conn
        .query_row(
            r#"
            SELECT chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language, blame_sha, blame_author, blame_author_email, blame_committed_at, blame_summary
            FROM chunks WHERE chunk_id = ?
            "#,
            params![chunk_id],
            |row| {
                Ok(ChunkRow {
                    chunk_id: row.get(0)?,
                    content_hash: row.get(1)?,
                    file_path: row.get(2)?,
                    start_line: row.get(3)?,
                    end_line: row.get(4)?,
                    node_type: row.get(5)?,
                    name: row.get(6)?,
                    language: row.get(7)?,
                    blame_sha: row.get(8)?,
                    blame_author: row.get(9)?,
                    blame_author_email: row.get(10)?,
                    blame_committed_at: row.get(11)?,
                    blame_summary: row.get(12)?,
                })
            },
        )
        .optional()?;
    Ok(result)
}

/// Get all chunks for a file
pub fn get_chunks_by_file(conn: &Connection, file_path: &str) -> DbResult<Vec<ChunkRow>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language, blame_sha, blame_author, blame_author_email, blame_committed_at, blame_summary
        FROM chunks WHERE file_path = ?
        ORDER BY start_line
        "#,
    )?;

    let rows = stmt.query_map(params![file_path], |row| {
        Ok(ChunkRow {
            chunk_id: row.get(0)?,
            content_hash: row.get(1)?,
            file_path: row.get(2)?,
            start_line: row.get(3)?,
            end_line: row.get(4)?,
            node_type: row.get(5)?,
            name: row.get(6)?,
            language: row.get(7)?,
            blame_sha: row.get(8)?,
            blame_author: row.get(9)?,
            blame_author_email: row.get(10)?,
            blame_committed_at: row.get(11)?,
            blame_summary: row.get(12)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

pub fn get_chunks_by_name(conn: &Connection, name: &str) -> DbResult<Vec<ChunkRow>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language, blame_sha, blame_author, blame_author_email, blame_committed_at, blame_summary
        FROM chunks WHERE name = ?
        "#,
    )?;

    let rows = stmt.query_map(params![name], |row| {
        Ok(ChunkRow {
            chunk_id: row.get(0)?,
            content_hash: row.get(1)?,
            file_path: row.get(2)?,
            start_line: row.get(3)?,
            end_line: row.get(4)?,
            node_type: row.get(5)?,
            name: row.get(6)?,
            language: row.get(7)?,
            blame_sha: row.get(8)?,
            blame_author: row.get(9)?,
            blame_author_email: row.get(10)?,
            blame_committed_at: row.get(11)?,
            blame_summary: row.get(12)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

pub fn get_chunks_by_name_ci(conn: &Connection, name: &str) -> DbResult<Vec<ChunkRow>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language, blame_sha, blame_author, blame_author_email, blame_committed_at, blame_summary
        FROM chunks WHERE lower(name) = lower(?)
        "#,
    )?;

    let rows = stmt.query_map(params![name], |row| {
        Ok(ChunkRow {
            chunk_id: row.get(0)?,
            content_hash: row.get(1)?,
            file_path: row.get(2)?,
            start_line: row.get(3)?,
            end_line: row.get(4)?,
            node_type: row.get(5)?,
            name: row.get(6)?,
            language: row.get(7)?,
            blame_sha: row.get(8)?,
            blame_author: row.get(9)?,
            blame_author_email: row.get(10)?,
            blame_committed_at: row.get(11)?,
            blame_summary: row.get(12)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Delete chunks for a file
pub fn delete_chunks_by_file(conn: &Connection, file_path: &str) -> DbResult<usize> {
    let count = conn.execute("DELETE FROM chunks WHERE file_path = ?", params![file_path])?;
    Ok(count)
}

/// Delete chunks by their IDs.
pub fn delete_chunks_by_ids(conn: &Connection, chunk_ids: &[String]) -> DbResult<usize> {
    if chunk_ids.is_empty() {
        return Ok(0);
    }

    let mut deleted = 0;
    for chunk_batch in chunk_ids.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk_batch.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("DELETE FROM chunks WHERE chunk_id IN ({})", placeholders);
        deleted += conn.execute(&sql, rusqlite::params_from_iter(chunk_batch.iter()))?;
    }

    Ok(deleted)
}

#[derive(Debug, Clone)]
pub struct ChunkRow {
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

// ============================================================================
// Branch Catalog Operations
// ============================================================================

/// Add chunks to a branch
pub fn add_chunks_to_branch(conn: &Connection, branch: &str, chunk_ids: &[String]) -> DbResult<()> {
    if chunk_ids.is_empty() {
        return Ok(());
    }

    let mut stmt =
        conn.prepare("INSERT OR IGNORE INTO branch_chunks (branch, chunk_id) VALUES (?, ?)")?;

    for chunk_id in chunk_ids {
        stmt.execute(params![branch, chunk_id])?;
    }
    Ok(())
}

/// Batch add chunks to a branch within a single transaction
pub fn add_chunks_to_branch_batch(
    conn: &mut Connection,
    branch: &str,
    chunk_ids: &[String],
) -> DbResult<()> {
    if chunk_ids.is_empty() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    {
        let mut stmt =
            tx.prepare("INSERT OR IGNORE INTO branch_chunks (branch, chunk_id) VALUES (?, ?)")?;

        for chunk_id in chunk_ids {
            stmt.execute(params![branch, chunk_id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Remove all chunks from a branch (for re-indexing)
pub fn clear_branch(conn: &Connection, branch: &str) -> DbResult<usize> {
    let count = conn.execute(
        "DELETE FROM branch_chunks WHERE branch = ?",
        params![branch],
    )?;
    Ok(count)
}

/// Return chunk IDs that are still referenced by any branch.
pub fn get_referenced_chunk_ids(conn: &Connection, chunk_ids: &[String]) -> DbResult<Vec<String>> {
    if chunk_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    for chunk in chunk_ids.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT DISTINCT chunk_id FROM branch_chunks WHERE chunk_id IN ({})",
            placeholders
        );
        let params = rusqlite::params_from_iter(chunk.iter());
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params, |row| row.get::<_, String>(0))?;
        for row in rows {
            results.push(row?);
        }
    }

    Ok(results)
}

/// Remove branch catalog entries for specific chunk IDs.
pub fn delete_branch_chunks_by_chunk_ids(
    conn: &Connection,
    chunk_ids: &[String],
) -> DbResult<usize> {
    if chunk_ids.is_empty() {
        return Ok(0);
    }

    let mut total = 0;
    for chunk in chunk_ids.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "DELETE FROM branch_chunks WHERE chunk_id IN ({})",
            placeholders
        );
        let params = rusqlite::params_from_iter(chunk.iter());
        total += conn.execute(&sql, params)?;
    }

    Ok(total)
}

/// Remove branch catalog entries for specific chunk IDs on a specific branch.
pub fn delete_branch_chunks_for_branch(
    conn: &Connection,
    branch: &str,
    chunk_ids: &[String],
) -> DbResult<usize> {
    if chunk_ids.is_empty() {
        return Ok(0);
    }

    let mut total = 0;
    for chunk in chunk_ids.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "DELETE FROM branch_chunks WHERE branch = ? AND chunk_id IN ({})",
            placeholders
        );
        let params = rusqlite::params_from_iter(
            std::iter::once(branch).chain(chunk.iter().map(|s| s.as_str())),
        );
        total += conn.execute(&sql, params)?;
    }

    Ok(total)
}

/// Get all chunk IDs for a branch
pub fn get_branch_chunk_ids(conn: &Connection, branch: &str) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT chunk_id FROM branch_chunks WHERE branch = ?")?;
    let rows = stmt.query_map(params![branch], |row| row.get::<_, String>(0))?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Get chunks that exist on branch A but not on branch B (delta)
pub fn get_branch_delta(
    conn: &Connection,
    branch: &str,
    base_branch: &str,
) -> DbResult<BranchDelta> {
    // Chunks added (on branch but not on base)
    let mut added_stmt = conn.prepare(
        r#"
        SELECT bc.chunk_id FROM branch_chunks bc
        WHERE bc.branch = ?
        AND bc.chunk_id NOT IN (
            SELECT chunk_id FROM branch_chunks WHERE branch = ?
        )
        "#,
    )?;
    let added: Vec<String> = added_stmt
        .query_map(params![branch, base_branch], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();

    // Chunks removed (on base but not on branch)
    let mut removed_stmt = conn.prepare(
        r#"
        SELECT bc.chunk_id FROM branch_chunks bc
        WHERE bc.branch = ?
        AND bc.chunk_id NOT IN (
            SELECT chunk_id FROM branch_chunks WHERE branch = ?
        )
        "#,
    )?;
    let removed: Vec<String> = removed_stmt
        .query_map(params![base_branch, branch], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(BranchDelta { added, removed })
}

#[derive(Debug, Clone)]
pub struct BranchDelta {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

/// Check if a chunk exists on a branch
pub fn chunk_exists_on_branch(conn: &Connection, branch: &str, chunk_id: &str) -> DbResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM branch_chunks WHERE branch = ? AND chunk_id = ?",
        params![branch, chunk_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Get all branches
pub fn get_all_branches(conn: &Connection) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT branch FROM branch_chunks
        UNION
        SELECT branch FROM branch_symbols
        "#,
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

// ============================================================================
// Symbol Operations (Call Graph)
// ============================================================================

#[derive(Debug, Clone)]
pub struct SymbolRow {
    pub id: String,
    pub file_path: String,
    pub name: String,
    pub kind: String,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub language: String,
}

#[derive(Debug, Clone)]
pub struct CallEdgeRow {
    pub id: String,
    pub from_symbol_id: String,
    pub target_name: String,
    pub to_symbol_id: Option<String>,
    pub call_type: String,
    pub confidence: String,
    pub line: u32,
    pub col: u32,
    pub is_resolved: bool,
}

#[derive(Debug, Clone)]
pub struct CallerRow {
    pub id: String,
    pub from_symbol_id: String,
    pub from_symbol_name: String,
    pub from_symbol_file_path: String,
    pub target_name: String,
    pub to_symbol_id: Option<String>,
    pub call_type: String,
    pub confidence: String,
    pub line: u32,
    pub col: u32,
    pub is_resolved: bool,
}

/// Insert or replace a symbol
pub fn upsert_symbol(conn: &Connection, symbol: &SymbolRow) -> DbResult<()> {
    conn.execute(
        r#"
        INSERT OR REPLACE INTO symbols (id, file_path, name, kind, start_line, start_col, end_line, end_col, language)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
        params![
            symbol.id,
            symbol.file_path,
            symbol.name,
            symbol.kind,
            symbol.start_line,
            symbol.start_col,
            symbol.end_line,
            symbol.end_col,
            symbol.language
        ],
    )?;
    Ok(())
}

/// Batch insert or replace symbols within a single transaction
pub fn upsert_symbols_batch(conn: &mut Connection, symbols: &[SymbolRow]) -> DbResult<()> {
    if symbols.is_empty() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            r#"
            INSERT OR REPLACE INTO symbols (id, file_path, name, kind, start_line, start_col, end_line, end_col, language)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )?;

        for symbol in symbols {
            stmt.execute(params![
                symbol.id,
                symbol.file_path,
                symbol.name,
                symbol.kind,
                symbol.start_line,
                symbol.start_col,
                symbol.end_line,
                symbol.end_col,
                symbol.language
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Get all symbols in a file
pub fn get_symbols_by_file(conn: &Connection, file_path: &str) -> DbResult<Vec<SymbolRow>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, file_path, name, kind, start_line, start_col, end_line, end_col, language
        FROM symbols WHERE file_path = ?
        ORDER BY start_line
        "#,
    )?;

    let rows = stmt.query_map(params![file_path], |row| {
        Ok(SymbolRow {
            id: row.get(0)?,
            file_path: row.get(1)?,
            name: row.get(2)?,
            kind: row.get(3)?,
            start_line: row.get(4)?,
            start_col: row.get(5)?,
            end_line: row.get(6)?,
            end_col: row.get(7)?,
            language: row.get(8)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Find a symbol by name and file path
pub fn get_symbol_by_name(
    conn: &Connection,
    name: &str,
    file_path: &str,
) -> DbResult<Option<SymbolRow>> {
    let result = conn
        .query_row(
            r#"
            SELECT id, file_path, name, kind, start_line, start_col, end_line, end_col, language
            FROM symbols WHERE name = ? AND file_path = ?
            "#,
            params![name, file_path],
            |row| {
                Ok(SymbolRow {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    name: row.get(2)?,
                    kind: row.get(3)?,
                    start_line: row.get(4)?,
                    start_col: row.get(5)?,
                    end_line: row.get(6)?,
                    end_col: row.get(7)?,
                    language: row.get(8)?,
                })
            },
        )
        .optional()?;
    Ok(result)
}

pub fn get_symbols_by_name(conn: &Connection, name: &str) -> DbResult<Vec<SymbolRow>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, file_path, name, kind, start_line, start_col, end_line, end_col, language
        FROM symbols WHERE name = ?
        "#,
    )?;

    let rows = stmt.query_map(params![name], |row| {
        Ok(SymbolRow {
            id: row.get(0)?,
            file_path: row.get(1)?,
            name: row.get(2)?,
            kind: row.get(3)?,
            start_line: row.get(4)?,
            start_col: row.get(5)?,
            end_line: row.get(6)?,
            end_col: row.get(7)?,
            language: row.get(8)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

pub fn get_symbols_by_name_ci(conn: &Connection, name: &str) -> DbResult<Vec<SymbolRow>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, file_path, name, kind, start_line, start_col, end_line, end_col, language
        FROM symbols WHERE lower(name) = lower(?)
        "#,
    )?;

    let rows = stmt.query_map(params![name], |row| {
        Ok(SymbolRow {
            id: row.get(0)?,
            file_path: row.get(1)?,
            name: row.get(2)?,
            kind: row.get(3)?,
            start_line: row.get(4)?,
            start_col: row.get(5)?,
            end_line: row.get(6)?,
            end_col: row.get(7)?,
            language: row.get(8)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Get all symbols for a branch
pub fn get_symbols_for_branch(conn: &Connection, branch: &str) -> DbResult<Vec<SymbolRow>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT s.id, s.file_path, s.name, s.kind, s.start_line, s.start_col, s.end_line, s.end_col, s.language
        FROM symbols s
        INNER JOIN branch_symbols bs ON s.id = bs.symbol_id
        WHERE bs.branch = ?
        ORDER BY s.start_line
        "#,
    )?;

    let rows = stmt.query_map(params![branch], |row| {
        Ok(SymbolRow {
            id: row.get(0)?,
            file_path: row.get(1)?,
            name: row.get(2)?,
            kind: row.get(3)?,
            start_line: row.get(4)?,
            start_col: row.get(5)?,
            end_line: row.get(6)?,
            end_col: row.get(7)?,
            language: row.get(8)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Get symbols for specific files on a branch
pub fn get_symbols_for_files(
    conn: &Connection,
    file_paths: &[String],
    branch: &str,
) -> DbResult<Vec<SymbolRow>> {
    if file_paths.is_empty() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    for chunk in file_paths.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            r#"
            SELECT s.id, s.file_path, s.name, s.kind, s.start_line, s.start_col, s.end_line, s.end_col, s.language
            FROM symbols s
            INNER JOIN branch_symbols bs ON s.id = bs.symbol_id
            WHERE bs.branch = ? AND s.file_path IN ({})
            ORDER BY s.start_line
            "#,
            placeholders
        );
        let params = rusqlite::params_from_iter(
            std::iter::once(branch).chain(chunk.iter().map(|s| s.as_str())),
        );

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params, |row| {
            Ok(SymbolRow {
                id: row.get(0)?,
                file_path: row.get(1)?,
                name: row.get(2)?,
                kind: row.get(3)?,
                start_line: row.get(4)?,
                start_col: row.get(5)?,
                end_line: row.get(6)?,
                end_col: row.get(7)?,
                language: row.get(8)?,
            })
        })?;

        for row in rows {
            results.push(row?);
        }
    }

    Ok(results)
}

/// Delete all symbols for a file
pub fn delete_symbols_by_file(conn: &Connection, file_path: &str) -> DbResult<usize> {
    let count = conn.execute(
        "DELETE FROM symbols WHERE file_path = ?",
        params![file_path],
    )?;
    Ok(count)
}

// ============================================================================
// Call Edge Operations (Call Graph)
// ============================================================================

/// Insert or replace a call edge
pub fn upsert_call_edge(conn: &Connection, edge: &CallEdgeRow) -> DbResult<()> {
    conn.execute(
        r#"
        INSERT OR REPLACE INTO call_edges (id, from_symbol_id, target_name, to_symbol_id, call_type, confidence, line, col, is_resolved)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
        params![
            edge.id,
            edge.from_symbol_id,
            edge.target_name,
            edge.to_symbol_id,
            edge.call_type,
            edge.confidence,
            edge.line,
            edge.col,
            edge.is_resolved as i32
        ],
    )?;
    Ok(())
}

/// Batch insert or replace call edges within a single transaction
pub fn upsert_call_edges_batch(conn: &mut Connection, edges: &[CallEdgeRow]) -> DbResult<()> {
    if edges.is_empty() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            r#"
            INSERT OR REPLACE INTO call_edges (id, from_symbol_id, target_name, to_symbol_id, call_type, confidence, line, col, is_resolved)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )?;

        for edge in edges {
            stmt.execute(params![
                edge.id,
                edge.from_symbol_id,
                edge.target_name,
                edge.to_symbol_id,
                edge.call_type,
                edge.confidence,
                edge.line,
                edge.col,
                edge.is_resolved as i32
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Get all call edges calling a symbol name (filtered by branch)
/// Uses COLLATE NOCASE for target_name to support case-insensitive languages like PHP.
pub fn get_callers(
    conn: &Connection,
    symbol_name: &str,
    branch: &str,
    call_type_filter: Option<&str>,
) -> DbResult<Vec<CallEdgeRow>> {
    let (sql, params) = if let Some(ct) = call_type_filter {
        (
            r#"
            SELECT ce.id, ce.from_symbol_id, ce.target_name, ce.to_symbol_id, ce.call_type, ce.confidence, ce.line, ce.col, ce.is_resolved
            FROM call_edges ce
            INNER JOIN symbols s ON ce.from_symbol_id = s.id
            INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
            WHERE ce.target_name = ?2 COLLATE NOCASE AND ce.call_type = ?3
            "#,
            vec![branch.to_string(), symbol_name.to_string(), ct.to_string()],
        )
    } else {
        (
            r#"
            SELECT ce.id, ce.from_symbol_id, ce.target_name, ce.to_symbol_id, ce.call_type, ce.confidence, ce.line, ce.col, ce.is_resolved
            FROM call_edges ce
            INNER JOIN symbols s ON ce.from_symbol_id = s.id
            INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
            WHERE ce.target_name = ?2 COLLATE NOCASE
            "#,
            vec![branch.to_string(), symbol_name.to_string()],
        )
    };

    let mut stmt = conn.prepare(sql)?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(CallEdgeRow {
            id: row.get(0)?,
            from_symbol_id: row.get(1)?,
            target_name: row.get(2)?,
            to_symbol_id: row.get(3)?,
            call_type: row.get(4)?,
            confidence: row.get(5)?,
            line: row.get(6)?,
            col: row.get(7)?,
            is_resolved: row.get::<_, i32>(8)? != 0,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

pub fn get_callers_with_context(
    conn: &Connection,
    symbol_name: &str,
    branch: &str,
    call_type_filter: Option<&str>,
) -> DbResult<Vec<CallerRow>> {
    let (sql, params) = if let Some(ct) = call_type_filter {
        (
            r#"
            SELECT
                ce.id,
                ce.from_symbol_id,
                s.name,
                s.file_path,
                ce.target_name,
                ce.to_symbol_id,
                ce.call_type,
                ce.confidence,
                ce.line,
                ce.col,
                ce.is_resolved
            FROM call_edges ce
            INNER JOIN symbols s ON ce.from_symbol_id = s.id
            INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
            WHERE ce.target_name = ?2 COLLATE NOCASE AND ce.call_type = ?3
            "#,
            vec![branch.to_string(), symbol_name.to_string(), ct.to_string()],
        )
    } else {
        (
            r#"
            SELECT
                ce.id,
                ce.from_symbol_id,
                s.name,
                s.file_path,
                ce.target_name,
                ce.to_symbol_id,
                ce.call_type,
                ce.confidence,
                ce.line,
                ce.col,
                ce.is_resolved
            FROM call_edges ce
            INNER JOIN symbols s ON ce.from_symbol_id = s.id
            INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
            WHERE ce.target_name = ?2 COLLATE NOCASE
            "#,
            vec![branch.to_string(), symbol_name.to_string()],
        )
    };

    let mut stmt = conn.prepare(sql)?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(CallerRow {
            id: row.get(0)?,
            from_symbol_id: row.get(1)?,
            from_symbol_name: row.get(2)?,
            from_symbol_file_path: row.get(3)?,
            target_name: row.get(4)?,
            to_symbol_id: row.get(5)?,
            call_type: row.get(6)?,
            confidence: row.get(7)?,
            line: row.get(8)?,
            col: row.get(9)?,
            is_resolved: row.get::<_, i32>(10)? != 0,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Get all call edges from a symbol (filtered by branch)
pub fn get_callees(
    conn: &Connection,
    symbol_id: &str,
    branch: &str,
    call_type_filter: Option<&str>,
) -> DbResult<Vec<CallEdgeRow>> {
    let (sql, params) = if let Some(ct) = call_type_filter {
        (
            r#"
            SELECT ce.id, ce.from_symbol_id, ce.target_name, ce.to_symbol_id, ce.call_type, ce.confidence, ce.line, ce.col, ce.is_resolved
            FROM call_edges ce
            INNER JOIN symbols s ON ce.from_symbol_id = s.id
            INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
            WHERE ce.from_symbol_id = ?2 AND ce.call_type = ?3
            "#,
            vec![branch.to_string(), symbol_id.to_string(), ct.to_string()],
        )
    } else {
        (
            r#"
            SELECT ce.id, ce.from_symbol_id, ce.target_name, ce.to_symbol_id, ce.call_type, ce.confidence, ce.line, ce.col, ce.is_resolved
            FROM call_edges ce
            INNER JOIN symbols s ON ce.from_symbol_id = s.id
            INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
            WHERE ce.from_symbol_id = ?2
            "#,
            vec![branch.to_string(), symbol_id.to_string()],
        )
    };

    let mut stmt = conn.prepare(sql)?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params
        .iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(CallEdgeRow {
            id: row.get(0)?,
            from_symbol_id: row.get(1)?,
            target_name: row.get(2)?,
            to_symbol_id: row.get(3)?,
            call_type: row.get(4)?,
            confidence: row.get(5)?,
            line: row.get(6)?,
            col: row.get(7)?,
            is_resolved: row.get::<_, i32>(8)? != 0,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Delete all call edges where the source symbol is in a file
pub fn delete_call_edges_by_file(conn: &Connection, file_path: &str) -> DbResult<usize> {
    let count = conn.execute(
        r#"
        DELETE FROM call_edges WHERE from_symbol_id IN (
            SELECT id FROM symbols WHERE file_path = ?
        )
        "#,
        params![file_path],
    )?;
    Ok(count)
}

/// Clear resolved call targets that point at symbols being deleted.
pub fn clear_call_edge_targets_for_symbols(
    conn: &Connection,
    symbol_ids: &[String],
) -> DbResult<usize> {
    if symbol_ids.is_empty() {
        return Ok(0);
    }

    let mut total = 0;
    for chunk in symbol_ids.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "UPDATE call_edges SET to_symbol_id = NULL, is_resolved = 0 WHERE to_symbol_id IN ({})",
            placeholders
        );
        let params = rusqlite::params_from_iter(chunk.iter());
        total += conn.execute(&sql, params)?;
    }

    Ok(total)
}

/// Resolve a call edge by setting the target symbol
pub fn resolve_call_edge(conn: &Connection, edge_id: &str, to_symbol_id: &str) -> DbResult<()> {
    conn.execute(
        "UPDATE call_edges SET to_symbol_id = ?, is_resolved = 1 WHERE id = ?",
        params![to_symbol_id, edge_id],
    )?;
    Ok(())
}

/// A single hop in a shortest path between two symbols
#[derive(Debug, Clone)]
pub struct PathHopRow {
    pub symbol_id: String,
    pub symbol_name: String,
    pub file_path: String,
    pub line: u32,
    pub call_type: String,
}

/// Find the shortest call path from a source symbol to a target symbol using BFS.
/// Traverses call_edges in the "callees" direction (from_symbol_id → to_symbol_id/target_name),
/// filtered by branch via branch_symbols.
/// Returns the path as a Vec of hops (source → ... → target), or empty if no path exists.
/// `max_depth` caps the BFS depth to prevent runaway traversals.
pub fn find_shortest_path(
    conn: &Connection,
    from_name: &str,
    to_name: &str,
    branch: &str,
    max_depth: u32,
) -> DbResult<Vec<PathHopRow>> {
    use std::collections::{HashMap, VecDeque};

    // Find all source symbols matching from_name on this branch
    let mut start_stmt = conn.prepare(
        r#"
        SELECT s.id, s.name, s.file_path, s.start_line
        FROM symbols s
        INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?
        WHERE s.name = ? COLLATE NOCASE
        "#,
    )?;
    let starts: Vec<(String, String, String, u32)> = start_stmt
        .query_map(params![branch, from_name], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u32>(3)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect();

    if starts.is_empty() {
        return Ok(Vec::new());
    }

    // Ambiguous source: multiple symbols match from_name on this branch.
    // We cannot determine which one the user means, so report no path.
    if starts.len() > 1 {
        return Ok(Vec::new());
    }

    // Prepare statements for BFS expansion
    // Get callees of a symbol (by symbol_id), filtered by branch
    let mut callees_stmt = conn.prepare(
        r#"
        SELECT ce.target_name, ce.to_symbol_id, ce.call_type, ce.line
        FROM call_edges ce
        INNER JOIN symbols s ON ce.from_symbol_id = s.id
        INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?
        WHERE ce.from_symbol_id = ?
        "#,
    )?;

    // Resolve a target_name to symbol IDs on this branch
    let mut resolve_stmt = conn.prepare(
        r#"
        SELECT s.id, s.name, s.file_path, s.start_line
        FROM symbols s
        INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?
        WHERE s.name = ? COLLATE NOCASE
        "#,
    )?;

    // BFS state: queue entries are (symbol_id, depth)
    // parent map: symbol_id -> (parent_symbol_id, call_type, line)
    let mut visited: HashMap<String, (String, String, u32)> = HashMap::new(); // child -> (parent_id, call_type, line)
    let mut queue: VecDeque<(String, u32)> = VecDeque::new();

    // Seed BFS with all start symbols
    for (sid, _name, _fp, _line) in &starts {
        visited.insert(sid.clone(), (String::new(), String::new(), 0)); // sentinel parent
        queue.push_back((sid.clone(), 0));
    }

    let target_name_lower = to_name.to_lowercase();
    let mut target_found: Option<String> = None;

    'bfs: while let Some((current_id, depth)) = queue.pop_front() {
        if depth >= max_depth {
            continue;
        }

        // Get callees of current symbol
        let callees: Vec<(String, Option<String>, String, u32)> = callees_stmt
            .query_map(params![branch, &current_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,         // target_name
                    row.get::<_, Option<String>>(1)?, // to_symbol_id
                    row.get::<_, String>(2)?,         // call_type
                    row.get::<_, u32>(3)?,            // line
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        for (callee_target_name, to_symbol_id, call_type, line) in callees {
            // Check if target_name matches our target (case-insensitive)
            if callee_target_name.to_lowercase() == target_name_lower {
                // Resolve the target to real symbol(s) on this branch
                let resolved_targets: Vec<(String, String, String, u32)> = resolve_stmt
                    .query_map(params![branch, to_name], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, u32>(3)?,
                        ))
                    })?
                    .filter_map(|r| r.ok())
                    .collect();

                // Determine which target to use:
                // 1. If edge has to_symbol_id and it's among resolved targets, use it
                // 2. If exactly one resolved target (unambiguous), use it
                // 3. Otherwise ambiguous — use synthetic target (consistent with
                //    existing call-graph behavior that keeps ambiguous targets unresolved)
                let chosen_target_id: Option<String> = if let Some(ref edge_resolved) = to_symbol_id
                {
                    if resolved_targets.iter().any(|(id, ..)| id == edge_resolved) {
                        Some(edge_resolved.clone())
                    } else {
                        None
                    }
                } else if resolved_targets.len() == 1 {
                    Some(resolved_targets[0].0.clone())
                } else {
                    None
                };

                if let Some(target_id) = chosen_target_id {
                    if !visited.contains_key(&target_id) {
                        visited.insert(
                            target_id.clone(),
                            (current_id.clone(), call_type.clone(), line),
                        );
                        target_found = Some(target_id);
                        break 'bfs;
                    }
                } else if resolved_targets.is_empty() {
                    // No symbol found at all (external/unindexed target) — use synthetic ID
                    let synthetic_id = format!("__target__{}", callee_target_name);
                    if !visited.contains_key(&synthetic_id) {
                        visited.insert(
                            synthetic_id.clone(),
                            (current_id.clone(), call_type.clone(), line),
                        );
                        target_found = Some(synthetic_id);
                        break 'bfs;
                    }
                }
                // else: ambiguous target (multiple matches, none resolved) — skip,
                // no proven path to a specific symbol
            }

            // If resolved, continue BFS through the resolved symbol (verify it's on branch)
            if let Some(ref resolved_id) = to_symbol_id {
                if !visited.contains_key(resolved_id) {
                    // Verify the resolved symbol exists on this branch
                    let on_branch: bool = conn
                        .query_row(
                            "SELECT COUNT(*) FROM branch_symbols WHERE branch = ? AND symbol_id = ?",
                            params![branch, resolved_id],
                            |row| row.get::<_, i64>(0),
                        )
                        .unwrap_or(0)
                        > 0;
                    if on_branch {
                        visited.insert(
                            resolved_id.clone(),
                            (current_id.clone(), call_type.clone(), line),
                        );
                        queue.push_back((resolved_id.clone(), depth + 1));
                    }
                }
            } else {
                // Unresolved: try resolving by target_name
                // Only traverse if unambiguous (single match) to avoid fabricating paths
                let resolved: Vec<(String, String, String, u32)> = resolve_stmt
                    .query_map(params![branch, &callee_target_name], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, u32>(3)?,
                        ))
                    })?
                    .filter_map(|r| r.ok())
                    .collect();

                // Only traverse unambiguous (single) resolution to avoid fabricating paths
                // through implementations the call graph never actually resolved
                if resolved.len() == 1 {
                    let (resolved_id, _name, _fp, _line) = &resolved[0];
                    if !visited.contains_key(resolved_id) {
                        visited.insert(
                            resolved_id.clone(),
                            (current_id.clone(), call_type.clone(), line),
                        );
                        queue.push_back((resolved_id.clone(), depth + 1));
                    }
                }
            }
        }
    }

    // Reconstruct path if found
    let Some(end_id) = target_found else {
        return Ok(Vec::new());
    };

    // Build symbol info lookup
    let mut info_stmt =
        conn.prepare("SELECT id, name, file_path, start_line FROM symbols WHERE id = ?")?;

    let mut path: Vec<PathHopRow> = Vec::new();
    let mut current = end_id;

    while let Some(entry) = visited.get(&current) {
        let (parent_id, call_type, _line) = entry.clone();

        // Look up symbol info
        let info: Option<(String, String, String, u32)> = if current.starts_with("__target__") {
            // Synthetic target - use the target name
            Some((current.clone(), to_name.to_string(), String::new(), 0))
        } else {
            info_stmt
                .query_row(params![&current], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, u32>(3)?,
                    ))
                })
                .optional()?
        };

        if let Some((_id, name, file_path, sym_line)) = info {
            path.push(PathHopRow {
                symbol_id: current.clone(),
                symbol_name: name,
                file_path,
                line: sym_line,
                call_type: if parent_id.is_empty() {
                    String::from("source")
                } else {
                    call_type
                },
            });
        }

        if parent_id.is_empty() {
            break; // Reached a start node
        }
        current = parent_id;
    }

    path.reverse();
    Ok(path)
}

// ============================================================================
// Branch Symbol Operations (Call Graph)
// ============================================================================

/// Add symbols to a branch
pub fn add_symbols_to_branch(
    conn: &Connection,
    branch: &str,
    symbol_ids: &[String],
) -> DbResult<()> {
    if symbol_ids.is_empty() {
        return Ok(());
    }

    let mut stmt =
        conn.prepare("INSERT OR IGNORE INTO branch_symbols (branch, symbol_id) VALUES (?, ?)")?;

    for symbol_id in symbol_ids {
        stmt.execute(params![branch, symbol_id])?;
    }
    Ok(())
}

/// Batch add symbols to a branch within a single transaction
pub fn add_symbols_to_branch_batch(
    conn: &mut Connection,
    branch: &str,
    symbol_ids: &[String],
) -> DbResult<()> {
    if symbol_ids.is_empty() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    {
        let mut stmt =
            tx.prepare("INSERT OR IGNORE INTO branch_symbols (branch, symbol_id) VALUES (?, ?)")?;

        for symbol_id in symbol_ids {
            stmt.execute(params![branch, symbol_id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Get all symbol IDs for a branch
pub fn get_branch_symbol_ids(conn: &Connection, branch: &str) -> DbResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT symbol_id FROM branch_symbols WHERE branch = ?")?;
    let rows = stmt.query_map(params![branch], |row| row.get::<_, String>(0))?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok(results)
}

/// Remove all symbols from a branch
pub fn clear_branch_symbols(conn: &Connection, branch: &str) -> DbResult<usize> {
    let count = conn.execute(
        "DELETE FROM branch_symbols WHERE branch = ?",
        params![branch],
    )?;
    Ok(count)
}

/// Return symbol IDs that are still referenced by any branch.
pub fn get_referenced_symbol_ids(
    conn: &Connection,
    symbol_ids: &[String],
) -> DbResult<Vec<String>> {
    if symbol_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    for chunk in symbol_ids.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT DISTINCT symbol_id FROM branch_symbols WHERE symbol_id IN ({})",
            placeholders
        );
        let params = rusqlite::params_from_iter(chunk.iter());
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params, |row| row.get::<_, String>(0))?;
        for row in rows {
            results.push(row?);
        }
    }

    Ok(results)
}

/// Remove branch-symbol catalog entries for specific symbol IDs.
pub fn delete_branch_symbols_by_symbol_ids(
    conn: &Connection,
    symbol_ids: &[String],
) -> DbResult<usize> {
    if symbol_ids.is_empty() {
        return Ok(0);
    }

    let mut total = 0;
    for chunk in symbol_ids.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "DELETE FROM branch_symbols WHERE symbol_id IN ({})",
            placeholders
        );
        let params = rusqlite::params_from_iter(chunk.iter());
        total += conn.execute(&sql, params)?;
    }

    Ok(total)
}

/// Remove branch-symbol catalog entries for specific symbol IDs on a specific branch.
pub fn delete_branch_symbols_for_branch(
    conn: &Connection,
    branch: &str,
    symbol_ids: &[String],
) -> DbResult<usize> {
    if symbol_ids.is_empty() {
        return Ok(0);
    }

    let mut total = 0;
    for chunk in symbol_ids.chunks(SQL_BIND_PARAM_BATCH_SIZE) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "DELETE FROM branch_symbols WHERE branch = ? AND symbol_id IN ({})",
            placeholders
        );
        let params = rusqlite::params_from_iter(
            std::iter::once(branch).chain(chunk.iter().map(|s| s.as_str())),
        );
        total += conn.execute(&sql, params)?;
    }

    Ok(total)
}

/// Remove all indexed data so a force rebuild starts from an empty database.
pub fn clear_all_indexed_data(conn: &Connection) -> DbResult<()> {
    conn.execute("DELETE FROM branch_symbols", [])?;
    conn.execute("DELETE FROM branch_chunks", [])?;
    conn.execute("DELETE FROM call_edges", [])?;
    conn.execute("DELETE FROM symbols", [])?;
    conn.execute("DELETE FROM chunks", [])?;
    conn.execute("DELETE FROM embeddings", [])?;
    Ok(())
}

// ============================================================================
// Metadata Operations
// ============================================================================

/// Get a metadata value
pub fn get_metadata(conn: &Connection, key: &str) -> DbResult<Option<String>> {
    let result = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = ?",
            params![key],
            |row| row.get(0),
        )
        .optional()?;
    Ok(result)
}

/// Set a metadata value
pub fn set_metadata(conn: &Connection, key: &str, value: &str) -> DbResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
        params![key, value],
    )?;
    Ok(())
}

/// Delete a metadata value
pub fn delete_metadata(conn: &Connection, key: &str) -> DbResult<bool> {
    let count = conn.execute("DELETE FROM metadata WHERE key = ?", params![key])?;
    Ok(count > 0)
}

// ============================================================================
// Garbage Collection
// ============================================================================

/// Delete orphaned embeddings (not referenced by any chunk)
pub fn gc_orphan_embeddings(conn: &Connection) -> DbResult<usize> {
    let count = conn.execute(
        r#"
        DELETE FROM embeddings
        WHERE content_hash NOT IN (
            SELECT DISTINCT content_hash FROM chunks
        )
        "#,
        [],
    )?;
    Ok(count)
}

/// Delete orphaned chunks (not referenced by any branch)
pub fn gc_orphan_chunks(conn: &Connection) -> DbResult<usize> {
    let count = conn.execute(
        r#"
        DELETE FROM chunks
        WHERE chunk_id NOT IN (
            SELECT DISTINCT chunk_id FROM branch_chunks
        )
        "#,
        [],
    )?;
    Ok(count)
}

/// Delete orphaned symbols (not referenced by any branch)
pub fn gc_orphan_symbols(conn: &Connection) -> DbResult<usize> {
    // First, delete call edges referencing orphan symbols to avoid FK violation
    conn.execute(
        r#"
        DELETE FROM call_edges
        WHERE from_symbol_id NOT IN (
            SELECT DISTINCT symbol_id FROM branch_symbols
        )
        "#,
        [],
    )?;
    let count = conn.execute(
        r#"
        DELETE FROM symbols
        WHERE id NOT IN (
            SELECT DISTINCT symbol_id FROM branch_symbols
        )
        "#,
        [],
    )?;
    Ok(count)
}

/// Delete orphaned call edges (from_symbol not in symbols table)
pub fn gc_orphan_call_edges(conn: &Connection) -> DbResult<usize> {
    let count = conn.execute(
        r#"
        DELETE FROM call_edges
        WHERE from_symbol_id NOT IN (
            SELECT DISTINCT id FROM symbols
        )
        "#,
        [],
    )?;
    Ok(count)
}

/// Get database statistics
pub fn get_stats(conn: &Connection) -> DbResult<DbStats> {
    let embedding_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM embeddings", [], |row| row.get(0))?;
    let chunk_count: i64 = conn.query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))?;
    let branch_chunk_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM branch_chunks", [], |row| row.get(0))?;
    let branch_count: i64 = conn.query_row(
        r#"
        SELECT COUNT(*)
        FROM (
            SELECT branch FROM branch_chunks
            UNION
            SELECT branch FROM branch_symbols
        )
        "#,
        [],
        |row| row.get(0),
    )?;
    let symbol_count: i64 = conn.query_row("SELECT COUNT(*) FROM symbols", [], |row| row.get(0))?;
    let call_edge_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM call_edges", [], |row| row.get(0))?;
    Ok(DbStats {
        embedding_count: embedding_count as u64,
        chunk_count: chunk_count as u64,
        branch_chunk_count: branch_chunk_count as u64,
        branch_count: branch_count as u64,
        symbol_count: symbol_count as u64,
        call_edge_count: call_edge_count as u64,
    })
}
#[derive(Debug, Clone)]
pub struct DbStats {
    pub embedding_count: u64,
    pub chunk_count: u64,
    pub branch_chunk_count: u64,
    pub branch_count: u64,
    pub symbol_count: u64,
    pub call_edge_count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_db() -> (TempDir, Connection) {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let conn = init_db(&db_path).unwrap();
        (temp_dir, conn)
    }

    #[allow(clippy::too_many_arguments)]
    fn upsert_chunk(
        conn: &Connection,
        chunk_id: &str,
        content_hash: &str,
        file_path: &str,
        start_line: u32,
        end_line: u32,
        node_type: Option<&str>,
        name: Option<&str>,
        language: &str,
    ) -> DbResult<()> {
        upsert_chunk_with_blame(
            conn,
            chunk_id,
            content_hash,
            file_path,
            start_line,
            end_line,
            node_type,
            name,
            language,
            None,
            None,
            None,
            None,
            None,
        )
    }

    #[test]
    fn test_init_db() {
        let (_temp_dir, conn) = setup_test_db();
        let version: String = conn
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, "6");
    }

    #[test]
    fn test_embedding_operations() {
        let (_temp_dir, conn) = setup_test_db();

        // Insert embedding
        let hash = "abc123";
        let embedding = vec![1u8, 2, 3, 4];
        upsert_embedding(&conn, hash, &embedding, "test content", "test-model").unwrap();

        // Check exists
        assert!(embedding_exists(&conn, hash).unwrap());
        assert!(!embedding_exists(&conn, "nonexistent").unwrap());

        // Get embedding
        let retrieved = get_embedding(&conn, hash).unwrap().unwrap();
        assert_eq!(retrieved, embedding);
    }

    #[test]
    fn test_chunk_operations() {
        let (_temp_dir, conn) = setup_test_db();

        // First insert the embedding
        upsert_embedding(&conn, "hash1", &[1, 2, 3], "content", "model").unwrap();

        // Insert chunk
        upsert_chunk(
            &conn,
            "chunk1",
            "hash1",
            "src/main.rs",
            10,
            20,
            Some("function"),
            Some("main"),
            "rust",
        )
        .unwrap();

        // Get chunk
        let chunk = get_chunk(&conn, "chunk1").unwrap().unwrap();
        assert_eq!(chunk.file_path, "src/main.rs");
        assert_eq!(chunk.start_line, 10);
        assert_eq!(chunk.node_type, Some("function".to_string()));
    }

    #[test]
    fn test_branch_operations() {
        let (_temp_dir, conn) = setup_test_db();

        // Setup
        upsert_embedding(&conn, "hash1", &[1], "c1", "m").unwrap();
        upsert_embedding(&conn, "hash2", &[2], "c2", "m").unwrap();
        upsert_embedding(&conn, "hash3", &[3], "c3", "m").unwrap();

        upsert_chunk(&conn, "c1", "hash1", "f1.rs", 1, 10, None, None, "rust").unwrap();
        upsert_chunk(&conn, "c2", "hash2", "f2.rs", 1, 10, None, None, "rust").unwrap();
        upsert_chunk(&conn, "c3", "hash3", "f3.rs", 1, 10, None, None, "rust").unwrap();

        // Add to branches
        add_chunks_to_branch(&conn, "main", &["c1".to_string(), "c2".to_string()]).unwrap();
        add_chunks_to_branch(&conn, "feature", &["c1".to_string(), "c3".to_string()]).unwrap();

        // Get branch chunks
        let main_chunks = get_branch_chunk_ids(&conn, "main").unwrap();
        assert_eq!(main_chunks.len(), 2);

        // Get delta
        let delta = get_branch_delta(&conn, "feature", "main").unwrap();
        assert_eq!(delta.added, vec!["c3".to_string()]);
        assert_eq!(delta.removed, vec!["c2".to_string()]);
    }

    #[test]
    fn test_garbage_collection() {
        let (_temp_dir, conn) = setup_test_db();

        // Create orphaned embedding
        upsert_embedding(&conn, "orphan", &[1], "orphan content", "m").unwrap();
        upsert_embedding(&conn, "used", &[2], "used content", "m").unwrap();

        // Create chunk using one embedding
        upsert_chunk(&conn, "c1", "used", "f1.rs", 1, 10, None, None, "rust").unwrap();
        add_chunks_to_branch(&conn, "main", &["c1".to_string()]).unwrap();

        // GC should remove orphan
        let removed = gc_orphan_embeddings(&conn).unwrap();
        assert_eq!(removed, 1);

        assert!(!embedding_exists(&conn, "orphan").unwrap());
        assert!(embedding_exists(&conn, "used").unwrap());
    }

    #[test]
    fn test_symbol_operations() {
        let (_temp_dir, conn) = setup_test_db();

        let symbol = SymbolRow {
            id: "sym1".to_string(),
            file_path: "src/main.ts".to_string(),
            name: "handleRequest".to_string(),
            kind: "function".to_string(),
            start_line: 10,
            start_col: 0,
            end_line: 25,
            end_col: 1,
            language: "typescript".to_string(),
        };

        // Insert
        upsert_symbol(&conn, &symbol).unwrap();

        // Get by file
        let symbols = get_symbols_by_file(&conn, "src/main.ts").unwrap();
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "handleRequest");
        assert_eq!(symbols[0].kind, "function");
        assert_eq!(symbols[0].start_line, 10);

        // Get by name
        let found = get_symbol_by_name(&conn, "handleRequest", "src/main.ts").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().id, "sym1");

        let by_name = get_symbols_by_name(&conn, "handleRequest").unwrap();
        assert_eq!(by_name.len(), 1);
        assert_eq!(by_name[0].id, "sym1");

        let by_name_ci = get_symbols_by_name_ci(&conn, "handlerequest").unwrap();
        assert_eq!(by_name_ci.len(), 1);
        assert_eq!(by_name_ci[0].id, "sym1");

        // Not found
        let missing = get_symbol_by_name(&conn, "missing", "src/main.ts").unwrap();
        assert!(missing.is_none());

        // Delete by file
        let deleted = delete_symbols_by_file(&conn, "src/main.ts").unwrap();
        assert_eq!(deleted, 1);
        let symbols = get_symbols_by_file(&conn, "src/main.ts").unwrap();
        assert!(symbols.is_empty());
    }

    #[test]
    fn test_symbol_batch_operations() {
        let (_temp_dir, mut conn) = setup_test_db();

        let symbols = vec![
            SymbolRow {
                id: "s1".to_string(),
                file_path: "src/a.ts".to_string(),
                name: "foo".to_string(),
                kind: "function".to_string(),
                start_line: 1,
                start_col: 0,
                end_line: 5,
                end_col: 1,
                language: "typescript".to_string(),
            },
            SymbolRow {
                id: "s2".to_string(),
                file_path: "src/a.ts".to_string(),
                name: "bar".to_string(),
                kind: "function".to_string(),
                start_line: 7,
                start_col: 0,
                end_line: 12,
                end_col: 1,
                language: "typescript".to_string(),
            },
            SymbolRow {
                id: "s3".to_string(),
                file_path: "src/b.ts".to_string(),
                name: "baz".to_string(),
                kind: "class".to_string(),
                start_line: 1,
                start_col: 0,
                end_line: 50,
                end_col: 1,
                language: "typescript".to_string(),
            },
        ];

        upsert_symbols_batch(&mut conn, &symbols).unwrap();

        let file_a = get_symbols_by_file(&conn, "src/a.ts").unwrap();
        assert_eq!(file_a.len(), 2);
        let file_b = get_symbols_by_file(&conn, "src/b.ts").unwrap();
        assert_eq!(file_b.len(), 1);
        assert_eq!(file_b[0].kind, "class");

        let foo = get_symbols_by_name(&conn, "foo").unwrap();
        assert_eq!(foo.len(), 1);
        assert_eq!(foo[0].id, "s1");
    }

    #[test]
    fn test_call_edge_operations() {
        let (_temp_dir, mut conn) = setup_test_db();

        // Setup symbols
        let symbols = vec![
            SymbolRow {
                id: "sym_main".to_string(),
                file_path: "src/main.ts".to_string(),
                name: "main".to_string(),
                kind: "function".to_string(),
                start_line: 1,
                start_col: 0,
                end_line: 10,
                end_col: 1,
                language: "typescript".to_string(),
            },
            SymbolRow {
                id: "sym_helper".to_string(),
                file_path: "src/helper.ts".to_string(),
                name: "helper".to_string(),
                kind: "function".to_string(),
                start_line: 1,
                start_col: 0,
                end_line: 5,
                end_col: 1,
                language: "typescript".to_string(),
            },
        ];
        upsert_symbols_batch(&mut conn, &symbols).unwrap();

        // Add symbols to branch
        add_symbols_to_branch(
            &conn,
            "main",
            &["sym_main".to_string(), "sym_helper".to_string()],
        )
        .unwrap();

        // Create call edge: main -> helper
        let edge = CallEdgeRow {
            id: "edge1".to_string(),
            from_symbol_id: "sym_main".to_string(),
            target_name: "helper".to_string(),
            to_symbol_id: None,
            call_type: "Call".to_string(),
            confidence: "Direct".to_string(),
            line: 5,
            col: 4,
            is_resolved: false,
        };
        upsert_call_edge(&conn, &edge).unwrap();

        // Get callees of main
        let callees = get_callees(&conn, "sym_main", "main", None).unwrap();
        assert_eq!(callees.len(), 1);
        assert_eq!(callees[0].target_name, "helper");
        assert!(!callees[0].is_resolved);

        // Get callers of helper (branch-filtered)
        let callers = get_callers(&conn, "helper", "main", None).unwrap();
        assert_eq!(callers.len(), 1);
        assert_eq!(callers[0].from_symbol_id, "sym_main");

        // Resolve the edge
        resolve_call_edge(&conn, "edge1", "sym_helper").unwrap();
        let callees = get_callees(&conn, "sym_main", "main", None).unwrap();
        assert!(callees[0].is_resolved);
        assert_eq!(callees[0].to_symbol_id, Some("sym_helper".to_string()));

        // Delete by file
        let deleted = delete_call_edges_by_file(&conn, "src/main.ts").unwrap();
        assert_eq!(deleted, 1);
        let callees = get_callees(&conn, "sym_main", "main", None).unwrap();
        assert!(callees.is_empty());
    }

    #[test]
    fn test_branch_symbols() {
        let (_temp_dir, mut conn) = setup_test_db();

        let symbols = vec![
            SymbolRow {
                id: "s1".to_string(),
                file_path: "src/a.ts".to_string(),
                name: "foo".to_string(),
                kind: "function".to_string(),
                start_line: 1,
                start_col: 0,
                end_line: 5,
                end_col: 1,
                language: "typescript".to_string(),
            },
            SymbolRow {
                id: "s2".to_string(),
                file_path: "src/b.ts".to_string(),
                name: "bar".to_string(),
                kind: "function".to_string(),
                start_line: 1,
                start_col: 0,
                end_line: 5,
                end_col: 1,
                language: "typescript".to_string(),
            },
        ];
        upsert_symbols_batch(&mut conn, &symbols).unwrap();

        // Add to branch
        add_symbols_to_branch_batch(&mut conn, "main", &["s1".to_string(), "s2".to_string()])
            .unwrap();

        let ids = get_branch_symbol_ids(&conn, "main").unwrap();
        assert_eq!(ids.len(), 2);

        // Clear
        let cleared = clear_branch_symbols(&conn, "main").unwrap();
        assert_eq!(cleared, 2);
        let ids = get_branch_symbol_ids(&conn, "main").unwrap();
        assert!(ids.is_empty());
    }

    #[test]
    fn test_gc_symbols_and_edges() {
        let (_temp_dir, mut conn) = setup_test_db();

        // Create symbols
        let symbols = vec![
            SymbolRow {
                id: "used".to_string(),
                file_path: "src/a.ts".to_string(),
                name: "used_fn".to_string(),
                kind: "function".to_string(),
                start_line: 1,
                start_col: 0,
                end_line: 5,
                end_col: 1,
                language: "typescript".to_string(),
            },
            SymbolRow {
                id: "orphan".to_string(),
                file_path: "src/b.ts".to_string(),
                name: "orphan_fn".to_string(),
                kind: "function".to_string(),
                start_line: 1,
                start_col: 0,
                end_line: 5,
                end_col: 1,
                language: "typescript".to_string(),
            },
        ];
        upsert_symbols_batch(&mut conn, &symbols).unwrap();

        // Only add 'used' to a branch
        add_symbols_to_branch(&conn, "main", &["used".to_string()]).unwrap();

        // Create call edges from both
        let edges = vec![
            CallEdgeRow {
                id: "e1".to_string(),
                from_symbol_id: "used".to_string(),
                target_name: "something".to_string(),
                to_symbol_id: None,
                call_type: "Call".to_string(),
                confidence: "Direct".to_string(),
                line: 3,
                col: 4,
                is_resolved: false,
            },
            CallEdgeRow {
                id: "e2".to_string(),
                from_symbol_id: "orphan".to_string(),
                target_name: "other".to_string(),
                to_symbol_id: None,
                call_type: "Call".to_string(),
                confidence: "Direct".to_string(),
                line: 2,
                col: 0,
                is_resolved: false,
            },
        ];
        upsert_call_edges_batch(&mut conn, &edges).unwrap();

        // GC orphan symbols (also cascades to delete orphan call edges from those symbols)
        let removed = gc_orphan_symbols(&conn).unwrap();
        assert_eq!(removed, 1);
        let remaining = get_symbols_by_file(&conn, "src/a.ts").unwrap();
        assert_eq!(remaining.len(), 1);
        let removed_syms = get_symbols_by_file(&conn, "src/b.ts").unwrap();
        assert!(removed_syms.is_empty());
        // gc_orphan_call_edges should find 0 since gc_orphan_symbols already cleaned them
        let removed_edges = gc_orphan_call_edges(&conn).unwrap();
        assert_eq!(removed_edges, 0);
        // Edge from 'used' still exists
        let remaining_edges = get_callees(&conn, "used", "main", None).unwrap();
        assert_eq!(remaining_edges.len(), 1);
    }

    #[test]
    fn test_clear_all_indexed_data() {
        let (_temp_dir, conn) = setup_test_db();

        upsert_embedding(&conn, "hash", &[1, 2, 3, 4], "chunk text", "model").unwrap();
        upsert_chunk(
            &conn,
            "chunk1",
            "hash",
            "src/main.ts",
            1,
            3,
            Some("function"),
            Some("main"),
            "typescript",
        )
        .unwrap();
        add_chunks_to_branch(&conn, "main", &["chunk1".to_string()]).unwrap();

        let symbol = SymbolRow {
            id: "sym1".to_string(),
            file_path: "src/main.ts".to_string(),
            name: "main".to_string(),
            kind: "function".to_string(),
            start_line: 1,
            start_col: 0,
            end_line: 3,
            end_col: 0,
            language: "typescript".to_string(),
        };
        upsert_symbol(&conn, &symbol).unwrap();
        add_symbols_to_branch(&conn, "main", &["sym1".to_string()]).unwrap();

        let edge = CallEdgeRow {
            id: "edge1".to_string(),
            from_symbol_id: "sym1".to_string(),
            target_name: "target".to_string(),
            to_symbol_id: None,
            call_type: "Call".to_string(),
            confidence: "Direct".to_string(),
            line: 2,
            col: 0,
            is_resolved: false,
        };
        upsert_call_edge(&conn, &edge).unwrap();

        clear_all_indexed_data(&conn).unwrap();

        assert!(!embedding_exists(&conn, "hash").unwrap());
        assert!(get_chunk(&conn, "chunk1").unwrap().is_none());
        assert!(get_branch_chunk_ids(&conn, "main").unwrap().is_empty());
        assert!(get_symbols_by_file(&conn, "src/main.ts")
            .unwrap()
            .is_empty());
        assert!(get_branch_symbol_ids(&conn, "main").unwrap().is_empty());
        assert!(get_callees(&conn, "sym1", "main", None).unwrap().is_empty());
    }

    #[test]
    fn test_stats_include_symbols() {
        let (_temp_dir, conn) = setup_test_db();

        // Initially empty
        let stats = get_stats(&conn).unwrap();
        assert_eq!(stats.symbol_count, 0);
        assert_eq!(stats.call_edge_count, 0);

        // Add a symbol and edge
        let symbol = SymbolRow {
            id: "s1".to_string(),
            file_path: "src/a.ts".to_string(),
            name: "test".to_string(),
            kind: "function".to_string(),
            start_line: 1,
            start_col: 0,
            end_line: 5,
            end_col: 1,
            language: "typescript".to_string(),
        };
        upsert_symbol(&conn, &symbol).unwrap();

        let edge = CallEdgeRow {
            id: "e1".to_string(),
            from_symbol_id: "s1".to_string(),
            target_name: "foo".to_string(),
            to_symbol_id: None,
            call_type: "Call".to_string(),
            confidence: "Direct".to_string(),
            line: 3,
            col: 0,
            is_resolved: false,
        };
        upsert_call_edge(&conn, &edge).unwrap();

        let stats = get_stats(&conn).unwrap();
        assert_eq!(stats.symbol_count, 1);
        assert_eq!(stats.call_edge_count, 1);
    }

    #[test]
    fn test_migration_v4_adds_cascade_on_call_edges_and_chunk_name_indexes() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("migration-v2.db");

        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                r#"
                CREATE TABLE metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE embeddings (
                    content_hash TEXT PRIMARY KEY,
                    embedding BLOB NOT NULL,
                    chunk_text TEXT NOT NULL,
                    model TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE chunks (
                    chunk_id TEXT PRIMARY KEY,
                    content_hash TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    start_line INTEGER NOT NULL,
                    end_line INTEGER NOT NULL,
                    node_type TEXT,
                    name TEXT,
                    language TEXT NOT NULL
                );
                CREATE TABLE branch_chunks (
                    branch TEXT NOT NULL,
                    chunk_id TEXT NOT NULL,
                    PRIMARY KEY (branch, chunk_id)
                );
                CREATE TABLE symbols (
                    id TEXT PRIMARY KEY,
                    file_path TEXT NOT NULL,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    start_line INTEGER NOT NULL,
                    start_col INTEGER NOT NULL,
                    end_line INTEGER NOT NULL,
                    end_col INTEGER NOT NULL,
                    language TEXT NOT NULL
                );
                CREATE TABLE call_edges (
                    id TEXT PRIMARY KEY,
                    from_symbol_id TEXT NOT NULL,
                    target_name TEXT NOT NULL,
                    to_symbol_id TEXT,
                    call_type TEXT NOT NULL,
                    line INTEGER NOT NULL,
                    col INTEGER NOT NULL,
                    is_resolved INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (from_symbol_id) REFERENCES symbols(id)
                );
                CREATE INDEX idx_call_edges_from ON call_edges(from_symbol_id);
                CREATE INDEX idx_call_edges_to ON call_edges(to_symbol_id);
                CREATE INDEX idx_call_edges_target_name ON call_edges(target_name);
                INSERT INTO metadata (key, value) VALUES ('schema_version', '2');
                "#,
            )
            .unwrap();
        }

        let conn = init_db(&db_path).unwrap();

        let schema_version: String = conn
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(schema_version, "6");

        let on_delete: String = conn
            .query_row("PRAGMA foreign_key_list(call_edges)", [], |row| row.get(6))
            .unwrap();
        assert_eq!(on_delete.to_uppercase(), "CASCADE");

        let mut stmt = conn.prepare("PRAGMA index_list('chunks')").unwrap();
        let index_names: Vec<String> = stmt
            .query_map([], |row| row.get(1))
            .unwrap()
            .map(|row| row.unwrap())
            .collect();

        assert!(index_names.iter().any(|name| name == "idx_chunks_name"));
        assert!(index_names
            .iter()
            .any(|name| name == "idx_chunks_name_lower"));
    }

    #[test]
    fn test_foreign_keys_enabled_by_default() {
        let (_temp_dir, conn) = setup_test_db();
        let enabled: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(enabled, 1);
    }

    #[test]
    fn test_cascade_deletes_call_edges_when_symbol_deleted() {
        let (_temp_dir, mut conn) = setup_test_db();

        let symbols = vec![
            SymbolRow {
                id: "sym_caller".to_string(),
                file_path: "src/main.ts".to_string(),
                name: "main".to_string(),
                kind: "function".to_string(),
                start_line: 1,
                start_col: 0,
                end_line: 10,
                end_col: 1,
                language: "typescript".to_string(),
            },
            SymbolRow {
                id: "sym_target".to_string(),
                file_path: "src/main.ts".to_string(),
                name: "target".to_string(),
                kind: "function".to_string(),
                start_line: 12,
                start_col: 0,
                end_line: 20,
                end_col: 1,
                language: "typescript".to_string(),
            },
        ];
        upsert_symbols_batch(&mut conn, &symbols).unwrap();
        add_symbols_to_branch(
            &conn,
            "main",
            &["sym_caller".to_string(), "sym_target".to_string()],
        )
        .unwrap();

        let edge = CallEdgeRow {
            id: "edge_cascade".to_string(),
            from_symbol_id: "sym_caller".to_string(),
            target_name: "target".to_string(),
            to_symbol_id: None,
            call_type: "Call".to_string(),
            confidence: "Direct".to_string(),
            line: 5,
            col: 2,
            is_resolved: false,
        };
        upsert_call_edge(&conn, &edge).unwrap();
        let before = get_callees(&conn, "sym_caller", "main", None).unwrap();
        assert_eq!(before.len(), 1);

        let deleted = delete_symbols_by_file(&conn, "src/main.ts").unwrap();
        assert_eq!(deleted, 2);

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM call_edges WHERE id = 'edge_cascade'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
    #[test]
    fn test_get_symbols_for_branch_empty() {
        let (_temp_dir, conn) = setup_test_db();
        let result = get_symbols_for_branch(&conn, "main").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn test_get_symbols_for_branch_populated() {
        let (_temp_dir, conn) = setup_test_db();

        let sym1 = SymbolRow {
            id: "s1".to_string(),
            file_path: "src/a.ts".to_string(),
            name: "funcA".to_string(),
            kind: "function".to_string(),
            start_line: 1,
            start_col: 0,
            end_line: 5,
            end_col: 1,
            language: "typescript".to_string(),
        };
        let sym2 = SymbolRow {
            id: "s2".to_string(),
            file_path: "src/b.ts".to_string(),
            name: "funcB".to_string(),
            kind: "function".to_string(),
            start_line: 10,
            start_col: 0,
            end_line: 15,
            end_col: 1,
            language: "typescript".to_string(),
        };
        upsert_symbol(&conn, &sym1).unwrap();
        upsert_symbol(&conn, &sym2).unwrap();
        add_symbols_to_branch(&conn, "main", &["s1".to_string(), "s2".to_string()]).unwrap();

        let result = get_symbols_for_branch(&conn, "main").unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "s1");
        assert_eq!(result[1].id, "s2");
    }

    #[test]
    fn test_get_symbols_for_branch_isolation() {
        let (_temp_dir, conn) = setup_test_db();

        let sym1 = SymbolRow {
            id: "s1".to_string(),
            file_path: "src/a.ts".to_string(),
            name: "funcA".to_string(),
            kind: "function".to_string(),
            start_line: 1,
            start_col: 0,
            end_line: 5,
            end_col: 1,
            language: "typescript".to_string(),
        };
        let sym2 = SymbolRow {
            id: "s2".to_string(),
            file_path: "src/b.ts".to_string(),
            name: "funcB".to_string(),
            kind: "function".to_string(),
            start_line: 10,
            start_col: 0,
            end_line: 15,
            end_col: 1,
            language: "typescript".to_string(),
        };
        upsert_symbol(&conn, &sym1).unwrap();
        upsert_symbol(&conn, &sym2).unwrap();
        add_symbols_to_branch(&conn, "main", &["s1".to_string()]).unwrap();
        add_symbols_to_branch(&conn, "feature", &["s2".to_string()]).unwrap();

        let main_result = get_symbols_for_branch(&conn, "main").unwrap();
        assert_eq!(main_result.len(), 1);
        assert_eq!(main_result[0].id, "s1");

        let feature_result = get_symbols_for_branch(&conn, "feature").unwrap();
        assert_eq!(feature_result.len(), 1);
        assert_eq!(feature_result[0].id, "s2");
    }

    #[test]
    fn test_get_symbols_for_files_empty() {
        let (_temp_dir, conn) = setup_test_db();
        let result = get_symbols_for_files(&conn, &[], "main").unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn test_get_symbols_for_files_single() {
        let (_temp_dir, conn) = setup_test_db();

        let sym1 = SymbolRow {
            id: "s1".to_string(),
            file_path: "src/a.ts".to_string(),
            name: "funcA".to_string(),
            kind: "function".to_string(),
            start_line: 1,
            start_col: 0,
            end_line: 5,
            end_col: 1,
            language: "typescript".to_string(),
        };
        let sym2 = SymbolRow {
            id: "s2".to_string(),
            file_path: "src/b.ts".to_string(),
            name: "funcB".to_string(),
            kind: "function".to_string(),
            start_line: 10,
            start_col: 0,
            end_line: 15,
            end_col: 1,
            language: "typescript".to_string(),
        };
        upsert_symbol(&conn, &sym1).unwrap();
        upsert_symbol(&conn, &sym2).unwrap();
        add_symbols_to_branch(&conn, "main", &["s1".to_string(), "s2".to_string()]).unwrap();

        let result = get_symbols_for_files(&conn, &["src/a.ts".to_string()], "main").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "s1");
    }

    #[test]
    fn test_get_symbols_for_files_multiple() {
        let (_temp_dir, conn) = setup_test_db();

        let sym1 = SymbolRow {
            id: "s1".to_string(),
            file_path: "src/a.ts".to_string(),
            name: "funcA".to_string(),
            kind: "function".to_string(),
            start_line: 1,
            start_col: 0,
            end_line: 5,
            end_col: 1,
            language: "typescript".to_string(),
        };
        let sym2 = SymbolRow {
            id: "s2".to_string(),
            file_path: "src/b.ts".to_string(),
            name: "funcB".to_string(),
            kind: "function".to_string(),
            start_line: 10,
            start_col: 0,
            end_line: 15,
            end_col: 1,
            language: "typescript".to_string(),
        };
        let sym3 = SymbolRow {
            id: "s3".to_string(),
            file_path: "src/c.ts".to_string(),
            name: "funcC".to_string(),
            kind: "function".to_string(),
            start_line: 20,
            start_col: 0,
            end_line: 25,
            end_col: 1,
            language: "typescript".to_string(),
        };
        upsert_symbol(&conn, &sym1).unwrap();
        upsert_symbol(&conn, &sym2).unwrap();
        upsert_symbol(&conn, &sym3).unwrap();
        add_symbols_to_branch(
            &conn,
            "main",
            &["s1".to_string(), "s2".to_string(), "s3".to_string()],
        )
        .unwrap();

        let result = get_symbols_for_files(
            &conn,
            &["src/a.ts".to_string(), "src/b.ts".to_string()],
            "main",
        )
        .unwrap();
        assert_eq!(result.len(), 2);
        let ids: Vec<String> = result.into_iter().map(|r| r.id).collect();
        assert!(ids.contains(&"s1".to_string()));
        assert!(ids.contains(&"s2".to_string()));
    }

    #[test]
    fn test_get_symbols_for_files_batch_chunking() {
        let (_temp_dir, mut conn) = setup_test_db();

        let mut symbols = Vec::new();
        let mut file_paths = Vec::new();
        let mut symbol_ids = Vec::new();

        for i in 0..1000 {
            let id = format!("s{}", i);
            let file_path = format!("src/f{}.ts", i);
            let sym = SymbolRow {
                id: id.clone(),
                file_path: file_path.clone(),
                name: format!("func{}", i),
                kind: "function".to_string(),
                start_line: i as u32,
                start_col: 0,
                end_line: i as u32 + 1,
                end_col: 10,
                language: "typescript".to_string(),
            };
            symbols.push(sym);
            file_paths.push(file_path);
            symbol_ids.push(id);
        }

        upsert_symbols_batch(&mut conn, &symbols).unwrap();
        add_symbols_to_branch(&conn, "main", &symbol_ids).unwrap();

        let result = get_symbols_for_files(&conn, &file_paths, "main").unwrap();
        assert_eq!(result.len(), 1000);
    }
}
