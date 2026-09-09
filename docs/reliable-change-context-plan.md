# Reliable Change Context Plan

## Purpose
Provide an authorized implementation roadmap for the requested reliability work while keeping this effort **measurement-first**.

- Scope: benchmark planning + implementation policy design only.
- Source of truth for baseline claims: `/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/results/baseline-representative/2026-09-09T18-48-55-366Z/`.
- Baseline repo revision: `e8e947f8359ee92b2fa2cea9d85efe00cd878f30`.
- Baseline run command (from snapshot):
  ```bash
  public node dist/cli.js eval run --project SNAPSHOT --config SNAPSHOT/.github/eval-ollama-full-config.json --dataset SNAPSHOT/benchmarks/golden/representative.json --output RESULTS --reindex
  ```
  where `SNAPSHOT=/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/baseline-project`.

## Baseline artifacts (authoritative)
- [Summary JSON](/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/results/baseline-representative/2026-09-09T18-48-55-366Z/summary.json)
- [Per-query JSON](/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/results/baseline-representative/2026-09-09T18-48-55-366Z/per-query.json)
- [Eval config](/Users/kenneth/.jcode/scratch/ocbi-competitive-implementation-20260909/baseline-project/.github/eval-ollama-full-config.json)

> Note: all link targets are absolute paths on the local host and exist at write time.

## Authorized roadmap
1. **Readiness diagnostics preserving strict branch isolation**
   - Add explicit checks that enforce branch-scoped readiness before any mutable operation.
   - Validate index freshness, branch ownership, and lock state before claiming readiness.
   - Emit machine-readable diagnostics including reasons and recovery hints.
   - **Status:** _pending (not implemented in this snapshot)_

2. **Optional SCIP with real compiler artifact checks, monotonic/stale fallback gates**
   - Add optional SCIP ingestion path that is strictly opt-in and feature-gated.
   - Require compiler artifacts for enabled repos; if missing or stale, gracefully fallback to existing graph/symbol path.
   - Gate transitions by monotonic freshness to avoid regression from older artifacts.
   - **Status:** _pending (not implemented in this snapshot)_

3. **One API handler-consumer-test workflow**
   - Define one end-to-end API handler + consumer contract test per release-relevant behavior.
   - Cover both success and failure/recovery signaling on the same handler boundary.
   - Keep test scope narrow and deterministic to avoid false confidence.
   - **Status:** _pending (not implemented in this snapshot)_

4. **Opt-in provider-free structural indexing**
   - Add a path to index structure-only metadata without requiring embedding provider calls.
   - Keep existing embedding mode default unchanged.
   - Ensure callers can opt-in per configuration/command.
   - **Status:** _pending (not implemented in this snapshot)_

5. **Explicit workspace readiness contract**
   - Add explicit readiness model consumed by route/operation execution.
   - Define and expose readiness state enum (`ready`, `degraded`, `requiresIndex`, `branchMismatch`, `staleArtifacts`, etc.).
   - Require explicit state transitions instead of implicit assumptions.
   - **Status:** _pending (not implemented in this snapshot)_

6. **Full regression and public acceptance gates**
   - Add acceptance criteria tied to retrieval and safety regressions.
   - Require regression checks before any roadmap milestone can be considered complete.
   - Publish public-facing baseline and follow-up acceptance matrix for changes.
   - **Status:** _pending (not implemented in this snapshot)_

## Acceptance matrix (authoritative, planned)

| Work item | Acceptance criteria | Evidence required | Current status |
|---|---|---|---|
| Readiness diagnostics with branch isolation | Mutating operations refuse when branch or lock scope is mismatched; diagnostic includes branch, lock owner, and stale index status | Integration test + diagnostic snapshots | Pending |
| Optional SCIP path with compiler-artifact gates | Optional mode only; rejected when artifacts missing/stale; fallback behavior deterministic and logged | Feature-flag tests + integration test with stale artifact fixture | Pending |
| API handler-consumer workflow | One workflow validates both handler contract and consumer interpretation, including recovery path | End-to-end test + fixture payload assertions | Pending |
| Provider-free structural indexing | Structural-only mode runs without embedding provider configuration and returns non-embedding-derived evidence metadata | CLI + API contract test + benchmark smoke run | Pending |
| Workspace readiness contract | Tool routing/operations block when readiness is not stable; explicit state transitions visible to observability | Unit + integration tests with readiness transitions | Pending |
| Full regression/public acceptance | Baseline and post-change benchmarks stay non-regressive on declared KPIs and failure buckets | Baseline + follow-up `eval` runs, diff report, and release note-ready summary | Pending |

## Baseline outcome framing for next plan execution
- Baseline results are **measured only** in this document. All implementation work is marked pending.
- Baseline metrics indicate `Hit@5` at 75% with `queryCount=17`, `datasetVersion=2.2.0`, and negative-control exclusion was applied for denominators.
- Failure buckets currently include: `wrong-file` (3), `wrong-symbol` (3), `no-relevant-hit-top-k` (1).
- The baseline run includes 17 queries and one run explicitly marked as **not superior** by source run context.
- This plan does **not** claim completion of these roadmap items.

## Reproducibility caveats
- Provider and env are part of baseline constraints (`ollama`, `nomic-embed-text`, debug metrics enabled).
- Branch and dataset are fixed to the scratch snapshot above.
- No additional implementation or code-logic edits are included in this deliverable.
