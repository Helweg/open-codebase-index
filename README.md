# open-codebase-index

[![npm version](https://img.shields.io/npm/v/open-codebase-index.svg)](https://www.npmjs.com/package/open-codebase-index)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Downloads](https://img.shields.io/npm/dm/open-codebase-index.svg)](https://www.npmjs.com/package/open-codebase-index)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Helweg/open-codebase-index/ci.yml?branch=main)](https://github.com/Helweg/open-codebase-index/actions)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.22-brightgreen.svg)](https://nodejs.org/)

> Search a codebase by meaning, then follow the result into definitions, callers, and dependency paths.

`open-codebase-index` is a local semantic code index for OpenCode, Jcode, Pi, Codex, Claude Code, and other MCP clients. It combines embeddings, BM25 keyword search, branch-aware filtering, symbol lookup, and a call graph behind agent-friendly tools.

New installs should use `open-codebase-index` and `open-codebase-index-mcp`. The legacy package `opencode-codebase-index` and `opencode-codebase-index-mcp` remain supported aliases.

For terminal use outside an MCP client, install the package globally and use the concise `ocbi` command:

```bash
npm install -g open-codebase-index
ocbi status --project /path/to/repo --host jcode
ocbi search "retry recovery" --project /path/to/repo
```

`cbi` remains available as a compatibility alias. `ocbi` provides status, indexing, search, definition lookup, and direct caller or callee inspection. See [Installation and host setup](docs/installation.md#human-cli) for the full command reference.

## Highlights

- **Semantic and hybrid retrieval** for questions where you do not know the identifier.
- **Low-token discovery** through `codebase_context` and `codebase_peek`.
- **Definition and graph navigation** through `implementation_lookup`, `call_graph`, and `call_graph_path`.
- **Incremental, branch-aware indexing** with file watching and content-hash reuse.
- **Local storage** backed by SQLite, usearch vectors, and a BM25 inverted index.
- **Multiple embedding providers**: Ollama, OpenAI, Google, or a custom OpenAI-compatible endpoint.
- **Native parsing** for TypeScript/TSX, JavaScript/JSX, Python, Rust, Swift, Go, Kotlin (`.kt` and `.kts`), Java, C#, Ruby, C/C++, Metal, PHP, Apex, Bash, Zig, GDScript, MATLAB, JSON, TOML, YAML, Markdown, HTML, XML, and SVG, plus text fallback for other formats.

## Quick start with OpenCode

Requires Node.js 22.22 or newer. Node.js 24 LTS is recommended.

1. Install the package:

   ```bash
   npm install open-codebase-index
   ```

   Legacy installs continue to work with:

   ```bash
   npm install opencode-codebase-index
   ```

2. Add it to `opencode.json`:

   For OpenCode 2.x:

   ```json
   {
     "plugins": ["open-codebase-index"]
   }
   ```

   For OpenCode 1.x (1.3.4 or newer):

   ```json
   {
     "plugin": ["open-codebase-index"]
   }
   ```

   Legacy alias (OpenCode 2.x):

   ```json
   {
     "plugins": ["opencode-codebase-index"]
   }
   ```

   Legacy alias (OpenCode 1.x):

   ```json
   {
     "plugin": ["opencode-codebase-index"]
   }
   ```

3. Run `/status`, then `/index`.
4. Ask a repository question, for example:

   > Where is authentication state validated before an API request?

The first index creates embeddings. Later runs reuse unchanged content and process only relevant changes.

## Choose your host

| Host | Recommended integration | Storage |
|---|---|---|
| OpenCode | Native plugin | `.opencode/` |
| Jcode | Per-session MCP server | `.codebase-index/` |
| Pi | Pi package | `.codebase-index/` |
| omp (oh-my-pi) | omp package; CLI `--host omp` aliases `pi` | `.codebase-index/` (same as Pi) |
| Codex | Marketplace plugin with MCP and skill guidance | `.codebase-index/` |
| Claude Code | Marketplace plugin with MCP and skill guidance | `.claude/` |
| Cursor, Windsurf, other MCP clients | `open-codebase-index-mcp` (legacy alias: `opencode-codebase-index-mcp`) | Selected by `--host`; default is OpenCode-compatible |

See [Installation and host setup](docs/installation.md) for complete instructions.

## Recommended workflow

1. **Check readiness when unknown** with `index_status` or `/status`; index only when needed.
2. **Orient in unfamiliar code** with one compact `codebase_context` first pass (`tokenBudget: 600`, `limit: 5`), then inspect the evidence. Skip this step when the task is already scoped.
3. **Go directly to known definitions or relationships** with `implementation_lookup`, `call_graph`, or `call_graph_path`.
4. **Optionally prepare a known edit target** with `codebase_edit_context` for bounded source and direct graph evidence.
5. **Choose metadata or matching source** with `codebase_peek` or `codebase_search`; do not repeat context calls unnecessarily.
6. **Read known paths or match literals directly** with targeted reads or `grep`.

### Which search tool should I use?

| Need | Tool |
|---|---|
| Orient in unfamiliar repository code with a compact evidence pack | `codebase_context` |
| Find likely files and symbols without source bodies | `codebase_peek` |
| Retrieve full matching code | `codebase_search` |
| Find an authoritative definition | `implementation_lookup` |
| Find analogous implementations or duplicates | `find_similar` |
| Find direct callers or callees | `call_graph` |
| Find a path between two symbols | `call_graph_path` |
| Analyze a branch or pull request blast radius | `pr_impact` |

See [Tools and commands](docs/tools.md) for host availability, tool details, MCP prompts, and slash commands.

## How it works

```text
source files
   │
   ├─ file discovery and git-aware change detection
   ├─ tree-sitter parsing and semantic chunking
   ├─ embedding generation and content-hash reuse
   ▼
SQLite metadata + usearch vectors + BM25 index
   │
   ├─ semantic candidates
   ├─ keyword candidates
   ├─ branch and request filters
   ├─ deterministic fusion and ranking
   ▼
locations, source results, definitions, and call-graph evidence
```

The TypeScript layer handles host integration, configuration, indexing orchestration, providers, ranking, and tools. The Rust NAPI module handles parsing, vector storage, SQLite operations, BM25 indexing, hashing, and call extraction.

Read [Architecture](ARCHITECTURE.md) for the detailed data flow and design decisions.

## Embedding providers

With `embeddingProvider: "auto"`, providers are tried in this order:

1. Ollama
2. OpenAI
3. Google

Ollama is the simplest local option:

```bash
ollama pull nomic-embed-text
```

```json
{
  "embeddingProvider": "ollama"
}
```

A custom OpenAI-compatible embeddings endpoint is also supported. Provider, indexing, search, reranking, include/exclude, knowledge-base, storage, and debug settings are documented in [Configuration](docs/configuration.md).

## Configuration example

OpenCode project config lives at `.opencode/codebase-index.json`. Codex, Pi, and Jcode use `.codebase-index/config.json`; Claude uses `.claude/codebase-index.json`.

```json
{
  "embeddingProvider": "auto",
  "scope": "project",
  "indexing": {
    "autoIndex": false,
    "watchFiles": true,
    "requireProjectMarker": true,
    "semanticOnly": false
  },
  "search": {
    "maxResults": 20,
    "minScore": 0.1,
    "fusionStrategy": "rrf",
    "rerankTopN": 20
  },
  "mcp": {
    "stallTimeoutMs": 300000
  }
}
```

Only specify values you want to override. See [Configuration](docs/configuration.md) for defaults and host-specific paths.

## Branch-aware indexing

The index stores reusable content by hash and maintains branch catalogs for chunks and symbols. On a branch switch, unchanged content can be reused while results remain scoped to the active branch. Linked worktrees without a local project config share the main checkout's portable project index; adding a worktree-local config creates an isolated index boundary.

## Private GitHub history

Opt in per repository in the **project-local** host config (never inherited globally or from another worktree):

```json
{
  "repositoryHistory": {
    "repositories": [
      { "repository": "owner/repo", "enabled": true, "initialSince": "2026-10-01" },
      { "repository": "github.example.com/team/service", "enabled": true, "initialSince": "2026-10-01" }
    ]
  }
}
```

Selectors use `[HOST/]OWNER/REPO`: bare `owner/repo` defaults to GitHub.com, and `github.com/OWNER/REPO` normalizes to the same lowercase `owner/repo`. Enterprise selectors normalize to lowercase `hostname/owner/repo`. The host must be a DNS hostname, not a URL, credential-bearing address, or host with a port; traversal components are not accepted. For Enterprise, authenticate separately using normal `gh auth login --hostname github.example.com`; sync uses existing authentication and requires `gh` REST/GraphQL access on that selected server.

The server hostname is part of source, cache, staging, citation, and permission identity: the same owner/repo on different hosts stays isolated. Citation URLs and `#number` references use the selected server; explicit URL references are validated, never rewritten across hosts or fetched from another host.

```sh
ocbi history sync --project /path/to/repo --host codex --repository github.example.com/team/service
ocbi history search "design rationale" --project /path/to/repo --host codex --repository github.example.com/team/service --state merged
ocbi history status --project /path/to/repo --host codex --repository github.example.com/team/service
ocbi history clear --project /path/to/repo --host codex --repository owner/repo
# Provider/code-index/native-free MCP status and cache management:
open-codebase-index-mcp --history-only --project /path/to/repo --host codex
```

The four `repository_history_sync/search/status/clear` tools are available in MCP, OpenCode, Pi, and omp; both package identities' MCP CLIs also accept `history ...`. Sync is explicit/read-only through existing `gh` authentication. An initial `--since` overrides configured `initialSince`; later omitted flags retain the cached window, and changed configuration gives clear-first feedback. Each cycle fully reconciles issue/PR discussions and deletions. Per-page ETags reduce unchanged response bodies (not HTTP request count); interrupted projected staging resumes on the next manual sync. Only changed local BM25 documents are retokenized, with no unchanged-index reserialization.

This is **private local lexical history**, not cloud-embedded semantic history. It supports short technical terms such as `CI`/`S3`, returns one grounded passage per entity, prioritizes direct identities over incidental mentions, and selects source-text excerpt windows. Unknown review edit time is `updatedAt: null` with timestamp provenance. Older lexical caches rebuild locally on first search without networking. Discussions are untrusted evidence, never instructions; current code remains authoritative. History stays outside default code search/context, AST/call graphs and linked tests. Offline freshness/permissions are not real-time; detected access loss purges searchable/projected/staged content, while transient/rate-limit failures retain the prior cache with explicit error. Precommit cancellation preserves published bytes; clear removes history, staging and orphan preparations even after disable, never code indexes. See [history lifecycle and privacy details](docs/tools.md#private-github-repository-history).

## Knowledge bases and reranking

OpenCode, Pi, and every MCP client can index additional directories as knowledge bases. Configure them with `knowledgeBases`, or use the knowledge-base tools:
- MCP and OpenCode: `add_knowledge_base`, `list_knowledge_bases`, `remove_knowledge_base`
- Pi: `knowledge_base_add`, `knowledge_base_list`, `knowledge_base_remove`

Optional external reranking supports Cohere, Jina, and custom compatible endpoints. Local filtering and evidence classes are applied before external candidates are submitted.

See [Configuration](docs/configuration.md) for examples and privacy considerations.

## Troubleshooting

Start with:

1. `/status` or `index_status`
2. `index_health_check`
3. a normal `/index` retry
4. a forced rebuild only when status reports incompatibility or corruption

Common provider, native module, stale index, branch, and performance issues are covered in [Troubleshooting](TROUBLESHOOTING.md).

MCP operations report structured, redacted failures and durable phase diagnostics through `index_status`. Codex keeps a lightweight connection while its idle indexing engine sleeps and resumes on demand. See [MCP engine idle timeout](docs/configuration.md#mcp-engine-idle-timeout) for configuration and external cleanup requirements. If the supervisor itself is terminated and the client loses stdio, start a fresh client session before retrying.

## Evaluation and performance

The repository includes reproducible retrieval datasets, latency and quality budgets, baseline comparison, and cross-repository benchmarking tools.

- [Evaluation harness](docs/evaluation.md)
- [Cross-repository benchmarking](docs/benchmarking-cross-repo.md)
- [Assistant-curated round-two comparison and limitations](docs/benchmarks/2026-10-07-self-curated-round2-study.md)
- [Kotlin/retrieval candidate development diagnosis](docs/benchmarks/2026-10-07-candidate-development-diagnosis.md)

Performance depends on repository size, parser coverage, provider latency, embedding cache reuse, and the selected indexing limits. Prefer measured evaluation over fixed marketing claims.

## Development

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run test:run
```

- Source installs and published consumers require Node.js 22.22 or newer because Chokidar 6 enforces that engine floor. The development toolchain supports `^22.22.0 || ^24.11.0 || >=26.0.0`; building the native module also requires the Rust toolchain.

Pi integration tests use the development host `@earendil-works/pi-coding-agent`
1.3 or newer and its `emitBeforeAgentStart(trigger, systemPromptOptions)` API.
This test-host floor does not narrow the optional Pi peer contract or change the
extension's native-section and legacy string-return prompt behavior.

Native changes require Rust and `npm run build:native`. See [Contributing](CONTRIBUTING.md), [Architecture](ARCHITECTURE.md), and [Adding language support](docs/adding-language-support.md).

## Documentation

- [Installation and host setup](docs/installation.md)
- [Tools and commands](docs/tools.md)
- [Configuration](docs/configuration.md)
- [Optional SCIP TypeScript enrichment](docs/scip-typescript.md)
- [Provider-free structural indexing](docs/structural-indexing.md)
- [API impact evidence](docs/api-impact.md)
- [Workspace readiness](docs/workspace-status.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Architecture](ARCHITECTURE.md)
- [Evaluation](docs/evaluation.md)
- [Cross-repository benchmarking](docs/benchmarking-cross-repo.md)
- [Adding language support](docs/adding-language-support.md)
- [Future `open-codebase-index` rename plan](docs/rename-to-open-codebase-index.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
