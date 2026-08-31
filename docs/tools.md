# Tools and commands

Tool availability depends on the host mode.

## Host surface matrix

| Host / integration | Tool surface | Additional capabilities |
|---|---|---|
| `opencode` (plugin) | 20 tools in total (16 portable tools + 3 knowledge-base tools + 1 OpenCode-native tool) | Slash commands and `index_visualize` |
| MCP clients, including `codex`, `claude`, and `jcode` | 19 tools + 5 prompts (16 portable tools + 3 knowledge-base tools) | Knowledge-base management for every MCP client; no OpenCode slash commands |
| `pi` (Pi extension) | 19 tools total (16 portable tools + 3 Pi knowledge-base tools) | Bundled `codebase-search` skill with host-specific knowledge-base names |

### Portable MCP core (16 tools)

These tools are available through the MCP server and the OpenCode plugin.

- `codebase_context`
- `codebase_edit_context`
- `codebase_search`
- `codebase_peek`
- `index_codebase`
- `index_status`
- `index_health_check`
- `index_metrics`
- `index_logs`
- `find_similar`
- `implementation_lookup`
- `call_graph`
- `call_graph_path`
- `pr_impact`
- `architecture_context`
- `code_communities`

The MCP server also exposes five prompts:

- `search`
- `find`
- `definition`
- `index`
- `status`

### Knowledge-base tools

The MCP server and the OpenCode plugin expose the same three knowledge-base tools. The index is the union of the project code and the configured knowledge-base folders.

- `add_knowledge_base`
- `list_knowledge_bases`
- `remove_knowledge_base`

Notes for MCP clients:

- `add_knowledge_base` writes the path to the **project-local** host config of the MCP server (for example `<repo>/.claude/codebase-index.json` for the `claude` host, or `<repo>/.codebase-index/config.json` for `codex`, `jcode`, and `pi`), and refreshes the index. It is not a user-global change.
- The MCP server runs at a fixed project root (`process.cwd()` or `--project`) for its lifetime. Knowledge-base tools operate on that root and the server host config; they are not per-call worktree-aware. For worktree-local knowledge-base management, use OpenCode or Pi.
- Different MCP hosts pointed at the same repository keep separate knowledge-base lists in separate host config files.
- `list_knowledge_bases` shows the union of project-local and user-global knowledge bases. `remove_knowledge_base` edits only the project-local config, so a knowledge base inherited from a user-global config is not removable by this tool.
- Git blame metadata is collected only for files in the project git repository. Knowledge-base files outside the repository remain searchable by content but have no blame, so `blameAuthor`, `blameSha`, and `blameSince` filters match only in-repo files.

### OpenCode-only tools and commands

OpenCode adds one extra tool beyond the shared MCP and OpenCode set:

- `index_visualize`

`index_visualize` generates an interactive HTML view of recent code movement and the call graph.

OpenCode also exposes slash commands (see [OpenCode slash commands](#opencode-slash-commands)).

### Pi naming notes

Pi does not expose the shared knowledge-base names. It registers equivalent tools with host-specific names:

- `knowledge_base_list`
- `knowledge_base_add`
- `knowledge_base_remove`

Pi exposes all 16 portable tools, including `architecture_context`, `call_graph`, and `call_graph_path`, plus its three host-specific knowledge-base aliases.

## Recommended selection order

1. `index_status` when index readiness is unknown.
2. `architecture_context` before repository-scale planning when module responsibilities and boundaries are not yet known.
3. `codebase_context` for a repository question that may require discovery, a definition, or a dependency path.
4. `codebase_edit_context` optionally when a broad change request already has a known or suspected target symbol, for compact pre-edit source plus caller/callee context.
5. `codebase_peek` for direct low-token location discovery.
6. `implementation_lookup` for a known symbol or definition question.
7. `codebase_search` when full matching source content is required.
8. `grep` for exact identifiers or exhaustive text matches.
9. `call_graph` or `call_graph_path` for graph-specific questions.

## Core retrieval tools

### `architecture_context`

Use `architecture_context` when an agent needs a concise repository map before focused retrieval or edits. Each module includes a responsibility excerpt derived from readable source and exact symbol/file/line citations. Cross-module boundaries include representative source and target symbols, while missing or sparse graph coverage is reported explicitly instead of inferred. Coverage includes branch-aware resolved and unresolved edge totals plus a deterministic per-language breakdown.

`query` and `directory` constrain which modules can consume the response budget. `depth` controls detail from 1 to 3, and `tokenBudget` is enforced from 128 to 4000 estimated tokens without cutting claims or citations mid-entry. When community data is unavailable, the tool can still group matching indexed symbols by source directory, but it labels that fallback and does not invent relationships.

Set `includeRecentActivity: true` to include matching Git activity from the last 90 days with commit, date, summary, and file provenance. If no matching Git history exists, the tool reports that directly and does not substitute graph importance as recent activity.

### `codebase_context`

Preferred entry point for general repository questions. It returns a bounded, deduplicated, file-diverse evidence pack. It can also route explicit symbol definitions or `from`/`to` dependency-path requests.

Important options include result limits, file and directory filters, path disambiguation, and a `tokenBudget` from 128 to 4000 tokens.

Set `diagnostic: true` when troubleshooting a surprising result. MCP returns the normal text response unchanged and provides bounded routing, retrieval, and evidence-pack traces as structured content. OpenCode and Pi render the same diagnostics alongside the normal response. Leave it unset during normal use.

### `codebase_peek`

Returns likely locations and metadata without full source bodies. Use it when you want to choose files before reading them.

### `codebase_search`

Returns full semantic search results, optionally with context lines and filters. Use it after discovery when you need implementation text.

### `implementation_lookup`

Finds authoritative definition locations and prefers implementation files over tests, documentation, examples, and fixtures.

### `find_similar`

Finds code analogous to a supplied snippet. Useful for duplicate detection, pattern discovery, and refactoring preparation.

## Index lifecycle tools

### `index_status`

Reports readiness, chunk counts, compatibility, current provider/model, and index health information.

MCP responses add `structuredContent.mcpDiagnostics` with schema version `1`. `activeOperations` reports each operation, its current phase, start and last-activity timestamps, and `active` or `suspected_stall` status. The current `index_status` call is excluded. `latestInterruptedOperation` is included only after an ordered shutdown marks an active call or a later local process confirms that the recorded PID is absent. A stale heartbeat alone is never classified as an interruption.

### `index_codebase`

Creates or updates the index. Incremental indexing is the default. Use `force: true` only for a required full rebuild. `estimateOnly` reports estimated embedding work without indexing. `dryRun` parses the real file set and reports the exact embedding token total (files, source chunks, tokens) without requesting embeddings or writing to the index — a read-only preflight.

### `index_health_check`

Removes stale references and reports orphan or artifact health.

### `index_metrics`

Returns process-lifetime operational metrics and enabled privacy-safe effectiveness aggregates.

### `index_logs`

Returns recent in-memory debug logs when debug logging is enabled.

### MCP errors and progress

Every MCP handler failure returns `isError: true`, a concise English instruction, and a redacted structured error:

```json
{
  "error": {
    "schemaVersion": 1,
    "code": "OPERATION_TIMEOUT",
    "operation": "index_codebase",
    "phase": "embedding",
    "durationMs": 123,
    "retryable": true,
    "nextAction": "Check index_status for the stalled phase, then retry the operation."
  }
}
```

Codes are `OPERATION_TIMEOUT`, `OPERATION_CANCELLED`, `PROVIDER_ERROR`, `INDEX_BUSY`, `INDEX_UNAVAILABLE`, and `INTERNAL_ERROR`. Provider timeouts, HTTP 429, and HTTP 5xx failures are retryable. Other HTTP 4xx failures and internal errors are not. Tool arguments, queries, paths, provider URLs, response bodies, raw causes, and secrets are never copied into this structure.

When the caller supplies a progress token, long-running operations reuse that exact token and emit serialized, strictly increasing progress from `0` through `100` with `total: 100`. No progress notification is emitted without a token. Raw progress still refreshes the inactivity deadline even when rounding produces no new percentage.

## Call graph and impact tools

### `call_graph`

Finds direct callers or callees for a function or method. File-path disambiguation is available when names are duplicated. For TypeScript and JavaScript, indexed call targets can follow local relative ES module imports, re-export chains, `tsconfig`/`jsconfig` path aliases, and project-local package imports selected by root workspace declarations or ancestor compatibility when no declaration exists. Package entry points support exact and bounded single-wildcard `exports`. Conditional exports use the first active `node`, `import`, or `default` branch in declaration order. Exact, null, and unsupported export declarations block broader wildcard fallbacks, and wildcard precedence follows Node's package-export specificity. External packages, CommonJS-only exports, missing modules, malformed, encoded-traversal, `node_modules`, escaping, or unsafe package metadata, and ambiguous module, package, or star-export targets remain unresolved rather than being guessed.

### `call_graph_path`

Finds the shortest known call path between two named symbols.

### `code_communities`

Discover call-graph communities and hub symbols, and summarize coupling between communities.

Options:

- `branch`: optional branch name to analyze.
- `minSize` (default 1): minimum number of symbols in a community.
- `limit` (default 20): maximum number of communities and hub nodes returned.
- `hubThreshold` (default 5): minimum distinct cross-community neighbors for a symbol to appear as a hub node.
- `minCoupling` (default 1): minimum distinct cross-community connection count required for a coupling entry.
- `couplingLimit` (default 20): maximum number of couplings included in results.

Output includes community summaries, hub node rows, and `Community couplings` entries with representative symbol-to-symbol relationships.

### `pr_impact`

Analyzes changed files, affected symbols, transitive dependencies, graph communities, hub nodes, conflicts, and merge risk for a branch or pull request.

## OpenCode-native tools

OpenCode registers the 15 portable tools, the three shared knowledge-base tools, and one OpenCode-only tool:

- `index_visualize`

`index_visualize` generates an interactive HTML view of recent code movement and the call graph.

Pi also provides native integration for knowledge bases using `knowledge_base_list`, `knowledge_base_add`, and `knowledge_base_remove` tool names.

Tool descriptions and MCP initialization instructions include routing guidance, but the client decides whether and when to invoke tools.

## OpenCode slash commands

| Command | Purpose |
|---|---|
| `/status` | Check index readiness and provider metadata |
| `/index` | Incrementally index the repository |
| `/reindex` | Force a complete rebuild |
| `/search` | Search by meaning and return source results |
| `/peek` | Find likely locations with minimal content |
| `/find` | Combine semantic discovery with precise follow-up |
| `/definition` | Find a symbol's authoritative definition |
| `/call-graph` | Query direct callers or callees |
| `/pr-impact` | Analyze branch or pull-request impact |
| `/visualize` | Generate the interactive index visualization |

The command definitions live in [`commands/`](../commands/).

## Filters

Search tools support combinations of:

- file extension
- directory
- chunk type
- git blame author
- git blame SHA
- git blame date
- result limit
- source context lines

Branch scoping is enabled by default for repository searches.

## Exact search still matters

Semantic retrieval is not a replacement for exact text search. Prefer `grep` when:

- you know the exact identifier
- you need every occurrence
- you are searching generated data or unusual syntax
- the file is not indexed

Use semantic tools when you know the behavior or intent but not the name.

See [Installation](installation.md) for host setup and [Configuration](configuration.md) for indexing and search behavior.
