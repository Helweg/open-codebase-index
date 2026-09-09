# Reliable change-context validation

Status: in progress, not a release approval. Observations below apply to the implementation snapshots tested on 2026-09-09. The final integrated tree must repeat the acceptance and regression gates before completion.

## Branch readiness

The public CLI was exercised against the isolated full source corpus used by the [baseline evaluation](benchmarks/2026-09-09-reliable-change-context-baseline.md), not a copied implementation or mocked CLI. The corpus is the exact `e8e947f8359ee92b2fa2cea9d85efe00cd878f30` source snapshot. Only this scratch project's branch reference and index were changed. The original user index was not rebuilt or moved.

| Requirement / output | Concrete check | Observed result |
|---|---|---|
| Distinguish stored chunks from active coverage | Built `cbi status` on previously unindexed `acceptance-missing` branch | Before: 6,722 stored chunks and compatible provider with no missing-branch diagnosis. After: `Indexed chunks (all branches): 6,722`, state `missing`, active count `0`, registered `no`, and normal-index recovery guidance. |
| Do not substitute another branch's evidence | Built `cbi definition parseConfig` before recovery | No definition returned. The status warning explicitly says other branches' chunks are not current-branch evidence. |
| Recover through ordinary public workflow | Built `cbi index`, then a new-process `cbi status` and `cbi definition parseConfig` on the missing branch | Normal indexing completed for 342 files. Status became `ready`, active count `6,722`, registered `yes`. Definition returned `src/config/schema.ts:225-475`. The printed token count was zero; the CLI's historical "new chunks embedded" wording is not proof of new provider requests. |
| Preserve original branch membership during recovery | Real Indexer/SQLite/Git regression in `tests/branch-readiness.test.ts` | Missing-branch normal indexing restored search and retained the original branch's exact sorted chunk IDs. Embedding responses are mocked only in this regression, not in the full-corpus public check above. |
| Known-empty catalog cannot return stale unscoped chunks | Remove both chunk and symbol memberships but retain the completion marker, then search | New regression first reproduced a stale `readinessTarget` result. Recognizing the completion marker in branch prefiltering changed the observed result to an empty list. |
| Preserve true legacy project handling | No membership rows and no completion marker | Status remains explicitly `legacy`, rather than manufacturing a registered catalog. |
| Long-lived reader follows checkout | Switch a real Git checkout after reading status | Current runtime refreshes to the changed checkout and reports its missing catalog. It does not remain pinned to the old branch. |
| Unreadable catalog is not reported ready | Database catalog read throws in regression | Status returns not indexed with a warning instead of throwing or claiming coverage. |
| Global catalog scope remains strict | Separate global-scoped regression index, then switch to an unindexed branch | State is missing and search returns no other-branch evidence. |
| Existing formatting and branch workflows remain compatible | Readiness, tools-utils and automatic-branch-index test files | 95 tests passed after the known-empty prefilter correction. |

Local artifacts: scratch `readiness-public-recovery.log`; background task `179912qzz0` (missing-branch public status/definition), `229440s17k` (normal public recovery), and `344788ktyn` (95-test regression run). These identifiers are local evidence references, not published downloadable artifacts.

## Other features and final gate

SCIP enrichment, API impact evidence, structural indexing and workspace readiness remain under integration review. Their acceptance results must be recorded separately, including unsupported cases and failure behavior. Passing readiness checks does not establish their correctness or improve the previously measured retrieval scores.

Final requirements remain: review the actual integrated diff, native rebuild and tests, TypeScript build/typecheck/lint/full suite, clean-package public-interface acceptance, and identical-corpus evaluation with per-query deltas. No competitor-superiority or completed coding-task success claim follows from these checks alone.
