# Descriptive identifier retrieval: v0.29.0 before/after

Date: 2026-09-13. This is a development-cohort evaluation of one local ranking fix, **not a competitor comparison or evidence of general superiority**.

## Result

| Independent track | Before | Final candidate |
|---|---:|---:|
| Natural-language file Hit@5, 46 tasks | 43/46 (93.48%) | **44/46 (95.65%)** |
| Natural-language MRR@10 | 0.718116 | **0.748732** |
| Explicit-symbol file Hit@5, 54 tasks | 54/54 | 54/54 |
| Explicit-symbol MRR@10 | 0.969136 | 0.969136 |
| Internal representative Hit@5, 16 positive tasks plus one negative control | 75.00% | 75.00% |
| Internal representative MRR@10 | 0.635417 | 0.645833 |
| Pre-edit context Hit@5 / MRR@10, 3 tasks | 100% / 0.833333 | 100% / 0.833333 |

All nine indexes and all 100 fixed-cohort query operations succeeded in the final comparison. All 167 expected evidence paths were present in active `default` branch catalogs. No fixed-cohort Hit@5 case regressed. The recovered case is `newtonsoft-json-contract-resolver-keyword-heavy`: `DefaultContractResolver.cs` reaches distinct-file rank 5 instead of being absent from the returned 50 chunks.

**Two first-relevant-file ranks became worse**, despite the net improvement:

- `newtonsoft-json-converter-keywords`: `JsonConverter.cs` moves from first relevant file rank 3 to 4.
- `symfony-console-command-dispatch-keywords`: `Command.php` moves from rank 1 to 2, after `TraceableCommand.php`.

Both remain Hit@5. These are retained and reported, not removed from the denominator. They arise because descriptive queries now retain fused relevance ordering instead of blanket identifier-lane precedence. No query-specific prefix, top-five promotion rule, or expectation adjustment was added to eliminate these tradeoffs. The JsonReader and Sinatra misses remain unresolved.

Diagnostic graded-order nDCG also decreases on five public queries: Axios transport controls, Newtonsoft converter keywords, ripgrep JSON printer events, ripgrep preprocessor/decompression, and Symfony command dispatch. nDCG was not the primary or secondary acceptance endpoint. Every before/after value is retained in the portable evidence; this is not a claim that every ordering metric improves.

## Causal evidence and bounded correction

The contract-resolver query already generated the correct implementation at keyword rank 1 and hybrid distinct-file rank 5. Later identifier lanes demoted it to chunk rank 106 and distinct-file rank 16 before the final 50-result limit. Its result list contained 37 chunks from `ContractResolverTests.cs`.

A query that describes behavior while mentioning types is not necessarily requesting those types' declarations. The fix separates that situation from explicit identifier lookup:

- Descriptive source-preferring queries with actual identifier hints do not prepend identifier rescue/definition lanes.
- Implementation-path blocks remain eligible for these descriptive queries. This matters for unnamed C# block evidence.
- Explicit definition/implementation requests, lone-identifier lookup, and existing source-preferring queries without identifier hints retain their previous lane and chunk-type behavior.
- Candidate generation, fusion weights, external reranker implementation, file filters, page-aware PDF deduplication, and public request/result schemas are unchanged.

Round-robin file diversification was investigated and rejected as the primary intervention: it preserves first-file order, so it cannot move a missing file past five distinct files that already precede it. Dotted `.Tests` classification was not changed in this patch.

## Controls and evidence

Baseline: v0.29.0, commit `b97c1ebae05a9c9afde6e18bc1a9a126a2a8c092`.

- Node 22.21.1; local Ollama `nomic-embed-text:latest`, digest `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`.
- Nine production revisions and unchanged 100-task datasets from [the existing source lock](../../benchmarks/competitive/2026-09-10/source-lock.json).
- Identical absolute source/index roots before and after. Indexing uses hybrid mode, `maxDepth: -1`, `maxFileSize: 1000000`, `maxChunksPerFile: 100`, no watchers, no auto-index, and no external reranker.
- Natural-language requests use public MCP `codebase_peek(query, limit=50)`; explicit-symbol requests use `implementation_lookup(query=symbol, limit=50)`. No expected-answer fields enter tool requests.
- The unchanged adapter validates candidates, deduplicates files in returned order, and scores the first ten distinct files. Quality uses one scored repeat, with the existing first-supported-query warmup separate. Errors remain in the full denominator.
- Built JavaScript, native binary, runtime, source-tree, dataset, configuration, adapter, scorer, wrapper, and local model hashes were frozen. The candidate source patch hash is retained separately from the base commit.
- Internal representative17/pre-edit3 use a fixed v0.29.0 source snapshot and identical roots/budgets. They are not pooled with the production cohort or compared to an older source snapshot.

[Portable per-query evidence](../../benchmarks/results/2026-09-13-identifier-promotion.jsonl) records all 100 before/after file orders and metrics, all 20 internal before/after cases, unchanged public query inputs, and original-record hashes. The first record contains configuration and provenance. Original public MCP responses, source archives, traces, and frozen scratch runners are retained locally, not bundled in that compact artifact. The artifact supports auditing the reported scores; it is not a turnkey replacement for those acquisition/indexing runners.

For a fresh reproduction, use the locked production revisions, the recorded configuration/model/runtime, and the public MCP requests above with the unchanged adapter/scorer. Maintain identical physical roots across variants and independently validate indexed evidence eligibility. Do not use the historical runner's old executable lock unchanged for a new build.

## Requirement-to-check mapping

| Requirement or changed behavior | Concrete check and observed result |
|---|---|
| Improve actual descriptive retrieval | Rebuilt public MCP full100 comparison recovers contract resolver at file rank 5; NL Hit@5 rises 43 to 44 of 46. |
| Preserve symbol lookup | All 54 public symbol tasks retain identical Hit@5/MRR; Indexer regression preserves lone identifier and `definitionIntent` authoritative class results. |
| Preserve source preference without identifier hints | Regression checks existing lane ordering for a no-hint query; full internal17 restores baseline Hit@5 and improves aggregate MRR. |
| Retain descriptive implementation blocks | Frozen-index query trace confirms recovered C# block evidence; integration regression exercises block-bearing implementation retrieval and full tier ordering. |
| Preserve scoped definitions and document handling | Existing scoped-definition and PDF indexing/deduplication regressions pass in the focused gate. No filter/schema/PDF code is modified. |
| Keep evaluator and denominator unchanged | Independent comparison asserts identical query sets and inputs, exactly 46/54 tasks, and reports every changed file order and rank loss. |
| Preserve pre-edit behavior | All three real CLI pre-edit evaluation cases retain Hit@5 100%, MRR 0.833333. |

## Iterations and limitations

The final Node 22.21.1 project gate passed: `npm run build`, `npm run typecheck`, `npm run lint`, and `npm run test:run -- --maxWorkers=1` (131 test files, 2,263 passed, 5 skipped). The focused lookup/ranking/PDF gate also passed. These checks are separate from the public retrieval measurements above.

The first candidate improved the fixed cohort but regressed internal representative Hit@5 from 75% to 68.75%. It was rejected. The final refinement preserves unrelated no-identifier source behavior and restores that guard. Both candidate runs remain retained; this is development-driven iteration, not a held-out confirmation.

An early baseline attempt was cancelled for harness provenance defects. A subsequent operational series retained a stale scratch-lock failure rather than scoring it as a ranking defect. Ownership was verified, the abandoned lock was quarantined reversibly, and a uniform error-free baseline was rerun. None of those partial/error series is silently mixed into the headline baseline.

The final chained command reached the orchestration timeout after fixed100 and representative output were complete. The pre-edit remainder was run separately and completed successfully. A timeout is not reported as a passing command.

No statistical significance, runtime speedup, current competitor advantage, or downstream coding-task improvement is claimed. Latency varied between runs and is not an acceptance claim. The four historical Gson natural-language misses were fixed by discovery coverage already present in v0.29.0, not by this ranking patch.
