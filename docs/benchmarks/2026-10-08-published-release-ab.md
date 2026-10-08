# Published open-codebase-index 0.35.3 vs 0.36.1 — exposed regression comparison

## Scope and observed conclusion

This is a **development-exposed regression comparison**, not a new independent, blind, representative or confirmatory holdout. It reuses the original frozen October 6 nine-repository, 100-task convenience cohort: Fastify, Hono, Typer, Gin, Clap, Moshi, CsvHelper, Monolog and Rack; 54 explicit-symbol and 46 natural-language tasks. Source-derived tasks and gold were assistant-curated, without independent human review. The cohort was already consumed by development work; historical/model-training and shared-ancestry exposure are not ruled out.

Both participants are actual preferred npm packages, `open-codebase-index@0.35.3` and `@0.36.1`, each in hybrid and structural mode. Neither is a local source build or the readiness PR candidate. The historical October 6 “0.35.3” participant was a local build associated with `969fd34`, **not proven identical to the published release**; these observations are a new study and do not amend historical scores.

All **36 cold-index cells**, **400 pass-one primary rows** and **1,200 query-pass records** completed. There were **zero setup errors and zero query/adapter errors**. Supported failures would have remained zero under the frozen scoring rules; no setup retry, query retry, best-of pass or score-driven configuration change occurred.

On these exposed tasks, the newer published package improved exact-file discovery in both modes. Natural-language hybrid discovery improved more than structural discovery, which retained one task-level regression. This does not establish coding productivity, semantic implementation correctness, general superiority, SOTA, or a speed advantage.

## Pass-one results

Hit@5 is relevant-file discovery, not proof that an implementation body or library closure is correct. All denominators include supported operational failures. Natural task `gin-natural-02` retains the original acceptable alternative file. Hit@1, MRR@10 and nDCG@10 reuse the original scoring equations and labels; other frozen `expectedRoute`/`expectedOutcome` metadata are not separately claimed as graded outcomes.

| Mode | Track | Published 0.35.3 Hit@5 | Published 0.36.1 Hit@5 | New − old | Paired wins / losses / ties |
| --- | --- | ---: | ---: | ---: | ---: |
| Hybrid | Explicit | 40/54 (74.07%) | 54/54 (100%) | +25.93 pp | 14 / 0 / 40 |
| Hybrid | Natural | 22/46 (47.83%) | 35/46 (76.09%) | +28.26 pp | 13 / 0 / 33 |
| Structural | Explicit | 40/54 (74.07%) | 54/54 (100%) | +25.93 pp | 14 / 0 / 40 |
| Structural | Natural | 20/46 (43.48%) | 24/46 (52.17%) | +8.70 pp | 5 / 1 / 40 |

Explicit Hit@1 changed from 40/54 to 53/54 in both modes; newer explicit MRR@10 is 0.990741. Natural MRR@10 changed from 0.360568 to 0.591391 in hybrid mode and from 0.341925 to 0.414208 in structural mode. Full query-weighted/equal-repository means, every task's paired differences and per-repository differences are in [the report](../../benchmarks/results/published-release-ab-2026-10-08/report.json) and [primary CSV](../../benchmarks/results/published-release-ab-2026-10-08/per-task-outcomes.csv).

Each cell below is **explicit hits / 6; natural hits / natural denominator**:

| Repository | Hybrid 0.35.3 | Hybrid 0.36.1 | Structural 0.35.3 | Structural 0.36.1 |
| --- | ---: | ---: | ---: | ---: |
| Fastify | 6/6; 4/5 | 6/6; 4/5 | 6/6; 2/5 | 6/6; 2/5 |
| Hono | 6/6; 3/5 | 6/6; 3/5 | 6/6; 3/5 | 6/6; 3/5 |
| Typer | 6/6; 4/5 | 6/6; 4/5 | 6/6; 4/5 | 6/6; 4/5 |
| Gin | 3/6; 4/5 | 6/6; 4/5 | 3/6; 4/5 | 6/6; 4/5 |
| Clap | 1/6; 0/6 | 6/6; 2/6 | 1/6; 0/6 | 6/6; 2/6 |
| Moshi | 0/6; 0/5 | 6/6; 4/5 | 0/6; 0/5 | 6/6; 3/5 |
| CsvHelper | 6/6; 3/5 | 6/6; 4/5 | 6/6; 3/5 | 6/6; 3/5 |
| Monolog | 6/6; 4/5 | 6/6; 5/5 | 6/6; 4/5 | 6/6; 3/5 |
| Rack | 6/6; 0/5 | 6/6; 5/5 | 6/6; 0/5 | 6/6; 0/5 |

The 14 explicit wins are concentrated in Gin (3), Clap (5), and Moshi (6). The structural natural loss is `monolog-nl-03`. This concentration and known development exposure matter to interpretation.

The predeclared 10,000-draw repository-cluster bootstrap, seed `20261008`, describes this cohort only. Equal-repository Hit@5-difference 95% intervals are `[0, 0.5370]` for explicit queries in either mode, `[0.0667, 0.5259]` for hybrid natural, and `[-0.0444, 0.2370]` for structural natural. They are not population or unseen-project confidence claims. Leave-one-repository-out values are retained in the report. Ranked path lists were identical across all three passes on 100/100 tasks for both hybrid packages, 97/100 for old structural and 98/100 for new structural. **Only pass one determines quality.**

## Source ranges and consumer-returned bodies

The original QA records provide source hashes and supporting/context ranges, **not necessarily complete declaration spans**. Before any participant feedback, `derive-gold.py` used independently installed upstream Python Tree-sitter grammars on the same verified pinned archives to identify exactly one named declaration node per explicit task, with no parse error on the selected node. Its whole inclusive source-line span and exact text were frozen for all 54 explicit tasks. Class spans include their full declaration bodies; Rust struct/trait spans are declarations, not proof of their separate concrete `impl` blocks. Grammar versions, original QA, expected bodies/ranges and exact derivation code are in the final preregistration.

The additive grading keeps distinct:

- Exact pinned-source citation provenance and valid source-contained ranges.
- Target identity in the returned citation header.
- Original QA supporting-evidence overlap and coverage (not exact-span equivalence).
- Independently established full declaration range coverage.
- Complete expected declaration text actually present in the **consumer-returned fenced body**; omitted text is never reconstructed from a source readback.
- Exact returned body versus cited source slice.

Full-declaration range coverage and target-identity Hit@5 are 40/54 → 54/54 in both modes. Complete returned declaration-body Hit@5 is only **8/54 → 14/54** in both modes; exact cited-body Hit@5 has the same counts. The public interface truncates many larger bodies—for example, `hookRunnerGenerator` includes a `// ... (7 more lines)` marker. A correct file/range with omitted body text is not credited as a complete returned body. These measures concern source-text evidence, **not semantic equivalence, inherited behavior, transitive helper/library closure or task completion**. The report does not grade concrete implementation closure for any task.

Natural-language tasks have **file-only gold**. `codebase_peek` returns metadata/citations rather than an implementation body; natural implementation/body correctness is **ungradeable**, not zero and not inferred from a file hit. Raw consumer output remains available.

Post-run provenance verification checked **all 26,418 citations across the 1,200 records**, covering 878 distinct pinned source files: every returned path/hash/range source slice matched the original source manifest and canonical archive extraction. This source readback verifies provenance, not missing consumer body completeness.

## Fixed execution and timing protocol

- Original canonical Git archives were copied byte-identically from the retained October 6 workspace and verified against its frozen archive SHA-256 values. Exact repository revisions, dataset/source/QA hashes and all task labels remain in the final preregistration. Fresh extraction per cell; default participant inclusion/parser policies still differ.
- Four conditions × nine repositories = 36 cells, **serially**, with one shared **300,000 ms** deadline for fresh MCP connection plus forced `index_codebase`. No retry. Each query has a **60,000 ms** deadline; request limit 50, retain at most ten distinct files. Three identical-order passes, pass one alone quality.
- A seeded reproducible schedule (`schedule.py`, Python `Random(20261008)`) balances 18 adjacent version pairs: nine old-first/nine new-first overall; hybrid four/five, structural five/four. Mode and query orders are frozen. The query order is identical across versions/modes/passes within a repository.
- Same existing loopback Ollama `nomic-embed-text` model, `nomic-embed-text:latest` tag digest `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`; model F16, 137M parameters, 768 embedding dimensions, advertised 2,048 context length. No model download or provider fallback. Ollama API version `0.35.1`; model tag digest was rechecked unchanged afterwards.
- Configuration: Ollama provider, `nomic-embed-text`, reranker disabled, auto-index/watch disabled, project marker not required, file size 1,000,000 bytes, max chunks/file 100, unlimited depth and max files/directory 1,000,000. Only declared hybrid/structural mode differs.
- Each participant has owned HOME/TMP/XDG/config/source/index roots. SDK runner uses `@modelcontextprotocol/sdk@1.29.0`; no import from a repository source build. CLI arguments, raw MCP requests/results, stderr, index/status output, environment and cell timing are retained.
- Parent sent explicit `BUILD_GATE_COMPLETE` after source validation. Immutable draft and final preregistrations had been committed at `be5d085` before scoring. Scored execution ran **2026-10-08 08:20:21.332Z–08:48:09.117Z**. No deliberately concurrent benchmark cells, source builds/tests or other embedding/index consumers were launched by this benchmark or parent during execution. **Unrelated host background activity was unmeasured and uncontrolled.** Global services/config/plugins/models/indexes were not changed by the runner.

Fresh archive/config preparation is outside setup timing. Setup includes process initialization, SDK connection and forced indexing. `index_status` was read after indexing and before the first scored query. There is **no excluded first-query warmup**. The first real scored query per fresh process/index is captured separately from later pass-one and pass-two/three queries. The existing Ollama model may already have been resident; model load/initialization and backend request timing are not independently isolated. First-query groups mix the frozen explicit/natural query types and are not synthetic equal-work latency tests.

Observed medians (same MCP interface; descriptive only):

| Condition | Cold setup (s), n=9 | First real query (ms), n=9 | Later pass-one query (ms), n=91 | Passes 2–3 (ms), n=200 |
| --- | ---: | ---: | ---: | ---: |
| 0.35.3 hybrid | 67.195 | 52.438 | 24.028 | 15.963 |
| 0.36.1 hybrid | 75.327 | 57.120 | 38.609 | 18.887 |
| 0.35.3 structural | 2.942 | 21.203 | 18.490 | 16.614 |
| 0.36.1 structural | 3.173 | 21.714 | 22.791 | 20.925 |

These observations **do not support a speed improvement claim**. One index per cell, order effects, changed indexed coverage, already-resident provider state and unmeasured host load prevent broad causal/performance conclusions. Peak memory, billing and network traffic were not independently measured.

## API-reported indexing work and coverage

Successful public `index_codebase` responses report processed files, new embedded chunks, token counts and product durations. The frozen runner extracts these product-reported counters; they are **not independently measured backend calls, actual prompt/token computation, retries or provider traffic**. Structural embedding/token counters, absent/unparseable values and failed setup counters are N/A, never silently zero. Actual backend work remains N/A without a proxy. No failed-embedding counter was present in these responses; its absence is reported N/A rather than a fabricated observed zero.

| Repository | 0.35.3 processed / chunks / reported tokens | 0.36.1 processed / chunks / reported tokens |
| --- | ---: | ---: |
| Fastify | 345 / 5,355 / 927,742 | 348 / 5,470 / 937,008 |
| Hono | 482 / 6,403 / 928,022 | 482 / 6,498 / 941,606 |
| Typer | 731 / 2,932 / 458,922 | 731 / 2,932 / 458,922 |
| Gin | 110 / 1,589 / 250,213 | 110 / 1,589 / 251,131 |
| Clap | 315 / 2,673 / 404,363 | 461 / 5,225 / 846,773 |
| Moshi | 150 / 1,851 / 380,760 | 163 / 3,281 / 453,916 |
| CsvHelper | 615 / 4,859 / 748,984 | 615 / 4,859 / 748,984 |
| Monolog | 127 / 1,418 / 204,712 | 127 / 1,418 / 204,712 |
| Rack | 111 / 1,047 / 174,615 | 112 / 1,048 / 174,677 |
| **Total** | **2,986 / 28,127 / 4,478,333** | **3,149 / 32,320 / 5,017,729** |

The table's chunk/token values are hybrid API reports. Structural API-reported chunk totals are also 28,127 and 32,320, respectively. Raw before/after status responses expose active catalog counts/state, provider/model and mode. Identical supplied archive bytes do **not** imply equal indexed coverage; changed processing/chunk counts are part of the package comparison, not evidence of equal-work speed.

## Publication-byte identity and runtime limits

Both package roots installed from `https://registry.npmjs.org`, with separate exact manifests/lockfiles and retained tarballs. Registry SHA-512 integrity and SHA-1 shasum were checked. All **52 target-package tarball files** matched the corresponding installed bytes for each release. `npm audit signatures --registry=https://registry.npmjs.org --json --include-attestations` exited zero in both roots: 112 verified registry signatures and 19 verified attestations per installation; JSON invalid/missing lists are empty, including the target packages. SLSA provenance/publish attestation bundles are retained in preregistration. No compatibility package identity or local build was substituted.

| Identity | 0.35.3 | 0.36.1 |
| --- | --- | --- |
| Registry tarball SHA-256 | `9e20dea739c55b48451d56fed05eb1d325269b999c70bf2e11ff1899f88815dc` | `1f4492249ff0eb64521911e838dc4882e75ac281ac4b8e86d49ab790aac8027c` |
| Bundled darwin-arm64 native SHA-256 | `1f3c0a31899cf87d51025a3b785826014746570ffe711f61a605a4c7bc018e10` | `76c385d24167d38ac12f01f88a819e58c647791cd78a4f8b02ca99a76e1a29f2` |

The native addon has no separately exported version API; native identity is the exact verified binary shipped in the named package, not an invented native version string. Post-run verification confirmed all **80 frozen bindings** and **13,068 regular dependency files** unchanged.

Host: Apple M2 Max, arm64, 96 GiB RAM; observed macOS 27.0.1/build 26A434, Darwin 27.0.0. Node 26.9.0, npm 11.19.1, Python 3.12.8. Node launcher SHA-256 `91ed66b8cd139609427a3e9d93518dd3b0d5407c737fc9a265bfd991ec623d8a`; linked `libnode.147.dylib` SHA-256 `962d6add54b805dfcdd847d5830baae73e4348928fc1b2fd5e7886ed39a6d7f5`. Ninety-three direct Homebrew library identities were captured before scoring. This is not a recursive dyld/system-library closure, portable OS image or independently measured live Ollama process/model-file inventory. The model tag digest, OS/runtime/API versions, library receipts, exact npm closures and archive/source hashes define the disclosed binding limits.

## Frozen and completed artifacts

All artifacts are **new** under [published-release-ab-2026-10-08](../../benchmarks/results/published-release-ab-2026-10-08/). Historical studies, reports, CSVs and archives are unchanged. The required original 13 result-file hashes, plus nine additional historical result/doc hashes, match before/after receipts.

| Artifact | SHA-256 |
| --- | --- |
| Immutable pre-score draft preregistration | `0a94875e1f1c3693910d5e60258b5c25891dc2b70d86ef127e104f3ff5a58d78` |
| **Final pre-score preregistration** | `5af3759a79b69a95d8c2d528056fea4b068284586987f4000cecb959fbf4e776` |
| Final private protocol | `4e007979dd7fd34ea4d5ec92326052770b57d89079a47bced286ddc96add9d3c` |
| Frozen explicit declaration gold | `737fa25459887a399a9429c4e8103d082bb079a898f7c3c9d110966b5bed85c0` |
| Complete normalized results evidence | `0a3ace56ef0e13e1a098391cab1d845da66e5e17fa007873d2f1acfc7c86e2f0` |
| Public report / replayed analysis | `477f894b78a66a2d68aded6330e9986fc05df3504e030b41b0996dabc6daa4ab` |
| Private durable original archive | `16301559f5c7c2bcb9a4d4fe67c91dbb14cd8a1f20f0b15b2981979d724358d8` |

The initial freeze was preserved unchanged; the final pre-score amendment added API-reported indexing counters and supplementary runtime identities. It did **not** change task labels, gold, modes, timeout budgets or order. Both preregistrations were frozen/committed before any participant indexing/query request.

The compact results archive contains 170 integrity-checked normalized UTF-8 members, including all 1,200 raw query records in `run/rows.json`, all 36 cell records and raw request/result/status streams, stderr/config, expected explicit bodies, scoring programs and input datasets. Original versus normalized hashes are distinguished. This is an **analysis replay**, not a portable timing or model/index runtime image. Upstream archives, exact installations, all native indexes and raw private-path evidence are retained in `${USER_HOME}/.jcode/scratch/ocbi-published-release-ab-20261008-originals.tar.gz` (920,530,168 bytes). Streaming tar/gzip readback verified all 34,732 regular members, including the inventory, byte-identically. See `retention.json` for scope/limits. Pinned source redistribution notices accompany the published snippets in `LICENSE-NOTICES.txt`.

Executed commands (owned root represented as `${PRIVATE_WORK}`):

```sh
# Separate package roots; preparation latency is not comparison data.
npm install --registry=https://registry.npmjs.org --no-audit --no-fund
npm audit signatures --registry=https://registry.npmjs.org --json --include-attestations
# Only after explicit parent BUILD_GATE_COMPLETE:
node programs/run.mjs "${PRIVATE_WORK}"
# No participant retry or new index/query in these post-run programs:
python3.12 programs/analyze.py "${PRIVATE_WORK}"
python3.12 programs/publish.py "${PRIVATE_WORK}" "${COMPARISON_WORKTREE}"
python3.12 benchmarks/published-release-ab-2026-10-08/verify-evidence.py "${PRIVATE_WORK}"
python3.12 benchmarks/published-release-ab-2026-10-08/replay.py \
  benchmarks/results/published-release-ab-2026-10-08/results-evidence.json.gz
```

The exercised public replay verified 170 member hashes and reproduced the report SHA-256 exactly. Final source build/typecheck/lint/test ownership remains with the parent; this benchmark owner did not run source build, tests, lint or formatting.
