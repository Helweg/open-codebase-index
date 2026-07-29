# Tools and commands

Tool availability depends on the host mode.

## Host surface matrix

| Host / integration | Tool surface | Additional capabilities |
|---|---|---|
| `opencode` (plugin) | 17 tools in total (13 portable MCP tools + 4 OpenCode-native tools) | Slash commands and native knowledge-base management |
| MCP clients, including `codex`, `claude`, and `jcode` | 13 tools + 5 prompts | No OpenCode slash commands |
| `pi` (Pi extension) | 16 tools total (13 portable tools + 3 Pi knowledge-base tools) | Bundled `codebase-search` skill with host-specific knowledge-base names |

### Portable MCP core (13 tools)

These tools are available through the MCP server and the OpenCode plugin.

- `codebase_context`
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

The MCP server also exposes five prompts:

- `search`
- `find`
- `definition`
- `index`
- `status`

### OpenCode-only tools and commands

OpenCode adds four extra tools beyond the core MCP set.

- `add_knowledge_base`
- `list_knowledge_bases`
- `remove_knowledge_base`
- `index_visualize`

OpenCode also exposes slash commands (see [OpenCode slash commands](#opencode-slash-commands)).

### Pi naming notes

Pi does not expose the OpenCode-native knowledge-base names. It registers equivalent tools with host-specific names:

- `knowledge_base_list`
- `knowledge_base_add`
- `knowledge_base_remove`

Pi exposes all 13 portable tools, including `call_graph` and `call_graph_path`, plus its three host-specific knowledge-base aliases.

## Recommended selection order

1. `index_status` when index readiness is unknown.
2. `codebase_context` for a repository question that may require discovery, a definition, or a dependency path.
3. `codebase_peek` for direct low-token location discovery.
4. `implementation_lookup` for a known symbol or definition question.
5. `codebase_search` when full matching source content is required.
6. `grep` for exact identifiers or exhaustive text matches.
7. `call_graph` or `call_graph_path` for graph-specific questions.

## Core retrieval tools

### `codebase_context`

Preferred entry point for general repository questions. It returns a bounded, deduplicated, file-diverse evidence pack. It can also route explicit symbol definitions or `from`/`to` dependency-path requests.

Important options include result limits, file and directory filters, path disambiguation, and a `tokenBudget` from 128 to 4000 tokens.

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

### `index_codebase`

Creates or updates the index. Incremental indexing is the default. Use `force: true` only for a required full rebuild. `estimateOnly` reports estimated embedding work without indexing.

### `index_health_check`

Removes stale references and reports orphan or artifact health.

### `index_metrics`

Returns process-lifetime operational metrics and enabled privacy-safe effectiveness aggregates.

### `index_logs`

Returns recent in-memory debug logs when debug logging is enabled.

## Call graph and impact tools

### `call_graph`

Finds direct callers or callees for a function or method. File-path disambiguation is available when names are duplicated.

### `call_graph_path`

Finds the shortest known call path between two named symbols.

### `pr_impact`

Analyzes changed files, affected symbols, transitive dependencies, graph communities, hub nodes, conflicts, and merge risk for a branch or pull request.

## OpenCode-native tools

OpenCode registers the 13 portable tools above plus:

- `add_knowledge_base`
- `list_knowledge_bases`
- `remove_knowledge_base`
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
