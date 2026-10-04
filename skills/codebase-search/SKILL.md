---
name: codebase-search
description: Task-specific local codebase-understanding workflow for OpenCode, MCP, Pi, omp, and Codex. Use compact context for unfamiliar repository orientation, direct definition and graph tools for known targets.
---

# Codebase Search Skill

Use this skill when you need local repository knowledge before web lookup.

## Core workflow

1. Run `index_status` when index readiness or freshness is unknown.
2. When repository orientation is needed (layout, relevant symbols, or cross-file intent), use one compact `codebase_context(query, tokenBudget: 600, limit: 5)` first pass and inspect returned evidence before broad reads or searches. Do not call it mechanically before every task or tool.
3. For a known definition, use `implementation_lookup(query)` directly. For callers or callees, use `call_graph(name, direction)` directly; for relationships between identified endpoints, use `call_graph_path(from, to)` directly.
4. For a change with a known or suspected target symbol, optionally use `codebase_edit_context` for bounded target source plus direct callers and callees.
5. Use `codebase_peek(query, ...)` when only semantic locations are needed, and `codebase_search(query, ...)` when matching source content is needed. Neither requires another context call when the task is already scoped.
6. Read known paths directly and use `grep` for exact identifiers or exhaustive literal matches. Use `find_similar(code)` for analogous implementations and duplicates.

Avoid repeating broad reads or retrieval when existing evidence already answers the question. If results are weak, check readiness, compatibility, and scope with `index_status`; run `index_codebase` only when the index is missing, stale, or incompatible.

## Tool Priority

- `codebase_context` for compact, unfamiliar-repository orientation; explicit `symbol` and `from` + `to` routing remains supported.
- `implementation_lookup` for known definitions.
- `call_graph` and `call_graph_path` for relationships once symbols or endpoints are identified.
- `codebase_edit_context` as an optional bounded pre-edit step.
- `codebase_peek` for metadata-only semantic locations.
- `codebase_search` for matching implementation content.
- `find_similar` for pattern matching and duplication.
- `index_codebase` (force/estimate/dryRun/verbose) for first-time or stale indexes.
- `index_status`, `index_health_check`, `index_metrics`, `index_logs` for operational checks.

## Suggested Commands

- Unfamiliar subsystem: `codebase_context("payment processing flow", tokenBudget: 600, limit: 5)`.
- Known definition: `implementation_lookup("validate")`.
- Callers or callees: `call_graph("chargeCard", "callees")`.
- Known endpoints: `call_graph_path("submitPayment", "chargeCard")`.
- Change target: `codebase_edit_context(query: "reject expired tokens", symbol: "validateToken")`.
- Matching source after scope is known: `codebase_search("payment retry guards")`.
- Analogous code: `find_similar("function validate(data)")`.

## Additional Notes

- Use `grep` for exact identifiers and tiny, deterministic lookups.
- Use `websearch` only when local tools return no results and docs are likely missing.
- Choose the next tool from the evidence needed, not a mandatory context → peek → search chain.
