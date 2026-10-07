# Candidate corrections and exposed-development diagnosis, 2026-10-07

Candidate source: `d44449d09ead0fcd0cb70d0631dcfff5b54ae65a`. This work precedes the separately frozen [round-two assistant-curated comparison](../../benchmarks/results/self-curated-round2-2026-10-07/). The prior [2026-10-06 study](2026-10-06-self-curated-study.md) is unchanged; its Rack tasks are **development-exposed**, not new evaluation evidence.

## Kotlin declarations and existing-cache upgrade

The native parser now recognizes `.kt` and `.kts` rather than falling back to generic text. Tree-sitter Kotlin declarations feed the existing persistence and exact-symbol lookup paths, including classes, interfaces, enums, annotations, objects/companions, functions/methods, named properties and type aliases. Kotlin call extraction uses syntactic evidence; it does not invent runtime dispatch, overload selection or constructor certainty from capitalization.

An old index without the branch-scoped `index.parser.kotlinVersion=1` marker selectively reparses unchanged Kotlin files. Other languages and existing indexes are retained. The marker is written on no-change, checkpoint and final indexing paths. A local property is not treated as an executable caller for calls in its initializer.

Pinned grammar: `tree-sitter-kotlin-ng=1.1.0`, upstream commit `77dd60ea0a9003ce062c9728a513ffe1aaff8c82`. Its scanner rejected valid one-line class bodies, including a named companion followed by another declaration. The vendored patch permits the zero-width member separator immediately before `}`; it does not rewrite source input or weaken fixtures. The generated parser is unchanged, SHA-256 `9ff65161845b9e9c9d62c12e9a4e4b8d8628bdc31c681ec7e6b4bd3bd6444cb3`. Attribution and patch scope are recorded in `THIRD_PARTY_LICENSES.md`.

Built MCP runtime smoke exercised fresh and selectively upgraded indexes in **both hybrid and structural modes**: classes, properties, methods, aliases, escaped ASCII names, script declarations and resolved calls. Source bytes remained unchanged. The public bare-symbol route still requires its existing ASCII identifier contract; Unicode or space-containing names are not silently promised exact lookup.

## Rack: candidate acquisition succeeded, hard promotion displaced evidence

The old five Rack natural questions were rerun only against an isolated copy of their exposed source/index. All five gold files entered retrieval. The failure was therefore not proved missing source acquisition:

| Old task order | Semantic gold-chunk rank | Keyword gold-chunk rank | Fused gold-chunk rank | Hard-tier rank |
|---|---:|---:|---:|---:|
| 1 | 115 | 1 | 15 | 102 |
| 2 | 42 | 5 | 2 | 63 |
| 3 | 1 | 1 | 7 | 83 |
| 4 | 82 | 2 | 2 | 133 |
| 5 | 1 | 1 | 1 | 99 |

Previously, definition/implementation prose could be classified as an explicit identifier lookup, and the first three ordinary prose words could become identifier hints. That converted useful balanced source/name evidence into a hard exact-style promotion tier. Gold chunks then fell outside the first 50 candidates.

The candidate removes prose-prefix identifier guesses and no longer treats definition intent alone as exact-identifier evidence. Actual quoted/code-shaped identifiers, path-qualified names and single meaningful identifiers remain supported. Existing identifier lanes are **retained under RRF balancing** for ordinary source questions without explicit hints.

A broader attempt to disable those lanes entirely was rejected: the representative suite fell from **75.0% to 62.5% Hit@5**, including watcher/lock misses. Restoring the lanes while correcting intent recovered **75.0%**. The final exposed Rack gold-file ranks are **3, 2, 2, 2, 2**—five development Hit@5 successes, not a fresh-study improvement claim.

## Controlled representative comparison

Old TypeScript ranking from `ca805a8` and candidate ranking were compared using the **same updated source corpus, native binary and representative dataset `2.2.1`**. This is not an old-release-versus-new-release comparison. The legitimate path-helper ownership gold moved with that helper; incompatible historical fingerprints were not overwritten or used to declare a pass.

Both final variants scored **75.0% Hit@5** across 16 quality-scored queries. MRR changed from **0.6692708333 to 0.6661458333**: one watcher query's first relevant file moved from rank 4 to 5. All per-query deltas were inspected and retained.

After an initial candidate latency-gate outlier, a three-pair serial validation plan was written before executing those pairs. All six results are retained, including one old-engine latency failure. Candidate p95 values were **132.795, 122.512 and 126.577 ms**, versus old-engine **303.450, 118.156 and 123.797 ms**. All three candidate gates passed. These observations do not establish a speed improvement.

## Cancellation entry and verification history

The full gate exposed a pre-cancelled MCP request that started diagnostic writes before aborting, creating late files during teardown. The shared entry now checks cancellation before configuration/diagnostic initialization. Regression and actual API smoke checked cancelled indexing, search and lookup: `OPERATION_CANCELLED`, no handler/progress/diagnostic artifacts and no leaked cancellation reason.

Final clean required gate:

```sh
npm run build && npm run typecheck && npm run lint && npm run test:run
```

Observed: **2,646 tests passed, six skipped; 142 test files passed, one skipped**, with build, typecheck and lint green. Optimized Rust: **145 passed**. Final built-MCP Kotlin smoke passed after that rebuild. Candidate runtime/source hashes were frozen at **2026-10-07T05:40:22.054Z**, before acquiring round-two source heads or authoring tasks.

Failures were not suppressed. An earlier debug Rust community timing check exceeded its one-second limit; the optimized suite passed without modifying that algorithm. An unchanged native-watcher refresh path also timed out once in a full run. Six instrumented and ten unwarmed runtime refresh observations passed; the final unmodified full suite passed. **The watcher timeout's cause remains unestablished.** Temporary tracing was removed and the original test restored before the final gate.

## Evidence and limits

[Candidate development evidence](../../benchmarks/results/self-curated-round2-2026-10-07/candidate-development-evidence.json.gz) contains **29 normalized text artifacts**: all three Rack ranking-stage traces, representative before/rejected/final results and deltas, serial validation plan/execution records, diagnostic observations, built MCP smoke sources/results and full-gate history. SHA-256: `d2e4f5c15f34034f358cd28f0bd06b30b8f68f55c96ac181a3a43aca2f65295f`.

Original and normalized content hashes are distinguished. The preregistration's candidate-freeze receipt is the authority for final verification; earlier failed/pending receipts remain historically intact. No independently reviewed holdout, release-byte identity, universal parser completeness, unseen-repository quality or coding-productivity claim follows from these development checks.
