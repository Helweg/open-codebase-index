# Competitive retrieval results, 2026-09-10

Status: the bounded experiment is complete, including the uniform amended coding rerun. These results do **not** establish overall superiority. OCBI is competitive on this development retrieval cohort and passes the tested structural/freshness workflows, but rivals match or exceed it on several measured endpoints.

## Scope

The frozen development cohort contains 100 tasks across nine pinned repositories: 54 explicit-symbol tasks and 46 natural-language tasks. It is not held-out. File-level Hit@5 means an expected evidence file appeared among the first five distinct returned files, not that the tool found the exact correct symbol or completed a coding task. Three query repeats were recorded, but only the first contributes to quality sample size.

| Configuration | Symbol Hit@5 (54) | Natural-language Hit@5 (46) |
|---|---:|---:|
| OCBI hybrid, ebd0702 | 49/54, 90.74% | 39/46, 84.78% |
| OCBI structural, ebd0702 | 49/54, 90.74% | 36/46, 78.26% |
| CodeGraph 1.6.0 | 54/54, 100% | 38/46, 82.61% |
| codebase-memory-mcp 0.10.8 | 54/54, 100% | Not evaluated by the selected one-call interface |
| grepai 0.36.1 | 39/54, 72.22% | 33/46, 71.74% |

The grepai operational denominator includes nine symbol and nine natural-language tasks from a repository whose index did not reach readiness within the frozen 300-second cap. These are not 18 independently observed inaccurate searches. Conditional on successful setup, its results were 39/45 and 33/37 respectively. Both denominators must be reported.

## Interpretation

- OCBI did not beat CodeGraph or codebase-memory on the primary symbol endpoint. All five OCBI symbol misses were on Gson. Both saved configurations inherit `indexing.maxDepth: 5`; the five target classes are at directory depths 7 or 9. Both manifests contain only 20 files (13 Markdown, four protobuf, three Java module descriptors), producing 104 chunks. None of the five target sources was indexed. This is a verified default discovery-limit failure, not evidence of a ranking defect.
- OCBI hybrid returned one more natural-language hit than CodeGraph, but CodeGraph's natural-language MRR@10 was higher: 0.6727 versus 0.6583. A one-hit difference is not general superiority.
- Structural mode matched hybrid on this symbol track without embeddings, but returned three fewer natural-language hits.
- The primary OCBI-minus-grepai symbol difference was +18.52 percentage points, strongly influenced by the setup timeout. The preregistered repository-cluster bootstrap adjusted interval includes zero. No preregistered superiority threshold was met.

Primary symbol differences and 98.333% percentile cluster-bootstrap intervals (10,000 samples, seed 20260910):

| Rival | OCBI hybrid difference | Adjusted interval |
|---|---:|---:|
| CodeGraph | -9.26 pp | [-40.00, 0.00] pp |
| codebase-memory | -9.26 pp | [-40.00, 0.00] pp |
| grepai | +18.52 pp | [-26.67, +57.89] pp |

Only nine repository clusters are available. These intervals are exploratory, and the machine-readable report also retains per-repository and leave-one-repository-out results.

## Corrections and provenance

The preregistration amendment A1 corrected a schema-driven codebase-memory adapter error: Folder/Channel-only groups are not source-file candidates. Every valid CBM response across all nine repositories was replayed uniformly into separate corrected trees with original-row and raw-response hashes. Original runs were preserved. No query, oracle, product, ordering, or scoring rule was tuned to improve OCBI.

- Protocol: [competitive preregistration](2026-09-10-competitive-preregistration.md).
- Frozen production revision: `ebd07022fe99b95a6ec4c56d5324fd8be6a2941d`.
- Parser correction: `0170744`.
- Replay utility: `c3f9e79`.
- Local artifact root: `/Users/kenneth/.jcode/scratch/ocbi-competitive-20260910`.
- Originals: `results/{repository}-run`.
- Uniform corrected evidence: `results-corrected/{repository}-run`.
- Complete aggregate with denominators and uncertainty: `competitive-report-corrected.json`.

Portable committed evidence: [retrieval metrics](../../benchmarks/results/competitive-2026-09-10/retrieval-report.json), [artifact hashes](../../benchmarks/results/competitive-2026-09-10/provenance.json), and [resource observations](../../benchmarks/results/competitive-2026-09-10/resource-observations.json). Resource observations retain 45 indexing/workspace measurements. Workspace bytes include source and must not be labelled isolated index size. Peak memory and comparable cross-interface speed were not measured. No memory, speed or token-saving superiority claim is supported.

One Cobra/grepai timing run overlapped the end of unrelated calibration. A separate quiet timing repeat is retained and never contributes replacement quality observations. No cross-tool speed claim is made: persistent MCP and one-shot CLI interfaces include different startup overhead. These task-local artifacts have not yet been packaged for public distribution.

## Graph and freshness conformance

All 60 cells completed in `conformance-results-v2` with runner `87ac8f6`. The original run remains preserved. The correction normalizes absolute/relative source identities across all adapters without changing source, answers, or edge policies. The portable [per-cell report](../../benchmarks/results/competitive-2026-09-10/conformance-report.json) records status, reason and original finding hashes.

| Configuration | Graph: pass / mismatch / manual (6) | Freshness: pass / mismatch / manual / adapter-blocked (6) |
|---|---:|---:|
| OCBI hybrid | 6 / 0 / 0 | 5 / 0 / 1 / 0 |
| OCBI structural | 6 / 0 / 0 | 5 / 0 / 1 / 0 |
| CodeGraph | 4 / 1 / 1 | 5 / 0 / 0 / 1 |
| codebase-memory | 6 / 0 / 0 | 6 / 0 / 0 / 0 |
| grepai default fast trace | 1 / 3 / 2 | 0 / 4 / 1 / 1 |

These are exact synthetic-contract outcomes, **not a universal graph-accuracy ranking**:

- OCBI passed all six graph scenarios and correctly exposed additions, deletions, renames, branch round trips, and an external writer to a long-lived reader. The modified-Python-callee scenario remained manual because a public edge was unresolved; the harness did not invent a target path.
- codebase-memory satisfied every specified scenario. Its source-snippet API reads source, so content retrieval alone is not proof of a persisted indexed-body snapshot.
- CodeGraph returned the two expected Python function callers plus two file-level neighbors. The exact function-only contract reports a mismatch. This is a graph-abstraction difference, not proof that its callers are absent or wrong. Duplicate-name disambiguation and a persistent-reader path were not fully calibrated in this adapter and remain manual/blocked, not product-incapability claims.
- grepai used its default fast trace, not optional precise tree-sitter mode. Raw traces missed a JS call and included Python self-edges. After the specified watcher restart/readiness path, deletion, rename and return-to-main queries still returned stale symbol paths. The modified-Python trace missed the new call. Other cells lacked sufficient canonical endpoint/duplicate evidence or a calibrated persistent-reader adapter. These limitations apply to the tested version, mode and workflow.

Refresh was explicit public indexing for OCBI, CodeGraph and codebase-memory. Grepai used foreground watcher restart with observed readiness. The external-writer scenario kept the original reader alive and used a distinct writer process where the adapter supported that boundary. No cells are silently dropped or pooled with the retrieval cohort.

## Coding feasibility

The first two-task, six-condition pilot ran the real local model but produced no valid repairs. Three runs exhausted the tool-call budget and three were aborted. Every condition encountered the same avoidable broker defect: `list({path: "."})` was rejected while omitting `path` listed the root. The summaries also incorrectly recorded zero tool calls on thrown model runs; full transcripts and usage remain available. These are harness-affected outcomes, not evidence that any indexing product cannot help coding.

Amendment A2 froze a root-listing-only correction and accurate attempted-call accounting before one uniform six-cell rerun (`743f531`). Prompts, tasks, model, search interfaces, budgets, order, confinement and hidden evaluator remained unchanged. Independent validation passed 71 tests, including actual OS-denial, reference/mutant, oracle-separation, spoof-rejection and timeout/reaping checks, plus strict script TypeScript and lint.

The amended run also produced **zero valid patches**:

| Condition | Valid repairs / tasks | Terminal outcomes |
|---|---:|---|
| OCBI hybrid | 0 / 2 | One aborted request, one call-budget exhaustion |
| CodeGraph | 0 / 2 | One aborted request, one call-budget exhaustion |
| Literal unindexed baseline | 0 / 2 | Two call-budget exhaustions |

All root-listing errors disappeared. The six runs made 68 attempted broker calls, including the four rejected thirteenth calls beyond the 12-call limit. Exact-text edits often failed to match source, with no source changes left in any run. No run reached candidate evaluation; the preflight did separately verify both reference implementations and seeded failing states. This is failure of the tested model/broker/budget pipeline to deliver a repair, not six hidden-test failures and not evidence isolating an indexing product's coding value.

Both attempts are preserved in the [coding report](../../benchmarks/results/competitive-2026-09-10/coding-pilot-report.json), including raw summary/plan/preflight hashes and corrected first-run counts derived from transcripts. Recorded prompt tokens are cumulative across requests, not unique context size. An aborted response can leave unreported partial generation, so recorded usage is not necessarily complete billing/resource usage. The original and amended attempts are not independent statistical replication.

No further retries, budget increases, or product tuning were performed. A larger held-out coding study was not started because this preliminary pipeline did not demonstrate successful task completion. The bounded feasibility gate, rather than the originally contemplated expanded study, is the stopping point.

## Requirement-to-evidence map

| Question or requirement | Concrete check and observed result |
|---|---|
| Fair current-tool comparison | Pinned source archives, binaries, runtime and local embedding digest; identical 54-symbol inputs and separate 46-text inputs; no expected-answer fields sent to tools |
| Retrieval accuracy and uncertainty | All nine repositories and five configurations completed; corrected report enforces the full 100-task denominator; adjusted intervals support no superiority claim |
| Avoid blaming a tool for parser errors | Uniform CBM replay across the cohort; audit matched 300 original repeat hashes, 162 raw response hashes, and 1,200 unchanged non-CBM repeat files |
| Graph and freshness integration | All 60 public-interface cells rerun after reviewed path normalization; per-cell pass/mismatch/manual/blocked evidence retained; branch return and separate writer with live reader exercised |
| Coding-task benefit | Actual six-cell local model run, one uniformly amended rerun, independent sandbox/reference checks; no valid patch in either run, so no demonstrated coding benefit |
| Main failure modes and scope | Gson source-depth exclusions, grepai setup timeout, unresolved/ambiguous graph endpoints, stale symbol traces, model aborts and edit/call-limit failures explicitly reported |
| Resource advantage | Index timing and workspace/cache observations retained; peak memory and comparable cross-interface timing unavailable; no unsupported efficiency claim |
| Reproducibility and preservation | Frozen manifests and committed harness, separate original/corrected trees, portable reports with hashes; full raw task-local artifacts preserved but not publicly packaged |

## Practical priorities supported by this evidence

1. Make incomplete source discovery visible and reconsider the default depth limit for deeply nested repositories. Do not tune the completed benchmark retroactively.
2. Improve unresolved cross-file graph edges, starting with a separately tested Python import/callee case.
3. Retain provider-free structural mode and truthful branch/external-writer freshness behavior as demonstrated capabilities, without claiming exclusivity.
4. Validate coding assistance with a usable broker and subsequently new held-out tasks across multiple repositories before making productivity or token-saving claims.
