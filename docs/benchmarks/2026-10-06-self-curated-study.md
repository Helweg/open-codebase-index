# Self-curated exploratory comparison, 2026-10-06

Status: **protocol frozen before scored execution**. This is an assistant-run, self-curated exploratory study requested by the maintainer, not an independently reviewed blind holdout. Outside recruitment in [issue #420](https://github.com/Helweg/open-codebase-index/issues/420) was withdrawn, not fulfilled; no targeted invitation was sent. This route is separate from the [independent-study protocol](2026-10-06-competitive-evidence-plan.md), does not satisfy its approval/novelty gates, and does not fabricate `accepted_novel` evidence.

## Frozen inputs

The [preregistration archive](../../benchmarks/results/self-curated-2026-10-06/preregistration.json.gz) embeds 42 pre-run files: the protocol, source/interface/runtime locks, all task datasets and curation evidence, internal source-QA annotations, mechanical validation, complete source manifests, the actual temporary coordinator/preparation/validation programs, acquisition evidence and unscored smoke observations.

- Compressed archive SHA-256: `7be6e9854a882b294bedaecab35daeec6ea35ad5386f533899b43fee0f8f4ba2`.
- Original frozen protocol SHA-256: `4b9e3892c4a914cf24d29a4dfbc911897c3ad8d30e34b32c55784569e0085033`.
- Original source-lock SHA-256: `2a024bf74df0ee8b95dadaeedc76a3afd299d5ae267205e1e931fb86dc1916e5`.
- 41 exact input files are checked against the frozen protocol; 34,861 interface/runtime artifacts are byte-bound, including all 33,180 regular installed project dependency files and internal dependency symlink targets.

Absolute project/workspace/home paths are normalized explicitly in published UTF-8 content. Each embedded file records **original** and **normalized** SHA-256 separately; normalized evidence is not asserted byte-identical to private-path originals. Runtime binaries and repository archives are pinned by hashes and public identities, not redistributed.

Repository selection preceded source inspection and participant responses. These repositories differ from the **known** exposed September nine; no exhaustive history, shared-ancestry or model-training novelty audit is claimed. This is a convenience language-oriented sample, not representative sampling or a powered superiority study.

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
- 63 cells, 700 first-pass quality outcomes, 2,100 query-pass records expected.
- Primary endpoint: exact-symbol **relevant-file Hit@5**. Secondary: Hit@1, MRR@10, nDCG@10, natural-language file discovery, lexical controls, repeat stability and operational coverage.
- Supported operational failures score zero; successful misses, errors and unsupported outcomes remain distinct. The selected CBM natural-language mapping is unsupported, not a claim that upstream has no other capability.
- Query-weighted and equal-repository means, per-task wins/losses/ties, per-repository results, and leave-one-repository-out sensitivity.
- 10,000 repository-cluster bootstrap draws; 95% and 98.333% descriptive intervals for the three predeclared OCBI-hybrid-versus-rival exact-symbol pairs. Nine convenience clusters do not establish generalizability.

Interface-specific cold/first/warm durations are recorded, **not cross-interface speed superiority**. Source/workspace bytes are not index size; peak memory and billing are not measured. No intentionally concurrent study cells/builds/annotation workers run during scoring; unrelated host background activity is not independently controlled. Failures are not silently retried or excluded, and no production ranking/configuration fix will be selected after inspecting scores.

## Pre-run proof and claim limits

The real SDK/CLI/indexing paths passed the seven-condition **unscored synthetic smoke**. Both lexical baselines also returned no matches for a deliberately absent lexical token. All 100 source labels passed archive-byte/schema/path/range checks, and the final complete interface/runtime/model/frozen-input validation passed before scored execution.

The endpoint is **file discovery**, not correct definition spans, graph identity, matched-context implementation evidence or coding-task completion. Source-derived detailed questions, self-selection, shared AI annotation, unknown historical/training exposure, different indexed coverage and locally built bytes remain limitations. Once scores are inspected this cohort is development-exposed. No independently reviewed holdout, coding-productivity or universal-SOTA claim is authorized by this study.
