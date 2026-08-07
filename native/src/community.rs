use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet, VecDeque};

use crate::db::{self, DbResult, SymbolRow};

#[derive(Debug, Clone, PartialEq)]
pub struct ReachabilityResult {
    pub symbol_id: String,
    pub symbol_name: String,
    pub file_path: String,
    pub depth: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CommunityAssignment {
    pub symbol_id: String,
    pub symbol_name: String,
    pub file_path: String,
    pub community_id: u32,
    pub community_label: String,
    pub cross_community_connections: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CommunityCouplingRelationship {
    pub from_symbol_id: String,
    pub from_symbol_name: String,
    pub from_file_path: String,
    pub to_symbol_id: String,
    pub to_symbol_name: String,
    pub to_file_path: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CommunityCoupling {
    pub community_a: u32,
    pub community_b: u32,
    pub count: u32,
    pub representative_relationships: Vec<CommunityCouplingRelationship>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CentralityScore {
    pub symbol_id: String,
    pub symbol_name: String,
    pub file_path: String,
    pub caller_count: u32,
    pub callee_count: u32,
    pub total_connections: u32,
}

fn resolve_target_symbol(
    to_symbol_id: &Option<String>,
    target_name: &str,
    symbol_map: &HashMap<String, SymbolRow>,
    name_map: &HashMap<String, Vec<String>>,
) -> Option<String> {
    if let Some(tid) = to_symbol_id {
        if symbol_map.contains_key(tid) {
            return Some(tid.clone());
        }

        return None;
    }

    let candidates = name_map.get(&target_name.to_lowercase());
    if let Some(cands) = candidates {
        if cands.len() == 1 {
            return Some(cands[0].clone());
        }
    }

    None
}

fn build_symbol_maps(
    symbols: &[SymbolRow],
) -> (HashMap<String, SymbolRow>, HashMap<String, Vec<String>>) {
    let symbol_map: HashMap<String, SymbolRow> =
        symbols.iter().map(|s| (s.id.clone(), s.clone())).collect();

    let mut name_map: HashMap<String, Vec<String>> = HashMap::new();
    for s in symbols {
        name_map
            .entry(s.name.to_lowercase())
            .or_default()
            .push(s.id.clone());
    }

    (symbol_map, name_map)
}

pub fn get_transitive_reachability(
    conn: &Connection,
    root_symbol_ids: &[String],
    branch: &str,
    direction: &str,
    max_depth: u32,
) -> DbResult<Vec<ReachabilityResult>> {
    if root_symbol_ids.is_empty() || max_depth == 0 {
        return Ok(vec![]);
    }

    let symbols = db::get_symbols_for_branch(conn, branch)?;
    let symbol_map: HashMap<String, SymbolRow> =
        symbols.iter().map(|s| (s.id.clone(), s.clone())).collect();
    let mut name_map: HashMap<String, Vec<String>> = HashMap::new();
    for s in &symbols {
        name_map
            .entry(s.name.to_lowercase())
            .or_default()
            .push(s.id.clone());
    }

    let seed_refs: Vec<String> = root_symbol_ids
        .iter()
        .filter(|r| symbol_map.contains_key(*r))
        .cloned()
        .collect();
    if seed_refs.is_empty() {
        return Ok(vec![]);
    }

    // Build the merged visited map based on direction
    let visited = match direction {
        "callees" => bfs_callees(conn, branch, &seed_refs, &symbol_map, &name_map, max_depth)?,
        "callers" => bfs_callers(conn, branch, &seed_refs, &symbol_map, &name_map, max_depth)?,
        _ => {
            // "both" or any other value: run both and merge by min depth
            let callees = bfs_callees(conn, branch, &seed_refs, &symbol_map, &name_map, max_depth)?;
            let callers = bfs_callers(conn, branch, &seed_refs, &symbol_map, &name_map, max_depth)?;
            let mut merged: HashMap<String, u32> = HashMap::new();
            for (id, depth) in callees.into_iter().chain(callers) {
                merged
                    .entry(id)
                    .and_modify(|d| *d = (*d).min(depth))
                    .or_insert(depth);
            }
            merged
        }
    };

    let mut results = Vec::new();
    for (symbol_id, depth) in visited {
        if root_symbol_ids.contains(&symbol_id) {
            continue;
        }
        if let Some(sym) = symbol_map.get(&symbol_id) {
            results.push(ReachabilityResult {
                symbol_id: sym.id.clone(),
                symbol_name: sym.name.clone(),
                file_path: sym.file_path.clone(),
                depth,
            });
        }
    }

    results.sort_by(|a, b| {
        a.depth
            .cmp(&b.depth)
            .then_with(|| a.symbol_id.cmp(&b.symbol_id))
    });
    Ok(results)
}

fn bfs_callees(
    conn: &Connection,
    branch: &str,
    seed_ids: &[String],
    symbol_map: &HashMap<String, SymbolRow>,
    name_map: &HashMap<String, Vec<String>>,
    max_depth: u32,
) -> DbResult<HashMap<String, u32>> {
    let mut visited: HashMap<String, u32> = HashMap::new();
    let mut queue: VecDeque<(String, u32)> = VecDeque::new();

    for id in seed_ids {
        visited.insert(id.clone(), 0);
        queue.push_back((id.clone(), 0));
    }

    let mut stmt = conn.prepare(
        r#"
        SELECT ce.target_name, ce.to_symbol_id
        FROM call_edges ce
        INNER JOIN symbols s ON ce.from_symbol_id = s.id
        INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?
        WHERE ce.from_symbol_id = ?
        "#,
    )?;

    while let Some((current_id, depth)) = queue.pop_front() {
        if depth >= max_depth {
            continue;
        }

        let edges: Vec<(String, Option<String>)> = stmt
            .query_map(params![branch, &current_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        for (target_name, to_symbol_id) in edges {
            let resolved = if let Some(ref tid) = to_symbol_id {
                if symbol_map.contains_key(tid) {
                    Some(tid.clone())
                } else {
                    None
                }
            } else {
                let candidates = name_map.get(&target_name.to_lowercase());
                if let Some(cands) = candidates {
                    if cands.len() == 1 {
                        Some(cands[0].clone())
                    } else {
                        None
                    }
                } else {
                    None
                }
            };

            if let Some(next_id) = resolved {
                if !visited.contains_key(&next_id) {
                    visited.insert(next_id.clone(), depth + 1);
                    queue.push_back((next_id, depth + 1));
                }
            }
        }
    }

    Ok(visited)
}

fn bfs_callers(
    conn: &Connection,
    branch: &str,
    seed_ids: &[String],
    symbol_map: &HashMap<String, SymbolRow>,
    name_map: &HashMap<String, Vec<String>>,
    max_depth: u32,
) -> DbResult<HashMap<String, u32>> {
    let mut visited: HashMap<String, u32> = HashMap::new();
    let mut queue: VecDeque<(String, u32)> = VecDeque::new();

    for id in seed_ids {
        visited.insert(id.clone(), 0);
        queue.push_back((id.clone(), 0));
    }

    let mut stmt = conn.prepare(
        r#"
        SELECT ce.from_symbol_id, ce.to_symbol_id, ce.target_name
        FROM call_edges ce
        INNER JOIN symbols s ON ce.from_symbol_id = s.id
        INNER JOIN branch_symbols bs ON s.id = bs.symbol_id AND bs.branch = ?
        WHERE (ce.to_symbol_id = ? OR ce.target_name = ? COLLATE NOCASE)
        "#,
    )?;

    while let Some((current_id, depth)) = queue.pop_front() {
        if depth >= max_depth {
            continue;
        }

        let current_name = symbol_map
            .get(&current_id)
            .map(|s| s.name.clone())
            .unwrap_or_default();
        if current_name.is_empty() {
            continue;
        }

        let edges: Vec<(String, Option<String>, String)> = stmt
            .query_map(params![branch, &current_id, &current_name], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        for (from_symbol_id, to_symbol_id, target_name) in edges {
            let is_match = if let Some(ref tid) = to_symbol_id {
                tid == &current_id
            } else {
                let candidates = name_map.get(&target_name.to_lowercase());
                if let Some(cands) = candidates {
                    cands.len() == 1 && cands[0] == current_id
                } else {
                    false
                }
            };

            if is_match && !visited.contains_key(&from_symbol_id) {
                visited.insert(from_symbol_id.clone(), depth + 1);
                queue.push_back((from_symbol_id, depth + 1));
            }
        }
    }

    Ok(visited)
}

pub fn detect_communities(
    conn: &Connection,
    branch: &str,
    symbol_ids: Option<&[String]>,
) -> DbResult<Vec<CommunityAssignment>> {
    let symbols = db::get_symbols_for_branch(conn, branch)?;
    if symbols.is_empty() {
        return Ok(vec![]);
    }

    let (symbol_map, name_map) = build_symbol_maps(&symbols);

    // Build adjacency list from branch-scoped edges
    let mut adjacency: HashMap<String, HashSet<String>> = HashMap::new();
    for s in &symbols {
        adjacency.insert(s.id.clone(), HashSet::new());
    }

    let mut edges_stmt = conn.prepare(
        r#"
        SELECT ce.from_symbol_id, ce.target_name, ce.to_symbol_id
        FROM call_edges ce
        INNER JOIN branch_symbols bs ON ce.from_symbol_id = bs.symbol_id AND bs.branch = ?
        "#,
    )?;

    let edge_rows: Vec<(String, String, Option<String>)> = edges_stmt
        .query_map(params![branch], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect();

    for (from_id, target_name, to_symbol_id) in edge_rows {
        let resolved = resolve_target_symbol(&to_symbol_id, &target_name, &symbol_map, &name_map);

        if let Some(to_id) = resolved {
            if to_id != from_id {
                adjacency
                    .entry(from_id.clone())
                    .or_default()
                    .insert(to_id.clone());
                adjacency.entry(to_id).or_default().insert(from_id.clone());
            }
        }
    }

    // Determine the set of symbols to process
    let active_ids: HashSet<String> = if let Some(ids) = symbol_ids {
        let seed: HashSet<String> = ids.iter().cloned().collect();
        let mut component = HashSet::new();
        let mut stack: Vec<String> = seed.iter().cloned().collect();
        while let Some(node) = stack.pop() {
            if !component.contains(&node) && adjacency.contains_key(&node) {
                component.insert(node.clone());
                for neighbor in &adjacency[&node] {
                    if !component.contains(neighbor) {
                        stack.push(neighbor.clone());
                    }
                }
            }
        }
        component
    } else {
        symbol_map.keys().cloned().collect()
    };

    if active_ids.is_empty() {
        return Ok(vec![]);
    }

    // Label propagation
    let mut labels: HashMap<String, String> = HashMap::new();
    for id in &active_ids {
        labels.insert(id.clone(), id.clone());
    }

    let mut degrees: HashMap<String, usize> = HashMap::new();
    for id in &active_ids {
        let deg = adjacency.get(id).map(|s| s.len()).unwrap_or(0);
        degrees.insert(id.clone(), deg);
    }

    // Deterministic seed ordering by degree-descending, then symbol_id ascending
    let mut order: Vec<String> = active_ids.iter().cloned().collect();
    order.sort_by(|a, b| {
        let da = degrees.get(a).unwrap_or(&0);
        let db = degrees.get(b).unwrap_or(&0);
        db.cmp(da).then_with(|| a.cmp(b))
    });

    for _ in 0..50 {
        let mut changed = false;
        for id in &order {
            let Some(neighbors) = adjacency.get(id) else {
                continue;
            };

            let mut label_counts: HashMap<String, usize> = HashMap::new();
            for neighbor in neighbors
                .iter()
                .filter(|neighbor| active_ids.contains(*neighbor))
            {
                let lbl = labels
                    .get(neighbor)
                    .cloned()
                    .unwrap_or_else(|| neighbor.clone());
                *label_counts.entry(lbl).or_insert(0) += 1;
            }

            if label_counts.is_empty() {
                continue;
            }

            let mut best_label: Option<String> = None;
            let mut best_count: usize = 0;
            for (lbl, cnt) in label_counts {
                if cnt > best_count
                    || (cnt == best_count && lbl < best_label.clone().unwrap_or_default())
                {
                    best_count = cnt;
                    best_label = Some(lbl);
                }
            }

            if let Some(new_label) = best_label {
                let current = labels.get(id).cloned().unwrap_or_else(|| id.clone());
                if new_label != current {
                    labels.insert(id.clone(), new_label);
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }

    // Group by community label
    let mut communities: HashMap<String, Vec<String>> = HashMap::new();
    for id in &active_ids {
        let lbl = labels.get(id).cloned().unwrap_or_else(|| id.clone());
        communities.entry(lbl).or_default().push(id.clone());
    }

    let mut results = Vec::new();
    let mut sorted_communities: Vec<(String, Vec<String>)> = communities.into_iter().collect();
    sorted_communities.sort_by(|a, b| a.0.cmp(&b.0));
    for (idx, (label, members)) in sorted_communities.into_iter().enumerate() {
        let community_id = idx as u32;

        // Find highest-degree symbol in community
        let mut best_member: Option<&String> = None;
        let mut best_deg: usize = 0;
        for m in &members {
            let deg = degrees.get(m).unwrap_or(&0);
            if best_member.is_none()
                || *deg > best_deg
                || (*deg == best_deg && m < best_member.unwrap())
            {
                best_deg = *deg;
                best_member = Some(m);
            }
        }
        let community_label = best_member
            .and_then(|m| symbol_map.get(m))
            .map(|s| s.name.clone())
            .unwrap_or_else(|| label.clone());

        for m in &members {
            if let Some(sym) = symbol_map.get(m) {
                let member_label = labels.get(m).unwrap_or(m);
                let cross_community_connections = adjacency
                    .get(m)
                    .map(|neighbors| {
                        neighbors
                            .iter()
                            .filter(|neighbor| {
                                active_ids.contains(*neighbor)
                                    && labels.get(*neighbor).unwrap_or(*neighbor) != member_label
                            })
                            .count() as u32
                    })
                    .unwrap_or(0);
                results.push(CommunityAssignment {
                    symbol_id: sym.id.clone(),
                    symbol_name: sym.name.clone(),
                    file_path: sym.file_path.clone(),
                    community_id,
                    community_label: community_label.clone(),
                    cross_community_connections,
                });
            }
        }
    }

    // Sort for determinism: by symbol_id
    results.sort_by(|a, b| a.symbol_id.cmp(&b.symbol_id));
    Ok(results)
}

pub fn compute_centrality(conn: &Connection, branch: &str) -> DbResult<Vec<CentralityScore>> {
    let symbols = db::get_symbols_for_branch(conn, branch)?;
    if symbols.is_empty() {
        return Ok(vec![]);
    }

    let (symbol_map, name_map) = build_symbol_maps(&symbols);

    let mut caller_counts: HashMap<String, u32> = HashMap::new();
    let mut callee_counts: HashMap<String, u32> = HashMap::new();

    for s in &symbols {
        caller_counts.insert(s.id.clone(), 0);
        callee_counts.insert(s.id.clone(), 0);
    }

    let mut edges_stmt = conn.prepare(
        r#"
        SELECT ce.from_symbol_id, ce.target_name, ce.to_symbol_id
        FROM call_edges ce
        INNER JOIN branch_symbols bs ON ce.from_symbol_id = bs.symbol_id AND bs.branch = ?
        "#,
    )?;

    let edge_rows: Vec<(String, String, Option<String>)> = edges_stmt
        .query_map(params![branch], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect();

    for (from_id, target_name, to_symbol_id) in edge_rows {
        *callee_counts.entry(from_id.clone()).or_insert(0) += 1;

        let resolved = resolve_target_symbol(&to_symbol_id, &target_name, &symbol_map, &name_map);

        if let Some(to_id) = resolved {
            *caller_counts.entry(to_id).or_insert(0) += 1;
        }
    }

    let mut results: Vec<CentralityScore> = symbols
        .iter()
        .map(|s| {
            let cc = *caller_counts.get(&s.id).unwrap_or(&0);
            let ec = *callee_counts.get(&s.id).unwrap_or(&0);
            CentralityScore {
                symbol_id: s.id.clone(),
                symbol_name: s.name.clone(),
                file_path: s.file_path.clone(),
                caller_count: cc,
                callee_count: ec,
                total_connections: cc + ec,
            }
        })
        .collect();

    // Sort by caller_count descending, then symbol_id ascending for determinism
    results.sort_by(|a, b| {
        b.caller_count
            .cmp(&a.caller_count)
            .then_with(|| a.symbol_id.cmp(&b.symbol_id))
    });

    Ok(results)
}

pub fn detect_community_couplings(
    conn: &Connection,
    branch: &str,
) -> DbResult<Vec<CommunityCoupling>> {
    let symbols = db::get_symbols_for_branch(conn, branch)?;
    if symbols.is_empty() {
        return Ok(vec![]);
    }

    let (symbol_map, _) = build_symbol_maps(&symbols);
    let assignments = detect_communities(conn, branch, None)?;
    let symbol_to_community: HashMap<String, u32> = assignments
        .into_iter()
        .map(|assignment| (assignment.symbol_id, assignment.community_id))
        .collect();

    let mut edges_stmt = conn.prepare(
        r#"
        SELECT ce.from_symbol_id, ce.target_name, ce.to_symbol_id
        FROM call_edges ce
        INNER JOIN branch_symbols bs ON ce.from_symbol_id = bs.symbol_id AND bs.branch = ?
        "#,
    )?;

    let edge_rows: Vec<(String, String, Option<String>)> = edges_stmt
        .query_map(params![branch], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(aggregate_community_couplings(
        &symbol_map,
        &symbol_to_community,
        edge_rows,
    ))
}

fn aggregate_community_couplings(
    symbol_map: &HashMap<String, SymbolRow>,
    symbol_to_community: &HashMap<String, u32>,
    edge_rows: Vec<(String, String, Option<String>)>,
) -> Vec<CommunityCoupling> {
    let mut couplings: HashMap<(u32, u32), (u32, Vec<CommunityCouplingRelationship>)> =
        HashMap::new();
    let mut seen_directed_edges: HashSet<(String, String)> = HashSet::new();

    for (from_id, _target_name, to_symbol_id) in edge_rows {
        // Coupling diagnostics intentionally use only persisted resolved edges.
        // Name inference is useful for community detection, but including it here
        // would report relationships that the call graph has not actually resolved.
        if let Some(to_id) = to_symbol_id.filter(|id| symbol_map.contains_key(id)) {
            if from_id == to_id {
                continue;
            }

            let Some(from_community) = symbol_to_community.get(&from_id) else {
                continue;
            };
            let Some(to_community) = symbol_to_community.get(&to_id) else {
                continue;
            };
            if from_community == to_community {
                continue;
            }

            let directed = (from_id.clone(), to_id.clone());
            if !seen_directed_edges.insert(directed) {
                continue;
            }

            let (community_a, community_b) = if from_community <= to_community {
                (*from_community, *to_community)
            } else {
                (*to_community, *from_community)
            };

            let from_symbol = symbol_map
                .get(&from_id)
                .expect("from symbol id should exist");
            let to_symbol = symbol_map.get(&to_id).expect("to symbol id should exist");

            let coupling = couplings
                .entry((community_a, community_b))
                .or_insert((0_u32, Vec::new()));
            coupling.0 += 1;
            coupling.1.push(CommunityCouplingRelationship {
                from_symbol_id: from_symbol.id.clone(),
                from_symbol_name: from_symbol.name.clone(),
                from_file_path: from_symbol.file_path.clone(),
                to_symbol_id: to_symbol.id.clone(),
                to_symbol_name: to_symbol.name.clone(),
                to_file_path: to_symbol.file_path.clone(),
            });
        }
    }

    let mut results: Vec<CommunityCoupling> = couplings
        .into_iter()
        .map(
            |((community_a, community_b), (count, mut representative_relationships))| {
                representative_relationships.sort_by(|left, right| {
                    left.from_symbol_name
                        .cmp(&right.from_symbol_name)
                        .then_with(|| left.from_symbol_id.cmp(&right.from_symbol_id))
                        .then_with(|| left.to_symbol_name.cmp(&right.to_symbol_name))
                        .then_with(|| left.to_symbol_id.cmp(&right.to_symbol_id))
                        .then_with(|| left.from_file_path.cmp(&right.from_file_path))
                        .then_with(|| left.to_file_path.cmp(&right.to_file_path))
                });

                if representative_relationships.len() > 5 {
                    representative_relationships.truncate(5);
                }

                CommunityCoupling {
                    community_a,
                    community_b,
                    count,
                    representative_relationships,
                }
            },
        )
        .collect();

    results.sort_by(|left, right| {
        left.community_a
            .cmp(&right.community_a)
            .then_with(|| left.community_b.cmp(&right.community_b))
            .then_with(|| right.count.cmp(&left.count))
    });

    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CallEdgeRow;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    fn setup_test_db() -> (TempDir, Connection) {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let conn = db::init_db(&db_path).unwrap();
        (temp_dir, conn)
    }

    fn make_symbol(id: &str, name: &str, file_path: &str) -> SymbolRow {
        SymbolRow {
            id: id.to_string(),
            file_path: file_path.to_string(),
            name: name.to_string(),
            kind: "function".to_string(),
            start_line: 1,
            start_col: 0,
            end_line: 10,
            end_col: 1,
            language: "typescript".to_string(),
        }
    }

    fn make_edge(id: &str, from: &str, target_name: &str, to: Option<&str>) -> CallEdgeRow {
        CallEdgeRow {
            id: id.to_string(),
            from_symbol_id: from.to_string(),
            target_name: target_name.to_string(),
            to_symbol_id: to.map(|s| s.to_string()),
            call_type: "Call".to_string(),
            confidence: "Direct".to_string(),
            line: 1,
            col: 0,
            is_resolved: to.is_some(),
        }
    }

    fn aggregate_test_couplings(
        symbols: &[SymbolRow],
        assignments: &[(&str, u32)],
        edges: &[CallEdgeRow],
    ) -> Vec<CommunityCoupling> {
        let symbol_map = symbols
            .iter()
            .map(|symbol| (symbol.id.clone(), symbol.clone()))
            .collect();
        let symbol_to_community = assignments
            .iter()
            .map(|(symbol_id, community_id)| ((*symbol_id).to_string(), *community_id))
            .collect();
        let edge_rows = edges
            .iter()
            .map(|edge| {
                (
                    edge.from_symbol_id.clone(),
                    edge.target_name.clone(),
                    edge.to_symbol_id.clone(),
                )
            })
            .collect();

        aggregate_community_couplings(&symbol_map, &symbol_to_community, edge_rows)
    }

    #[test]
    fn test_reachability_callees_chain() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![
            make_symbol("s_a", "A", "src/a.ts"),
            make_symbol("s_b", "B", "src/b.ts"),
            make_symbol("s_c", "C", "src/c.ts"),
        ];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(
            &conn,
            "main",
            &["s_a".to_string(), "s_b".to_string(), "s_c".to_string()],
        )
        .unwrap();

        let edges = vec![
            make_edge("e1", "s_a", "B", Some("s_b")),
            make_edge("e2", "s_b", "C", Some("s_c")),
        ];
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let results =
            get_transitive_reachability(&conn, &["s_a".to_string()], "main", "callees", 5).unwrap();
        let map: HashMap<String, u32> = results
            .iter()
            .map(|r| (r.symbol_id.clone(), r.depth))
            .collect();
        assert_eq!(map.get("s_b"), Some(&1));
        assert_eq!(map.get("s_c"), Some(&2));
        assert!(!map.contains_key("s_a")); // root excluded
    }

    #[test]
    fn test_reachability_callers_chain() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![
            make_symbol("s_a", "A", "src/a.ts"),
            make_symbol("s_b", "B", "src/b.ts"),
            make_symbol("s_c", "C", "src/c.ts"),
        ];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(
            &conn,
            "main",
            &["s_a".to_string(), "s_b".to_string(), "s_c".to_string()],
        )
        .unwrap();

        let edges = vec![
            make_edge("e1", "s_a", "B", Some("s_b")),
            make_edge("e2", "s_b", "C", Some("s_c")),
        ];
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let results =
            get_transitive_reachability(&conn, &["s_c".to_string()], "main", "callers", 5).unwrap();
        let map: HashMap<String, u32> = results
            .iter()
            .map(|r| (r.symbol_id.clone(), r.depth))
            .collect();
        assert_eq!(map.get("s_b"), Some(&1));
        assert_eq!(map.get("s_a"), Some(&2));
        assert!(!map.contains_key("s_c")); // root excluded
    }

    #[test]
    fn test_reachability_depth_cap() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![
            make_symbol("s_a", "A", "src/a.ts"),
            make_symbol("s_b", "B", "src/b.ts"),
            make_symbol("s_c", "C", "src/c.ts"),
            make_symbol("s_d", "D", "src/d.ts"),
        ];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(
            &conn,
            "main",
            &[
                "s_a".to_string(),
                "s_b".to_string(),
                "s_c".to_string(),
                "s_d".to_string(),
            ],
        )
        .unwrap();

        let edges = vec![
            make_edge("e1", "s_a", "B", Some("s_b")),
            make_edge("e2", "s_b", "C", Some("s_c")),
            make_edge("e3", "s_c", "D", Some("s_d")),
        ];
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let results =
            get_transitive_reachability(&conn, &["s_a".to_string()], "main", "callees", 2).unwrap();
        let map: HashMap<String, u32> = results
            .iter()
            .map(|r| (r.symbol_id.clone(), r.depth))
            .collect();
        assert_eq!(map.get("s_b"), Some(&1));
        assert_eq!(map.get("s_c"), Some(&2));
        assert!(!map.contains_key("s_d")); // depth 3 capped
    }

    #[test]
    fn test_reachability_unresolved_edge() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![
            make_symbol("s_a", "A", "src/a.ts"),
            make_symbol("s_b", "B", "src/b.ts"),
        ];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(&conn, "main", &["s_a".to_string(), "s_b".to_string()]).unwrap();

        let edges = vec![
            make_edge("e1", "s_a", "B", None), // unresolved
        ];
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let results =
            get_transitive_reachability(&conn, &["s_a".to_string()], "main", "callees", 5).unwrap();
        let map: HashMap<String, u32> = results
            .iter()
            .map(|r| (r.symbol_id.clone(), r.depth))
            .collect();
        assert_eq!(map.get("s_b"), Some(&1));
    }

    #[test]
    fn test_reachability_multiple_roots() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![
            make_symbol("s_a", "A", "src/a.ts"),
            make_symbol("s_b", "B", "src/b.ts"),
            make_symbol("s_c", "C", "src/c.ts"),
        ];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(
            &conn,
            "main",
            &["s_a".to_string(), "s_b".to_string(), "s_c".to_string()],
        )
        .unwrap();

        let edges = vec![
            make_edge("e1", "s_a", "C", Some("s_c")),
            make_edge("e2", "s_b", "C", Some("s_c")),
        ];
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let results = get_transitive_reachability(
            &conn,
            &["s_a".to_string(), "s_b".to_string()],
            "main",
            "callees",
            5,
        )
        .unwrap();
        let map: HashMap<String, u32> = results
            .iter()
            .map(|r| (r.symbol_id.clone(), r.depth))
            .collect();
        assert_eq!(map.get("s_c"), Some(&1));
    }

    #[test]
    fn test_reachability_both_directions() {
        // Graph: A -> B -> C (callees chain), also D -> A and E -> C (callers)
        // Root: A
        // callers: D (depth 1)
        // callees: B (depth 1), C (depth 2)
        // both: D (depth 1), B (depth 1), C (depth 2)
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![
            make_symbol("s_a", "A", "src/a.ts"),
            make_symbol("s_b", "B", "src/b.ts"),
            make_symbol("s_c", "C", "src/c.ts"),
            make_symbol("s_d", "D", "src/d.ts"),
            make_symbol("s_e", "E", "src/e.ts"),
        ];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(
            &conn,
            "main",
            &[
                "s_a".to_string(),
                "s_b".to_string(),
                "s_c".to_string(),
                "s_d".to_string(),
                "s_e".to_string(),
            ],
        )
        .unwrap();

        let edges = vec![
            make_edge("e1", "s_a", "B", Some("s_b")), // A calls B
            make_edge("e2", "s_b", "C", Some("s_c")), // B calls C (transitive callee of A)
            make_edge("e3", "s_d", "A", Some("s_a")), // D calls A (caller of A)
            make_edge("e4", "s_e", "C", Some("s_c")), // E calls C (caller of C, but not A directly)
        ];
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        // callers: should find D at depth 1, E at depth 1 (via A->B->C, E calls C)
        let callers =
            get_transitive_reachability(&conn, &["s_a".to_string()], "main", "callers", 5).unwrap();
        let callers_map: HashMap<String, u32> = callers
            .iter()
            .map(|r| (r.symbol_id.clone(), r.depth))
            .collect();
        assert!(callers_map.contains_key("s_d")); // D calls A directly
                                                  // E calls C which is a callee of A, not a caller of A — E should NOT appear as caller of A

        // callees: should find B at depth 1, C at depth 2
        let callees =
            get_transitive_reachability(&conn, &["s_a".to_string()], "main", "callees", 5).unwrap();
        let callees_map: HashMap<String, u32> = callees
            .iter()
            .map(|r| (r.symbol_id.clone(), r.depth))
            .collect();
        assert_eq!(callees_map.get("s_b"), Some(&1));
        assert_eq!(callees_map.get("s_c"), Some(&2));
        assert!(!callees_map.contains_key("s_d")); // D is a caller, not callee

        // both: should contain union of callers and callees
        let both =
            get_transitive_reachability(&conn, &["s_a".to_string()], "main", "both", 5).unwrap();
        let both_map: HashMap<String, u32> = both
            .iter()
            .map(|r| (r.symbol_id.clone(), r.depth))
            .collect();
        assert!(both_map.contains_key("s_b")); // callee
        assert!(both_map.contains_key("s_c")); // transitive callee
        assert!(both_map.contains_key("s_d")); // caller
                                               // Min depth for B should be 1 (reached via callees)
        assert_eq!(both_map.get("s_b"), Some(&1));
    }

    #[test]
    fn test_communities_disconnected() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![
            make_symbol("s_a", "A", "src/a.ts"),
            make_symbol("s_b", "B", "src/b.ts"),
            make_symbol("s_c", "C", "src/c.ts"),
            make_symbol("s_d", "D", "src/d.ts"),
        ];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(
            &conn,
            "main",
            &[
                "s_a".to_string(),
                "s_b".to_string(),
                "s_c".to_string(),
                "s_d".to_string(),
            ],
        )
        .unwrap();

        let edges = vec![
            make_edge("e1", "s_a", "B", Some("s_b")),
            make_edge("e2", "s_c", "D", Some("s_d")),
        ];
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let results = detect_communities(&conn, "main", None).unwrap();
        assert_eq!(results.len(), 4);

        let communities: HashSet<u32> = results.iter().map(|r| r.community_id).collect();
        assert_eq!(communities.len(), 2);

        // Each pair should share a community
        let a_comm = results
            .iter()
            .find(|r| r.symbol_id == "s_a")
            .unwrap()
            .community_id;
        let b_comm = results
            .iter()
            .find(|r| r.symbol_id == "s_b")
            .unwrap()
            .community_id;
        assert_eq!(a_comm, b_comm);
        assert!(results
            .iter()
            .filter(|result| matches!(result.symbol_id.as_str(), "s_a" | "s_b"))
            .all(|result| result.community_label == "A"));

        let c_comm = results
            .iter()
            .find(|r| r.symbol_id == "s_c")
            .unwrap()
            .community_id;
        let d_comm = results
            .iter()
            .find(|r| r.symbol_id == "s_d")
            .unwrap()
            .community_id;
        assert_eq!(c_comm, d_comm);
        assert_ne!(a_comm, c_comm);
        assert!(results
            .iter()
            .filter(|result| matches!(result.symbol_id.as_str(), "s_c" | "s_d"))
            .all(|result| result.community_label == "C"));
    }

    #[test]
    fn test_communities_triangle() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![
            make_symbol("s_a", "A", "src/a.ts"),
            make_symbol("s_b", "B", "src/b.ts"),
            make_symbol("s_c", "C", "src/c.ts"),
        ];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(
            &conn,
            "main",
            &["s_a".to_string(), "s_b".to_string(), "s_c".to_string()],
        )
        .unwrap();

        let edges = vec![
            make_edge("e1", "s_a", "B", Some("s_b")),
            make_edge("e2", "s_b", "C", Some("s_c")),
            make_edge("e3", "s_c", "A", Some("s_a")),
        ];
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let results = detect_communities(&conn, "main", None).unwrap();
        let communities: HashSet<u32> = results.iter().map(|r| r.community_id).collect();
        assert_eq!(communities.len(), 1);
    }

    #[test]
    fn test_communities_single_node() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![make_symbol("s_a", "A", "src/a.ts")];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(&conn, "main", &["s_a".to_string()]).unwrap();

        let results = detect_communities(&conn, "main", None).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].symbol_id, "s_a");
        assert_eq!(results[0].community_label, "A");
    }

    #[test]
    fn test_communities_filtered_component() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![
            make_symbol("s_a", "A", "src/a.ts"),
            make_symbol("s_b", "B", "src/b.ts"),
            make_symbol("s_c", "C", "src/c.ts"),
            make_symbol("s_d", "D", "src/d.ts"),
        ];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(
            &conn,
            "main",
            &[
                "s_a".to_string(),
                "s_b".to_string(),
                "s_c".to_string(),
                "s_d".to_string(),
            ],
        )
        .unwrap();

        let edges = vec![
            make_edge("e1", "s_a", "B", Some("s_b")),
            make_edge("e2", "s_c", "D", Some("s_d")),
        ];
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let results =
            detect_communities(&conn, "main", Some(&["s_a".to_string(), "s_b".to_string()]))
                .unwrap();
        assert_eq!(results.len(), 2);
        let comm_a = results
            .iter()
            .find(|r| r.symbol_id == "s_a")
            .unwrap()
            .community_id;
        let comm_b = results
            .iter()
            .find(|r| r.symbol_id == "s_b")
            .unwrap()
            .community_id;
        assert_eq!(comm_a, comm_b);
    }

    #[test]
    fn test_communities_count_distinct_cross_community_neighbors() {
        let (_temp, mut conn) = setup_test_db();
        let mut symbols = Vec::new();
        for group in ["a", "b"] {
            for index in 0..5 {
                let id = format!("s_{group}_{index}");
                symbols.push(make_symbol(&id, &id, &format!("src/{group}/{index}.ts")));
            }
            let bridge_id = format!("s_{group}_bridge");
            symbols.push(make_symbol(
                &bridge_id,
                &bridge_id,
                &format!("src/{group}/bridge.ts"),
            ));
        }
        db::upsert_symbols_batch(&mut conn, &symbols).unwrap();
        db::add_symbols_to_branch(
            &conn,
            "main",
            &symbols
                .iter()
                .map(|symbol| symbol.id.clone())
                .collect::<Vec<_>>(),
        )
        .unwrap();

        let mut edges = Vec::new();
        for group in ["a", "b"] {
            for left in 0..5 {
                for right in (left + 1)..5 {
                    let from = format!("s_{group}_{left}");
                    let to = format!("s_{group}_{right}");
                    edges.push(make_edge(
                        &format!("e_{group}_{left}_{right}"),
                        &from,
                        &to,
                        Some(&to),
                    ));
                }
            }
            edges.push(make_edge(
                &format!("e_{group}_bridge"),
                &format!("s_{group}_0"),
                &format!("s_{group}_bridge"),
                Some(&format!("s_{group}_bridge")),
            ));
        }
        edges.push(make_edge(
            "bridge",
            "s_a_bridge",
            "s_b_bridge",
            Some("s_b_bridge"),
        ));
        edges.push(make_edge(
            "bridge_duplicate",
            "s_a_bridge",
            "s_b_bridge",
            Some("s_b_bridge"),
        ));
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let results = detect_communities(&conn, "main", None).unwrap();
        let community_count = results
            .iter()
            .map(|result| result.community_id)
            .collect::<HashSet<_>>()
            .len();
        assert_eq!(community_count, 2);
        let communities_by_symbol = results
            .iter()
            .map(|result| (result.symbol_id.as_str(), result.community_id))
            .collect::<HashMap<_, _>>();
        let mut expected_neighbors: HashMap<&str, HashSet<&str>> = HashMap::new();
        for edge in &edges {
            let Some(to_symbol_id) = edge.to_symbol_id.as_deref() else {
                continue;
            };
            if communities_by_symbol.get(edge.from_symbol_id.as_str())
                != communities_by_symbol.get(to_symbol_id)
            {
                expected_neighbors
                    .entry(edge.from_symbol_id.as_str())
                    .or_default()
                    .insert(to_symbol_id);
                expected_neighbors
                    .entry(to_symbol_id)
                    .or_default()
                    .insert(edge.from_symbol_id.as_str());
            }
        }
        assert!(!expected_neighbors.is_empty());
        for result in &results {
            assert_eq!(
                result.cross_community_connections,
                expected_neighbors
                    .get(result.symbol_id.as_str())
                    .map(|neighbors| neighbors.len() as u32)
                    .unwrap_or(0),
                "unexpected cross-community count for {}",
                result.symbol_id
            );
        }
    }

    #[test]
    fn test_community_couplings_deduplicates_directed_pairs() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![
            make_symbol("s_a", "A", "src/a.ts"),
            make_symbol("s_b", "B", "src/b.ts"),
            make_symbol("s_c", "C", "src/c.ts"),
            make_symbol("s_d", "D", "src/d.ts"),
        ];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(
            &conn,
            "main",
            &[
                "s_a".to_string(),
                "s_b".to_string(),
                "s_c".to_string(),
                "s_d".to_string(),
            ],
        )
        .unwrap();

        let edges = vec![
            make_edge("e_a_b", "s_a", "B", Some("s_b")),
            make_edge("e_c_d", "s_c", "D", Some("s_d")),
            make_edge("e_cross_1", "s_a", "C", Some("s_c")),
            make_edge("e_cross_2", "s_a", "C", Some("s_c")),
        ];
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let results = aggregate_test_couplings(
            &syms,
            &[("s_a", 0), ("s_b", 0), ("s_c", 1), ("s_d", 1)],
            &edges,
        );
        assert_eq!(results.len(), 1);
        assert!(results[0].community_a < results[0].community_b);
        assert_eq!(results[0].count, 1);
        assert_eq!(results[0].representative_relationships.len(), 1);
        assert_eq!(
            results[0].representative_relationships[0].from_symbol_id,
            "s_a".to_string()
        );
        assert_eq!(
            results[0].representative_relationships[0].to_symbol_id,
            "s_c".to_string()
        );
    }

    #[test]
    fn test_community_couplings_normalizes_reverse_directions() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![
            make_symbol("s_a", "A", "src/a.ts"),
            make_symbol("s_b", "B", "src/b.ts"),
        ];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(&conn, "main", &["s_a".to_string(), "s_b".to_string()]).unwrap();

        let edges = vec![
            make_edge("e_ab", "s_a", "B", Some("s_b")),
            make_edge("e_ba", "s_b", "A", Some("s_a")),
        ];
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let results = aggregate_test_couplings(&syms, &[("s_a", 0), ("s_b", 1)], &edges);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].count, 2);
        let relations = &results[0].representative_relationships;
        assert_eq!(relations.len(), 2);
        assert_eq!(relations[0].from_symbol_id, "s_a");
        assert_eq!(relations[0].to_symbol_id, "s_b");
        assert_eq!(relations[1].from_symbol_id, "s_b");
        assert_eq!(relations[1].to_symbol_id, "s_a");
    }

    #[test]
    fn test_community_couplings_ignores_unresolved_self_and_intra_community_edges() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![
            make_symbol("s_a", "A", "src/a.ts"),
            make_symbol("s_b", "B", "src/b.ts"),
            make_symbol("s_c", "C", "src/c.ts"),
        ];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(
            &conn,
            "main",
            &["s_a".to_string(), "s_b".to_string(), "s_c".to_string()],
        )
        .unwrap();

        let edges = vec![
            make_edge("e_a_b", "s_a", "B", Some("s_b")),
            make_edge("e_self", "s_a", "A", Some("s_a")),
            make_edge("e_unresolved", "s_a", "C", None),
            make_edge("e_cross", "s_a", "C", Some("s_c")),
        ];
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let results =
            aggregate_test_couplings(&syms, &[("s_a", 0), ("s_b", 0), ("s_c", 1)], &edges);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].count, 1);
        let relation = &results[0].representative_relationships[0];
        assert_eq!(relation.from_symbol_id, "s_a");
        assert_eq!(relation.to_symbol_id, "s_c");
    }

    #[test]
    fn test_community_couplings_representatives_are_deterministic() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![
            make_symbol("s_a0", "A0", "src/a0.ts"),
            make_symbol("s_a1", "A1", "src/a1.ts"),
            make_symbol("s_b0", "B0", "src/b0.ts"),
            make_symbol("s_b1", "B1", "src/b1.ts"),
            make_symbol("s_b2", "B2", "src/b2.ts"),
        ];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(
            &conn,
            "main",
            &syms
                .iter()
                .map(|symbol| symbol.id.clone())
                .collect::<Vec<_>>(),
        )
        .unwrap();

        let edges = vec![
            make_edge("intra_a", "s_a0", "A1", Some("s_a1")),
            make_edge("intra_b", "s_b0", "B1", Some("s_b1")),
            make_edge("intra_b_2", "s_b1", "B2", Some("s_b2")),
            make_edge("a0_b0", "s_a0", "B0", Some("s_b0")),
            make_edge("a0_b1", "s_a0", "B1", Some("s_b1")),
            make_edge("a0_b2", "s_a0", "B2", Some("s_b2")),
            make_edge("a1_b0", "s_a1", "B0", Some("s_b0")),
            make_edge("a1_b1", "s_a1", "B1", Some("s_b1")),
            make_edge("a1_b2", "s_a1", "B2", Some("s_b2")),
        ];
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let results = aggregate_test_couplings(
            &syms,
            &[
                ("s_a0", 0),
                ("s_a1", 0),
                ("s_b0", 1),
                ("s_b1", 1),
                ("s_b2", 1),
            ],
            &edges,
        );
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].count, 6);
        assert_eq!(results[0].representative_relationships.len(), 5);

        let relation_names: Vec<(String, String)> = results[0]
            .representative_relationships
            .iter()
            .map(|relation| {
                (
                    relation.from_symbol_name.clone(),
                    relation.to_symbol_name.clone(),
                )
            })
            .collect();

        assert_eq!(
            relation_names,
            vec![
                ("A0".to_string(), "B0".to_string()),
                ("A0".to_string(), "B1".to_string()),
                ("A0".to_string(), "B2".to_string()),
                ("A1".to_string(), "B0".to_string()),
                ("A1".to_string(), "B1".to_string()),
            ]
        );
    }

    #[test]
    fn test_communities_10k_nodes_stay_within_performance_budget() {
        const NODE_COUNT: usize = 10_000;
        const COMMUNITY_SIZE: usize = 100;
        const SAMPLE_COUNT: usize = 5;

        let (_temp, mut conn) = setup_test_db();
        let symbols = (0..NODE_COUNT)
            .map(|index| {
                make_symbol(
                    &format!("s_{index}"),
                    &format!("symbol_{index}"),
                    &format!("src/{}/{}.ts", index / COMMUNITY_SIZE, index),
                )
            })
            .collect::<Vec<_>>();
        db::upsert_symbols_batch(&mut conn, &symbols).unwrap();
        db::add_symbols_to_branch(
            &conn,
            "main",
            &symbols
                .iter()
                .map(|symbol| symbol.id.clone())
                .collect::<Vec<_>>(),
        )
        .unwrap();

        let edges = (0..NODE_COUNT)
            .filter(|index| index % COMMUNITY_SIZE != COMMUNITY_SIZE - 1)
            .map(|index| {
                make_edge(
                    &format!("e_{index}"),
                    &format!("s_{index}"),
                    &format!("symbol_{}", index + 1),
                    Some(&format!("s_{}", index + 1)),
                )
            })
            .collect::<Vec<_>>();
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let cold_started = Instant::now();
        let cold_communities = detect_communities(&conn, "main", None).unwrap();
        let cold_couplings = detect_community_couplings(&conn, "main").unwrap();
        let cold_elapsed = cold_started.elapsed();

        assert_eq!(cold_communities.len(), NODE_COUNT);
        assert_eq!(cold_couplings.len(), 0);

        let mut sample_durations = Vec::with_capacity(SAMPLE_COUNT);
        for _ in 0..SAMPLE_COUNT {
            let started = Instant::now();
            let communities = detect_communities(&conn, "main", None).unwrap();
            let couplings = detect_community_couplings(&conn, "main").unwrap();
            sample_durations.push((started.elapsed(), communities, couplings));
        }

        let elapsed_samples = sample_durations
            .iter()
            .map(|(duration, _, _)| *duration)
            .collect::<Vec<_>>();
        let mut sorted_elapsed = elapsed_samples.clone();
        sorted_elapsed.sort();
        let median_elapsed = sorted_elapsed[sorted_elapsed.len() / 2];
        let max_elapsed = elapsed_samples.iter().copied().max().unwrap_or_default();
        let (_, communities, couplings) = sample_durations
            .first()
            .expect("Expected timing samples for 10k-node communities test.");

        assert_eq!(communities.len(), NODE_COUNT);
        assert_eq!(couplings.len(), 0);
        assert!(
            median_elapsed < Duration::from_secs(1),
            "10k-node detection and coupling median was {median_elapsed:?}"
        );
        assert!(
            cold_elapsed < Duration::from_secs(2) && max_elapsed < Duration::from_secs(2),
            "10k-node detection and coupling exceeded the outlier budget: cold={cold_elapsed:?}, max warm={max_elapsed:?}"
        );
    }

    #[test]
    fn test_centrality_star_graph() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![
            make_symbol("s_center", "Center", "src/center.ts"),
            make_symbol("s_l1", "Leaf1", "src/leaf1.ts"),
            make_symbol("s_l2", "Leaf2", "src/leaf2.ts"),
            make_symbol("s_l3", "Leaf3", "src/leaf3.ts"),
        ];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(
            &conn,
            "main",
            &[
                "s_center".to_string(),
                "s_l1".to_string(),
                "s_l2".to_string(),
                "s_l3".to_string(),
            ],
        )
        .unwrap();

        let edges = vec![
            make_edge("e1", "s_center", "Leaf1", Some("s_l1")),
            make_edge("e2", "s_center", "Leaf2", Some("s_l2")),
            make_edge("e3", "s_center", "Leaf3", Some("s_l3")),
            make_edge("e4", "s_l1", "Center", Some("s_center")),
            make_edge("e5", "s_l2", "Center", Some("s_center")),
            make_edge("e6", "s_l3", "Center", Some("s_center")),
        ];
        db::upsert_call_edges_batch(&mut conn, &edges).unwrap();

        let results = compute_centrality(&conn, "main").unwrap();
        let center = results.iter().find(|r| r.symbol_id == "s_center").unwrap();
        assert_eq!(center.caller_count, 3);
        assert_eq!(center.callee_count, 3);
        assert_eq!(center.total_connections, 6);

        let leaf = results.iter().find(|r| r.symbol_id == "s_l1").unwrap();
        assert_eq!(leaf.caller_count, 1);
        assert_eq!(leaf.callee_count, 1);
        assert_eq!(leaf.total_connections, 2);

        // Center should be first (sorted by caller_count desc)
        assert_eq!(results[0].symbol_id, "s_center");
    }

    #[test]
    fn test_centrality_isolated_node() {
        let (_temp, mut conn) = setup_test_db();
        let syms = vec![make_symbol("s_a", "A", "src/a.ts")];
        db::upsert_symbols_batch(&mut conn, &syms).unwrap();
        db::add_symbols_to_branch(&conn, "main", &["s_a".to_string()]).unwrap();

        let results = compute_centrality(&conn, "main").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].caller_count, 0);
        assert_eq!(results[0].callee_count, 0);
        assert_eq!(results[0].total_connections, 0);
    }
}
