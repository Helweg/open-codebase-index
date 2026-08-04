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

It returns a single token-bounded evidence pack containing:

1. The authoritative target implementation source, when a symbol resolves.
2. Direct callers and callees for that resolved symbol, with locations and edge types.
3. A short risk note when the target is ambiguous, unresolved, or graph data is unavailable.
4. Conceptual retrieval evidence when no target can be resolved.

The first release must not claim test coverage or related-test certainty. The current index has test-path-aware ranking, but no durable test-to-symbol relationship. Test discovery is a separate, measurable follow-up.

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

## Explicit non-goals

- No new parser or call-resolution heuristic in the first release.
- No inferred test coverage claims.
- No source expansion beyond the requested token budget.
- No breaking change to `codebase_context`.
