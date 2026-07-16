# AGENTS.md - AI Agent Guidelines for opencode-codebase-index

**Generated:** 2026-05-31 | **Commit:** 317a76b | **Branch:** main

Semantic codebase indexing plugin for OpenCode. Hybrid TypeScript/Rust architecture:
- **TypeScript** (`src/`): Plugin logic, embedding providers, OpenCode tools
- **Rust** (`native/`): Tree-sitter parsing, usearch vectors, SQLite storage, BM25 inverted index, call graph extraction

## Build/Test/Lint

```bash
npm run build          # Build TS + Rust native module
npm run build:ts       # TypeScript only (tsup)
npm run build:native   # Rust only (cargo + napi)

npm run test:run       # All tests once
npm test               # Watch mode

npm run lint           # ESLint
npm run typecheck      # tsc --noEmit
```

### Single Test
```bash
npx vitest run tests/files.test.ts
npx vitest run -t "parseFile"
```

### Native Module (requires Rust)
```bash
cd native && cargo build --release && napi build --release --platform
```

## File Structure

```
src/
├── index.ts              # Plugin entry: exports tools + slash commands
├── mcp-server.ts         # MCP server: wraps Indexer for Cursor/Claude Code/Windsurf
├── cli.ts                # CLI entry point for MCP stdio transport
├── config/               # Config schema (Zod) + parsing
├── embeddings/           # Provider detection (auto/github/openai/google/ollama)
├── indexer/              # Core: Indexer class, delta tracking
├── git/                  # Branch detection from .git/HEAD
├── tools/                # OpenCode tool definitions (codebase_search, index_*)
├── utils/                # File collection, cost estimation, Logger
├── native/               # TS wrapper for Rust bindings
└── watcher/              # Chokidar file + git branch watcher

native/src/
├── lib.rs                # NAPI exports: parse_file, VectorStore, Database, InvertedIndex
├── parser.rs             # Tree-sitter parsing (20 languages: TS, JS, Python, Rust, Go, Java, C#, Ruby, PHP, Apex, Bash, C, C++, Metal, JSON, TOML, YAML, Zig, GDScript, MATLAB)
├── chunker.rs            # Semantic chunking with overlap
├── store.rs              # usearch vector store (F16 quantization)
├── db.rs                 # SQLite: embeddings, chunks, branch catalog, symbols, call edges
├── call_extractor.rs     # Tree-sitter query-based call extraction (TS/JS, Python, Go, Rust, PHP, Zig, Apex, GDScript, MATLAB, Bash, Metal)
├── inverted_index.rs     # BM25 keyword search
├── hasher.rs             # xxhash content hashing
└── types.rs              # Shared types (Language enum with from_string)

tests/                    # Vitest tests (30s timeout for native ops)
commands/                 # Slash command definitions (/search, /find, /index)
skill/                    # OpenCode skill guidance
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add embedding provider | `src/embeddings/detector.ts` + `provider.ts` |
| Modify indexing logic | `src/indexer/index.ts` (Indexer class) |
| Add OpenCode tool | `src/tools/index.ts` |
| Change parsing behavior | `native/src/parser.rs` |
| Modify vector storage | `native/src/store.rs` |
| Add database operation | `native/src/db.rs` + expose in `lib.rs` |
| Add slash command | `commands/` + register in `src/index.ts` config() |

| Add/modify MCP tool | `src/mcp-server.ts` (createMcpServer) |
| Modify call graph extraction | `native/src/call_extractor.rs` + query files in `native/queries/` |
| Add call graph language | `native/queries/<lang>-calls.scm` + update `call_extractor.rs` |
## CODE MAP

### TypeScript Exports (`src/index.ts`)
| Symbol | Type | Purpose |
|--------|------|---------|
| `default` | Plugin | Main entry: returns tools + config callback |
| `codebase_search` | Tool | Semantic search by meaning (returns full code content) |
| `codebase_peek` | Tool | Semantic search returning metadata only (file, line, name) - saves tokens |
| `find_similar` | Tool | Find code similar to a given snippet (duplicate detection, pattern discovery) |
| `index_codebase` | Tool | Trigger indexing (force/estimate/verbose) |
| `index_status` | Tool | Check index health |
| `index_health_check` | Tool | GC orphaned embeddings/chunks |
| `index_metrics` | Tool | Get performance metrics (requires debug.enabled + debug.metrics) |
| `index_logs` | Tool | Get debug logs (requires debug.enabled) |
| `call_graph` | Tool | Query call graph for callers/callees of functions |


### MCP Server Exports (`src/mcp-server.ts`)
| Symbol | Type | Purpose |
|--------|------|---------|
| `createMcpServer` | fn | Creates MCP Server with 9 tools + 4 prompts, lazy Indexer init |

### CLI Entry (`src/cli.ts`)
| Symbol | Type | Purpose |
|--------|------|---------|
| `main` | fn | Parses --project/--config args, starts stdio transport, handles shutdown |
### Rust NAPI Exports (`native/src/lib.rs`)
| Symbol | Type | Purpose |
|--------|------|---------|
| `parse_file` | fn | Parse single file → CodeChunk[] |
| `parse_files` | fn | Parallel multi-file parsing |
| `hash_content` | fn | xxhash string |
| `hash_file` | fn | xxhash file contents |
| `VectorStore` | class | usearch wrapper (add/addBatch/search/save/load) |
| `Database` | class | SQLite: embeddings, chunks, branches, metadata (includes batch methods) |
| `InvertedIndex` | class | BM25 keyword search |

### Database Batch Methods
The `Database` class exposes batch operations for high-performance bulk inserts:
| Method | Purpose | Speedup |
|--------|---------|---------|
| `upsertEmbeddingsBatch` | Batch insert embeddings in single transaction | ~1.3x |
| `upsertChunksBatch` | Batch insert chunks in single transaction | ~12x |
| `addChunksToBranchBatch` | Batch add chunks to branch in single transaction | ~18x |

These are used by the Indexer for all bulk operations. Prefer batch methods over sequential calls.

## CONVENTIONS

### Import Rules (CRITICAL - causes runtime errors if wrong)
```typescript
// CORRECT: .js extension required for ESM
import { Indexer } from "./indexer/index.js";

// WRONG: runtime error
import { Indexer } from "./indexer/index";

// Node.js built-ins: namespace imports
import * as path from "path";
import * as os from "os";
```

### Import Order
1. Type-only imports (`import type { ... }`)
2. External packages + Node.js built-ins
3. Internal modules (with .js extension)

### Naming
| Element | Convention | Example |
|---------|------------|---------|
| Files/Dirs | kebab-case | `codebase-index.json` |
| Functions/Vars | camelCase | `loadJsonFile` |
| Classes/Types | PascalCase | `Indexer`, `ChunkType` |
| OpenCode tools | snake_case | `codebase_search` |
| Constants | UPPER_SNAKE_CASE | `MAX_BATCH_TOKENS` |

### Type Patterns
- Explicit return types on exported functions
- `strict: true` enabled
- Prefix unused params with `_` (ESLint enforced)
- Error handling: use `unknown`, then narrow

```typescript
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
```

### OpenCode Tool Definitions
```typescript
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
const z = tool.schema;  // Use this, not direct zod import

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

## ANTI-PATTERNS

| Forbidden | Why |
|-----------|-----|
| Missing `.js` in imports | Runtime ESM resolution failure |
| Direct zod import for tools | Use `tool.schema` from plugin package |
| `as any`, `@ts-ignore` | Strict mode violations |
| Empty catch blocks | Hide errors; use `catch { /* ignore */ }` with comment |
| Forgetting `npm run build:native` | Native module won't reflect Rust changes |

## TESTING

- **Framework**: Vitest with globals enabled
- **Timeout**: 30s (native ops can be slow)
- **Location**: `tests/*.test.ts`

### Temp Directory Pattern
```typescript
let tempDir: string;
beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-")); });
afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });
```

### Test Categories
| File | Tests |
|------|-------|
| `native.test.ts` | Rust bindings: parsing, vectors, hashing |
| `database.test.ts` | SQLite: CRUD, branches, GC, batch operations |
| `inverted-index.test.ts` | BM25 keyword search |
| `files.test.ts` | File collection, .gitignore |
| `cost.test.ts` | Token estimation |
| `watcher.test.ts` | File/git branch watching |
| `auto-gc.test.ts` | Automatic garbage collection |
| `git.test.ts` | Git branch detection |
| `commands.test.ts` | Slash command loader, frontmatter parsing |
| `logger.test.ts` | Logger utility, metrics collection |

| `mcp-server.test.ts` | MCP server: tool/prompt registration, execution via InMemoryTransport |
| `call-graph.test.ts` | Call extraction, storage, resolution, branch awareness, integration |
### Benchmarks
```bash
npx tsx benchmarks/run.ts   # Performance testing for native operations
```

Tests batch vs sequential performance for VectorStore and SQLite operations.

## CONFIGURATION

Config loaded from `.opencode/codebase-index.json` or `~/.config/opencode/codebase-index.json`.

Key options:
- `embeddingProvider`: `auto` | `github-copilot` | `openai` | `google` | `ollama`
- `indexing.watchFiles`: Auto-reindex on file changes
- `indexing.semanticOnly`: Skip generic blocks, only index functions/classes
- `indexing.requireProjectMarker`: Require `.git`/`package.json` etc. to enable watching (prevents hanging in home dir)
- `search.hybridWeight`: 0.0 (semantic) to 1.0 (keyword)
- `debug.enabled`: Enable debug logging and metrics collection
- `debug.metrics`: Enable performance metrics (use with `index_metrics` tool)

## PR CHECKLIST

```bash
npm run build && npm run typecheck && npm run lint && npm run test:run
```

## RELEASE CHECKLIST

When creating a new release:

1. **Update `CHANGELOG.md`** - Add new version section with Added/Changed/Fixed entries
2. **Reconcile the full previous-tag delta** - Compare `git log --oneline <previous-tag>..HEAD` with the Release Drafter draft so `CHANGELOG.md` and release notes reflect everything shipped since the last release, not only the current `Unreleased` bullets
3. **Bump version in `package.json`** - Follow semver (patch for fixes, minor for features)
4. **Commit changes** - `git commit -m "chore: bump version to X.Y.Z"`
5. **Push the release branch** - `git push -u origin release/vX.Y.Z`
6. **Open and merge a PR into `main`**
7. **Create git tag** - `git tag vX.Y.Z`
8. **Push tag** - `git push origin vX.Y.Z`
9. **Create GitHub release** - `gh release create vX.Y.Z --title "vX.Y.Z - Title" --notes "..."`

Follow the repository workflow: prepare the release on a `release/vX.Y.Z` branch, open a PR into `main`, merge the PR, then tag and publish from the merged commit.

Example:
```bash
# After updating CHANGELOG.md, package.json, and package-lock.json on release/v0.8.0
git checkout -b release/v0.8.0
git add CHANGELOG.md package.json package-lock.json
git commit -m "chore: prepare v0.8.0 release metadata"
git push -u origin release/v0.8.0
# Open and merge the PR into main, then tag the merged commit on main
git tag v0.8.0
git push origin v0.8.0
gh release create v0.8.0 --title "v0.8.0 - Apex semantic parsing" --notes "$(cat <<'EOF'
## What's New
...
EOF
)"
```
