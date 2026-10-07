# Assistant-curated exploratory comparison — round 2, 2026-10-07

Status: **completed, including three operational setup failures**. Candidate `d44449d` was fully verified and frozen before acquiring new source heads or authoring tasks. Protocol, source/task labels and actual project/tool bytes were committed as `b7358d3` before scoring. This is an assistant-curated descriptive file-discovery study, **not an independently reviewed, exposure-free or representative holdout**. The [prior study](2026-10-06-self-curated-study.md) and its results remain byte-unchanged.

## Observed results

Execution ran from **2026-10-07T06:55:02.969Z to 2026-10-07T07:51:01.910Z**: nine repositories, 100 tasks, seven conditions, **63 cells, 700 first-pass outcomes and 2,100 query-pass records**. Candidate/input/runtime/model locks checked unchanged before and after. Repeat 1 alone determines quality. No retries, score exclusions or post-score runtime/query/gold/configuration changes.

All **102 supported error-pass records receive zero file-discovery scores** and remain in the supported denominator; they propagate three setup failures. Unsupported mappings are reported separately, not treated as missed supported answers.

| Condition | Exact-symbol Hit@5, 54 tasks | Natural-language Hit@5, 46 tasks | Setup-failed primary tasks |
|---|---:|---:|---:|
| OCBI hybrid | **47/54 — 87.0%** | **30/46 — 65.2%** | 11 |
| OCBI structural | **53/54 — 98.1%** | 29/46 — 63.0% | 0 |
| CodeGraph | **54/54 — 100.0%** | 16/46 — 34.8% | 0 |
| codebase-memory-mcp | 53/54 — 98.1% | Unsupported selected mapping | 0 |
| grepai | 38/54 — 70.4% | 27/46 — 58.7% | 23 |
| Literal/unindexed | 44/54 — 81.5% | 0/46 — 0.0% | 0 |
| Plain-file BM25 | 47/54 — 87.0% | 24/46 — 52.2% | 0 |

OCBI hybrid trails CodeGraph and CBM on the preregistered exact endpoint. Its positive observed difference against grepai includes asymmetric setup failures; it is **not established retrieval superiority**. OCBI hybrid has the most natural Hit@5 successes in this cohort, but that descriptive ordering does not establish superiority on unseen projects. Structural exact lookup succeeds on 53 targets without setup failures, with one Pino declaration miss.

The cohorts differ from the prior study. **These aggregate percentages are not an old/new causal improvement estimate.** [Candidate development checks](2026-10-07-candidate-development-diagnosis.md) separately document exposed Rack diagnosis, rejected ranking variants, controlled representative deltas, Kotlin/cache smoke and complete gate history.

### Per-repository outcomes

Cells are **exact hits, natural hits**. Exact denominator is six per repository; natural denominator is five except Sequel's six. `—` is unsupported. `E` marks a setup-failed cell, not observed wrong query rankings.

| Repository | Hybrid | Structural | CodeGraph | CBM | grepai | Literal | BM25 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Pino | 5, 4 | 5, 3 | 6, 1 | 5, — | 6, 5 | 3, 0 | 4, 1 |
| Zod | 6, 2 | 6, 3 | 6, 0 | 6, — | 4, 4 | 5, 0 | 5, 2 |
| Requests | 6, 3 | 6, 3 | 6, 2 | 6, — | 5, 4 | 3, 0 | 6, 1 |
| Echo | 6, 5 | 6, 4 | 6, 1 | 6, — | 5, 5 | 5, 0 | 5, 4 |
| Bytes | 6, 4 | 6, 4 | 6, 2 | 6, — | 6, 4 | 6, 0 | 6, 4 |
| kotlinx-datetime | 6, 3 | 6, 2 | 6, 3 | 6, — | 6, 1 | 5, 0 | 6, 2 |
| Humanizer | 0, 0 E | 6, 4 | 6, 2 | 6, — | 0, 0 E | 6, 0 | 3, 3 |
| Flysystem | 6, 4 | 6, 3 | 6, 4 | 6, — | 6, 4 | 6, 0 | 6, 3 |
| Sequel | 6, 5 | 6, 3 | 6, 1 | 6, — | 0, 0 E | 5, 0 | 6, 4 |

All 700 primary outcomes are available in [per-task CSV](../../benchmarks/results/self-curated-round2-2026-10-07/per-task-outcomes.csv): questions, relevant files, status, returned files/ranks, metrics and errors. Unsupported metrics are blank. The [full report](../../benchmarks/results/self-curated-round2-2026-10-07/report.json) also includes all paired task outcomes, repository/query-weighted aggregates, Hit@1, MRR@10, nDCG@10, three-pass stability, operational observations and read-only coverage/source diagnostics.

### Paired outcomes and uncertainty

Wins/losses/ties are OCBI hybrid relative to the other condition at Hit@5. Setup-error pairs are included, not removed.

| Other condition | Exact wins / losses / ties | Natural wins / losses / ties |
|---|---:|---:|
| CodeGraph | 0 / 7 / 47 | 17 / 3 / 26 |
| CBM | 1 / 7 / 46 | 46 unsupported pairs |
| grepai | 10 / 1 / 43 | 8 / 5 / 33 |
| Structural, secondary | 0 / 6 / 48 | 6 / 5 / 35 |
| Literal, secondary | 10 / 7 / 37 | 30 / 0 / 16 |
| BM25, secondary | 4 / 4 / 46 | 10 / 4 / 32 |

Ten-thousand-draw **repository-cluster bootstrap** descriptions; seed `202610072`, nine convenience clusters. The 98.333% intervals address three predeclared exact-track rival comparisons. Values are percentage points, OCBI hybrid minus rival. Intervals do not establish population representativeness or confirmatory superiority.

| Rival | Exact Hit@5 difference | 95% interval | 98.333% interval | Leave-one-repository-out range |
|---|---:|---:|---:|---:|
| CodeGraph | −13.0 | [−35.2, 0.0] | [−44.4, 0.0] | [−14.6, −2.1] |
| CBM | −11.1 | [−33.3, 0.0] | [−44.4, 0.0] | [−12.5, 0.0] |
| grepai | +16.7 | [0.0, +40.7] | [−1.9, +48.1] | [+6.3, +20.8] |

Query-weighted and equal-repository exact means coincide because each repository has six tasks. Natural equal-repository Hit@5 differs slightly: hybrid 64.8%, structural 63.3%, CodeGraph 35.2%, grepai 60.0%, BM25 51.9%; the main table uses query-weighted means.

Nine task-condition rankings changed lower returned paths across repeats: hybrid Pino `nl-03`, structural Pino `nl-04`, structural Humanizer `nl-01`–`nl-04`, hybrid Sequel `nl-01`/`nl-06`, structural Sequel `nl-06`. **No recorded score metric changed.** All pass records are retained; no best-of-repeat selection.

## Operational failures and source-backed findings

There were **1,860 successful, 102 error and 138 unsupported pass records**. All 102 errors propagate setup failure; no ready-cell scored query or saved warmup failed. Error-placeholder durations are not backend query timings.

1. **Humanizer / OCBI hybrid:** five-minute MCP index-request timeout; whole-cell duration **300,255.5 ms**. All 11 tasks × three passes become errors without query invocation. Retained SQLite contains 17,364 chunks across 896 paths and matching cached embeddings, with corresponding vector metadata. Substantial work exists, but there is no successful index response establishing final readiness. OCBI adapter stderr was counted, not persisted; no phase diagnostic establishes the final blocking step. Complete corpus acquisition, CPU/embedding cause and why completion exceeded budget remain unproved. This is not an empty-index or wrong-ranking result.
2. **Humanizer / grepai:** watcher readiness timeout, **300,023.8 ms**; 11 × three error records. Logs lack required readiness markers; pre-shutdown counters reached 493/2,054.
3. **Sequel / grepai:** watcher readiness timeout, **300,032.1 ms**; 12 × three errors. Pre-shutdown counters reached 718/867. Both grepai logs emit outstanding embedding cancellations **after shutdown**; later 100% counters do not prove successful indexing. No score-driven longer budget or retry was applied.
4. **Pino exact declaration:** `getCallers` in `lib/caller.js:13–40` is a named function expression assigned to `module.exports`. Both OCBI modes retain the body as an unnamed `expression_statement` chunk but omit `getCallers` from the persisted symbols table. Saved exact outcomes are `not_found` in every pass. This establishes a declaration-representation gap, not missing source or merely a low file rank. The responsible upstream extraction rule remains unisolated; no new parser experiment or score correction occurred.
5. **Natural misses:** successful OCBI outcomes contain 28 Hit@5 misses across 18 tasks: 11 hybrid, 17 structural. Every primary gold file has chunk-file presence; 27 also have some symbol-file presence, with structural `sequel-nl-05` the exception. This is **not** proof of adequate implementation/declaration coverage or a ranking cause. The report enumerates each ID, relevant file, saved returned ranks and metadata observations, including both acceptable Zod deep-partial implementations.
6. **Kotlin endpoints:** both OCBI modes found all six new kotlinx-datetime exact targets at rank one. Hybrid natural gold ranks were **1, 3, absent, absent, 4**: 3/5 Hit@5. This does not prove universal grammar completeness or causal improvement over the old Moshi cohort.

These read-only post-score annotations did not issue retrieval/index/embedding calls or amend scores. Next development priority: **large embedding-index completion/readiness**, then Pino's exported named function-expression declaration. This cohort is now development-exposed; subsequent fixes need separate evaluation rather than relabeling a tuned rerun as fresh.

## Frozen inputs, rights and evidence replay

- Candidate freeze **05:40:22.054Z**, before fresh acquisition; full build/typecheck/lint/test gate passed (2,646 tests, six skipped), optimized Rust 145 passed, final built MCP Kotlin smoke passed. Locally rebuilt `0.35.3` is not published-release byte identity.
- Protocol/task freeze **05:55:17.615Z**, committed `b7358d3` before first scored request. [Preregistration](../../benchmarks/results/self-curated-round2-2026-10-07/preregistration.json.gz): 75 text artifacts; SHA-256 `268df163a1f5d31f8ede4ce7f78171a72a936d4348753aeb4728f608dfd2ce8b`.
- [Completed evidence](../../benchmarks/results/self-curated-round2-2026-10-07/results-evidence.json.gz): **3,778 normalized text artifacts**, all 2,100 pass records, available raw responses/logs, readiness/index observations, warmups, configurations, full analysis and actual publication programs; SHA-256 `06684446fa6f4edcad6fc718e5461bbc03727810c20a7576839203804dd70906`.
- [Report](../../benchmarks/results/self-curated-round2-2026-10-07/report.json): SHA-256 `14447aa6918b7084a07170fba405dc5dec897a784393caf2c117d22be7cf103d`.
- [Publication verification](../../benchmarks/results/self-curated-round2-2026-10-07/verification.json): **3,853 embedded hashes checked, 1,860 successful raw returned-file lists replayed, all 2,100 records rescored, full report/paired outcomes/bootstrap intervals reproduced exactly**. No participant request during replay. Hash-verified pinned source archives are required for raw path containment; native indexes are not.

Source heads were pinned before inspection, excluding all 18 prior-study repository identities. Canonical Git archives honor export attributes and are identical across conditions. Pre-score QA replaced a Flysystem local MIME wrapper excluded by that archive with an inspected checksum-stream trait and removed excluded AWS adapter alternatives; the initial failure and source-only correction receipt are preserved. Scoped licenses were inspected rather than inferred from GitHub metadata: selected MIT code, and Apache-2.0 Requests/kotlinx-datetime code with required notices and exceptions distinguished. Source curation, source snippets, ranges, full-file hashes, licenses and duplicate-definition alternatives were frozen outside participant roots.

Original private-path records, source archives, indexes and actual project/comparator runtime snapshots are retained locally; see [retention metadata](../../benchmarks/results/self-curated-round2-2026-10-07/retention.json). Public text is explicitly normalized, with original and normalized SHA-256 values distinguished. Upstream archives, native indexes and runtime binaries are not redistributed.

## Claim limits

Assistant source-author/internal AI checks are not independent review. Convenience selection, source-derived wording and shared AI annotation remain biased; historical/model-training exposure is unknown. Pino appeared as a prior Fastify dependency and Zod is used by OCBI dependencies. Different source identities do not prove novelty. Equal supplied archives do not imply equal indexed coverage. Selected CBM natural mapping is unsupported, not universal upstream incapability. Unchanged-question literal matching is weak; whole-file BM25 shares OCBI's native tokenizer and is not best-in-class lexical tuning.

Node/rg entry executables, project/tool artifacts and the selected model manifest were bound, but **the transitive OS/Homebrew dynamic-library graph was not fully byte-bound**. Retained snapshots are not a portable whole-runtime image. Host background load, peak memory, billing and network traffic were not independently measured. No cross-interface-speed, unseen-project superiority, independent holdout, `accepted_novel`, implementation-span correctness, graph-identity, coding-productivity or universal-SOTA claim follows.
