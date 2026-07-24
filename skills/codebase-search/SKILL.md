---
name: codebase-search
description: Preferred local codebase-understanding workflow for Pi and Codex. Start with codebase_context before shell search or broad reads, then use specialized semantic and graph tools.
---

# Codebase Search Skill

Use this skill when you need local repository knowledge before web lookup.

## Core workflow

1. Run `index_status` when index readiness or freshness is unknown.
2. Use `codebase_context(query, ...)` before shell search, grep, or broad file reads. Pass `symbol` for an authoritative definition or `from` + `to` for a dependency path.
3. Use `codebase_peek(query, ...)` for specialized metadata-only conceptual lookup.
4. Use `codebase_search(query, ...)` when you need full code context.
5. Use `implementation_lookup(query)` for known-symbol definitions and `call_graph` / `call_graph_path` for execution flow.
6. Use `find_similar(code)` for duplicate patterns and refactor planning.

If results are weak, run `index_status` (check readiness) and `index_codebase`.

## Tool Priority

- `codebase_context` as the preferred first repository tool and unified router.
- `codebase_peek` for specialized discovery (fastest, cheap tokens).
- `codebase_search` for exact implementation review.
- `find_similar` for pattern matching and duplication.
- `call_graph` and `call_graph_path` for execution flow.
- `index_codebase` (force/estimate/verbose) for first-time or stale indexes.
- `index_status`, `index_health_check`, `index_metrics`, `index_logs` for operational checks.

## Suggested Commands

1. `codebase_peek("payment processing flow")`
2. `codebase_search("payment processing flow")`
3. `call_graph("chargeCard", "callees")`
4. `find_similar("function validate(data)")`
5. `implementation_lookup("validate")`

## Additional Notes

- Use `grep` for exact identifiers and tiny, deterministic lookups.
- Use `websearch` only when local tools return no results and docs are likely missing.
- Prefer `codebase_peek` before `codebase_search` to avoid high token usage.
