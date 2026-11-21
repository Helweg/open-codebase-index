use super::{run_batch_with_write_transaction, DbError, DbResult};
use rusqlite::{params, types::ValueRef, Connection, OptionalExtension};
use xxhash_rust::xxh3::Xxh3;

/// Optional access path for languages with case-insensitive call names.
/// An existing v9 reader works without the index; a writer installs it.
pub(super) fn ensure_lookup_indexes(conn: &Connection) -> DbResult<()> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_symbols_insensitive_name ON symbols(name COLLATE NOCASE)
         WHERE language IN ('apex', 'php');",
    )?;
    Ok(())
}

pub(super) fn migrate(conn: &Connection) -> DbResult<()> {
    let migration = conn.unchecked_transaction()?;
    migration.execute_batch(
        r#"
        -- Some older catalogs have symbols and edges but no branch membership yet.
        CREATE TABLE IF NOT EXISTS branch_symbols (
            branch TEXT NOT NULL,
            symbol_id TEXT NOT NULL,
            PRIMARY KEY (branch, symbol_id)
        );
        CREATE INDEX IF NOT EXISTS idx_branch_symbols_branch ON branch_symbols(branch);
        CREATE INDEX IF NOT EXISTS idx_branch_symbols_symbol_id ON branch_symbols(symbol_id);

        CREATE TABLE IF NOT EXISTS call_edge_sets (
            id INTEGER PRIMARY KEY,
            from_symbol_id TEXT NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
            digest BLOB NOT NULL,
            UNIQUE (from_symbol_id, digest)
        );
        CREATE TABLE IF NOT EXISTS shared_call_edges (
            id INTEGER PRIMARY KEY,
            edge_set_id INTEGER NOT NULL REFERENCES call_edge_sets(id) ON DELETE CASCADE,
            target_name TEXT NOT NULL,
            to_symbol_id TEXT,
            call_type TEXT NOT NULL,
            confidence TEXT NOT NULL,
            line INTEGER NOT NULL,
            col INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_shared_call_edges_set ON shared_call_edges(edge_set_id);
        CREATE INDEX IF NOT EXISTS idx_shared_call_edges_to ON shared_call_edges(to_symbol_id);
        CREATE INDEX IF NOT EXISTS idx_shared_call_edges_name ON shared_call_edges(target_name);
        "#,
    )?;
    let has_column: bool = migration.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('branch_symbols') WHERE name = 'edge_set_id')",
        [],
        |row| row.get(0),
    )?;
    if !has_column {
        migration.execute_batch(
            "ALTER TABLE branch_symbols ADD COLUMN edge_set_id INTEGER REFERENCES call_edge_sets(id) ON DELETE SET NULL;",
        )?;
    }
    migration.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_branch_symbols_set ON branch_symbols(edge_set_id, branch)
        WHERE edge_set_id IS NOT NULL;

        CREATE TRIGGER IF NOT EXISTS gc_call_set_after_branch_symbol_delete
        AFTER DELETE ON branch_symbols WHEN OLD.edge_set_id IS NOT NULL
        BEGIN
            DELETE FROM call_edge_sets WHERE id = OLD.edge_set_id AND NOT EXISTS (
                SELECT 1 FROM branch_symbols WHERE edge_set_id = OLD.edge_set_id
            );
        END;
        CREATE TRIGGER IF NOT EXISTS gc_call_set_after_branch_symbol_update
        AFTER UPDATE OF edge_set_id ON branch_symbols
        WHEN OLD.edge_set_id IS NOT NULL AND OLD.edge_set_id IS NOT NEW.edge_set_id
        BEGIN
            DELETE FROM call_edge_sets WHERE id = OLD.edge_set_id AND NOT EXISTS (
                SELECT 1 FROM branch_symbols WHERE edge_set_id = OLD.edge_set_id
            );
        END;

        CREATE VIEW IF NOT EXISTS catalog_call_edges AS
            SELECT b.branch, e.id, e.from_symbol_id, e.target_name, e.to_symbol_id,
                   e.call_type, e.confidence, e.line, e.col, e.is_resolved
            FROM call_edges e JOIN branch_symbols b ON b.symbol_id = e.from_symbol_id
            WHERE b.edge_set_id IS NULL
            UNION ALL
            SELECT b.branch, 'shared:' || e.id, b.symbol_id, e.target_name, target.symbol_id,
                   e.call_type, e.confidence, e.line, e.col, target.symbol_id IS NOT NULL
            FROM shared_call_edges e JOIN branch_symbols b ON b.edge_set_id = e.edge_set_id
            LEFT JOIN branch_symbols target ON target.branch = b.branch AND target.symbol_id = e.to_symbol_id;

        INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '9');
        "#,
    )?;
    migration.commit()?;
    Ok(())
}

/// A read-only v6–v8 database has no set selector. Keep the same query surface
/// without installing objects in a user's old catalog.
pub(super) fn create_legacy_read_view(conn: &Connection) -> DbResult<()> {
    conn.execute_batch(
        r#"
        CREATE TEMP VIEW catalog_call_edges AS
            SELECT b.branch, e.id, e.from_symbol_id, e.target_name, e.to_symbol_id,
                   e.call_type, e.confidence, e.line, e.col, e.is_resolved
            FROM main.call_edges e JOIN main.branch_symbols b ON b.symbol_id = e.from_symbol_id;
        "#,
    )?;
    Ok(())
}

pub struct BranchCallSet {
    pub from_symbol_id: String,
    pub sites: Vec<BranchCallSite>,
}

pub struct BranchCallSite {
    pub target_name: String,
    pub to_symbol_id: Option<String>,
    pub call_type: String,
    pub confidence: String,
    pub line: u32,
    pub col: u32,
}

impl BranchCallSite {
    fn location(&self) -> (u32, u32, &str) {
        (self.line, self.col, &self.target_name)
    }
}

fn digest_sites(sites: &[BranchCallSite]) -> [u8; 16] {
    fn field(hash: &mut Xxh3, value: &str) {
        hash.update(&(value.len() as u64).to_le_bytes());
        hash.update(value.as_bytes());
    }
    let mut hash = Xxh3::new();
    for site in sites {
        hash.update(&site.line.to_le_bytes());
        hash.update(&site.col.to_le_bytes());
        field(&mut hash, &site.target_name);
        field(&mut hash, &site.call_type);
        field(&mut hash, &site.confidence);
        if let Some(target) = &site.to_symbol_id {
            hash.update(&[1]);
            field(&mut hash, target);
        } else {
            hash.update(&[0]);
        }
    }
    hash.digest128().to_le_bytes()
}

/// A set's contents are immutable. Only this branch's selector is replaced;
/// the delete/update triggers reclaim sets once the last branch drops them.
pub fn replace_branch_call_sets(
    conn: &mut Connection,
    branch: &str,
    mut sets: Vec<BranchCallSet>,
) -> DbResult<()> {
    run_batch_with_write_transaction(conn, |conn| {
        let mut lookup = conn.prepare_cached(
            "SELECT id FROM call_edge_sets WHERE from_symbol_id = ?1 AND digest = ?2",
        )?;
        let mut existing = conn.prepare_cached(
            "SELECT target_name, to_symbol_id, call_type, confidence, line, col FROM shared_call_edges WHERE edge_set_id = ?1 ORDER BY id",
        )?;
        let mut add_set = conn.prepare_cached(
            "INSERT INTO call_edge_sets (from_symbol_id, digest) VALUES (?1, ?2) RETURNING id",
        )?;
        let mut add_site = conn.prepare_cached(
            "INSERT INTO shared_call_edges (edge_set_id, target_name, to_symbol_id, call_type, confidence, line, col) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        let mut select_set = conn.prepare_cached(
            "UPDATE branch_symbols SET edge_set_id = ?3 WHERE branch = ?1 AND symbol_id = ?2 AND edge_set_id IS NOT ?3",
        )?;
        let mut membership = conn
            .prepare_cached("SELECT 1 FROM branch_symbols WHERE branch = ?1 AND symbol_id = ?2")?;
        for set in &mut sets {
            let caller = &set.from_symbol_id;
            // Match legacy last-write-wins callsite identity, then compare sets
            // in canonical order independently of the extractor's traversal.
            set.sites.sort_by(|a, b| a.location().cmp(&b.location()));
            set.sites.dedup_by(|later, earlier| {
                if later.location() == earlier.location() {
                    std::mem::swap(later, earlier);
                    true
                } else {
                    false
                }
            });
            let selected = if set.sites.is_empty() {
                None
            } else {
                let digest = digest_sites(&set.sites);
                let found: Option<i64> = lookup
                    .query_row(params![caller, &digest[..]], |row| row.get(0))
                    .optional()?;
                if let Some(id) = found {
                    let mut rows = existing.query([id])?;
                    for site in &set.sites {
                        let target = site
                            .to_symbol_id
                            .as_ref()
                            .map_or(ValueRef::Null, |id| ValueRef::Text(id.as_bytes()));
                        let matches = if let Some(row) = rows.next()? {
                            row.get_ref(0)? == ValueRef::Text(site.target_name.as_bytes())
                                && row.get_ref(1)? == target
                                && row.get_ref(2)? == ValueRef::Text(site.call_type.as_bytes())
                                && row.get_ref(3)? == ValueRef::Text(site.confidence.as_bytes())
                                && row.get::<_, u32>(4)? == site.line
                                && row.get::<_, u32>(5)? == site.col
                        } else {
                            false
                        };
                        if !matches {
                            return Err(DbError::CallGraph("call-edge set digest collision"));
                        }
                    }
                    if rows.next()?.is_some() {
                        return Err(DbError::CallGraph("call-edge set digest collision"));
                    }
                    Some(id)
                } else {
                    let id: i64 =
                        add_set.query_row(params![caller, &digest[..]], |row| row.get(0))?;
                    for site in &set.sites {
                        add_site.execute(params![
                            id,
                            site.target_name,
                            site.to_symbol_id,
                            site.call_type,
                            site.confidence,
                            site.line,
                            site.col
                        ])?;
                    }
                    Some(id)
                }
            };
            if select_set.execute(params![branch, caller, selected])? == 0
                && !membership.exists(params![branch, caller])?
            {
                return Err(DbError::CallGraph(
                    "caller is not indexed on the selected branch",
                ));
            }
        }
        Ok(())
    })
}
