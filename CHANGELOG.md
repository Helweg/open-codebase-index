# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added an Ollama-only representative retrieval evaluation command with expanded coverage for embedding failure recovery, index-lock recovery, and duplicate-definition path disambiguation.

### Changed

- Retired the unavailable `github-copilot` embedding provider with an actionable migration error. GitHub Models retired its inference API.
- Added Google `gemini-embedding-2` support with its recommended code-retrieval formatting.

## [0.23.0] - 2026-08-11

### Added

- **Low-descriptor native file watching**: On platforms that support it, file watching now uses one native recursive watcher and deterministic snapshot reconciliation for `add`, `change`, and `unlink` events, with automatic Chokidar fallback when native watching is unavailable.
- **Mixed-intent cross-repo benchmark pilot**: Expanded the frozen five-repository cohort from 25 exact-definition queries to 35 reviewed queries by adding keyword-heavy production retrieval coverage across JavaScript, Python, Go, and Rust. The report keeps CodeGraph and codebase-memory-mcp comparison scoped to their shared 25-query exact-definition interface.
- **Mixed-intent benchmark coverage and CI gate**: Expanded the frozen cohort to 45 queries with implementation-intent and conceptual coverage, and added a no-model cross-repo benchmark contract check to pull-request CI.

### Changed

- **Serialized watcher replacement**: On OpenCode plugin reloads, the next project watcher is only created after the previous one has fully stopped, so concurrent reloads cannot leak or double-start watchers.

### Fixed

- **Large-project watcher startup**: Avoid a redundant native snapshot at startup and retain low-descriptor native project watching when a worktree configuration is inherited from outside the project, using Chokidar only for the external configuration target.
- **Watcher reconciliation correctness**: Reconcile native watcher path hints selectively, respect `indexing.maxDepth`, and retain prior entries below temporarily unreadable paths rather than emitting false `unlink` events.
- **Frozen cross-repo definition benchmark**: Reject contradictory exact-symbol targets in reviewed fixed datasets, and replace the ambiguous duplicate Express `error` query with an unambiguous `GithubView` lookup.
- **Source-intent keyword retrieval**: Recognize Go, Rust, and Python test filenames and retain a wider candidate pool for identifier-rich source queries, so related test assertions do not displace production evidence before reranking.
- **MCP server clean shutdown**: `opencode-codebase-index-mcp` now terminates its file watcher, auto-index coordination, and stdio transport on stdin EOF, protocol close, or `SIGHUP`/`SIGINT`/`SIGTERM`, exiting 0 instead of leaving persistent watcher processes and file descriptors behind after the host disappears.

## [0.22.5] - 2026-08-09

### Added

- **codebase-memory-mcp comparator**: Added an opt-in, fixed-version fair comparator to the cross-repository benchmark runner. It uses repeat-local source copies and cache state, retains raw artifacts, and disqualifies malformed or unsafe results rather than scoring them as misses.
- **Expanded cross-repo benchmark pilot**: Added a frozen 25-query definition cohort across JavaScript, Python, Go, and Rust, plus reproducible three-way results for the plugin, CodeGraph, and codebase-memory-mcp.

### Fixed

- **Frozen benchmark inputs**: `cross-repo-benchmark --dataset-dir` now requires a validated dataset for every requested repository instead of silently mixing reviewed inputs with generated candidates.
- **Exact definition ranking**: Prefer same-module results for duplicate exact definition names while preserving explicit file hints and exact-match safety.
- **Cross-repository comparator isolation**: Exclude existing `.opencode` data from comparator source copies and tolerate codebase-memory-mcp file-level results that omit source lines without accepting unusable paths.

## [0.22.4] - 2026-08-07

### Added

- **Context diagnostics**: `codebase_context` now supports an optional `diagnostic` flag across MCP, OpenCode, and Pi. It exposes bounded routing, retrieval, and evidence-pack traces for troubleshooting without changing normal text output.
- **Pre-edit context**: Added the portable `codebase_edit_context` tool for gathering bounded, edit-oriented repository evidence across MCP, OpenCode, and Pi.
- **Pre-edit evaluation gate**: `codebase_edit_context` now has a documented CI evaluation gate. The budget gate supports a `minGraphNeighborRecall` threshold, and `npm run eval:pre-edit:ci` runs the deterministic mock-embedding baseline (Hit@5 1.0, MRR@10 1.0, graph-neighbor recall 1.0) with thresholds in `benchmarks/budgets/pre-edit.json`. The golden dataset covers a resolvable caller lookup, a target-only lookup, and an unresolved-symbol fallback that must route to the conceptual search pack.
- **Fair CodeGraph comparator**: Added a documented cross-repository benchmark harness and public comparison matrix for normalized CodeGraph retrieval measurements.

### Fixed

- **GitHub Actions runtime**: Updated the CI path-semantics job to Node 24-compatible `actions/checkout` and `actions/setup-node` releases, removing the deprecated Node 20 action-runtime warning.

- **Community detection performance**: Avoid cloning adjacency sets on every label-propagation pass, keeping the 10k-node community and coupling workload within its CI performance budget.

- **Package metadata staging**: Exclude local indexes, benchmark results, and other generated workspace artifacts from staged package copies, preventing release-validation timeouts and accidental inclusion of local data.

- **Dependency vulnerabilities**: Bumped transitive dependency pins to patched releases so `npm audit` reports 0 vulnerabilities: `hono` 4.12.34 (CORS ReDoS), `ip-address` 10.4.0 (SSRF and trust-boundary bypasses), `fast-uri` 3.1.5 (host confusion), `postcss` 8.5.26 (source-map disclosure), `undici` 8.9.0 via `@earendil-works/pi-coding-agent` 0.84.0 (CRLF injection, cache parsing, cookie and retry issues), `brace-expansion` 5.0.9 (DoS), and `@eslint/config-array` 0.23.5 (minimatch-based DoS path).

- **JS-YAML vulnerability**: Pinned transitive `js-yaml` to 4.3.1 to remediate CVE-2026-59870 quadratic CPU consumption in `!!omap` resolution.

- **Pre-edit fallback quality gates**: Added optional `minRouteAccuracy` and `minOutcomeAccuracy` evaluation budget thresholds and applied them in `benchmarks/budgets/pre-edit.json` so unresolved `expectedRoute`/`expectedOutcome` assertions now gate CI.

- **Cross-repo comparison latency**: Omit non-comparable CodeGraph CLI startup time from fair quality tables while retaining raw timing artifacts for diagnostics.
- **Cross-repo comparison eligibility**: Exclude documentation-only symbols from the CodeGraph exact-definition cohort, keeping the comparator aligned to source-intent definition retrieval.
- **Exact definition context**: Preserve exact definition lookup ordering when assembling `codebase_context` evidence, so diversification cannot displace the requested definition.

## [0.22.3] - 2026-08-02

### Changed

- **Canonical identity cleanup**: Standardized remaining user-facing defaults and development example copy to prefer `open-codebase-index` in docs and build artifacts, including architecture, contributor and troubleshooting guidance, native crate description, benchmark defaults, and host-neutral bundle banners. Legacy package, binary, manifest, storage, and dual-publication compatibility remains unchanged.

### Fixed

- **CI timing reliability**: Added explicit Git watcher readiness, replaced watcher startup sleeps with readiness synchronization, stopped forcing polling in config-refresh integration tests, retried file writes only when an event was not observed, and changed the 10k-node community performance gate to enforce a sub-second warm median plus a two-second cold/outlier ceiling.

## [0.22.2] - 2026-08-02

### Changed

- **Repository rename preparation**: Added validated repository URL overrides for staged package and host metadata, including package, Claude, and Codex repository fields, and made release metadata follow `GITHUB_REPOSITORY` before and after the planned GitHub rename.
- **Canonical repository identity**: Renamed the GitHub repository to `Helweg/open-codebase-index` and updated package metadata, host manifests, badges, installation commands, security links, troubleshooting links, and changelog comparisons while preserving legacy package, binary, storage, and tool compatibility.

## [0.22.1] - 2026-08-01

### Added

- **Two-tier retrieval quality gates**: Added a daily focused Ollama smoke evaluation and a weekly full-repository representative evaluation spanning TypeScript, Rust, Swift, and PHP, with manual tier selection, separate artifacts, and dataset-specific absolute budgets.

### Changed

- **Faster real-provider evaluation**: Scoped the four-query scheduled Ollama smoke gate to the relevant indexer, OpenCode adapter, and configuration source areas, retaining real semantic competition and all expected files while avoiding full-repository embedding on CPU-only GitHub runners.

### Fixed

- **Evaluation quality gate**: Replaced the retired GitHub Models fallback with a pinned local Ollama provider, refreshed stale smoke-dataset paths after the adapter and ranking refactors, explicitly scoped scheduled runs to the smoke dataset, and fail fast when CI reindexing produces no searchable vectors instead of reporting a misleading zero-quality score.

## [0.22.0] - 2026-08-01

### Added

- **Direct index CLI subcommand for MCP binary**: Added an `index` command to the shared MCP CLI entrypoint with `--project`, `--host`, `--config`, `--force`, `--estimate-only`, and `--verbose` options. The command shares indexing execution and lock handling with existing flows, writes diagnostics to `stderr`, fails on usage and runtime errors, and keeps MCP/eval/visualize modes intact.
- **Portable `code_communities` tool**: Added a graph-analysis tool across OpenCode, MCP, and Pi to expose call-graph communities and hub symbols. It performs label-propagation clustering, reports deterministic member summaries, and identifies hubs using distinct cross-community neighbors. It supports `branch`, `minSize`, `limit`, and `hubThreshold` and recomputes on demand from branch-local data.
- **Community coupling options for `code_communities`**: Added parity support for `minCoupling` and `couplingLimit` across OpenCode, MCP, and Pi, including representative coupling rendering and expanded host-parity test coverage.
- **Community-aware retrieval ranking**: Added deterministic, opt-in ranking that boosts exact symbol matches within the same in-scope call-graph community. The feature is branch-aware, disabled by default, and falls back to existing ranking when graph context is unavailable.

### Changed

- **Bounded file-level indexing batches** (#224): Changed-file scans now store only path, hash, and byte size before parsing and chunking. Embedding, call-graph extraction, and storage are processed in bounded batches with queue backpressure. Failed embeddings are persisted as versioned JSONL and retried from a bounded stream while preserving legacy JSON-array reads, branch catalogs, Git blame, duplicate-embedding reuse, and index visibility after interrupted runs.

## [0.21.0] - 2026-07-30

### Added

- **Host-neutral package identity**: Published `open-codebase-index` as the preferred package with both `open-codebase-index-mcp` and `opencode-codebase-index-mcp` binaries. The existing `opencode-codebase-index` package remains fully supported and is published from the same implementation.
- **Safe rename roadmap**: Documented the staged package, repository, compatibility, deprecation, storage, native-artifact, validation, and rollback plan for the transition to `open-codebase-index`.

### Changed

- **Host-neutral adapter architecture**: Isolated OpenCode, MCP, and Pi registration behind dedicated adapters, moved MCP CLI runtime behind its adapter, centralized portable tool-name contracts, and require explicit host context wherever runtime paths or behavior differ. Tool names, schemas, outputs, and host-specific aliases remain unchanged.
- **Portable project indexes across Git worktrees**: Project-owned paths are now persisted relative to the project root. Worktrees that inherit project configuration share the main checkout's index and reuse unchanged chunks and embeddings, while an explicit worktree-local project config keeps its index isolated. Existing project indexes with absolute stored paths require a one-time force rebuild.
- **Compatibility-aware release pipeline**: Package metadata and host manifests are staged per package identity, native artifacts remain stable, new installation examples prefer `open-codebase-index`, and release retries skip package versions already published.

## [0.20.1] - 2026-07-29

### Changed

- **Maintainable internal boundaries**: Split the TypeScript native facade, search and definition ranking, embedding batches, tool adapters and runtime, context packing and recovery, Git branch resolution, native Database bindings, and SQLite call-graph persistence into focused modules while preserving existing public APIs and behavior.
- **Focused documentation**: Reorganized the README into a concise entry point with dedicated installation, configuration, and tool-reference guides, and refreshed architecture, contribution, troubleshooting, and language-support documentation to match the current source tree.

### Fixed

- **Stable filesystem path identities** (#178): Canonicalize physical, symlinked, missing-descendant, case-insensitive, and Unicode-equivalent paths before comparing project ownership and index state, preventing duplicate identities and incomplete cleanup across equivalent checkout paths. Added cross-platform path-semantics CI coverage and bundled the pinned Unicode case-folding dependency with its license notice.
- **Watcher file-descriptor exhaustion** (#179): Fall back once from native file watching to polling after `EMFILE`, while preserving readiness, pending changes, restart behavior, asynchronous shutdown, and the native-watcher default.

## [0.20.0] - 2026-07-28

### Added

- **Battery-aware background indexing**: Added the opt-in `indexing.pauseBackgroundIndexingOnBattery` setting. On macOS, automatic startup and watcher-triggered indexing now waits for AC power, coalesces pending work into one update, and keeps manual `index_codebase` requests available. Power detection uses a five-second `pmset` timeout and fails open if the source cannot be determined.
- **Actionable effectiveness diagnostics**: Privacy-safe runtime metrics now include bounded per-route outcome, result-count, latency, and returned-token histograms. Scheduled quality evaluations retain public synthetic summary and per-query artifacts for 14 days, including failed runs.
- **Representative retrieval evaluation**: Added a versioned hand-labeled benchmark spanning TypeScript, Rust, Swift, and PHP with difficulty and intent axes, scoped filters, recovery expectations, strict negative cases, symbol-aware graded evidence, and per-query route, outcome, and recovery diagnostics.

### Changed

- **Maintained GitHub Actions runtime**: Updated JavaScript-based workflow actions to immutable Node.js 24 releases, including Release Drafter, checkout, artifact, setup, and script actions.
- **Broader agent routing hints** (#158): Common repository tasks such as fixing bugs, adding support, investigating failures, refactoring, and reviewing code now receive lightweight `codebase_context`-first guidance. Each matching user message emits the hint at most once, preventing repeated token overhead during tool-call loops. Exact identifier, direct-path, external, and unrelated operational requests remain unnudged.
- **Stronger retrieval quality gate**: The GitHub Models scheduled evaluation now requires at least 75% Hit@5 and 0.65 MRR@10, so the gate catches material retrieval regressions that the previous permissive floor allowed.
- **Source-aware context packs**: Conceptual agent context now prioritizes implementation files over documentation, tests, and fixtures unless the query explicitly asks for those paths, while preserving the underlying retrieval order within each evidence class.

### Fixed

- **Development dependency advisories**: Updated the pinned PostCSS and brace-expansion transitive dependencies to patched releases.
- **Exact definitions in large files**: Definition and implementation searches now rescue branch-scoped symbols from the uncapped symbol catalog when per-file embedding limits omit their semantic chunks, restoring exact lookup without increasing embedding volume.
- **Nested method definitions**: Symbol catalogs now recursively extract nested declarations independently of capped semantic chunks, migrate unchanged indexes without re-embedding content, and restore exact method lookup in large classes.
- **Evaluation artifact uploads**: Scheduled quality diagnostics now use a visible output directory so GitHub Actions uploads the generated summaries and per-query evidence on both successful and failed runs.
- **Silent branch switching by default** (#189): Branch changes no longer print directly to stdout. Opt-in branch diagnostics are recorded through the configured debug logger and remain available through `index_logs` when both `debug.enabled` and `debug.logBranch` are enabled.

## [0.19.1] - 2026-07-27

### Added

- **Plugin startup smoke coverage**: Added a bounded subprocess harness for empty, runtime-state-only, and package-marked non-git projects. It runs within the existing CI test job without additional native builds.

### Changed

- **Safer project marker detection**: Runtime-generated `.opencode` and `.codebase-index` directories no longer qualify as project markers, so they cannot enable background watching or indexing in otherwise empty directories.

### Fixed

- **OpenCode startup root handling** (#184): When selecting the OpenCode plugin root, prefer `worktree` only if it is a real Git repository. Non-git worktree values now correctly fall back to `directory` to avoid accidental indexing and watching from filesystem roots.

## [0.19.0] - 2026-07-27

### Added

- **Reliable opt-in MCP auto-indexing**: Added a process-scoped coordinator shared by Jcode, Codex, Claude, OpenCode, Pi, manual indexing, and file watchers. It tracks sanitized lifecycle/progress timestamps, skips healthy current indexes, coalesces concurrent work, bounds exponential lock retries and first-retrieval waits, refreshes stale indexes with the latest Indexer, and cancels retry work during shutdown while preserving multiprocess locks and home/project-marker safety. `autoIndex` remains `false` by default so retrieval never triggers paid embedding work without explicit opt-in.
- **Privacy-safe effectiveness metrics**: Added independent top-level opt-in, process-lifetime memory-only, schema-versioned fixed counters and histograms for repository tool routes, hosts, outcomes, recovery, result counts, latency, token budgets, returned-token estimates, exact-search handoffs, and scope relaxation across OpenCode, MCP, and Pi. The process-wide collector survives Indexer and config-watcher refreshes without repository or user identity dimensions, supports explicit reset, and has adversarial privacy, saturation, disabled-overhead, final-response, and error-path coverage.
- **Offline effectiveness evaluation**: Added deterministic synthetic fixtures and a no-network formatting report with equal `maxResults` and final-response token budgets across routes. Evidence is credited only when visible in returned text, and the oracle exact-search baseline emits only matching lines without arbitrary complete reads. The report states that fixed rankings and markers do not measure retrieval quality, latency, end-to-end agent success, causal impact, or production performance.
- **Intent-aware ranking evaluation**: Added a transparent fixed-candidate baseline comparison for evidence recall@3 and MRR across exact and Unicode-normalized definitions, test/docs/config/call-flow queries, duplicate evidence, file diversity, and a conceptual-search guardrail.

### Changed

- **Exact-search handoffs**: Metadata-only semantic discovery and conceptual context packs now return bounded, result-derived symbol suggestions for exact usage or exhaustive-match searches, with handoffs included in context token-budget accounting across OpenCode, MCP, and Pi.
- **Automatic branch and PR index preparation**: `pr_impact` now safely materializes and indexes missing branch or pull-request commits in isolated hook-disabled worktrees, verifies commit-aware fork-specific catalogs, and reuses or replaces indexes without changing the caller's worktree.
- **Global knowledge-base reuse**: Global indexes now reuse identical knowledge-base chunks across projects instead of re-embedding them for each project catalog, while keeping project-owned source chunks isolated.
- **Name-based call graph routing**: Callers, callees, and dependency paths now resolve unique symbol names automatically across native OpenCode, MCP, Pi, and `codebase_context`. Duplicate names return bounded candidate locations with optional file-path disambiguators, while `symbolId` remains an optional compatibility escape hatch.
- **Self-recovering context lookup**: `codebase_context` now retries empty scoped searches without file filters, retries inferred symbol text after definition-style misses, reports bounded recovery metadata, and keeps all fallback responses within the requested token budget across MCP, native OpenCode, Pi, and evaluation.
- **Intent-aware local ranking**: Semantic and hybrid search now strongly promote exact NFKC/case-normalized authoritative definitions, interpret definition/implementation/test/docs/config/call-flow wording, demote imports, wrappers, fixtures, generated/vendor copies unless requested, remove nested duplicate chunks, diversify useful files, preserve conceptual retrieval strength, and keep stable ties.
- **Scoped external reranking**: Directory, file-type, chunk-type, and blame filters now run before external reranking. Only already-scoped candidates and their exact indexed line ranges can be sent, while intent classification and evidence-class ordering remain deterministic and local.

## [0.18.1] - 2026-07-26

### Fixed

- **CommonJS package import**: Bundle the ESM-only OpenCode plugin dependency into CommonJS artifacts so the advertised `require("opencode-codebase-index")` entry point works in clean installations, and regression-test both published module formats during every TypeScript build.

## [0.18.0] - 2026-07-26

### Added

- **Ollama model discovery**: Added support for arbitrary local embedding models by reading their capabilities, dimensions, and context length from the Ollama API at runtime.
- **Swift language support**: Added Tree-sitter semantic parsing, nested symbols, source ranges, and case-sensitive call graph extraction for Swift.
- **PHP 8.x coverage**: Expanded semantic chunking and call graph regression coverage for PHP 8.0 through supported PHP 8.5 syntax, and updated `tree-sitter-php` to 0.24.2.
- **C and C++ call graphs**: Added Tree-sitter extraction for direct, member, and qualified calls, constructors, includes, and namespace imports.
- **Metal Shading Language**: Added default `.metal` discovery, semantic chunks for Metal declarations, and direct, template, member, and qualified call extraction.

### Fixed

- **Language-aware call graph lookup**: Preserve case-sensitive caller and path queries for Swift, C, C++, Metal, and other case-sensitive languages while retaining case-insensitive matching for PHP and Apex.
- **Ollama upgrade safety**: Keep built-in `:latest` model names compatible with existing indexes, bound embedding requests with a timeout, and reject malformed or dimensionally invalid vectors.
- **PHP call graph resolution**: Resolve same-file PHP function and constructor calls case-insensitively, disambiguate function and class name collisions by call type, and refresh cached PHP call edges after resolution upgrades.
- **Git worktree index isolation**: Keep project indexes local to each worktree while continuing to inherit project configuration from the main checkout, preventing cross-worktree index mutations and stale absolute paths.

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

[Unreleased]: https://github.com/Helweg/open-codebase-index/compare/v0.22.2...HEAD
[0.22.2]: https://github.com/Helweg/open-codebase-index/compare/v0.22.1...v0.22.2
[0.22.1]: https://github.com/Helweg/open-codebase-index/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/Helweg/open-codebase-index/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/Helweg/open-codebase-index/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/Helweg/open-codebase-index/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/Helweg/open-codebase-index/compare/v0.19.1...v0.20.0
[0.19.1]: https://github.com/Helweg/open-codebase-index/compare/v0.19.0...v0.19.1
[0.19.0]: https://github.com/Helweg/open-codebase-index/compare/v0.18.1...v0.19.0
[0.18.1]: https://github.com/Helweg/open-codebase-index/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/Helweg/open-codebase-index/compare/v0.17.1...v0.18.0
[0.17.1]: https://github.com/Helweg/open-codebase-index/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/Helweg/open-codebase-index/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/Helweg/open-codebase-index/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/Helweg/open-codebase-index/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/Helweg/open-codebase-index/compare/v0.13.2...v0.14.0
[0.13.2]: https://github.com/Helweg/open-codebase-index/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/Helweg/open-codebase-index/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/Helweg/open-codebase-index/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/Helweg/open-codebase-index/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/Helweg/open-codebase-index/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/Helweg/open-codebase-index/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Helweg/open-codebase-index/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/Helweg/open-codebase-index/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Helweg/open-codebase-index/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Helweg/open-codebase-index/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/Helweg/open-codebase-index/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Helweg/open-codebase-index/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/Helweg/open-codebase-index/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Helweg/open-codebase-index/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Helweg/open-codebase-index/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Helweg/open-codebase-index/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Helweg/open-codebase-index/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/Helweg/open-codebase-index/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Helweg/open-codebase-index/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Helweg/open-codebase-index/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Helweg/open-codebase-index/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Helweg/open-codebase-index/compare/v0.1.11...v0.2.0
[0.1.11]: https://github.com/Helweg/open-codebase-index/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/Helweg/open-codebase-index/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/Helweg/open-codebase-index/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/Helweg/open-codebase-index/compare/v0.1.3...v0.1.8
[0.1.3]: https://github.com/Helweg/open-codebase-index/compare/v0.1.1...v0.1.3
[0.1.1]: https://github.com/Helweg/open-codebase-index/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Helweg/open-codebase-index/releases/tag/v0.1.0
