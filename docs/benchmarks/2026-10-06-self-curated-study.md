# Self-curated exploratory comparison, 2026-10-06

Status: **completed; results unfavorable to OCBI**. This is an assistant-run, self-curated exploratory study requested by the maintainer, not an independently reviewed blind holdout. The protocol was committed locally as `976ff12` before scored execution. Outside recruitment in [issue #420](https://github.com/Helweg/open-codebase-index/issues/420) was withdrawn, not fulfilled; no targeted invitation was sent. This route is separate from the [independent-study protocol](2026-10-06-competitive-evidence-plan.md), does not satisfy its approval/novelty gates, and does not fabricate `accepted_novel` evidence.

## Observed results

The frozen run completed **63 repository-condition cells, 700 first-pass outcomes and 2,100 query-pass records**, from `2026-10-06T11:59:38.554Z` to `2026-10-06T13:02:46.177Z`. No setup or query errors occurred. The 138 unsupported pass records are the selected CBM natural-language mapping: 46 tasks × three repeats, not operational failures or zero-scored supported answers. Input, runtime, model and candidate byte locks remained unchanged.

**OCBI did not outperform any of the three primary rivals on exact-symbol file discovery in this sample.** On natural-language file discovery it trailed grepai and the declared whole-file BM25 control, while exceeding CodeGraph. These are descriptive findings on this self-curated cohort, not confirmatory superiority/inferiority or SOTA claims.

| Condition | Explicit-symbol Hit@5, 54 tasks | Natural-language Hit@5, 46 tasks |
|---|---:|---:|
| OCBI hybrid | 40/54 — **74.1%** | 22/46 — **47.8%** |
| OCBI structural | 40/54 — 74.1% | 20/46 — 43.5% |
| CodeGraph | 54/54 — **100.0%** | 15/46 — 32.6% |
| codebase-memory-mcp | 54/54 — **100.0%** | Unsupported selected mapping |
| grepai | 46/54 — 85.2% | 33/46 — **71.7%** |
| Literal/unindexed | 43/54 — 79.6% | 0/46 — 0.0% |
| Plain-file BM25 | 44/54 — 81.5% | 30/46 — **65.2%** |

The [machine-readable report](../../benchmarks/results/self-curated-2026-10-06/report.json) includes all 700 first-pass outcomes with questions, gold paths, returned paths and scores; Hit@1, MRR@10 and nDCG@10; per-repository metrics; every paired task outcome; operational observations; coverage snapshots; and post-score diagnoses. Quality is always repeat 1. Three OCBI-structural tasks changed lower-ranked returned paths across repeats (`hono-nl-01`, `typer-nl-02`, `clap-natural-06`); their scored metrics did not change. Other recorded task-condition rankings were stable.

### Repository breakdown

Cells show **explicit hits, natural hits**, not percentages. Each repository has six explicit tasks; natural denominators are five except Clap, which has six. `—` means unsupported, not a miss.

| Repository | OCBI hybrid | OCBI structural | CodeGraph | CBM | grepai | Literal | BM25 |
|---|---:|---:|---:|---:|---:|---:|---:|
| fastify | 6, 4 | 6, 2 | 6, 3 | 6, — | 5, 3 | 6, 0 | 6, 1 |
| hono | 6, 3 | 6, 3 | 6, 2 | 6, — | 5, 3 | 2, 0 | 4, 3 |
| typer | 6, 4 | 6, 4 | 6, 1 | 6, — | 4, 2 | 5, 0 | 4, 2 |
| gin | 3, 4 | 3, 4 | 6, 3 | 6, — | 6, 4 | 6, 0 | 6, 4 |
| clap | 1, 0 | 1, 0 | 6, 3 | 6, — | 6, 4 | 4, 0 | 6, 4 |
| moshi | 0, 0 | 0, 0 | 6, 1 | 6, — | 5, 5 | 6, 0 | 6, 3 |
| csvhelper | 6, 3 | 6, 3 | 6, 0 | 6, — | 3, 3 | 4, 0 | 3, 4 |
| monolog | 6, 4 | 6, 4 | 6, 0 | 6, — | 6, 4 | 4, 0 | 4, 5 |
| rack | 6, 0 | 6, 0 | 6, 2 | 6, — | 6, 5 | 6, 0 | 5, 4 |

### Paired outcomes and uncertainty

Wins/losses/ties are OCBI hybrid relative to the other condition at relevant-file Hit@5. No paired supported query had an operational error.

| Other condition | Explicit wins / losses / ties | Natural wins / losses / ties |
|---|---:|---:|
| CodeGraph | 0 / 14 / 40 | 14 / 7 / 25 |
| CBM | 0 / 14 / 40 | 46 unsupported pairs |
| grepai | 7 / 13 / 34 | 6 / 17 / 23 |
| OCBI structural, secondary | 0 / 0 / 54 | 2 / 0 / 44 |
| Literal, secondary | 10 / 13 / 31 | 22 / 0 / 24 |
| BM25, secondary | 10 / 14 / 30 | 7 / 15 / 24 |

The preregistered primary comparison is the explicit-symbol track. Intervals below are **repository-cluster bootstrap descriptions**, not independent confirmatory inference; the 98.333% intervals address the three predeclared primary rival comparisons. Differences and intervals are percentage points, OCBI minus rival.

| Rival | Observed Hit@5 difference | 95% interval | 98.333% interval | Leave-one-repository-out difference range |
|---|---:|---:|---:|---:|
| CodeGraph | −25.9 | [−53.7, −5.6] | [−59.3, 0.0] | [−29.2, −16.7] |
| CBM | −25.9 | [−53.7, −5.6] | [−59.3, 0.0] | [−29.2, −16.7] |
| grepai | −11.1 | [−42.6, +16.7] | [−50.0, +22.2] | [−18.8, −2.1] |

All nine repositories have equal explicit task counts. Query-weighted and equal-repository explicit Hit@5 therefore agree. Natural-language repository means differ slightly: OCBI hybrid 48.9%, CodeGraph 32.2%, grepai 71.9%, BM25 65.2%; the main table uses query-weighted means.

### What failed

Post-score inspection was read-only: no production changes, scored retries, label changes or score amendments.

1. **Clap source-policy exclusion: five explicit misses.** Ten of its twelve gold files, including five natural tasks, lie under `clap_builder/` and are absent from OCBI's stored chunk catalog. The built-in `**/*build*/**` rule in `src/utils/files.ts:47-66` matches that production directory. A separate source-policy probe found all ten ignored by OCBI defaults but not by upstream `.gitignore`; the two targets outside that directory were not automatically excluded. The frozen worker contains the same rule. Unlimited traversal does not override this exclusion. `Usage` returned a benchmark file, not the absent gold implementation.
2. **Gin receiver-method catalog defects: three explicit misses.** The target files have chunks, but `WriteHeaderNow`, `findCaseInsensitivePathRec` and `ValidateStruct` are absent from the stored symbol names. The declaration at `binding/default_validator.go:47` is cataloged as `error`; other receiver methods are recorded as return-type names such as `int` and `bool`. This is observed missing/misnamed declaration coverage, not a proved receiver-qualification mismatch. The precise generic-parser fallback mechanism was not independently established by a new parser experiment.
3. **Moshi Kotlin declaration support: six explicit misses.** All six `.kt` target files have generic `text`/`block` chunks, but no symbol entries. Native `Language::from_extension` does not recognize Kotlin and falls back to `Text`. `executeImplementationLookup` classifies the bare symbol query and explicitly enables exact catalog lookup (`src/tools/execute-common.ts:132-151`), so text presence cannot rescue the absent declaration symbols. This does not prove that every natural-language miss has the same cause.

OCBI hybrid also missed 24 natural tasks: five gold files were absent because of the Clap exclusion; the other nineteen had stored chunk records. File presence alone does not establish adequate declaration/body evidence or isolate a ranking defect. Rack is a particularly clear retrieval-quality follow-up: 0/5 OCBI hybrid versus 5/5 grepai and 4/5 BM25 in this sample.

The exact-symbol route consults the persisted symbol catalog, not embeddings. These fourteen misses therefore identify acquisition/declaration work before any conclusion about replacing the embedding model. Hybrid added two natural-language hits over structural here; both were in Fastify.

### Published evidence and replay

- [Completed evidence archive](../../benchmarks/results/self-curated-2026-10-06/results-evidence.json.gz): 3,894 normalized UTF-8 files, including all 2,100 pass records, available raw SDK/CLI responses, index observations, excluded warmups, exact configurations, full analysis/coverage data and the actual analysis/publication programs. SHA-256: `f414dec3a77e0c32e808c60b15903548fc4c869938bfdfda0bba663644b64c13`.
- [Report](../../benchmarks/results/self-curated-2026-10-06/report.json) SHA-256: `a18c9a2582ebeb401690c212f6ef075716e4a21590fd7dec499e9827f08be436`.
- [Publication verification](../../benchmarks/results/self-curated-2026-10-06/verification.json) preserves the executed replay program and observations. SHA-256: `d60d563df3fe1d42a39fd62e3e1b058e7464c9e562cad11ac4a60c99866f26de`.

The published normalized archives were actually decoded and checked: **3,936 embedded content hashes verified; all 1,962 successful raw returned-path lists replayed; all 2,100 records rescored; the complete primary report, paired outcomes and bootstrap intervals reproduced exactly.** No participant retrieval request was made during replay. Raw path containment validation requires the nine hash-verified pinned source archives; score/report rebuilding alone does not require native indexes. The replay program is embedded in `verification.json`, and expects `OCBI_PROJECT` plus `OCBI_STUDY_ROOT` containing `archives/<repository>-<revision>.tar`.

Original private-path records, source archives, native indexes and isolated comparator installations are preserved in a 768,711,988-byte local archive; [retention metadata](../../benchmarks/results/self-curated-2026-10-06/retention.json) records its normalized local path, SHA-256 and successful full gzip-integrity/completion-member checks. This is not a portable runtime image. Published text is explicitly normalized, not asserted byte-identical to originals. Full upstream archives, runtime binaries and native indexes are not redistributed. Source manifests preserve relevant license/notice text. The preserved September evidence was not modified.

## Frozen inputs

The [preregistration archive](../../benchmarks/results/self-curated-2026-10-06/preregistration.json.gz) embeds 42 pre-run files: the protocol, source/interface/runtime locks, all task datasets and curation evidence, internal source-QA annotations, mechanical validation, complete source manifests, the actual temporary coordinator/preparation/validation programs, acquisition evidence and unscored smoke observations.

- Compressed archive SHA-256: `7be6e9854a882b294bedaecab35daeec6ea35ad5386f533899b43fee0f8f4ba2`.
- Original frozen protocol SHA-256: `4b9e3892c4a914cf24d29a4dfbc911897c3ad8d30e34b32c55784569e0085033`.
- Original source-lock SHA-256: `2a024bf74df0ee8b95dadaeedc76a3afd299d5ae267205e1e931fb86dc1916e5`.
- 41 exact input files are checked against the frozen protocol; 34,861 interface/runtime artifacts are byte-bound, including all 33,180 regular installed project dependency files and internal dependency symlink targets.

Absolute project/workspace/home paths are normalized explicitly in published UTF-8 content. Each embedded file records **original** and **normalized** SHA-256 separately; normalized evidence is not asserted byte-identical to private-path originals. Runtime binaries and repository archives are pinned by hashes and public identities, not redistributed.

Repository selection preceded source inspection and participant responses. These repositories differ from the **known** exposed September nine; no exhaustive history, shared-ancestry or model-training novelty audit is claimed. A concrete shared-code risk remains: **Typer incorporates/adapts Click**, which was in that exposed prior cohort. This was recorded before scoring, not erased by selecting a different repository name. This is a convenience language-oriented sample, not representative sampling or a powered superiority study.

| Repository | Pin | Observed task language | Explicit / natural tasks |
|---|---|---|---|
| [fastify](https://github.com/fastify/fastify) | `0d945819bebc08f4ca666d8283c03a26ed9706a0` | JavaScript | 6 / 5 |
| [hono](https://github.com/honojs/hono) | `5f36607f67aa9357887337328ac84a1c1d48dc04` | TypeScript | 6 / 5 |
| [typer](https://github.com/fastapi/typer) | `11b083b92126fb8e149ab9e7d5c9a0f5594dfe58` | Python | 6 / 5 |
| [gin](https://github.com/gin-gonic/gin) | `43fe48e8a0f44af783116cdb010725e6bb50255f` | Go | 6 / 5 |
| [clap](https://github.com/clap-rs/clap) | `4be56132cf7a5ef6e237409a13225a5829cb24e4` | Rust | 6 / 6 |
| [moshi](https://github.com/square/moshi) | `889013ec2edb8d8034902662a1dc8c4f3b3f8111` | Kotlin | 6 / 5 |
| [CsvHelper](https://github.com/JoshClose/CsvHelper) | `33970e5183383bdac1fbce3b3fbcdf46b318ca52` | C# | 6 / 5 |
| [monolog](https://github.com/Seldaek/monolog) | `3bed304b1905fed5c30d172872f4d890cbb03c6a` | PHP | 6 / 5 |
| [rack](https://github.com/rack/rack) | `a9833c8f3bd6b6d1e0ab35de00a1f1a16b5095f5` | Ruby | 6 / 5 |

The initial Moshi language assumption was Java; current production implementations at its **unchanged pin** are Kotlin. Java examples were not substituted. Actual checked-in license terms, including CsvHelper's MS-PL OR Apache-2.0 and Rack's MIT code license, override partial `NOASSERTION` metadata. Source manifests preserve license/notice text and hashes; the Rack logo's separate license is not treated as a source-code license.

The 100 tasks have 100 distinct primary production files. Internal AI source checks corrected feature/scope wording before freeze without changing gold files. Exact byte/path/range/schema validation passed all **54 explicit-symbol and 46 natural-language tasks**. These checks are not independent human annotation or authenticated novelty review. Questions and labels remain outside participant source roots and are not passed as retrieval arguments.

## Participants and interfaces

| Condition | Frozen installation | Selected file-discovery interface |
|---|---|---|
| OCBI hybrid | locally built `0.35.3` bytes, associated with main `969fd34` | MCP `implementation_lookup` / `codebase_peek` |
| OCBI structural | same bytes; structural indexing | same MCP endpoints; **not pure BM25** |
| CodeGraph | `1.6.2`, exact npm/platform package | CLI `query` / `context --no-code` |
| codebase-memory-mcp | `0.11.0`, official checksum-verified binary | CLI `search_graph` after `index_repository` |
| grepai | `0.37.0`, official checksum-verified Darwin ARM64 asset | CLI `search`, local nomic embeddings |
| Literal/unindexed | ripgrep `15.1.0`, exact executable hash | unchanged fixed-string symbol/question; lexicographic file order |
| Plain-file BM25 | frozen native `InvertedIndex` only | whole UTF-8 text files, `k1=1.2`, `b=0.75`; no graph/vector/path/intent boosts |

Local OCBI bytes are **not proven byte-identical to the published release**. Node `26.9.0`, npm `11.19.1`, Ollama `0.35.1`, the native module, executed scripts, installed dependency bytes and existing `nomic-embed-text:latest` digest are frozen. Official latest metadata still matched the selected versions when preparation ran. No model download or hosted source-upload interface was selected; network behavior was not independently captured.

BM25 uses the existing native lowercase Unicode-alphanumeric tokenizer, discards tokens at most two bytes long, and performs no stemming/stopword/synonym expansion. Scores are normalized by the native implementation without changing rank; ties are resolved by path before the 50-hit boundary. It shares OCBI's native tokenizer, not OCBI's retrieval pipeline, and is not presented as tuned best-in-class BM25. Both lexical baselines use the same regular UTF-8 text corpus, excluding NUL-containing/oversized files, `.git` and symlinks. Literal natural-language phrase matching is not a competent keyword rewrite; BM25 supplies the separate lexical control.

## Execution and scoring

Each condition receives a fresh extraction of the identical pinned Git archive, honoring export attributes. Native ignore/language policies still differ; equal input bytes do not imply equal indexed coverage. OCBI traversal depth is unlimited and its per-directory file cap effectively uncapped **before scoring**, avoiding the known nested-source acquisition limitation. Other inclusion/parser policies remain in effect; files over 1,000,000 bytes remain out of scope.

- Serial repository/condition cells; fixed per-repository shuffle seed `20261006 + repositoryIndex`.
- One cold index per cell, one excluded first-supported-query warmup, three query passes. **Repeat 1 alone determines quality**, never best-of repeats.
- 300-second index and 60-second query bounds; request 50 raw hits and retain the first ten distinct returned files.
- Planned and completed: 63 cells, 700 first-pass quality outcomes, 2,100 query-pass records.
- Primary endpoint: exact-symbol **relevant-file Hit@5**. Secondary: Hit@1, MRR@10, nDCG@10, natural-language file discovery, lexical controls, repeat stability and operational coverage.
- Supported operational failures score zero; successful misses, errors and unsupported outcomes remain distinct. The selected CBM natural-language mapping is unsupported, not a claim that upstream has no other capability.
- Query-weighted and equal-repository means, per-task wins/losses/ties, per-repository results, and leave-one-repository-out sensitivity.
- 10,000 repository-cluster bootstrap draws; 95% and 98.333% descriptive intervals for the three predeclared OCBI-hybrid-versus-rival exact-symbol pairs. Nine convenience clusters do not establish generalizability.

Interface-specific cold/first/warm durations are recorded, **not cross-interface speed superiority**. Source/workspace bytes are not index size; peak memory and billing are not measured. No intentionally concurrent study cells/builds/annotation workers run during scoring; unrelated host background activity is not independently controlled. Failures are not silently retried or excluded, and no production ranking/configuration fix will be selected after inspecting scores.

## Pre-run proof and claim limits

The real SDK/CLI/indexing paths passed the seven-condition **unscored synthetic smoke**. Both lexical baselines also returned no matches for a deliberately absent lexical token. All 100 source labels passed archive-byte/schema/path/range checks, and the final complete interface/runtime/model/frozen-input validation passed before scored execution.

The endpoint is **file discovery**, not correct definition spans, graph identity, matched-context implementation evidence or coding-task completion. Source-derived detailed questions, self-selection, shared AI annotation, unknown historical/training exposure, different indexed coverage and locally built bytes remain limitations. This cohort is now development-exposed. No independently reviewed holdout, coding-productivity or universal-SOTA claim is authorized by this study.
