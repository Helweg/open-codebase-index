# Architecture Overview

This document explains the architecture of opencode-codebase-index, including data flow, component interactions, and key design decisions.

## Table of Contents

- [High-Level Architecture](#high-level-architecture)
- [Data Flow](#data-flow)
  - [Indexing Flow](#indexing-flow)
  - [Search Flow](#search-flow)
- [Component Details](#component-details)
- [Design Decisions](#design-decisions)
- [Performance Characteristics](#performance-characteristics)
- [Security Considerations](#security-considerations)
- [Extending the Architecture](#extending-the-architecture)

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Interfaces: OpenCode, Pi, MCP hosts, slash commands, and skills            │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TypeScript Layer                                  │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Indexer    │  │  Embeddings  │  │   Watcher    │  │     Git      │     │
│  │              │  │   Provider   │  │              │  │   Detector   │     │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Rust Native Module (NAPI)                           │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  Tree-sitter │  │   usearch    │  │    SQLite    │  │     BM25     │     │
│  │   Parser     │  │   Vectors    │  │   Database   │  │ Inverted Idx │     │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Host-specific project storage                                              │
│  ├── .opencode/index/      # OpenCode                                        │
│  ├── .claude/index/        # Claude                                          │
│  └── .codebase-index/index/ # Codex, Pi, Jcode                              │
│      ├── SQLite metadata and branch catalogs                                │
│      ├── usearch vector artifacts                                            │
│      ├── BM25 inverted-index artifacts                                       │
│      └── index metadata and file-state artifacts                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Indexing Flow

```
Source Files → Parse → Chunk → Embed → Store

1. COLLECT: File discovery (respects .gitignore)
   └─ src/utils/files.ts: collectFiles()

2. DELTA: Check what's changed
   └─ Compare file hashes (xxhash) against stored hashes
   └─ Only process new/modified files

2a. BATCH: Bound changed-file working state
   └─ Retain path, hash, and byte-size descriptors during discovery
   └─ Process in discovery order, up to 64 files or 8 MiB of source per batch
   └─ A single file larger than 8 MiB is processed alone

3. PARSE: Tree-sitter language-aware parsing
   └─ native/src/parser.rs: parse_file()
   └─ Extracts: functions, classes, methods, interfaces
   └─ Includes: JSDoc/docstrings with their code

4. CHUNK: Split large blocks with overlap
   └─ native/src/chunker.rs: semantic chunking
   └─ Preserves code structure boundaries
   └─ Adds overlap for context continuity

5. EMBED: Convert to vectors via AI provider
   └─ src/embeddings/provider.ts
   └─ Deduped by content hash (same code = same embedding)

6. STORE: Persist to disk
   └─ SQLite: embeddings (by hash), chunks, branch catalog
   └─ usearch: vector index for similarity search
   └─ BM25: inverted index for keyword search
```

Changed-file source, parse results, pending embedding text, and queued requests are released between file batches. Embedding requests still use provider-aware dynamic batches and queue backpressure. Failed embedding records are written incrementally as versioned JSONL and streamed during retry, while legacy JSON-array state remains readable.

SQLite mutations participate in one coordinated write transaction, so an interrupted run does not expose partially indexed rows to other connections. Vector, BM25, file-hash, and branch-catalog publication remains at the existing final boundary. These separate artifacts are not claimed to form one cross-storage atomic transaction.

### Search Flow

```
Query → Embed → Search → Scope → Rank → Return

1. EMBED QUERY
   └─ Same embedding model as indexing
   └─ Single API call (~800ms latency)

2. PARALLEL SEARCH
   ├─ SEMANTIC: usearch cosine similarity
   │  └─ Returns top-K similar vectors
   └─ KEYWORD: BM25 inverted index
      └─ Returns top-K keyword matches

3. SCOPE CANDIDATES
   └─ Restricts candidates to the current branch
   └─ Applies directory, file-type, chunk-type, and blame filters before reranking
   └─ Prevents out-of-scope source from reaching an external reranker

4. HYBRID FUSION
   └─ Combines semantic + keyword candidates
   └─ Fusion controlled by fusionStrategy (rrf default, weighted fallback)

5. LOCAL EVIDENCE RANKING
   └─ NFKC/case-normalized exact symbol matching
   └─ Definition, implementation, test, docs, config, and call-flow intent signals
   └─ Authoritative-definition preference, nested duplicate removal, and file diversity
   └─ Stable ordering for equal scores
   └─ Optional external reranking stays within local evidence classes and scoped candidates

6. RETURN RESULTS
   └─ File path, line numbers, code snippet
   └─ Sorted by combined score
```

## Component Details

### Indexer (`src/indexer/index.ts`)

The central orchestrator. Responsibilities:
- Manages full and incremental indexing
- Coordinates parsing → embedding → storage
- Handles rate limiting and retries
- Tracks per-file hashes for delta detection

Focused helpers keep ranking and batch mechanics out of the orchestrator:

- `search-ranking.ts` handles generic fusion, filtering, diversity, and result assembly.
- `definition-ranking.ts` handles definition-query normalization and evidence ranking.
- `embedding-batches.ts` handles pending embedding batches, retry state, and vector pooling.
- `file-batches.ts` defines deterministic file-count and source-byte batch limits.
- `failed-state-persistence.ts` streams versioned JSONL failure state and legacy reads.
- `call-graph-constants.ts` owns the shared declaration chunk-type allowlist.

Key public methods include:

| Method | Purpose |
|--------|---------|
| `index()` | Orchestrate full or incremental indexing |
| `search()` | Run branch-aware hybrid retrieval and result assembly |
| `findSimilar()` | Find semantically similar code for a snippet |
| `getStatus()` | Report readiness, compatibility, and index metadata |
| `healthCheck()` | Inspect and clean stale index state |

### Embedding Provider (`src/embeddings/`)

Abstracts different AI embedding APIs:

| Provider | Implementation | Rate Limit Strategy |
|----------|----------------|---------------------|
| GitHub Copilot | OAuth + internal API | 1 concurrent, 4s delay |
| OpenAI | Official API | 3 concurrent, 500ms delay |
| Google | Gemini API | 5 concurrent, 200ms delay |
| Ollama | Local REST | 5 concurrent, no delay |

Detection order: Ollama → GitHub Copilot → OpenAI → Google

### Native Module (`native/src/`)

Rust components exposed via NAPI:

| Component | Crate | Purpose |
|-----------|-------|---------|
| Parser | tree-sitter-* | Language-aware code parsing |
| VectorStore | usearch | HNSW vector similarity search |
| Database | rusqlite | Persistent storage with batch ops |
| InvertedIndex | Custom | BM25 keyword search |
| Hasher | xxhash-rust | Fast content hashing |

The crate root in `native/src/lib.rs` remains the NAPI assembly facade. The Database NAPI class lives in `native/src/bindings/database.rs`. SQLite call-graph rows and queries live in `native/src/db/call_graph.rs`, while the remaining schema, migrations, chunk, embedding, and branch persistence stay in `native/src/db.rs`.

### Tool Runtime (`src/tools/`)

Tool adapters keep their existing public facades while delegating cohesive mechanics:

- `context.ts` owns path/direct-edge routing and effectiveness reporting; `context-search.ts` owns definition/conceptual recovery.
- `utils.ts` owns general response formatting; `context-pack.ts` owns token budgeting, evidence selection, and packing.
- `operations.ts` owns repository operations; `operation-runtime.ts` owns Indexer caches, initialization, retrieval readiness, and best-effort metrics plumbing.

### Git Branch Materialization (`src/git/`)

`branch-resolution.ts` validates and resolves local, remote, and pull-request refs through temporary fetch refs. `branch-materialization.ts` owns temporary worktree registration, callback execution, rollback, and cleanup.

### Watcher (`src/watcher/index.ts`)

File system observer using chokidar:
- Watches for file changes → triggers incremental index
- Watches `.git/HEAD` → detects branch switches
- Debounces rapid changes (500ms window)
- Merges `additionalInclude` patterns with `include` patterns for proper file filtering

## Design Decisions

### Why Hybrid TypeScript + Rust?

| Layer | Language | Rationale |
|-------|----------|-----------|
| Plugin interface | TypeScript | Native OpenCode integration, config parsing |
| Core logic | TypeScript | Orchestration, API calls, easier iteration |
| Hot paths | Rust | Performance: parsing, vectors, DB operations |

The 80/20 rule: TypeScript for flexibility, Rust for speed-critical operations.

### Why usearch for Vectors?

Alternatives considered:
- **FAISS**: Heavier, complex build, overkill for our scale
- **hnswlib**: Good, but usearch is faster and has F16 support
- **In-memory arrays**: Too slow for 10k+ vectors

usearch advantages:
- F16 quantization → 50% memory savings
- Fast HNSW algorithm
- Simple C++ core, easy Rust bindings
- Persistent on-disk index

### Why SQLite for Storage?

Alternatives considered:
- **JSON files**: No transactions, slow for large data
- **LevelDB/RocksDB**: Overkill, complex keys
- **PostgreSQL**: External dependency, overkill

SQLite advantages:
- Single-file database
- ACID transactions for batch inserts
- Fast lookups by content hash
- Built-in query capabilities
- Widely supported in Rust

### Why BM25 Hybrid Search?

Pure semantic search has weaknesses:
- Misses exact identifier matches
- Can't find "the function named exactly X"
- Embedding models have knowledge cutoffs

BM25 hybrid provides:
- Exact keyword matching for precision
- Fallback when semantic misses
- Better results for technical queries
- Configurable weighting (hybridWeight)

### Why Optimized Tool Return Formats?

Problem: Redundant prompt phrases in tool responses increase token usage and may cause LLMs to exit reasoning prematurely.

Solution:
- **Remove summary phrases**: e.g., "Found X results", "Index status:", "Health check complete:"
- **Return raw data**: Direct result lists without introductory text
- **Maintain clarity**: Keep essential context for unambiguous results

Benefits:
- Reduced token consumption for LLM tool calls
- Faster LLM processing (less text to parse)
- Better integration with LLM reasoning loops
- Maintained functionality with cleaner output

### Why Branch-Aware Indexing?

Problem: Switching branches changes code but embeddings are expensive.

Solution:
1. **Store embeddings by content hash** (not by file)
   - Same code = same embedding, regardless of branch
   - Deduplicated storage
   
2. **Branch catalog tracks membership**
   - Lightweight: just chunk IDs per branch
   - Instant branch switch (no re-embedding)
   
3. **Filter search by current branch**
   - Query only returns relevant results
   - No stale results from other branches

### Why Content-Based Deduplication?

Instead of storing embeddings per-file, we hash the content:
- `hash(code) → embedding_id`
- Same utility function across files? One embedding.
- Copy-paste code? Already embedded.

Benefits:
- Reduces token costs (don't re-embed duplicates)
- Smaller index size
- Faster incremental indexing

## Performance Characteristics

### Indexing Performance

| Phase | Time Complexity | Actual Performance |
|-------|-----------------|-------------------|
| File collection | O(n files) | ~10ms for 1000 files |
| Parsing | O(n files × file size) | ~7ms for 100 files |
| Embedding | O(n chunks) × API latency | Bottleneck (rate limited) |
| Storage | O(n chunks) | ~4ms for 1000 chunks (batch) |

### Search Performance

| Phase | Time Complexity | Actual Performance |
|-------|-----------------|-------------------|
| Query embedding | O(1) API call | ~800-1000ms |
| Vector search | O(log n) HNSW | ~1ms for 10k vectors |
| BM25 search | O(n tokens) | ~5ms for 50k tokens |
| Result fusion | O(k results) | <1ms |

**Total search latency**: ~800-1000ms (dominated by embedding API call)

### Memory Usage

| Component | Memory Profile |
|-----------|----------------|
| Vector index | ~3KB per chunk (F16 quantization) |
| SQLite | ~1KB per chunk metadata |
| BM25 index | ~2KB per unique token |

For a typical 500-file codebase (~5000 chunks): ~30MB total

### Tool Call Performance

Tool return formats are optimized to reduce token usage:

| Tool | Before Optimization | After Optimization | Token Savings |
|------|---------------------|-------------------|---------------|
| `codebase_search` | "Found X results for 'query': ..." | Raw result list | ~15-20 tokens |
| `codebase_peek` | "Found X locations for 'query': ..." | Raw result list | ~15-20 tokens |
| `find_similar` | "Found X similar code blocks: ..." | Raw result list | ~15-20 tokens |
| `call_graph` | "X calls Y function(s): ..." | Raw result list | ~10-15 tokens |
| `index_status` | "Index status: ..." | Raw data | ~5-10 tokens |
| `formatHealthCheck` | "Health check complete: ..." | Raw data | ~5-10 tokens |

**Impact**: Reduces LLM context size, improves reasoning loop efficiency, and lowers API costs.

## Security Considerations

### What Gets Sent to Cloud

| Data | Destination | Purpose |
|------|-------------|---------|
| Code chunks | Embedding provider | Vector generation |
| Search queries | Embedding provider | Query embedding |

The vector index itself stays local. Only code/queries go to the embedding API.

### Privacy Options

For maximum privacy, use Ollama:
```json
{ "embeddingProvider": "ollama" }
```
All processing happens locally. Nothing leaves your machine.

### Credential Handling

- GitHub Copilot: Uses OpenCode's OAuth token
- OpenAI/Google: Reads from environment variables
- Ollama: Local REST, no credentials needed

No credentials are stored by the plugin.

## Extending the Architecture

### Adding a New Language

1. Add tree-sitter grammar to `native/Cargo.toml`
2. Update `native/src/types.rs`: `Language` enum
3. Update `native/src/parser.rs`:
   - `ts_language()` match arm
   - `is_comment_node()` patterns
   - `is_semantic_node()` patterns
   - Note: Recursion depth is limited to 1024 levels to prevent stack overflow
4. Add tests in `native/src/parser.rs`

### Adding a New Embedding Provider

1. Add detection in `src/embeddings/detector.ts`
2. Implement embed function in `src/embeddings/provider.ts`
3. Add rate limit config in `src/indexer/index.ts`

### Adding a New Storage Backend

1. Implement persistence in `native/src/db.rs` or a focused `native/src/db/` submodule
2. Expose Database methods in `native/src/bindings/database.rs` and re-export through `native/src/lib.rs`
3. Update the focused wrapper under `src/native/` and preserve `src/native/index.ts` as the facade
4. Update `src/indexer/index.ts` to use new backend

### Structural Boundaries

Large files are not split solely by line count. `src/utils/auto-index.ts` remains one state machine because lease, retry, and publication transitions must be reviewed together. `native/src/parser.rs` and `native/src/call_extractor.rs` keep language policy beside their extensive grammar tests. `native/src/community.rs` remains a cohesive graph-algorithm module, and `native/src/store.rs` remains the vector persistence boundary because its format and publication invariants are tightly coupled.
