# Optional local SCIP TypeScript enrichment feasibility

**Date:** 2026-08-26

**Decision:** Feasible as an import-only, feature-flagged experiment. Do not implement it on this branch yet.

## Summary

SCIP can improve TypeScript and JavaScript target resolution where OCBI's current tree-sitter and local-module heuristics leave an edge unresolved. It is not a replacement for OCBI parsing or call extraction.

The safest first integration is:

1. keep OCBI as the source of symbols, call sites, call types, and source excerpts;
2. optionally consume a user-generated local `index.scip`;
3. invoke a user-installed `scip` CLI with `execFile` to produce bounded JSON;
4. use SCIP only to resolve currently unresolved TypeScript/JavaScript edges;
5. fall back to the existing graph without failing indexing.

No adapter was implemented because neither `scip-typescript` nor `scip` is installed in the current environment, and the remaining correctness gates need a real generated index: position-encoding conversion, symbol-to-OCBI definition matching, stale-enrichment removal, and memory behavior on realistic SCIP JSON. Adding `@scip-code/scip` or a protobuf runtime would also add production dependencies, contrary to the current constraint.

## Evidence from the current repository

### Existing graph pipeline

- `src/indexer/index.ts:116-122` enables call extraction for TypeScript, TSX, JavaScript, and JSX.
- `src/indexer/index.ts:1349-1370` creates stable OCBI `SymbolData` records from parsed source symbols. SCIP should map to these records rather than introduce a second symbol catalog.
- `src/indexer/index.ts:4265-4369` discovers files, hashes them, and already forces JavaScript-family graph refreshes when a JavaScript-family source changes.
- `src/indexer/index.ts:4452-4474` builds the branch-aware `LocalModuleCallResolver` and lazily loads unchanged modules.
- `src/indexer/index.ts:4566-4747` extracts call sites, identifies enclosing OCBI symbols, applies same-file and local-module resolution, then batch-writes symbols and edges.
- `src/native/types.ts:50-86` has a deliberately small graph contract: call type, source location, target name, optional target symbol, confidence, and resolution state. SCIP can enrich this shape without a native schema migration.
- `native/src/db/call_graph.rs:321-368` uses `INSERT OR REPLACE` for call edges. Reprocessing a file can therefore clear a stale enriched target by writing the same edge ID with no `to_symbol_id`.
- `src/indexer/call-graph-coverage.ts:33-79` already computes resolved and unresolved edge counts by language. This is the correct first observability and benchmark surface.
- `src/watcher/index.ts:30-69` turns any included file or config change into a normal background index request. A whole-project SCIP generator must not be silently attached to every watcher event.

### Current architecture-context behavior

`architecture_context` reads source files and derives cited excerpts from graph symbol ranges (`src/tools/architecture-context.ts:271-300`), while its public adapter remains thin (`src/adapters/opencode/tools.ts:398-409`). Better target resolution can improve communities, entry points, relationships, and cited source selection without changing the public tool. The enrichment must preserve OCBI file paths and symbol ranges so the existing source excerpt path remains authoritative.

### SCIP ecosystem facts

Authoritative upstream evidence checked on 2026-08-26:

- [`scip-typescript`](https://github.com/sourcegraph/scip-typescript) is a compiler-backed TypeScript/JavaScript indexer. Its documented flow is `scip-typescript index`, producing `index.scip`.
- Its [CLI options](https://github.com/sourcegraph/scip-typescript/blob/main/src/CommandLineOptions.ts) include `--output`, `--infer-tsconfig`, explicit Yarn and pnpm workspace flags, `--no-global-caches`, and `--max-file-byte-size`.
- Its [index command](https://github.com/sourcegraph/scip-typescript/blob/main/src/main.ts) truncates and rewrites the output, walks projects sequentially, and emits a complete workspace index. This is not changed-file incremental indexing.
- The latest npm package observed was `@sourcegraph/scip-typescript@0.4.0`, published in October 2025. It depends on TypeScript 5.6.2 and `google-protobuf`; OCBI now supports Node 24+ and uses TypeScript 5.9.3 for development.
- The [SCIP schema](https://github.com/scip-code/scip/blob/main/scip.proto) is streaming protobuf. Documents contain relative paths, occurrences, definitions, and an explicit position encoding.
- The [`scip` CLI](https://github.com/scip-code/scip/blob/main/docs/CLI.md) supports `scip print --json`; upstream warns only that non-JSON print output is unstable for scripts.
- Official TypeScript decoding is available through [`@scip-code/scip`](https://github.com/scip-code/scip/tree/main/bindings/typescript), which also brings `@bufbuild/protobuf`. Both are Apache-2.0, but adding them would be new production dependencies.

## Fit and limitations

### What SCIP should enrich

SCIP should resolve an existing OCBI edge when all of these hold:

1. the source language is TypeScript, TSX, JavaScript, or JSX;
2. OCBI already extracted the call/import/inheritance site and its enclosing source symbol;
3. the OCBI edge is unresolved;
4. a SCIP occurrence matches that source identifier after position-encoding normalization;
5. the SCIP symbol has exactly one project-local definition that maps to exactly one existing OCBI symbol.

This preserves OCBI's call semantics. SCIP occurrences are references, not a drop-in call graph, so creating an OCBI edge for every SCIP reference would incorrectly turn type references, reads, writes, and other identifiers into calls.

### Expected wins

- `tsconfig` path aliases and project references;
- package `exports` and workspace package resolution;
- renamed and namespace imports beyond the current local resolver's syntax coverage;
- method targets where compiler type information disambiguates same-named declarations;
- re-export chains that remain ambiguous to syntax-only resolution.

### Known gaps and risks

- SCIP TypeScript emits a whole-workspace index. Running it for each watcher batch would make normal background indexing expensive and noisy.
- Workspace selection is explicit. OCBI would otherwise need to infer Yarn versus pnpm behavior or expose generator arguments.
- SCIP positions may be UTF-16 code units while tree-sitter columns are byte-oriented. Non-ASCII source requires tested conversion through line text, not direct line/column equality.
- A SCIP symbol is not an OCBI symbol ID. Definitions must map by canonical project-relative path, range overlap, and declaration compatibility. Name-only matching is unsafe.
- `scip print --json` can be much larger than the protobuf input. A no-dependency pilot must cap output before `JSON.parse`, which limits it to small and medium repositories.
- The current edge table has no enrichment provenance. A pilot can avoid a migration by enriching only in-memory `edgeBatch` entries and forcing JavaScript-family reprocessing whenever adapter state changes.
- `scip-typescript` uses its bundled TypeScript version. Repositories relying on newer compiler behavior may produce incomplete or inaccurate data.
- Running a project tool consumes local CPU and memory and reads installed dependencies. It must remain explicit opt-in and must never use `npx`, install packages, run an external service, or invoke a shell.

## Proposed first-milestone configuration

Add this nested section to `IndexingConfig` in `src/config/schema.ts` and defaults in `src/config/defaults.ts`:

```ts
interface ScipTypeScriptConfig {
  /** Default false. */
  enabled: boolean;
  /** Existing SCIP file, relative to the materialized project root. Default "index.scip". */
  indexFile: string;
  /** User-installed local decoder executable. Default "scip". */
  decoderCommand: string;
  /** Maximum decoder runtime. Default 30_000, clamped to 1_000..300_000. */
  timeoutMs: number;
  /** Maximum JSON output accepted. Default 67_108_864, clamped to 1 MiB..256 MiB. */
  maxOutputBytes: number;
  /** Reject an index older than relevant project sources/config. Default true. */
  requireFreshIndex: boolean;
}
```

Example:

```json
{
  "indexing": {
    "scipTypeScript": {
      "enabled": true,
      "indexFile": ".codebase-index/scip/index.scip",
      "decoderCommand": "/opt/homebrew/bin/scip",
      "timeoutMs": 30000,
      "maxOutputBytes": 67108864,
      "requireFreshIndex": true
    }
  }
}
```

Deliberately excluded from milestone one:

- no `scip-typescript` generator command;
- no arbitrary command arguments;
- no `npx`, package-manager, network, or auto-install behavior;
- no direct protobuf dependency;
- no host-adapter-specific config;
- no support outside the TypeScript/JavaScript family.

A later generator mode should be a separate decision after benchmarks. It would need an explicit manual-only lifecycle and separate workspace configuration.

For `requireFreshIndex`, treat TypeScript/JavaScript sources, `tsconfig*.json`, `jsconfig*.json`, `package.json`, workspace manifests, and lockfiles as relevant inputs. Reject the SCIP file when its modification time is older than the newest relevant input. This is intentionally conservative but not cryptographic proof that the SCIP file represents the current tree; the benchmark spike should determine whether a generated sidecar fingerprint is required.

## Exact integration boundaries

### New module

Create `src/indexer/scip-typescript-enrichment.ts` with host-neutral functions only:

```ts
interface ScipEnrichmentInput {
  projectRoot: string;
  materializedProjectRoot: string;
  indexFile: string;
  decoderCommand: string;
  timeoutMs: number;
  maxOutputBytes: number;
  sourceFiles: ReadonlyMap<string, string>;
  symbols: readonly SymbolData[];
  edges: readonly CallEdgeData[];
}

interface ScipEnrichmentResult {
  edges: CallEdgeData[];
  matchedEdges: number;
  unmatchedOccurrences: number;
  ambiguousDefinitions: number;
  decoderVersion?: string;
}
```

Responsibilities:

- resolve and validate `indexFile` beneath `materializedProjectRoot`;
- reject non-files and path escapes;
- invoke `execFile(decoderCommand, ["print", "--json", indexFile])` with timeout, byte cap, no shell, and no stdin;
- validate only the required JSON fields;
- canonicalize document paths and reject absolute or `..` paths;
- convert SCIP position encodings using source line text;
- index project-local definition occurrences by SCIP symbol;
- match only unresolved OCBI edges and return copied enriched edges;
- never write SQLite or mutate the indexer directly.

### Existing indexer

Modify `src/indexer/index.ts` in two narrow places:

1. **Refresh decision near `src/indexer/index.ts:4292-4369`.** Add a branch-scoped adapter metadata fingerprint. If the adapter configuration, SCIP file fingerprint, freshness state, or adapter version changed, mark all JavaScript-family files changed. This guarantees old enriched targets are replaced by ordinary OCBI edges when the adapter is disabled, stale, missing, or failing.
2. **Edge overlay near `src/indexer/index.ts:4566-4747`.** After ordinary `edgeBatch` construction and before `upsertCallEdgesBatch`, apply successfully prepared SCIP resolutions to unresolved edges only.

Prepare/parse the SCIP data before `database.beginWriteTransaction()` where possible. Do not hold the SQLite write transaction while an external process runs. Keep the existing index mutation lease so branch and materialized-root state cannot change underneath the import.

### Persistence and public surfaces

- No Rust schema or NAPI contract change is required for the first milestone.
- Store branch-scoped metadata keys for adapter version, SCIP file fingerprint, last outcome, and matched-edge count.
- Add an optional `scipTypeScript` block to `StatusResult` only after the pilot proves useful. Until then, emit one bounded logger event per index run.
- Do not change OpenCode, MCP, Pi, `architecture_context`, `call_graph`, or `code_communities` adapters. They already consume the shared graph.

## Lifecycle and fallback behavior

| Condition | Behavior |
|---|---|
| Feature disabled | Run the current indexer unchanged. If previously enabled, force one JavaScript-family graph refresh to clear enriched targets. |
| SCIP file missing/unreadable | Warn once, use ordinary OCBI edges, record non-fatal adapter status. |
| SCIP file stale | Do not import it. Reprocess JavaScript-family graph edges and use ordinary OCBI resolution. |
| Decoder missing/non-zero/timeout | Kill the child, discard all staged enrichment, continue ordinary indexing. |
| JSON exceeds cap or is malformed | Terminate or reject the decoder output, discard all staged enrichment, continue ordinary indexing. |
| Project root/path mismatch | Reject affected documents or the entire import before writes; never resolve outside the project. |
| Occurrence has no unique local definition | Leave the OCBI edge unresolved. |
| SCIP disagrees with an already resolved OCBI edge | Keep the existing OCBI target in milestone one and count the disagreement for benchmark review. |
| Indexing transaction fails later | Existing transaction rollback behavior applies; SCIP input is read-only. |
| Watcher event | Normal OCBI reindex. The import runs only when its file/config fingerprint or relevant source freshness requires reevaluation. No generator runs. |
| Branch/worktree | Resolve the SCIP file from `materializedProjectRoot`; persist adapter metadata under the existing branch catalog identity. |

The adapter must be monotonic in milestone one: it can change `unresolved -> resolved`, never `resolved -> different resolved`.

## Test plan before implementation approval

### Unit tests

Add `tests/scip-typescript-enrichment.test.ts` using a fake executable created in a temporary directory. Tests must cover:

- disabled path performs no process invocation;
- `execFile` argument vector is exact and never shell-expanded;
- missing executable, non-zero exit, timeout, oversized output, malformed JSON;
- absolute paths, `..` traversal, mismatched project roots, and external symbols;
- UTF-8 and UTF-16 columns with non-ASCII identifiers;
- unique definition match, ambiguous definition, no definition, overloads, and duplicate names;
- unresolved-only monotonic overlay;
- deterministic output ordering.

### Indexer integration tests

Extend `tests/call-graph.test.ts` with fixture JSON representing `scip print --json` output:

- path alias import;
- namespace import and re-export chain;
- project reference/workspace target;
- ambiguous method names where type information selects one target;
- stale SCIP file causes heuristic fallback and clears prior enrichment;
- enabling/disabling the flag forces exactly one graph refresh;
- failed enrichment does not fail indexing or alter resolved baseline edges;
- branch/worktree path mapping remains source-backed.

A real end-to-end test must be gated on locally available `scip-typescript` and `scip` binaries. Fake-command tests alone are not sufficient for release approval.

## Benchmark plan and acceptance gates

### Cohort

1. Current OCBI repository at a fixed commit.
2. Existing frozen JavaScript repositories `axios` and `express` from `benchmarks/golden/expanded-cross-repo/cohort.json`.
3. One fixed, type-heavy TypeScript monorepo with path aliases and project references, added as a separate pilot rather than changing current baselines.
4. Hand-labeled fixtures for aliases, re-exports, namespace imports, methods, overloads, inheritance, and Unicode positions.

### Compare

Run three modes against the same commits:

- current OCBI baseline;
- OCBI plus import-only SCIP enrichment;
- SCIP upper-bound analysis, including disagreements with already resolved OCBI edges, without applying those disagreements.

### Metrics

- edge target precision and recall against hand labels;
- resolved-edge rate by language using `summarizeCallGraphCoverage`;
- count and precision of newly resolved edges;
- disagreements with existing resolved edges;
- `architecture_context` source-citation validity and relationship usefulness on `npm run eval:architecture`;
- community count, coupling stability, and hub churn;
- cold and warm index wall time;
- peak RSS of `scip-typescript`, `scip print --json`, and OCBI;
- protobuf size, JSON size, SQLite growth, and temporary disk usage;
- watcher-triggered index latency and fallback latency.

### Go criteria

Proceed beyond an experiment only if all hold:

- at least 98% precision on newly resolved hand-labeled edges;
- at least 10 percentage points improvement in unresolved TypeScript/JavaScript edge resolution on two realistic repositories;
- no regression in existing resolved-edge precision or source-citation validity;
- no architecture evaluation regression beyond the existing budget;
- import overhead at p95 is below 20% of baseline OCBI indexing time for repositories whose JSON stays under the configured cap;
- every missing/stale/crash/timeout case demonstrably falls back without failing ordinary indexing.

If JSON memory or size fails the pilot, stop. The next step would require explicit approval for a direct protobuf decoder dependency or a native streaming decoder, not a larger `maxOutputBytes` default.

## Decision and blockers

**Decision:** Keep this branch document-only. The architecture supports a narrow enrichment overlay, but a safe implementation is not yet validated locally.

**Blockers before code:**

1. install or otherwise provide fixed `scip-typescript` and `scip` binaries for a real fixture run;
2. capture and freeze representative `scip print --json` output;
3. verify exact TypeScript occurrence ranges, definition roles, symbol formats, and UTF-16 handling;
4. measure JSON expansion and peak RSS on this repository;
5. confirm the refresh/fallback path clears previously enriched targets under watcher, config-toggle, branch, and stale-file scenarios.

The recommended next task is a benchmark-only spike with pinned local binaries and no production dependency changes. Implement the adapter only after that spike passes the correctness and memory gates above.
