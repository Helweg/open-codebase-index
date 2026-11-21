use super::{DbResult, SQL_BIND_PARAM_BATCH_SIZE};
use rusqlite::{params, types::ValueRef, Connection, OptionalExtension};

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

/// Insert or update a symbol without deleting its outgoing call edges.
pub fn upsert_symbol(conn: &Connection, symbol: &SymbolRow) -> DbResult<()> {
    conn.execute(
        r#"
        INSERT INTO symbols (id, file_path, name, kind, start_line, start_col, end_line, end_col, language)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            file_path = excluded.file_path,
            name = excluded.name,
            kind = excluded.kind,
            start_line = excluded.start_line,
            start_col = excluded.start_col,
            end_line = excluded.end_line,
            end_col = excluded.end_col,
            language = excluded.language
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

/// Batch insert or update symbols within a single transaction, preserving call edges.
pub fn upsert_symbols_batch(conn: &mut Connection, symbols: &[SymbolRow]) -> DbResult<()> {
    if symbols.is_empty() {
        return Ok(());
    }

    super::run_batch_with_write_transaction(conn, |conn| {
        let mut stmt = conn.prepare(
            r#"
            INSERT INTO symbols (id, file_path, name, kind, start_line, start_col, end_line, end_col, language)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                file_path = excluded.file_path,
                name = excluded.name,
                kind = excluded.kind,
                start_line = excluded.start_line,
                start_col = excluded.start_col,
                end_line = excluded.end_line,
                end_col = excluded.end_col,
                language = excluded.language
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
        Ok(())
    })
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
        // Start with file-index seeks; membership-first scans the branch for every bind batch.
        let sql = format!(
            r#"
            SELECT s.id, s.file_path, s.name, s.kind, s.start_line, s.start_col, s.end_line, s.end_col, s.language
            FROM symbols s
            CROSS JOIN branch_symbols bs ON bs.branch = ? AND bs.symbol_id = s.id
            WHERE s.file_path IN ({})
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

    super::run_batch_with_write_transaction(conn, |conn| {
        let mut stmt = conn.prepare(
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
        Ok(())
    })
}

fn is_case_insensitive_language(language: &str) -> bool {
    // Keep this aligned with the SQL IN lists below and CASE_INSENSITIVE_LANGUAGES in the indexer.
    matches!(language, "apex" | "php")
}

fn symbol_names_match(language: &str, left: &str, right: &str) -> bool {
    if is_case_insensitive_language(language) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

#[derive(Clone, Copy)]
pub enum CallGraphLayout {
    Legacy,
    BranchSets,
}

impl CallGraphLayout {
    fn point_query(self, legacy: &'static str, branch_sets: &'static str) -> &'static str {
        match self {
            Self::Legacy => legacy,
            Self::BranchSets => branch_sets,
        }
    }
}

macro_rules! legacy_call_edges_sql {
    ($context:literal, $condition:literal) => {
        concat!(
            "SELECT e.id, e.from_symbol_id, ",
            $context,
            r#"e.target_name, e.to_symbol_id, e.call_type, e.confidence, e.line, e.col, e.is_resolved
            FROM branch_symbols b
            JOIN call_edges e ON e.from_symbol_id = b.symbol_id
            JOIN symbols s ON s.id = b.symbol_id
            WHERE b.branch = ?1 AND (?3 IS NULL OR e.call_type = ?3)
            "#,
            $condition,
        )
    };
}

macro_rules! legacy_callers_sql {
    ($context:literal) => {
        legacy_call_edges_sql!(
            $context,
            r#"
            AND (
                (s.language IN ('apex', 'php') AND e.target_name = ?2 COLLATE NOCASE)
                OR
                (s.language NOT IN ('apex', 'php') AND e.target_name = ?2 COLLATE BINARY)
                OR EXISTS (
                    SELECT 1
                    FROM symbols target
                    JOIN branch_symbols member ON member.symbol_id = target.id AND member.branch = ?1
                    WHERE target.id = e.to_symbol_id AND (
                        (target.language IN ('apex', 'php') AND target.name = ?2 COLLATE NOCASE)
                        OR
                        (target.language NOT IN ('apex', 'php') AND target.name = ?2 COLLATE BINARY)
                    )
                )
            )
            "#
        )
    };
}

// Start with indexed spelling or declaration-name hits, not with every symbol
// in a case-insensitive language. A folded spelling match is valid only for
// an Apex/PHP caller; aliases use the target declaration's language.
macro_rules! callers_sql {
    ($layout:expr, $context:literal) => {
        ($layout).point_query(
            legacy_callers_sql!($context),
            concat!(
                legacy_callers_sql!($context),
                " AND b.edge_set_id IS NULL UNION ALL SELECT e.id, b.symbol_id, ",
                $context,
                r#"e.target_name, t.symbol_id, e.call_type, e.confidence, e.line, e.col, t.symbol_id IS NOT NULL
                FROM (
                    SELECT edge.id FROM shared_call_edges edge
                    JOIN branch_symbols caller ON caller.branch = ?1 AND caller.edge_set_id = edge.edge_set_id
                    WHERE edge.target_name = ?2 COLLATE NOCASE AND (
                        edge.target_name = ?2 COLLATE BINARY OR EXISTS (
                            SELECT 1 FROM symbols source
                            WHERE source.id = caller.symbol_id AND source.language IN ('apex', 'php')
                        )
                    )
                    UNION
                    SELECT edge.id FROM symbols target
                    CROSS JOIN branch_symbols member ON member.branch = ?1 AND member.symbol_id = target.id
                    CROSS JOIN shared_call_edges edge ON edge.to_symbol_id = target.id
                    WHERE target.name = ?2 COLLATE BINARY
                    UNION
                    SELECT edge.id FROM symbols target
                    JOIN branch_symbols member ON member.branch = ?1 AND member.symbol_id = target.id
                    JOIN shared_call_edges edge ON edge.to_symbol_id = target.id
                    WHERE target.language IN ('apex', 'php') AND target.name = ?2 COLLATE NOCASE
                ) hit
                CROSS JOIN shared_call_edges e ON e.id = hit.id
                CROSS JOIN branch_symbols b ON b.edge_set_id = e.edge_set_id AND b.branch = ?1
                JOIN symbols s ON s.id = b.symbol_id
                LEFT JOIN branch_symbols t ON t.branch = ?1 AND t.symbol_id = e.to_symbol_id
                WHERE (?3 IS NULL OR e.call_type = ?3)
                "#,
            ),
        )
    };
}

/// Get all call edges calling a symbol name (filtered by branch).
pub fn get_callers(
    conn: &Connection,
    symbol_name: &str,
    branch: &str,
    call_type_filter: Option<&str>,
    layout: CallGraphLayout,
) -> DbResult<Vec<CallEdgeRow>> {
    let mut stmt = conn.prepare_cached(callers_sql!(layout, ""))?;
    let rows = stmt.query_map(
        params![branch, symbol_name, call_type_filter],
        call_edge_row,
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn call_edge_id(row: &rusqlite::Row<'_>) -> rusqlite::Result<String> {
    match row.get_ref(0)? {
        ValueRef::Integer(id) => Ok(format!("shared:{id}")),
        _ => row.get(0),
    }
}

fn call_edge_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CallEdgeRow> {
    Ok(CallEdgeRow {
        id: call_edge_id(row)?,
        from_symbol_id: row.get(1)?,
        target_name: row.get(2)?,
        to_symbol_id: row.get(3)?,
        call_type: row.get(4)?,
        confidence: row.get(5)?,
        line: row.get(6)?,
        col: row.get(7)?,
        is_resolved: row.get::<_, i32>(8)? != 0,
    })
}

pub fn get_callers_with_context(
    conn: &Connection,
    symbol_name: &str,
    branch: &str,
    call_type_filter: Option<&str>,
    layout: CallGraphLayout,
) -> DbResult<Vec<CallerRow>> {
    let mut stmt = conn.prepare_cached(callers_sql!(layout, "s.name, s.file_path, "))?;
    let rows = stmt.query_map(params![branch, symbol_name, call_type_filter], |row| {
        Ok(CallerRow {
            id: call_edge_id(row)?,
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
    layout: CallGraphLayout,
) -> DbResult<Vec<CallEdgeRow>> {
    let sql = layout.point_query(
        legacy_call_edges_sql!("", " AND b.symbol_id = ?2"),
        concat!(
            legacy_call_edges_sql!("", " AND b.symbol_id = ?2"),
            r#"
            AND b.edge_set_id IS NULL
            UNION ALL
            SELECT e.id, b.symbol_id, e.target_name, t.symbol_id, e.call_type, e.confidence,
                   e.line, e.col, t.symbol_id IS NOT NULL
            FROM branch_symbols b
            JOIN shared_call_edges e ON e.edge_set_id = b.edge_set_id
            LEFT JOIN branch_symbols t ON t.branch = ?1 AND t.symbol_id = e.to_symbol_id
            WHERE b.branch = ?1 AND b.symbol_id = ?2 AND (?3 IS NULL OR e.call_type = ?3)
            "#
        ),
    );
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map(params![branch, symbol_id, call_type_filter], call_edge_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
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
    let shared: usize = conn.query_row(
        "SELECT COUNT(*) FROM shared_call_edges WHERE edge_set_id IN (
            SELECT a.id FROM call_edge_sets a JOIN symbols s ON s.id = a.from_symbol_id WHERE s.file_path = ?1
        )",
        [file_path],
        |row| row.get(0),
    )?;
    if shared != 0 {
        conn.execute(
            "DELETE FROM call_edge_sets WHERE from_symbol_id IN (SELECT id FROM symbols WHERE file_path = ?1)",
            [file_path],
        )?;
    }
    Ok(count + shared)
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
    if edge_id.starts_with("shared:") {
        return Err(super::DbError::CallGraph(
            "shared edges must be replaced through a branch call set",
        ));
    }
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
        SELECT s.id, s.name, s.file_path, s.start_line, s.language
        FROM symbols s
        INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
        WHERE
            (s.language IN ('apex', 'php') AND s.name = ?2 COLLATE NOCASE)
            OR
            (s.language NOT IN ('apex', 'php') AND s.name = ?2 COLLATE BINARY)
        "#,
    )?;
    let starts: Vec<(String, String, String, u32, String)> = start_stmt
        .query_map(params![branch, from_name], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u32>(3)?,
                row.get::<_, String>(4)?,
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
        FROM catalog_call_edges ce
        JOIN symbols s ON s.id = ce.from_symbol_id
        WHERE ce.branch = ? AND ce.from_symbol_id = ?
        "#,
    )?;

    // Resolve a target_name to symbol IDs on this branch
    let mut resolve_stmt = conn.prepare(
        r#"
        SELECT s.id, s.name, s.file_path, s.start_line, s.language
        FROM symbols s
        INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?1
        WHERE
            (?2 IN ('apex', 'php') AND s.name = ?3 COLLATE NOCASE)
            OR
            (?2 NOT IN ('apex', 'php') AND s.name = ?3 COLLATE BINARY)
        "#,
    )?;

    let mut branch_symbol_language_stmt = conn.prepare(
        r#"
        SELECT s.language
        FROM symbols s
        INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?
        WHERE s.id = ?
        "#,
    )?;

    // BFS state: queue entries are (symbol_id, language, depth)
    // parent map: symbol_id -> (parent_symbol_id, call_type, line)
    let mut visited: HashMap<String, (String, String, u32)> = HashMap::new(); // child -> (parent_id, call_type, line)
    let mut queue: VecDeque<(String, String, u32)> = VecDeque::new();

    // Seed BFS with all start symbols
    for (sid, _name, _fp, _line, language) in &starts {
        visited.insert(sid.clone(), (String::new(), String::new(), 0)); // sentinel parent
        queue.push_back((sid.clone(), language.clone(), 0));
    }

    let mut target_found: Option<String> = None;

    'bfs: while let Some((current_id, current_language, depth)) = queue.pop_front() {
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
            // Check if target_name matches using the current/source symbol's language.
            if symbol_names_match(&current_language, &callee_target_name, to_name) {
                // Resolve the target to real symbol(s) on this branch
                let resolved_targets: Vec<(String, String, String, u32, String)> = resolve_stmt
                    .query_map(params![branch, &current_language, to_name], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, u32>(3)?,
                            row.get::<_, String>(4)?,
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
                    // Verify the resolved symbol exists on this branch and carry its language
                    // into the next BFS expansion.
                    let resolved_language: Option<String> = branch_symbol_language_stmt
                        .query_row(params![branch, resolved_id], |row| row.get(0))
                        .optional()?;
                    if let Some(resolved_language) = resolved_language {
                        visited.insert(
                            resolved_id.clone(),
                            (current_id.clone(), call_type.clone(), line),
                        );
                        queue.push_back((resolved_id.clone(), resolved_language, depth + 1));
                    }
                }
            } else {
                // Unresolved: try resolving by target_name
                // Only traverse if unambiguous (single match) to avoid fabricating paths
                let resolved: Vec<(String, String, String, u32, String)> = resolve_stmt
                    .query_map(
                        params![branch, &current_language, &callee_target_name],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, u32>(3)?,
                                row.get::<_, String>(4)?,
                            ))
                        },
                    )?
                    .filter_map(|r| r.ok())
                    .collect();

                // Only traverse unambiguous (single) resolution to avoid fabricating paths
                // through implementations the call graph never actually resolved
                if resolved.len() == 1 {
                    let (resolved_id, _name, _fp, _line, resolved_language) = &resolved[0];
                    if !visited.contains_key(resolved_id) {
                        visited.insert(
                            resolved_id.clone(),
                            (current_id.clone(), call_type.clone(), line),
                        );
                        queue.push_back((
                            resolved_id.clone(),
                            resolved_language.clone(),
                            depth + 1,
                        ));
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

    super::run_batch_with_write_transaction(conn, |conn| {
        let mut stmt =
            conn.prepare("INSERT OR IGNORE INTO branch_symbols (branch, symbol_id) VALUES (?, ?)")?;

        for symbol_id in symbol_ids {
            stmt.execute(params![branch, symbol_id])?;
        }
        Ok(())
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CallGraphLayout::BranchSets;
    use rusqlite::StatementStatus;

    #[test]
    fn caller_query_work_does_not_grow_with_unrelated_php_symbols() {
        fn work(conn: &Connection, sql: &str) -> (i32, i32) {
            let mut stmt = conn.prepare(sql).unwrap();
            let mut rows = stmt
                .query(params!["project:main", "target", "Call"])
                .unwrap();
            assert!(rows.next().unwrap().is_some());
            assert!(rows.next().unwrap().is_none());
            drop(rows);
            (
                stmt.get_status(StatementStatus::VmStep),
                stmt.get_status(StatementStatus::FullscanStep),
            )
        }
        for optional_indexes in [true, false] {
            let dir = tempfile::TempDir::new().unwrap();
            let conn = super::super::init_db(&dir.path().join("callers.db")).unwrap();
            if !optional_indexes {
                conn.execute_batch(
                    "DROP INDEX idx_shared_call_edges_name_ci;
                     DROP INDEX idx_symbols_insensitive_name;
                     CREATE INDEX idx_shared_call_edges_name ON shared_call_edges(target_name);",
                )
                .unwrap();
            }
            conn.execute_batch(
                "INSERT INTO symbols VALUES ('caller', 'src/caller.ts', 'run', 'function', 1, 0, 3, 1, 'typescript');
                 INSERT INTO symbols VALUES ('target', 'src/target.ts', 'target', 'function', 1, 0, 3, 1, 'typescript');
                 INSERT INTO call_edge_sets VALUES (1, 'caller', X'00');
                 INSERT INTO branch_symbols VALUES ('project:main', 'caller', 1), ('project:main', 'target', NULL);
                 INSERT INTO shared_call_edges VALUES (1, 1, 'target', 'target', 'Call', 'Direct', 2, 8);",
            )
            .unwrap();
            let queries = [
                callers_sql!(BranchSets, ""),
                callers_sql!(BranchSets, "s.name, s.file_path, "),
            ];
            let before = queries.map(|sql| work(&conn, sql));
            conn.execute_batch(
                "WITH RECURSIVE unrelated(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM unrelated WHERE n<20000)
                 INSERT INTO symbols SELECT 'php-' || n, '/other/src/' || n || '.php', 'unrelated' || n,
                 'function', 1, 0, 3, 1, 'php' FROM unrelated;
                 INSERT INTO call_edge_sets (from_symbol_id, digest)
                 SELECT id, X'00' FROM symbols WHERE language = 'php';
                 INSERT INTO branch_symbols (branch, symbol_id, edge_set_id)
                 SELECT 'other-project:main', from_symbol_id, id FROM call_edge_sets WHERE id > 1;
                 INSERT INTO shared_call_edges
                 SELECT id, id, 'callee' || id, NULL, 'Call', 'Direct', 2, 8 FROM call_edge_sets WHERE id > 1;",
            )
            .unwrap();
            let after = queries.map(|sql| work(&conn, sql));
            eprintln!("optional indexes {optional_indexes}: (VM instructions, full-scan steps) {before:?} -> {after:?}");
            for ((before_steps, _), (after_steps, full_scan_steps)) in before.into_iter().zip(after)
            {
                // Allow a constant amount of work to close an index range.
                assert!(
                    after_steps <= before_steps + 16,
                    "VM work scaled with another project"
                );
                assert_eq!(full_scan_steps, 0);
            }
        }
    }
}
