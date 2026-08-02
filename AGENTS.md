# AGENTS.md - AI Agent Guidelines for open-codebase-index

**Updated:** 2026-08-02 | **Commit:** c33c88b | **Branch:** main | **Version:** 0.22.2

Semantic codebase indexing for OpenCode, MCP hosts, Pi, Claude, Codex, and Jcode. repo uses hybrid TypeScript/Rust architecture:

- **TypeScript** (`src/`): host adapters, tool orchestration, indexing, retrieval, embedding providers, config, evaluation, and watchers
- **Rust** (`native/`): tree-sitter parsing, semantic chunking, usearch vectors, SQLite persistence, BM25, call graphs, and graph analytics

## Build, Test, and Lint

```bash
npm run build          # Build TypeScript and the Rust native module
npm run build:ts       # TypeScript bundle plus built-CLI smoke test
npm run build:native   # Rust/NAPI module for the current platform

npm run test:run       # Full Vitest suite once; pretest rebuilds native code
npm test               # Vitest watch mode
npm run test:coverage  # Coverage run; pretest rebuilds native code

npm run lint           # ESLint over src/
npm run typecheck      # tsc --noEmit
```

### Run a Single Test

```bash
npx vitest run tests/files.test.ts
npx vitest run -t "parseFile"
```

When Rust code changes, rebuild native module before running targeted tests that bypass `npm run test:run`

```bash
npm run build:native
# Equivalent low-level command:
cd native && cargo build --release && napi build --release --platform
```

 full PR validation gate is:

```bash
npm run build && npm run typecheck && npm run lint && npm run test:run
```

## Architecture and File Structure

```text
src/
├── index.ts                    # Thin OpenCode facade; re-exports adapters/opencode
├── mcp-server.ts               # Thin MCP facade; re-exports createMcpServer
├── cli.ts                      # CLI facade for MCP, eval, and visualization commands
├── adapters/
│   ├── opencode.ts             # OpenCode plugin composition and hooks
│   ├── opencode/               # OpenCode tool and PR-impact adapters
│   ├── mcp/                    # MCP CLI, server, tools, prompts, and shared schemas
│   └── pi/                     # Pi extension and call-graph adapters
├── tools/
│   ├── operations.ts           # Shared host-neutral tool operations
│   ├── operation-runtime.ts    # Shared operation runtime/context
│   ├── contracts.ts            # Shared request/result contracts
│   ├── execute-common.ts       # Common execution helpers
│   ├── context*.ts             # Context routing, retrieval, and evidence packing
│   └── tool-names.ts           # Canonical and host-specific public tool names
├── indexer/
│   ├── index.ts                # Indexer orchestration
│   ├── search-ranking.ts       # Hybrid fusion, filtering, diversity, assembly
│   ├── definition-ranking.ts   # Definition-oriented evidence ranking
│   ├── embedding-batches.ts    # Embedding batching, retry state, vector pooling
│   └── call-graph-constants.ts # Shared declaration chunk-type rules
├── native/                     # Focused TypeScript wrappers over the NAPI binding
├── config/                     # Host-aware config schema, merging, paths, and validation
├── embeddings/                 # Provider detection and implementations
├── git/                        # Branch resolution and branch-index materialization
├── watcher/                    # File and Git branch watchers
├── eval/                       # Retrieval evaluation CLI, datasets, metrics, and reports
├── rerank/                     # Optional external reranking
├── utils/                      # Files, paths, logging, metrics, power state, and helpers
├── identity-catalog.json       # Current/future product and package identities
└── package-metadata.ts         # Runtime package metadata helpers

native/src/
├── lib.rs                      # NAPI facade and exports
├── bindings/
│   └── database.rs             # NAPI Database wrapper methods
├── db.rs                       # Core SQLite database implementation
├── db/call_graph.rs            # Call-graph persistence and query operations
├── parser.rs                   # Tree-sitter parsing
├── chunker.rs                  # Semantic chunking with overlap
├── call_extractor.rs           # Query-based call extraction
├── community.rs                # Community detection and centrality algorithms
├── store.rs                    # usearch vector storage
├── inverted_index.rs           # BM25 keyword index
├── hasher.rs                   # xxhash content hashing
└── types.rs                    # Shared native types and language mapping

native/queries/                 # Tree-sitter call queries by language
tests/                          # Vitest integration and unit tests
benchmarks/                     # Native and retrieval benchmarks/evaluation fixtures
commands/                       # OpenCode slash command definitions
skill/                          # OpenCode skill guidance
docs/                           # Installation, configuration, tools, migration docs
```

See `ARCHITECTURE.md` for data flow and design details.

## Where to Look

| Task | Primary location |
|---|---|
| Add or change an OpenCode integration | `src/adapters/opencode.ts`, `src/adapters/opencode/` |
| Add or change an MCP tool/prompt | `src/adapters/mcp/register-tools.ts`, `register-prompts.ts` |
| Add or change a Pi integration | `src/adapters/pi/` |
| Change shared tool behavior | `src/tools/operations.ts`, `operation-runtime.ts`, `contracts.ts` |
| Add or rename a public tool | `src/tools/tool-names.ts`, then update each host adapter |
| Change context routing/evidence packs | `src/tools/context.ts`, `context-search.ts`, `context-pack.ts` |
| Modify indexing orchestration | `src/indexer/index.ts` |
| Modify generic search ranking | `src/indexer/search-ranking.ts` |
| Modify definition-first ranking | `src/indexer/definition-ranking.ts` |
| Modify embedding batching/retries | `src/indexer/embedding-batches.ts` |
| Add an embedding provider | `src/embeddings/detector.ts`, `provider.ts`, `provider-types.ts` |
| Change host config or storage paths | `src/config/host.ts`, `src/config/paths.ts` |
| Change branch resolution/materialization | `src/git/branch-resolution.ts`, `branch-materialization.ts` |
| Change TypeScript native wrappers | `src/native/` |
| Change parsing/chunking | `native/src/parser.rs`, `chunker.rs` |
| Add parser language support | `native/src/types.rs`, `parser.rs`; see `docs/adding-language-support.md` |
| Modify call extraction | `native/src/call_extractor.rs`, `native/queries/*-calls.scm` |
| Modify SQLite operations | `native/src/db.rs`, `native/src/db/`, `native/src/bindings/database.rs` |
| Modify graph communities/centrality | `native/src/community.rs` and database bindings |
| Modify vector or BM25 storage | `native/src/store.rs`, `inverted_index.rs` |
| Add a slash command | `commands/`, then register it in the OpenCode adapter config callback |
| Change product/package identity | `src/identity-catalog.json`, `scripts/prepare-package-metadata.mjs` |
| Change release packaging | `.github/workflows/build.yml` |

## Host Adapter Boundary

Shared behavior belongs below `src/adapters/`. Host adapters should translate host schemas and lifecycle events into shared operations rather than reimplement indexing or search.

- **OpenCode:** `src/index.ts` re-exports `src/adapters/opencode.ts`.
- **MCP:** `src/mcp-server.ts` re-exports `src/adapters/mcp/server.ts` `src/adapters/mcp/cli.ts` owns stdio transport.
- **Pi:** public compatibility facades `src/pi-extension.ts`  `src/pi-call-graph.ts` delegate to `src/adapters/pi/`.
- **Shared tools:** use `src/tools/contracts.ts` `operations.ts` `operation-runtime.ts` `execute-common.ts`.

When adding portable tool, update shared operation and contract first, add its canonical name to `src/tools/tool-names.ts`then wire each supported host adapter. Preserve host-specific schemas, registration order, and output formats.

## Public Tool Families

Canonical tool names live in `src/tools/tool-names.ts`.

- Retrieval: `codebase_context` `codebase_search` `codebase_peek` `find_similar` `implementation_lookup`
- Index lifecycle: `index_codebase` `index_status` `index_health_check` `index_metrics` `index_logs`
- Graph analysis: `call_graph` `call_graph_path` `pr_impact` `code_communities`
- OpenCode-only additions: knowledge-base management `index_visualize`
- Pi knowledge-base aliases: `knowledge_base_add` `knowledge_base_list` `knowledge_base_remove`

Do not silently rename tools or change request/result contracts. They are compatibility surfaces across hosts.

## Native Boundary

`src/native/binding.ts` is only low-level loader for platform-specific `.node` files. Focused wrappers expose native capabilities:

- `parsing.ts`parsing, hashing, and call extraction
- `database.ts`SQLite database API
- `embedding.ts`embedding-related types/helpers
- `vector-store.ts`vector index wrapper
- `inverted-index.ts`BM25 wrapper
- `types.ts`TypeScript types for native values
- `index.ts`native facade exports

Rust implementation details should remain behind NAPI facade in `native/src/lib.rs`  `native/src/bindings/`. Keep JavaScript-facing names and value shapes stable unless TypeScript wrappers and tests are updated together.

Prefer existing batch database methods for bulk indexing. Do not replace them w/ sequential calls.

## Package Identity and Compatibility

 checked-in package remains `opencode-codebase-index@0.22.2`while release workflow publishes both:

- `open-codebase-index`preferred host-neutral package; exports `open-codebase-index-mcp` and legacy binary alias
- `opencode-codebase-index`synchronized compatibility package

Identity constants live in `src/identity-catalog.json`. `scripts/prepare-package-metadata.mjs` stages package-specific manifests w/o rewriting checked-in metadata. Native binary names, tool names, config paths, and persisted index formats remain stable during rename.

Do not broadly replace `opencode-codebase-index` strings. First classify each occurrence as current compatibility contract, future public identity, historical docs, or test fixture. Follow `docs/rename-to-open-codebase-index.md`.

## TypeScript Conventions

### Imports

This is ESM project. Relative TypeScript imports must use `.js` extensions:

```typescript
// Correct
import { Indexer } from "./indexer/index.js";

// Wrong at runtime
import { Indexer } from "./indexer/index";
```

Import order:

1. Type-only imports
2. External packages and Node.js built-ins
3. Internal modules w/ `.js` extensions

Use namespace imports for Node.js built-ins when consistent w/ surrounding code:

```typescript
import * as os from "node:os";
import * as path from "node:path";
```

### Naming and Types

| Element | Convention | Example |
|---|---|---|
| Files/directories | kebab-case | `search-ranking.ts` |
| Functions/variables | camelCase | `resolveProjectIndexPath` |
| Classes/types | PascalCase | `Indexer`, `SearchResult` |
| Public tools | snake_case | `codebase_context` |
| Constants | UPPER_SNAKE_CASE | `PORTABLE_TOOL_NAMES` |

- Keep `strict: true` compatibility.
- Use explicit return types on exported functions.
- Prefix intentionally unused parameters w/ `_`.
- Catch errors as `unknown` and narrow them.
- Avoid `as any` `@ts-ignore`and empty catch blocks.

```typescript
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
```

### Tool Schemas

OpenCode schemas use `tool.schema` from `@opencode-ai/plugin`not direct Zod import:

```typescript
import { tool, type ToolDefinition } from "@opencode-ai/plugin";

const z = tool.schema;

export const my_tool: ToolDefinition = tool({
  description: "Clear description",
  args: {
    query: z.string().describe("Argument purpose"),
    limit: z.number().optional().default(10),
  },
  async execute(args) {
    return "Result string";
  },
});
```

Shared behavior should normally be added to tool operations/contracts, not embedded directly in this adapter definition.

## Rust Conventions

- Rebuild w/ `npm run build:native` after Rust changes.
- Keep NAPI-facing conversions in `native/src/bindings/`  `native/src/lib.rs`.
- Keep core SQLite logic in `native/src/db.rs` and focused `native/src/db/` modules.
- Add call-query files under `native/queries/` and update `call_extractor.rs` when adding call-graph support.
- Update `native/src/types.rs`parser mapping, Cargo dependencies, and tests together when adding language.
- Preserve deterministic ordering for graph, search, and batch results exposed to TypeScript.

## Testing

- **Framework:** Vitest w/ globals enabled
- **Default timeout:** 30 seconds b/c native operations can be slow
- **Tests:** `tests/*.test.ts`

Use isolated temporary directories and always clean them:

```typescript
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
```

Important coverage areas include:

| Area | Representative tests |
|---|---|
| Native parsing, vectors, hashing | `native.test.ts`, `inverted-index.test.ts` |
| Database, batches, GC | `database.test.ts`, `embedding-batches.test.ts`, `auto-gc.test.ts` |
| Search and ranking | `search-integration.test.ts`, `retrieval-ranking.test.ts`, `definition-ranking.test.ts` |
| Call graph and PR impact | `call-graph.test.ts`, `pr-impact.test.ts` |
| MCP and host adapters | `mcp-server.test.ts`, `plugin-hooks.test.ts`, `pi-package.test.ts` |
| Identity and package compatibility | `identity-phase0.test.ts`, `host-mode-paths.test.ts`, `claude-plugin.test.ts` |
| Watchers and branch behavior | `watcher.test.ts`, `watcher-config-refresh.test.ts`, `automatic-branch-index.test.ts` |
| Multi-process safety | `multiprocess-indexing.test.ts`, `index-lock.test.ts` |
| Retrieval quality | `retrieval-benchmark.test.ts`, evaluation datasets under `benchmarks/golden/` |

For native performance checks:

```bash
npx tsx benchmarks/run.ts
```

For retrieval-quality gates, use `eval:*` scripts in `package.json`. Do not update evaluation baselines merely to make regression pass.

## Configuration and Storage

config and index paths are host-aware:

| Host | Project config | Project index | Global config |
|---|---|---|---|
| OpenCode | `.opencode/codebase-index.json` | `.opencode/index/` | `~/.config/opencode/codebase-index.json` |
| Claude | `.claude/codebase-index.json` | `.claude/index/` | `~/.claude/codebase-index.json` |
| Codex, Pi, Jcode | `.codebase-index/config.json` | `.codebase-index/index/` | `~/.config/codebase-index/config.json` |

Non-OpenCode hosts retain fallbacks to existing OpenCode paths for compatibility. Worktrees may resolve config and indexes from main repo. Change path precedence only w/ explicit compatibility tests.

Key config groups in `src/config/schema.ts` include:

- embedding provider/model and custom provider settings
- `indexing`watching, semantic-only mode, project markers, battery behavior, batching
- `search`hybrid fusion, limits, ranking, and related options
- `reranker`optional external reranking
- `debug`logging and metrics
- effectiveness metrics and knowledge-base settings

Never move or delete existing user indexes as part of branding or path cleanup w/o separate migration design and rollback path.

## Anti-Patterns

| Avoid | Reason |
|---|---|
| Missing `.js` on relative imports | ESM runtime failure |
| Host-specific search/index logic duplicated in adapters | Shared operations will diverge |
| Public tool names duplicated as string literals | `tool-names.ts` is the compatibility catalog |
| Direct Zod imports for OpenCode tools | Use `tool.schema` |
| `as any` or `@ts-ignore` | Hides strict-mode contract failures |
| Empty catch blocks | Hides operational failures |
| Sequential database writes in bulk paths | Existing batch methods are substantially faster |
| Rust changes without rebuilding native code | Tests may exercise stale `.node` binaries |
| Renaming package/native/storage identities together | Breaks installs and persisted indexes |
| External reranking before local scope filters | Can leak out-of-scope source and waste requests |
| Updating retrieval baselines without investigating deltas | Masks quality regressions |

## Pull Request Checklist

1. Keep host adapters thin and shared behavior centralized.
2. Add or update tests for every affected host contract.
3. Rebuild native code when Rust changes.
4. Run:

   ```bash
   npm run build && npm run typecheck && npm run lint && npm run test:run
   ```

5. For retrieval changes, run relevant evaluation command and inspect per-query deltas.
6. For identity, config-path, or storage changes, test both current and legacy compatibility paths.
7. Update `CHANGELOG.md` for user-visible changes.

## Release Checklist

Releases are prepared on `release/vX.Y.Z`merged into `main`then tagged and published from merged commit.

1. Reconcile full delta since previous tag, not only current `Unreleased` bullets.
2. Update `CHANGELOG.md` w/ Added/Changed/Fixed entries.
3. Bump `package.json`  `package-lock.json` together.
4. Run full PR validation gate.
5. Commit release metadata and push `release/vX.Y.Z`.
6. Open and merge release PR into `main`.
7. Tag merged commit and push tag.
8. Create GitHub release from that tag.
9. Verify `Build and Publish` workflow:
   - builds all five native targets
   - stages both package identities
   - publishes `open-codebase-index`  `opencode-codebase-index` through npm trusted publishing
10. Smoke-test clean installs, both MCP binary names, ESM/CJS loading, MCP initialization, and native loading.

Supported release targets are macOS ARM64/x64, Linux ARM64/x64 GNU, and Windows x64 MSVC.

Do not manually publish release version that workflow is expected to publish. Do not reuse or overwrite existing npm version.

