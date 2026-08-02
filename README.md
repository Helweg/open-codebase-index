# open-codebase-index

[![npm version](https://img.shields.io/npm/v/open-codebase-index.svg)](https://www.npmjs.com/package/open-codebase-index)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Downloads](https://img.shields.io/npm/dm/open-codebase-index.svg)](https://www.npmjs.com/package/open-codebase-index)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Helweg/open-codebase-index/ci.yml?branch=main)](https://github.com/Helweg/open-codebase-index/actions)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

> Search a codebase by meaning, then follow the result into definitions, callers, and dependency paths.

`open-codebase-index` is a local semantic code index for OpenCode, Jcode, Pi, Codex, Claude Code, and other MCP clients. It combines embeddings, BM25 keyword search, branch-aware filtering, symbol lookup, and a call graph behind agent-friendly tools.

New installs should use `open-codebase-index` and `open-codebase-index-mcp`. The legacy package `opencode-codebase-index` and `opencode-codebase-index-mcp` remain supported aliases.

## Highlights

- **Semantic and hybrid retrieval** for questions where you do not know the identifier.
- **Low-token discovery** through `codebase_context` and `codebase_peek`.
- **Definition and graph navigation** through `implementation_lookup`, `call_graph`, and `call_graph_path`.
- **Incremental, branch-aware indexing** with file watching and content-hash reuse.
- **Local storage** backed by SQLite, usearch vectors, and a BM25 inverted index.
- **Multiple embedding providers**: Ollama, GitHub Copilot, OpenAI, Google, or a custom OpenAI-compatible endpoint.
- **Native parsing** for TypeScript/TSX, JavaScript/JSX, Python, Rust, Swift, Go, Java, C#, Ruby, C/C++, Metal, PHP, Apex, Bash, Zig, GDScript, MATLAB, JSON, TOML, YAML, Markdown, and HTML, with text fallback.

## Quick start with OpenCode

Requires Node.js 20 or newer.

1. Install the package:

   ```bash
   npm install open-codebase-index
   ```

   Legacy installs continue to work with:

   ```bash
   npm install opencode-codebase-index
   ```

2. Add it to `opencode.json`:

   ```json
   {
     "plugin": ["open-codebase-index"]
   }
   ```

   Legacy alias:

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
| Codex | Marketplace plugin with MCP and skill guidance | `.codebase-index/` |
| Claude Code | Marketplace plugin with MCP and skill guidance | `.claude/` |
| Cursor, Windsurf, other MCP clients | `open-codebase-index-mcp` (legacy alias: `opencode-codebase-index-mcp`) | Selected by `--host`; default is OpenCode-compatible |

See [Installation and host setup](docs/installation.md) for complete instructions.

## Recommended workflow

1. **Check readiness** with `index_status` or `/status`.
2. **Index when needed** with `index_codebase` or `/index`.
3. **Start repository discovery** with `codebase_context`.
4. **Use `codebase_peek`** when you only need likely locations.
5. **Use `implementation_lookup`** for a known symbol or definition question.
6. **Use `codebase_search`** when you need full matching source content.
7. **Use `grep`** for exact identifiers or exhaustive text matches.
8. **Use call-graph tools** for callers, callees, and dependency paths.

### Which search tool should I use?

| Need | Tool |
|---|---|
| Route a repository question to a bounded evidence pack | `codebase_context` |
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
2. GitHub Copilot
3. OpenAI
4. Google

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
  }
}
```

Only specify values you want to override. See [Configuration](docs/configuration.md) for defaults and host-specific paths.

## Branch-aware indexing

The index stores reusable content by hash and maintains branch catalogs for chunks and symbols. On a branch switch, unchanged content can be reused while results remain scoped to the active branch. Linked worktrees without a local project config share the main checkout's portable project index; adding a worktree-local config creates an isolated index boundary.

## Knowledge bases and reranking

OpenCode and Pi can index additional directories as knowledge bases. Configure them with `knowledgeBases` or use the host-native knowledge-base tools where available.

Optional external reranking supports Cohere, Jina, and custom compatible endpoints. Local filtering and evidence classes are applied before external candidates are submitted.

See [Configuration](docs/configuration.md) for examples and privacy considerations.

## Troubleshooting

Start with:

1. `/status` or `index_status`
2. `index_health_check`
3. a normal `/index` retry
4. a forced rebuild only when status reports incompatibility or corruption

Common provider, native module, stale index, branch, and performance issues are covered in [Troubleshooting](TROUBLESHOOTING.md).

## Evaluation and performance

The repository includes reproducible retrieval datasets, latency and quality budgets, baseline comparison, and cross-repository benchmarking tools.

- [Evaluation harness](docs/evaluation.md)
- [Cross-repository benchmarking](docs/benchmarking-cross-repo.md)

Performance depends on repository size, parser coverage, provider latency, embedding cache reuse, and the selected indexing limits. Prefer measured evaluation over fixed marketing claims.

## Development

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run test:run
```

Native changes require Rust and `npm run build:native`. See [Contributing](CONTRIBUTING.md), [Architecture](ARCHITECTURE.md), and [Adding language support](docs/adding-language-support.md).

## Documentation

- [Installation and host setup](docs/installation.md)
- [Tools and commands](docs/tools.md)
- [Configuration](docs/configuration.md)
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
