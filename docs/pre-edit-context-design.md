# Pre-edit context design

## Decision

Add a new portable `codebase_edit_context` tool rather than changing `codebase_context`.

`codebase_context` is intentionally the low-token, metadata-only discovery entry point. Returning source and graph evidence from it would change its established response shape, token behavior, and agent routing expectations. A separate tool gives agents an explicit, bounded transition from discovery to modification.

## Initial contract

The tool accepts:

- `query`: the requested change or target behavior
- `symbol` and optional `filePath`: an authoritative target when known
- `tokenBudget`: total returned context budget
- `callerLimit` and `calleeLimit`: direct graph-edge limits
- `includeTests` (default false): current-source JS/TS test-reference evidence
- `includeApiImpact` (default false): bounded Express/fetch associations

It returns a single token-bounded evidence pack containing:

1. A bounded excerpt of the authoritative target implementation source, when a symbol resolves.
2. Direct callers and callees for that resolved symbol, with locations and edge types.
3. A short risk note when the target is ambiguous, unresolved, or graph data is unavailable.
4. Conceptual retrieval evidence when no target can be resolved.

The initial release did not claim test coverage. The opt-in test section now reuses native AST-backed `discoverSymbolTests`: direct target references precede graph neighbors, and one-hop caller-test references follow them. Target `filePath` disambiguation leaves test-directory scope independent. Returned callback citations, evidence labels, selected-only structured details, discovery caps, and response omissions remain inspectable; no static link claims runtime coverage or passing tests. See [Tools and commands](tools.md#codebase_edit_context) for the current contract.

Resolved targets use canonical native symbol IDs and declaration coordinates rather than ranked body fragments. The shared per-indexer lookup serves both production and evaluation. Source blocks are capped at 512 tokens, preserve declaration starts and whole-line fences, and leave response space for relationships and test references. Unreadable source retains canonical metadata but receives no source-included credit.

## Integration boundaries

1. Define the request/result contract under `src/tools/contracts.ts`.
2. Implement shared behavior below `src/tools/`, keeping OpenCode, MCP, and Pi adapters thin.
3. Add the canonical name in `src/tools/tool-names.ts` and register the same portable contract for each supported host.
4. Reuse `implementationLookup`, `getCallGraphData`, and the existing context token-budget machinery. Do not duplicate host-specific retrieval logic.

## Evaluation plan

Add a `pre-edit-context` golden set with definition-led modification tasks. Each case must assert:

- target implementation location
- at least one expected graph neighbor when one exists
- maximum response-token budget
- fallback behavior for an ambiguous or unresolved symbol

The acceptance gate is no regression in the existing `agent-context` and representative evaluation suites, plus a documented pre-edit baseline for Hit@5, MRR@10, graph-neighbor recall, p95 latency, and returned tokens.

## Baseline (mock embeddings, 2026-08-06)

The gate runs in CI through `npm run eval:pre-edit:ci` with the deterministic mock-embedding provider and `benchmarks/budgets/pre-edit.json`. The dataset (`benchmarks/golden/pre-edit-context.json`) covers three cases: a resolvable caller lookup, a resolvable target-only lookup, and an unresolved-symbol fallback that must route to the conceptual `search` pack and surface the expected implementation chunk.

| Metric | Baseline | Budget threshold |
|---|---|---|
| Hit@5 | 1.0000 | `minHitAt5` 1.0 |
| MRR@10 | 1.0000 | `minMrrAt10` 1.0 |
| Graph-neighbor recall | 1.0000 | `minGraphNeighborRecall` 1.0 |
| Route accuracy | 1.0000 | `minRouteAccuracy` 1.0 |
| Outcome accuracy | 1.0000 | `minOutcomeAccuracy` 1.0 |
| p95 latency | 672 ms | `p95LatencyMaxAbsoluteMs` 5000 |
| Response tokens average | 314.3 | `maxContextResponseTokensAverage` 600 |
| Response tokens p95 | 394.9 | `maxContextResponseTokensP95` 800 |
| Response tokens max | 404 | `maxContextResponseTokensMax` 1000 |
| Duplicate candidate ratio | 0.0 | `maxContextDuplicateCandidateRatio` 0.5 |
| Selected-file ratio | 0.8571 | `minContextSelectedFileRatio` 0.5 |
| Hit@5 per 1k response tokens | 3.181 | `minContextHitAt5Per1kResponseTokens` 1.0 |
| MRR@10 per 1k response tokens | 3.181 | `minContextMrrAt10Per1kResponseTokens` 1.0 |

The budget gate also supports `minRouteAccuracy` and `minOutcomeAccuracy` so unresolved-query fallback behavior is enforced when queries assert `expectedRoute` and `expectedOutcome`.

## Explicit non-goals

- No new parser or call-resolution heuristic in the first release.
- No inferred test coverage claims.
- No source expansion beyond the requested token budget.
- No breaking change to `codebase_context`.
