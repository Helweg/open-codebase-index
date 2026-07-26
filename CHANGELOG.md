# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Swift language support**: Added Tree-sitter semantic parsing, nested symbols, source ranges, and case-sensitive call graph extraction for Swift.
- **PHP 8.x coverage**: Added grammar, semantic chunking, and call graph regression coverage for PHP 8.0 through supported PHP 8.5 syntax, and updated `tree-sitter-php` to 0.24.2.
- **C and C++ call graphs**: Added Tree-sitter extraction for direct, member, and qualified calls, constructors, includes, and namespace imports.
- **Metal Shading Language**: Added default `.metal` discovery, semantic chunks for Metal declarations, and direct, template, member, and qualified call extraction.

## [0.17.1] - 2026-07-25

### Fixed

- **Published MCP CLI startup**: Keep `tiktoken` external to the ESM bundle so the installed `opencode-codebase-index-mcp` executable no longer crashes with `__dirname is not defined`; every TypeScript build now smoke-tests the built ESM CLI.

## [0.17.0] - 2026-07-25

### Added

- **Agent-facing retrieval evaluation**: Added a versioned `codebase_context` golden dataset, `npm run eval:agent`, and per-query route metadata for measuring definition routing and conceptual discovery.
- **Token-budgeted context packs**: Added deterministic overlapping-result deduplication and cross-file evidence selection with configurable 128-4000 token response budgets across native OpenCode, MCP, and Pi clients.
- **Context efficiency gates**: Added returned-token, duplicate-candidate, file-diversity, and quality-per-1,000-token evaluation metrics with configurable CI thresholds.

### Changed

- **Automatic definition routing**: `codebase_context` now conservatively infers unambiguous symbol names from definition-style questions before falling back to conceptual search, using shared routing across native OpenCode, MCP, Pi, and evaluation.
- **Large-file retrieval coverage**: Files exceeding `maxChunksPerFile` now retain representative chunks from across the file instead of silently indexing only the beginning.
- **Location-first context details**: Definition and conceptual routes now return compact locations rather than full source bodies, deduplicate overlapping evidence, diversify results across files, and report why candidates were omitted.
- **Hard token caps**: Context budgets are enforced with the `cl100k_base` tokenizer, including Unicode-safe compaction, so agent harnesses can bound retrieval responses before requesting exact source.

### Fixed

- **Concurrent lock recovery**: Hardened crashed-owner index lock reclamation so concurrent recovery attempts publish a single valid lock without losing the winning candidate.
- **Packed-context edge cases**: Preserve valid Unicode and report zero selected results when even one evidence item cannot fit the requested token budget.

## [0.16.0] - 2026-07-24

### Added

- **Unified agent context gateway**: Added the `codebase_context` MCP and Pi tool as the preferred first step for repository questions, routing conceptual discovery, authoritative symbol definitions, and call-graph paths through one low-friction interface.
- **Cross-client tool adoption**: Added native Codex session guidance, skill/default-prompt updates, and Pi pre-agent routing guidance so Jcode, OpenCode, Codex, and Pi agents select codebase tools before broad shell search or file reads.

### Changed

- **Self-routing MCP guidance**: Reworked server instructions and tool descriptions around a staged, client-neutral workflow: check readiness, retrieve lightweight context, locate definitions or graph paths, then use full-content search or exact grep only when needed.
- **Client plugin metadata**: Aligned Codex and Claude Code marketplace manifests with the package release version so clients can discover and refresh the updated integration guidance.

### Fixed

- **Jcode MCP argument compatibility**: Treat explicit JSON `null` values for optional MCP arguments as omitted values across search, definition, graph, PR-impact, and index tools.
- **Embedding-provider outages**: Keep `codebase_search` and `codebase_peek` operational through BM25 keyword fallback when query embedding generation is temporarily unavailable, with full keyword weighting and actionable diagnostics.

## [0.15.0] - 2026-07-24

### Added

- **First-class Jcode integration**: Added the `jcode` MCP host mode, neutral `.codebase-index/` storage, legacy OpenCode state fallback, automated host-path coverage, and global multi-repository setup guidance for Jcode v0.56.0 and newer.

### Changed

- **Node.js runtime requirement**: Raised the supported Node.js version from 18 to 20 to use patched runtime dependencies.

### Fixed

- **Multiprocess index safety**: Serialized index mutations across processes with canonical-path leases, kept cold readers non-mutating, hardened atomic vector and BM25 publication, and added recovery for incomplete or crashed publications.
- **Parser-backed source discovery**: Added `.mts`, `.cts`, `.cxx`, `.hxx`, and `.cs` to the default include patterns.

### Security

- **Dependency vulnerabilities**: Updated vulnerable runtime and development dependency chains, including Hono, `@hono/node-server`, `body-parser`, `fast-uri`, `brace-expansion`, `js-yaml`, and Pi's shrinkwrapped dependencies. `npm audit` now reports zero vulnerabilities.

## [0.14.0] - 2026-07-08

### Added

- **Bash call graph support**: Added tree-sitter call extraction for Bash scripts so shell functions and invocations participate in call graph indexing.
- **Git blame metadata**: Added git blame details to indexed chunks so search results can include authorship and recency context.

### Fixed

- **Pi call graph output**: Aligned Pi call graph formatting with the host adapters.
- **Bash parser linting**: Resolved Rust clippy warnings in the Bash parser merge guard.

## [0.13.2] - 2026-07-04

### Fixed

- **Local plugin development**: Added `npm run dev:link-mcp` so this repository checkout can provide the local `opencode-codebase-index-mcp` bin expected by the standard `npx --package opencode-codebase-index ...` MCP command, without changing the published Codex/Claude manifests.
- **MCP install docs**: Updated MCP examples to use the published-package `npx -y --package opencode-codebase-index opencode-codebase-index-mcp ...` form and clarified that MCP runtime dependencies ship with the package.

## [0.13.1] - 2026-07-03

### Fixed

- **Codex and Claude MCP startup**: Recognize npm `.bin` symlink launches as the CLI entrypoint so `npx --package opencode-codebase-index opencode-codebase-index-mcp --host ...` starts the MCP server instead of exiting before handshake.

## [0.13.0] - 2026-07-01

### Added

- **Temporal call graph visualization**: Added the `index_visualize` tool, `/visualize` slash command, and `npm run visualize` CLI shortcut for generating a self-contained browser HTML view of recent change lenses, module topology, symbol exploration, hotspots, and cycles (#120).
- **First-class Codex integration**: Added Codex plugin marketplace metadata, skill guidance, session hook guidance, and an MCP manifest so Codex can install and run the package as a plugin (#121).
- **First-class Claude Code integration**: Added Claude Code plugin metadata, inline MCP server configuration, and host-specific installation documentation so Claude Code sessions can use the same MCP tools and skill guidance (#139).
- **First-class Pi integration**: Added a Pi extension and package metadata exposing semantic search, indexing, call graph, PR impact, and knowledge-base tools through Pi's native tool interface (#139).
- **Host-native storage paths**: Added Codex/Pi neutral `.codebase-index/` paths and Claude Code `.claude/` paths, with fallback to legacy OpenCode state when host-native state is absent.

### Fixed

- **Codex marketplace install**: Run the Codex MCP server through the published npm CLI via `npx` so git marketplace installs no longer depend on gitignored local `dist/` artifacts (#140).
- **Claude marketplace install**: Run the Claude Code MCP server through the published npm CLI via `npx` so git plugin installs no longer depend on gitignored local `dist/` artifacts.
- **Watcher reindexing**: Run file-watch reindexing in the background while keeping reindex jobs serialized, avoiding blocking watcher callbacks without allowing unsafe concurrent rebuilds.
- **Codex legacy rebuilds**: Preserve legacy local force rebuild behavior for Codex host mode.

## [0.12.0] - 2026-06-22

### Added
- **PR impact analysis**: Added the `pr_impact` tool, `/pr-impact` slash command, and native call-graph reachability/community analysis so PRs can be ranked by affected symbols, hub nodes, and optional concurrent-PR conflicts (#128).
- **Opt-in OMO CodeGraph routing hints**: Added `search.routingGraphHandoffHints` plus command routing updates so conceptual discovery can hand off to graph/path tools after semantic lookup identifies the right symbols (#130).

### Fixed
- **Exported TS/JS symbol indexing**: Restored call-graph symbol persistence for exported declarations so `call_graph`, `call_graph_path`, and `pr_impact` work correctly on fresh indexes (#132).

### Security
- **Dependency hardening**: Bumped `js-yaml` to 4.2.0 and the transitive `hono` override to 4.12.25 to close shipped dependency vulnerabilities (#127, #131).

## [0.11.0] - 2026-06-16

### Added
- Shortest-path queries between symbols in call graph (`e5f9046`).
- Extract inheritance and implements relationships in call graph (#118, `b12ff6b`).
- Confidence metadata on call graph edges (`af29b8a`).

### Changed
- Apply rustfmt formatting fixes in `db.rs` (`26e0d2b`).

### Fixed
- Reject ambiguous source/target names in path queries (`a30a09c`).
- Prevent fabricated paths through ambiguous intermediate edges (`1102072`).
- Avoid ambiguous target resolution in BFS path queries (`12f1d19`).
- Resolve clippy lints in BFS path reconstruction and Rust code (`ab2e325`, `933ddf1`).
- Restore `@opencode-ai/plugin` version pin (`ca0fdee`).

### Security
- Bump `vite` 8.0.16 / `esbuild` 0.28.1 overrides (`20a10c4`).

## [0.10.0] - 2026-06-05

### Added
- **Developer role for routing hints**: Support `developer` role for routing hint messages via `search.routingHintRole` config option (#102).

### Fixed
- **Multi-project index collision**: Resolved index collisions when multiple projects are open by using per-directory Indexer map keyed by worktree root (#108).
- **Watcher EPERM flood**: Prevent watcher from recursing into OS-restricted directories that cause permission error storms (#109).
- **CodeQL security findings**: Fully break taint chains from `apiKey` to error logs and resolve 6 GitHub CodeQL security findings (#105).

## [0.9.0] - 2026-05-31

### Added
- **GDScript language support**: Added tree-sitter semantic parsing, file discovery (`.gd`), and call-graph extraction for GDScript (#94).
- **MATLAB indexing support**: Added tree-sitter semantic parsing and file discovery for MATLAB (`.m`). MATLAB is opt-in via `additionalInclude` because `.m` conflicts with Objective-C on Apple codebases (#91).
- **MATLAB call graph support**: Added query-based call extraction for MATLAB direct function calls and dotted method/package calls, enabled `.m` files in the `call_graph` indexing path, and documented the MATLAB indexing/function-call ambiguity in tests (#91).

### Changed
- **Subsystem module splits**: Split large config, embeddings, eval, MCP, watcher, git, tools, routing, and utility modules into smaller focused files while preserving public entrypoints (#92).
- **AI slop removal**: Trimmed redundant comments and small wrapper noise across config, eval, runtime, indexer, tools, and utils with behavior-neutral refactors (#93).
- **Remove SiliconFlow default**: The custom reranker no longer falls back to a Chinese endpoint (`api.siliconflow.cn`). A `baseUrl` is now required for the `custom` reranker provider. README examples updated to use Cohere and generic env-var placeholders.

### Fixed
- **SSRF protection for custom embedding provider**: Custom provider URLs are now validated against cloud metadata endpoints (169.254.x.x, metadata.google.internal) and non-HTTP protocols to prevent server-side request forgery via malicious config files.
- **Knowledge base path restrictions**: `add_knowledge_base` now blocks sensitive system directories (`/etc`, `/proc`, `/sys`, `/dev`, `/boot`, `/root`, `/var/run`, `/var/log`) and home dotdirs (`.ssh`, `.gnupg`, `.aws`, `.config/gcloud`, `.docker`, `.kube`). Symlinks are resolved before checking.
- **Google API key moved to header**: The Google embedding provider now sends the API key via the `x-goog-api-key` header instead of a URL query parameter, preventing credential exposure in logs and proxies.
- **Error response truncation**: All embedding providers now truncate error response bodies to 500 characters, preventing reflection of potentially sensitive data from misconfigured or malicious endpoints.
- **Config and eval loading hardening**: File-specific parse/shape errors, knowledge-base/include path rebasing fixes, and malformed eval summary coverage (#92).
- **Command and indexer diagnostics**: Surface command file read failures and warn-level cache recovery details for corrupted persisted state (#92).
- **`additionalInclude` dedup filter removal**: User-supplied globs that matched default include patterns were silently stripped; the filter is now removed so `additionalInclude` correctly extends defaults (#91).
- **npm audit vulnerabilities**: Remediated vulnerable transitive dependencies (#99).

## [0.8.1] - 2026-05-22

### Changed
- **Release metadata alignment**: Reconciled the post-`v0.8.0` shipped delta so the changelog and release metadata match the fixes that landed after the `v0.8.0` tag.

### Fixed
- **Atomic file-hash cache writes**: `Indexer.atomicWriteSync()` now recreates missing parent directories before writing `file-hashes.json.tmp`, preventing `ENOENT` crashes after the index directory has been removed.

## [0.8.0] - 2026-05-14

### Added
- **Git worktree fallback and reuse**: Fresh git worktrees now inherit the main repository's project-scoped `.opencode` config and index when no local worktree state exists, including matching eval-path and knowledge-base handling.
- **Apex semantic parsing**: Added tree-sitter-based semantic chunking for Salesforce Apex source files (`.cls` and `.trigger`) via the [`tree-sitter-sfapex`](https://github.com/aheber/tree-sitter-sfapex) grammar. Recognizes class, interface, enum, method, constructor, and trigger declarations with leading JavaDoc-style block comments attached to their target chunks. Anonymous Apex (`.apex`), SOQL, and SOSL standalone files are out of scope.
- **Apex call graph extraction**: Method invocations, constructor calls (`new MyClass(...)`), and instance/static method calls are extracted for the `call_graph` tool. Apex is case-insensitive at the language level, so callee names are normalized to lowercase during extraction (matching the existing PHP behavior). Apex has no imports — namespaces are referenced via fully qualified names — so no `Import` edges are produced.
- **Zig language support**: Added tree-sitter semantic parsing, file discovery, and call-graph extraction for `.zig` files.
- **New slash commands**: Added `/peek` for lightweight location-first discovery and `/reindex` as a full rebuild shortcut.

### Changed
- **Ollama oversized-input handling**: Built-in Ollama embeddings now use pooled multi-part requests, broader context-length detection, and progressive retry/backoff behavior for oversized inputs.
- **Release documentation and support guidance**: Aligned maintainer guidance, support policy, and release workflow docs with the protected-branch release process used for `v0.8.0`.

### Fixed
- **Index reset and cleanup hardening**: Fixed shared/global rebuild flows, SQLite corruption recovery, stale chunk ownership cleanup, and related rebuild-state edge cases across project and worktree setups.
- **Windows build and test reliability**: Fixed Windows-native build/test failures with explicit database/indexer cleanup, portable path handling, and cross-platform native pretest scripting.
- **Database close lifecycle**: Hardened `Database.close()` so use-after-close fails fast instead of silently swapping to an in-memory SQLite connection.
- **Semantic search and rebuild cleanup**: Restored identifier fallback in semantic search and rebuilt cleanup paths from SQLite-backed state without relying on unsafe native remove flows.

## [0.7.0] - 2026-04-14

### Added
- **Knowledge base support**: Added `add_knowledge_base`, `list_knowledge_bases`, and `remove_knowledge_base` tools to manage external document folders indexed alongside the project
- **Reranking with SiliconFlow**: Added `BAAI/bge-reranker-v2-m3` reranking support via SiliconFlow API for improved search result quality
- **Routing hints for local discovery**: Added dynamic routing hints so local search can steer retrieval toward more relevant code paths before semantic reranking
- **TXT/HTML file support**: Added `*.txt`, `*.html`, `*.htm` to default include patterns for document indexing
- **Config merging**: Global and project configs are now merged, allowing shared provider settings at global level and knowledge base paths at project level
- **Hidden file exclusion**: Files and folders starting with `.` are now excluded from indexing and file watching
- **Build folder exclusion**: Folders containing "build" in their name (e.g., `build`, `mingwBuildDebug`) are now excluded from indexing and file watching
- **additionalInclude config**: Added new config option to extend default file patterns without replacing them
- **Eval diversity quality gates**: Added raw and distinct top-k diversity metrics, budgets, and regression coverage for eval runs and reranker benchmarking

### Changed
- **Default verbose=false**: Changed `/index` command default to `verbose=false` to reduce token consumption
- **Dependency hardening**: Added targeted npm overrides and refreshed lockfile resolution to keep vulnerable transitive packages patched in release builds

### Fixed
- **Knowledge base refresh behavior**: Adding or removing knowledge bases now rebuilds the shared in-memory indexer immediately instead of requiring a restart
- **Watcher-triggered reindexing**: Restored automatic reindexing on file changes so watched projects and attached knowledge bases stay current during a live session
- **Parser and call-graph stability**: Fixed recursion-limit and segmentation-fault regressions, removed unsupported parent traversal paths, and improved PHP method-call extraction reliability
- **Plugin/runtime packaging**: Kept `@opencode-ai/plugin` available at runtime by shipping it as a dependency instead of relying on dev-only installation
- **Eval workflow rate limiting**: Throttled GitHub Models quality runs to avoid rate-limit failures in the release verification pipeline

## [0.6.1] - 2026-03-29

### Added
- **Custom provider batch caps**: Added `customProvider.maxBatchSize` / `max_batch_size` support so OpenAI-compatible embedding servers can cap inputs per `/embeddings` request
- **Environment placeholders in config**: Added `{env:VAR_NAME}` placeholder support for string config values so secrets and endpoints can be supplied from the environment instead of committed files

### Changed
- **Release documentation alignment**: Updated release metadata to publish the post-`v0.6.0` config improvements as `v0.6.1`

## [0.6.0] - 2026-03-28

### Added
- **Evaluation harness**: First-class eval CLI, golden datasets, budgets, compare mode, run artifacts, and smoke/quality workflows for measuring retrieval quality over time
- **Implementation lookup workflow**: Added a dedicated definition/implementation retrieval path across the CLI, plugin tools, MCP server, indexer, and tests for faster code lookup by intent
- **Cross-repo benchmarking**: Added a benchmark runner with ripgrep and ast-grep baselines plus reproducible benchmarking documentation and golden datasets for external repos
- **Release automation guardrails**: Added Release Drafter automation and CI enforcement for release-category and semver labels on pull requests
- **Contributor language-support guide**: Added an agent-ready guide for extending semantic parsing and call-graph support to new languages
- **PHP language support**: Added semantic parsing, chunking, and call-graph extraction for PHP, including fixtures and tests for constructors, imports, method calls, and simple calls

### Changed
- **Evaluation CI strategy**: Split the default GitHub Models quality gate from explicit external-provider budget checks and documented the active CI budget paths
- **Documentation refresh**: Reorganized contributor and maintenance docs, expanded evaluation and benchmarking guidance, and updated README benchmark snapshots and workflow references

### Fixed
- **Release Drafter permissions**: Restored draft-release updates so release automation can keep draft notes current
- **Eval/CI correctness**: Closed CI gating gaps, normalized baseline paths, and pinned the Rust toolchain action input used by CI
- **Benchmark auditability**: Fixed scoped ast-grep metric accounting and dataset/result mutability issues in the benchmark runner and reporting flow
- **Supply-chain hardening**: Tightened dependency and repository security posture, including stronger git/worktree handling coverage in tests
- **Native test reliability**: `test:run` and `test:coverage` now rebuild the native module first so newly added parser/call-graph language support is exercised against a current binary during release verification

## [0.5.2] - 2026-03-21

### Added
- **Call graph extraction and query**: Tree-sitter query-based extraction of function calls, method calls, constructors, and imports across 5 languages (TypeScript/JavaScript, Python, Go, Rust)
- **`call_graph` tool**: Query callers or callees of any function/method with branch-aware filtering
- **DB schema v2**: `symbols`, `call_edges`, and `branch_symbols` tables with full CRUD, GC, and batch operations
- **Same-file call resolution**: Automatically resolves call edges to symbols defined in the same file during indexing
- **`/call-graph` slash command**: Added command support for call graph workflows

### Changed
- **Documentation updates**: Expanded README, CHANGELOG, and skill guide to document call graph usage and behavior

### Fixed
- **Missing `call_graph` export**: The `call_graph` tool was not exported from the plugin entry point — now available to OpenCode users
- **JavaScript call extraction routing**: JavaScript now uses a dedicated query file instead of TypeScript query routing
- **Caller output context**: Caller results now include caller symbol/file context for clearer navigation
- **Call graph consistency/integrity**: Improved branch filtering and database integrity handling for call graph data

## [0.5.1] - 2026-03-01

### Added
- **Custom embedding provider**: Support for any OpenAI-compatible embedding endpoint (`custom` provider with `baseUrl`, `model`, `dimensions` config). Works with llama.cpp, vLLM, text-embeddings-inference, LiteLLM, etc.

### Fixed
- **Critical: infinite recursion on stale lock file**: When a stale `indexing.lock` existed from a crashed session, `initialize()` entered infinite recursion via `recoverFromInterruptedIndexing()` → `healthCheck()` → `ensureInitialized()` → `initialize()`, causing 70GB+ memory usage and OOM. Recovery now runs after store/database initialization.
- **Relative path storage**: Index now stores relative paths for project portability. Detects and warns about legacy absolute-path indexes.
- **MCP status prompt**: Removed empty args schema from status prompt that caused validation errors

### Changed
- **Changelog and README**: Fixed bullet formatting, added platform support table

## [0.5.0] - 2026-02-23

### Added
- **MCP server**: Standalone MCP server (`opencode-codebase-index-mcp` CLI) exposing all 8 tools and 4 prompts over stdio transport, enabling integration with Cursor, Claude Code, and Windsurf
- **Crash-safe indexing**: Lock file and atomic writes prevent index corruption from interrupted indexing sessions, with automatic recovery on next run
- **Git worktree support**: Branch detection now works correctly in git worktrees by resolving `.git` file pointers to the actual git directory
- **Index metadata contract**: Stores embedding provider, model, and dimensions in the database; blocks searches against incompatible indexes with clear error messages and `force=true` rebuild instructions
- **Google `gemini-embedding-001` model**: Support for Google's latest embedding model with Matryoshka truncation (3072D → 1536D) and task-specific embeddings (`CODE_RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT`)
- **Google batch embedding**: Batch requests up to 20 texts per API call via `batchEmbedContents` endpoint
- **Compatibility warnings**: Provider mismatch (same model + dimensions) now logs a warning instead of forcing a rebuild
- **Windows support**: Native binaries now build on Windows MSVC across all 5 platform targets (macOS x86/ARM, Linux x86/ARM, Windows x86)

### Changed
- **Embedding API split**: `embed()` replaced by `embedQuery()` and `embedDocument()` to support task-specific embeddings (Google)
- **Type-safe embedding models**: `EMBEDDING_MODELS` constant as single source of truth; `EmbeddingProvider`, `EmbeddingModelName`, and related types derived at compile time
- **Google default model**: Updated from deprecated `text-embedding-004` to `text-embedding-005`
- **Tool formatting**: Extracted all formatting functions from `src/tools/index.ts` to `src/tools/utils.ts`
- **Exhaustive provider check**: `createEmbeddingProvider` uses `never` exhaustive check instead of default branch
- **ESM compatibility**: Build config adds `createRequire` shim for ESM entry points

### Fixed
- **SQLite bind parameter limit**: `get_missing_embeddings` and `get_embeddings_batch` now batch `IN (...)` queries to stay under `SQLITE_MAX_VARIABLE_NUMBER` (999) — fixes crash on large codebases (thanks @zb1749)
- **Google embedding API endpoints**: Corrected single and batch request URLs
- **Index compatibility on force rebuild**: `clearIndex()` now deletes stale index metadata so provider changes take effect
- **Search/findSimilar initialization**: Both now call `ensureInitialized()` before compatibility check
- **Windows MSVC build**: Disabled usearch `simsimd` feature on Windows — MSVC lacks `_mm512_reduce_add_ph` intrinsic. Pinned usearch to 2.23.0 to avoid 2.24.0 `MAP_FAILED` regression. Committed `Cargo.lock` for reproducible CI builds.

## [0.4.1] - 2025-01-19

### Added
- **`requireProjectMarker` config option**: Prevents plugin from hanging when opened in non-project directories like home. When `true` (default), requires a project marker (`.git`, `package.json`, `Cargo.toml`, etc.) to enable file watching and auto-indexing.

### Fixed
- Plugin no longer hangs when OpenCode is opened in home directory or other large non-project directories

## [0.4.0] - 2025-01-18

### Added
- **`find_similar` tool**: Find code similar to a given snippet for duplicate detection, pattern discovery, and refactoring prep. Paste code and find semantically similar implementations elsewhere in the codebase.
- **`codebase_peek` tool**: Token-efficient semantic search returning metadata only (file, line, name, type) without code content. Saves ~90% tokens compared to `codebase_search` for discovery workflows.

## [0.3.2] - 2025-01-18

### Fixed
- Rust code formatting (cargo fmt)
- CI publish workflow: use Node 24 + npm OIDC trusted publishing (no token required)

## [0.3.1] - 2025-01-18

### Added
- **Query embedding cache**: LRU cache (100 entries, 5min TTL) avoids redundant API calls for repeated searches
- **Query similarity matching**: Reuses cached embeddings for similar queries (Jaccard similarity ≥0.85)
- **Batch metadata lookup**: `VectorStore.getMetadata()` and `getMetadataBatch()` for efficient chunk retrieval
- **Parse timing metrics**: Tracks `parseMs` for tree-sitter parsing duration
- **Query cache stats**: Separate tracking for exact hits, similar hits, and misses

### Changed
- BM25 keyword search now uses `getMetadataBatch()` - O(n) instead of O(total) for result metadata lookup

### Fixed
- Remove console output from Logger (was leaking to stdout)
- Record embedding API metrics for search queries (previously only tracked during indexing)
- Record embedding API metrics during batch retries

## [0.3.0] - 2025-01-16

### Added
- **Language support**: Java, C#, Ruby, Bash, C, and C++ parsing via tree-sitter
- **CI improvements**: Rust caching, `cargo fmt --check`, `cargo clippy`, and `cargo test` in workflows
- **/status command**: Check index health and provider info
- **Batch operations**: High-performance bulk inserts for embeddings and chunks (~10-18x speedup)
- **Auto garbage collection**: Configurable automatic cleanup of orphaned embeddings/chunks
- **Documentation**: ARCHITECTURE.md, TROUBLESHOOTING.md, comprehensive AGENTS.md

### Changed
- Upgraded tree-sitter from 0.20 to 0.24 (new LANGUAGE constant API)
- Optimized `embedBatch` for Google and Ollama providers with Promise.all
- Enhanced skill documentation with filter examples

### Fixed
- Node version consistency in publish workflow (Node 24 → Node 22)
- Clippy warnings in Rust code

## [0.2.1] - 2025-01-10

### Fixed
- Rate limit handling and error messages
- TypeScript errors in delta.ts

## [0.2.0] - 2025-01-09

### Added
- **Branch-aware indexing**: Embeddings stored by content hash, branch catalog tracks membership
- **SQLite storage**: Persistent storage for embeddings, chunks, and branch catalog
- **Slash commands**: `/search`, `/find`, `/index`, `/status` registered via config hook
- **Global config support**: `~/.config/opencode/codebase-index.json`
- **Provider-specific rate limiting**: Ollama has no limits, GitHub Copilot has strict limits

### Changed
- Migrated from JSON file storage to SQLite database
- Improved rate limit handling for GitHub Models API (15 req/min)

## [0.1.11] - 2025-01-07

### Added
- Community standards: LICENSE, Code of Conduct, Contributing guide, Security policy, Issue templates

### Fixed
- Clippy warnings and TypeScript type errors

## [0.1.10] - 2025-01-06

### Added
- **F16 quantization**: 50% memory reduction for vector storage
- **Dead-letter queue**: Failed embedding batches are tracked for retry
- **JSDoc/docstring extraction**: Comments included with semantic nodes
- **Overlapping chunks**: Improved context continuity across chunk boundaries
- **maxChunksPerFile config**: Control token costs for large files
- **semanticOnly config**: Only index functions/classes, skip generic blocks

### Changed
- Moved inverted index from TypeScript to Rust native module (performance improvement)

### Fixed
- GitHub Models API for embeddings instead of Copilot API

## [0.1.9] - 2025-01-05

### Fixed
- Use GitHub Models API for embeddings instead of Copilot API

## [0.1.8] - 2025-01-04

### Fixed
- Only export default plugin to prevent OpenCode loader crash
- Downgrade to zod v3 to match OpenCode SDK version

## [0.1.3] - 2025-01-02

### Changed
- Use Node.js 24 for npm 11+ trusted publishing support
- Externalize @opencode-ai/plugin to prevent runtime conflicts

### Fixed
- ESM output as main entry for Bun/OpenCode compatibility
- Native binding loading in CJS context

## [0.1.1] - 2025-01-01

### Added
- CI/CD workflows for testing and publishing
- Comprehensive README with badges, diagrams, and examples

### Fixed
- NAPI configuration for OIDC trusted publishing

## [0.1.0] - 2024-12-30

### Added
- **Initial release**
- Semantic codebase indexing with tree-sitter parsing
- Vector similarity search with usearch (HNSW algorithm)
- Hybrid search combining semantic + BM25 keyword matching
- Support for TypeScript, JavaScript, Python, Rust, Go, JSON
- Multiple embedding providers: GitHub Copilot, OpenAI, Google, Ollama
- Incremental indexing with file hash caching
- File watcher for automatic re-indexing
- OpenCode tools: `codebase_search`, `index_codebase`, `index_status`, `index_health_check`

[Unreleased]: https://github.com/Helweg/opencode-codebase-index/compare/v0.17.1...HEAD
[0.17.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.13.2...v0.14.0
[0.13.2]: https://github.com/Helweg/opencode-codebase-index/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/Helweg/opencode-codebase-index/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/Helweg/opencode-codebase-index/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Helweg/opencode-codebase-index/compare/v0.1.11...v0.2.0
[0.1.11]: https://github.com/Helweg/opencode-codebase-index/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/Helweg/opencode-codebase-index/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/Helweg/opencode-codebase-index/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/Helweg/opencode-codebase-index/compare/v0.1.3...v0.1.8
[0.1.3]: https://github.com/Helweg/opencode-codebase-index/compare/v0.1.1...v0.1.3
[0.1.1]: https://github.com/Helweg/opencode-codebase-index/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Helweg/opencode-codebase-index/releases/tag/v0.1.0
