# Reliable code-change context

Status: implementation in progress. Baseline: `e8e947f8359ee92b2fa2cea9d85efe00cd878f30`.

## Goal

Improve OCBI's usefulness for code changes while preserving local operation, branch isolation, existing host contracts and user indexes. The user authorized implementation, not only planning. Features remain pending until their public acceptance checks pass. No release, publication or merge is part of this authorization.

## Stages and acceptance

| Stage | Intended behavior | Required observations | Status |
|---|---|---|---|
| Current baseline | Record existing retrieval and pre-edit quality before changes | Public eval CLI on an isolated exact source snapshot; query-level outcomes and repeat run | Measured, see [baseline report](benchmarks/2026-09-09-reliable-change-context-baseline.md) |
| Readiness | Distinguish global stored chunks from active-branch readiness; provide actionable recovery | Missing, empty, populated and legacy catalogs; no cross-branch leakage; normal indexing restores readiness; host output contracts | Public recovery and focused regressions verified; integrated gate pending |
| Optional SCIP enrichment | Resolve only existing unresolved JS/TS call edges to unique existing local symbols | Real generated compiler index improves known unresolved targets; no invented reference-as-call edges; Unicode, path, cancellation, timeout, stale/disabled/restart cases preserve correctness | Pending |
| API change impact | One supported ecosystem exposes handler, matching consumers and relevant test evidence through existing change-context tools | Each relationship has source citations and an evidence class; ambiguous/dynamic cases explicitly remain uncertain; public tool response respects budget and existing behavior | Pending |
| Provider-free indexing | Opt-in structural and keyword retrieval without an embedding provider; semantic default unchanged | Clean indexing, restart, definitions, callers, keyword search, updates/deletes and mode transitions; zero embedding requests in provider-free mode | Pending |
| Workspace readiness | Make repository/branch identity and readiness explicit beyond existing knowledge-base directory support | Independent repository identity and revision reporting; no fabricated cross-repository graph links; scope/path boundaries retained | Pending |
| Final validation | Demonstrate outcomes and preserve compatibility | Actual diff review, build/typecheck/lint/tests, applicable native rebuild/tests, clean-package public acceptance, baseline comparison with per-query deltas | Pending |

## Design boundaries

- Missing branch membership must not silently fall back to another branch's source evidence. A compatible embedding model does not establish branch coverage or freshness.
- Existing indexes are preserved. Baseline and destructive/failure-path checks use isolated task directories.
- SCIP is import-only, disabled by default. No automatic generator, package installation, remote service, or shell invocation in production. The first pilot may change an unresolved edge to a resolved edge, never overwrite an already resolved target.
- Compiler artifact freshness and provenance need explicit validation. Modification-time checks alone are not cryptographic proof that an artifact matches a source tree.
- API evidence is change-impact retrieval, not a new application API or a generic contract-test framework. Test files linked by route/source evidence are not claimed to prove runtime coverage.
- Prefer extending existing shared operations rather than multiplying host-specific tools. A named workspace does not by itself establish cross-service dependencies.
- Recommendations are hypotheses. Retain optional enrichment only if measured benefit and correctness justify it. Do not alter evaluation expectations merely to pass a gate.

## Baseline and comparison scope

See the [baseline report](benchmarks/2026-09-09-reliable-change-context-baseline.md). The representative dataset measures retrieval behavior. The pre-edit dataset measures evidence selection and graph neighbors. Neither measures completed coding tasks or current competitor superiority.

Before final acceptance, rerun identical datasets/configuration over the fixed source corpus using the changed implementation and inspect each delta. New capabilities require their own real public-interface checks as well as regression tests. Agent task-success and broader competitive evaluations must be labeled separately from retrieval scores.

See [implementation validation](reliable-change-context-validation.md) for requirement-to-check observations and remaining gates.
