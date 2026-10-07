# Assistant-curated exploratory comparison — round 2, 2026-10-07

This is a **new assistant-curated file-discovery cohort**, not an independently reviewed or exposure-free holdout. The prior [2026-10-06 study](../self-curated-2026-10-06/) remains unchanged.

## Frozen before scoring

- Candidate: `d44449d09ead0fcd0cb70d0631dcfff5b54ae65a`, locally rebuilt OCBI `0.35.3`; not a published-release byte-identity claim.
- Full build/typecheck/lint/test gate passed before candidate freeze: 2,646 tests passed, six skipped. Optimized Rust: 145 passed. Built MCP Kotlin smoke passed in hybrid and structural modes.
- Candidate freeze: **2026-10-07T05:40:22.054Z**, before acquiring the new repository heads and authoring tasks.
- Protocol/input freeze: **2026-10-07T05:55:17.615Z**, before any scored request.
- `preregistration.json.gz`: **75 embedded UTF-8 artifacts**, SHA-256 `268df163a1f5d31f8ede4ce7f78171a72a936d4348753aeb4728f608dfd2ce8b`. Original private-byte hashes and normalized public-content hashes are distinguished.
- Nine pinned repositories: Pino, Zod, Requests, Echo, Bytes, kotlinx-datetime, Humanizer, Flysystem, Sequel. Exact commits, source archives/manifests, rights scopes, questions, source ranges, full-file hashes and ambiguities are embedded or hash-bound.
- 100 tasks, **54 exact-symbol and 46 natural-language**, 100 distinct primary source files; nine repository clusters.
- Seven conditions: OCBI hybrid/structural, CodeGraph `1.6.2`, codebase-memory-mcp `0.11.0`, grepai `0.37.0`, literal ripgrep, whole-file BM25. Current official versions and copied isolated installation bytes were verified; these were not freshly reinstalled.
- **35,026 actual project/tool execution artifacts** byte-bound; Node `v26.9.0`, Darwin ARM64 and the existing local Nomic model digest are pinned.
- Synthetic seven-condition runtime smoke passed. Pre-score archive QA corrected Flysystem labels excluded by Git export attributes; the initial failure and source-only correction receipt are retained.

## Protocol

Serial fresh repository/condition indexes; seed `202610072`; three query passes, first pass alone determines quality. One excluded supported-query warmup. Expected matrix: **63 cells, 700 primary outcomes, 2,100 query-pass records**. No score-driven retries, query/gold/configuration edits or runtime fixes. Preserve unsupported mappings and all operational failures.

Primary endpoint: exact-symbol relevant-file Hit@5. Secondary file metrics, natural-language outcomes, per-task comparisons, source coverage, repeat stability and interface-specific durations. Three predeclared hybrid-versus-rival exact comparisons use 10,000 repository-cluster bootstrap draws, 95% and 98.333% intervals and leave-one-repository-out sensitivity.

## Claim limits

Source-author/internal AI QA is not independent review. Convenience selection and source-derived questions remain biased; historical/pretraining exposure is unknown. Pino was referenced as a prior Fastify dependency, and Zod is used by OCBI dependencies. New repository identities do not prove novelty. Equal supplied archive bytes do not imply equal indexed coverage. Selected CBM natural mapping is unsupported, not a universal upstream-capability claim. Literal unchanged-question matching is intentionally weak; whole-file BM25 shares OCBI's native tokenizer. No general-superiority, universal-SOTA, implementation-span, graph-identity, coding-productivity or cross-interface-speed claim is authorized.

## Completed results and replay

Execution: **2026-10-07T06:55:02.969Z–07:51:01.910Z**; all **63 cells, 700 primary outcomes and 2,100 pass records** retained, frozen locks unchanged. All 102 pass errors propagate three setup failures: OCBI hybrid/Humanizer and grepai/Humanizer/Sequel. There were 1,860 successful and 138 unsupported records; no ready-cell scored-query errors, retries or score amendments.

| Condition | Exact Hit@5 / 54 | Natural Hit@5 / 46 |
|---|---:|---:|
| OCBI hybrid | 47 | 30 |
| OCBI structural | 53 | 29 |
| CodeGraph | 54 | 16 |
| codebase-memory-mcp | 53 | Unsupported |
| grepai | 38 | 27 |
| Literal | 44 | 0 |
| Plain-file BM25 | 47 | 24 |

- [Complete findings and clustered uncertainty](../../../docs/benchmarks/2026-10-07-self-curated-round2-study.md).
- [All 700 per-task outcomes, CSV](per-task-outcomes.csv); unsupported metric fields are blank.
- [Full report](report.json), SHA-256 `14447aa6918b7084a07170fba405dc5dec897a784393caf2c117d22be7cf103d`.
- [Completed evidence](results-evidence.json.gz): 3,778 text artifacts, SHA-256 `06684446fa6f4edcad6fc718e5461bbc03727810c20a7576839203804dd70906`.
- [Actual publication replay](verification.json): 3,853 embedded hashes checked, all 1,860 successful raw returned-file lists replayed, all 2,100 records rescored, primary report and intervals reproduced exactly without participant requests.
- [Exposed-development candidate diagnosis](../../../docs/benchmarks/2026-10-07-candidate-development-diagnosis.md) and [29-artifact development archive](candidate-development-evidence.json.gz); these are not fresh-study scores.
- [Durable private evidence retention](retention.json).

Operational zeros and different new tasks prevent a causal old/new improvement estimate. The transitive OS/Homebrew dynamic-library graph was not fully hash-bound; entry executables and project/tool bindings are not a portable whole-runtime image. Next development targets are embedding-index completion/readiness and Pino's omitted exported named function-expression symbol. This cohort is now development-exposed.
