---
name: codebase-search
description: Task-specific semantic code and documentation retrieval. Use compact context for unfamiliar repository orientation, direct lookup for known definitions, graph tools for relationships, and grep for exhaustive literal matches.
---

# Codebase Search Skill

## Important: Indexed Content

The indexed codebase contains **two types of content**:

1. **Project Source Code** — all code files in the current workspace
2. **Knowledge Base Documentation** — external documentation, usage guides, API references, and example programs added via `add_knowledge_base` (MCP/OpenCode) or `knowledge_base_add` (Pi).

## When to Use What

| Scenario | Tool | Why |
|----------|------|-----|
| Unfamiliar repository layout or subsystem | `codebase_context` | Compact orientation before broad reads |
| Code/library/API question | `codebase_search` | Search local knowledge first |
| Just need file locations | `codebase_peek` | Metadata only, saves ~90% tokens |
| Need to see actual code | `codebase_search` | Returns full code content |
| Find duplicates/patterns | `find_similar` | Given code snippet → similar code |
| Understand code flow | `call_graph` | Find callers/callees of any function |
| Trace dependency paths | `call_graph_path` | Find a shortest known path between two symbols |
| Analyze PR blast radius | `pr_impact` | Find affected symbols, communities, hub nodes, and risk |
| Don't know function/class names | `codebase_context` | Natural-language orientation with bounded evidence |
| Know a symbol and need its definition | `implementation_lookup` | Authoritative source without a context prerequisite |
| Need ALL occurrences | `grep` | Semantic returns top N only |
| Access specific URL | `webfetch` | Direct URL access, no codebase search needed |
| Local search fails | `websearch` | Fallback when codebase has no results |
| Local and web search fails | suggest adding knowledge base | Notify user to add related folder |

## Task-specific Workflow

1. Check `index_status` when readiness or freshness is unknown. Index only when missing, stale, or incompatible.
2. For unfamiliar repository orientation, use one compact `codebase_context` first pass (`tokenBudget: 600`, `limit: 5`) and inspect its evidence before broad reads or searches.
3. For known definitions, use `implementation_lookup` directly. For callers/callees or dependency paths, use `call_graph` or `call_graph_path` directly once endpoints are identified.
4. For known or suspected edit targets, optionally use `codebase_edit_context` for bounded source plus direct graph evidence.
5. Use `codebase_peek` for semantic locations or `codebase_search` for matching content when needed. Neither requires another context call when scope is already known.
6. Read known paths directly; use `grep` for exact identifiers and exhaustive literal matches. Apply directory/file filters when the scope is known, rather than guessing a narrower scope.

For repository implementation questions, use local source evidence before web search. External library/API documentation questions may need web sources when the local index lacks relevant documentation. Avoid repeating retrieval when existing evidence already answers the task.

## Tools

### `codebase_peek`
Find WHERE code is. Returns metadata only (file, line, name, type).

```
codebase_peek(query="validation logic", chunkType="function", directory="src/utils")
codebase_peek(query="authentication flow", blameAuthor="jane@example.com")
```

### `codebase_search`
Find code with full content. Use when you need to see implementation.

```
codebase_search(query="error handling middleware", fileType="ts", contextLines=2)
codebase_search(query="rate limiter", blameSince="2025-01-01", blameUntil="2025-01-31")
```

### `find_similar`
Find code similar to a given snippet. Use for duplicate detection, pattern discovery, refactoring.

```
find_similar(code="function validate(input) { return input.length > 0; }", excludeFile="src/current.ts", blameSince="2025-01-01")
```

### `call_graph`
Query callers or callees of a function/method.

```
call_graph(name="validateToken", direction="callers")
```

### `index_codebase`
Manually trigger indexing. Required before first search.

### `index_status`
Check if indexed and ready.

### MCP/OpenCode knowledge-base tools

- `add_knowledge_base(path="/path/to/docs")`
- `list_knowledge_bases`
- `remove_knowledge_base(path="/path/to/docs")`

### Pi knowledge-base tools

- `knowledge_base_add(path="/path/to/docs")`
- `knowledge_base_list`
- `knowledge_base_remove(path="/path/to/docs")`

## Query Tips

**Describe behavior, not syntax:**
- Good: `"function that hashes passwords securely"`
- Bad: `"hashPassword"` (use grep for exact names)

**Search across documentation:**
- Good: `"how to configure WiFi in ESP-IDF"`
- Good: `"GPIO initialization example"`

## Filters

| Filter | Example |
|--------|---------|
| `chunkType` | `function`, `class`, `interface`, `type`, `method` |
| `directory` | `"src/api"`, `"tests"` |
| `fileType` | `"ts"`, `"py"`, `"rs"` |
| `blameAuthor` | `"jane@example.com"` or `"Jane Doe"` |
| `blameSha` | `"abc1234"` |
| `blameSince` | `"2025-01-01"` |
| `blameUntil` | `"2025-01-31"` |
