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

SCIP enrichment, API impact evidence, structural indexing and workspace readiness remain under integration review. Passing readiness checks does not establish their correctness or improve the previously measured retrieval scores.

### Intermediate integration observations

These are snapshot-specific observations, not approval of the final combined tree:

| Requirement / boundary | Check | Observed result |
|---|---|---|
| Structural indexing without provider traffic | Built CLI on the same 342-file source corpus, with child-process network APIs configured to reject and count connection attempts | Indexed 6,722 structural chunks. Three successful index/definition/callers processes each recorded zero attempts. No mock embedding implementation was substituted. |
| Structural restart retrieval | New CLI processes against the persisted structural index | `parseConfig` definition returned `src/config/schema.ts:225-475`; graph lookup returned 22 callers. Status reported provider `none`, structural mode and active count 6,722. |
| Preserve hybrid artifacts | Run hybrid-configured definition lookup after creating the isolated structural child index | The existing hybrid definition remained retrievable. This is not yet a complete mode-transition or recovery gate. |
| SCIP enrichment must not mutate another checkout's graph | Real Git checkout regression with no branch-name or catalog-identity overrides | Branch A retained its exact resolved target after branch B used a missing decoder and then disabled enrichment; restarting A preserved its target. |
| Workspace status must retain live-WAL visibility without changing repository files | Workspace regression suite including bundled CLI execution against a structural writer with a live WAL | Focused suite passed. Snapshot reading preserves visible persisted/active chunks and tests require unchanged repository file listings. Source freshness remains explicitly `not_checked`. |
| Public workspace command leaves the full repository unchanged | Independently hash every file before and after built `cbi workspace status --repo baseline=... --host opencode --json` | All 469 files and the file tree were unchanged byte-for-byte. Output reported hybrid mode, active count 6,722, ready coverage and `freshness: "not_checked"`. The scratch repository has no commit, so `actualHead` correctly remained null. |
| Real handler plus symbol-free consumers appear through the public tool | Run a small real Express server, then built OpenCode `index_codebase` and `codebase_edit_context(includeApiImpact: true)` with explicitly configured local Ollama/nomic embeddings | Runtime returned HTTP 201. Indexing processed three files/four chunks. Output cited the route at `src/server.js:4`, top-level fetch at `src/client.js:1`, and conventional test callback at `tests/server.test.js:2`, with the expected distinct evidence labels. This is a deliberately small representative fixture, not broad application coverage. |
| MCP error behavior and branch compatibility after refactoring | Independent run of MCP server, knowledge bases, workspace, CBI CLI, worktree and SCIP test files | All 113 tests across six files passed after earlier error-classification and legacy-fixture failures were corrected. |

The earlier whole-suite run failed: 1,848 of 1,858 tests passed. Failures included a newly added native method absent from the then-loaded binary, an unsupported-operation error imported from a mocked module, structural fixtures, and an outdated legacy-catalog expectation. The focused rerun above closes only its covered failures. A fresh native build and complete rerun remain required.

The first independent API indexing attempt was cancelled while waiting on local Ollama. Its scratch configuration incorrectly nested provider/model under `embedding`, which only controls batching. Repeating with the supported root `embeddingProvider` and `embeddingModel` fields completed successfully in 6.8 seconds. This corrects the acceptance setup, not production provider selection behavior.

Review also identified pending checks for missing/empty structural keyword artifacts with matching generation markers, config-only SCIP lifecycle changes through normal `cbi index`, and API metadata under tight output budgets. These must pass before completion. The structural corpus run predates the latest publication/recovery changes and must be repeated on the final build.

Final requirements remain: review the actual integrated diff, native rebuild and tests, TypeScript build/typecheck/lint/full suite, clean-package public-interface acceptance, and identical-corpus evaluation with per-query deltas. No competitor-superiority or completed coding-task success claim follows from these checks alone.
