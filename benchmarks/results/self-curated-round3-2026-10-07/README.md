# Assistant-curated round3 exploratory comparison — 2026-10-07

## Prospective registration

- Candidate: [`0bef15addb9ebbb703eb1e6b676e69b0394833ad`](https://github.com/Helweg/open-codebase-index/commit/0bef15addb9ebbb703eb1e6b676e69b0394833ad), locally rebuilt version `0.35.3`; not published-release byte identity.
- Candidate frozen at **2026-10-07T09:48:04.539Z**, before new source/task acquisition. Build, typecheck, lint and full Vitest gate passed: **2,656 passed, 6 skipped**; optimized native suite **146 passed**. Exact final native bytes and fresh/unchanged legacy-cache public MCP lookup were exercised in both modes, including process reopening.
- Protocol frozen at **2026-10-07T10:30:12.048Z**, before any scored request. `preregistration.json.gz` embeds **92 hash-bound files**, including all tasks, source ownership/rights evidence, manifests, runtime/interface locks, six execution/publication programs and retained development failure evidence.
- Preregistration archive SHA-256: `72dc711acd440b8f0053f298010d2d40eae188db0c15047a5e8c245e6c06a5db`.
- Nine repository clusters; **100 distinct-primary-file tasks: 54 explicit-symbol, 46 natural-language**. Seven conditions, three query passes; repeat1 alone determines primary quality: **700 primary rows, 2,100 pass records**.
- Conditions: OCBI hybrid, OCBI structural, CodeGraph `1.6.2`, codebase-memory-mcp `0.11.0`, grepai `0.37.0`, literal unindexed ripgrep `15.1.0`, and whole-file native BM25.
- Setup deadline **300,000 ms**; query deadline **60,000 ms**. One attempt per cell; supported operational errors score zero and stay in the supported denominator. Selected CBM natural-language mapping is unsupported, reported separately with blank metric fields.

## Selected pinned sources

| Repository | Revision |
|---|---|
| [Mongoose](https://github.com/Automattic/mongoose) | `83e9665b52bc8c019569d6403faca030fc7434fc` |
| [Redux Toolkit](https://github.com/reduxjs/redux-toolkit) | `0fd611cc79d44990ac9a040dec4d5cb446233440` |
| [Flask](https://github.com/pallets/flask) | `d73fa1cdcbd8b1465c151db8924ba58b1dd14e35` |
| [Chi](https://github.com/go-chi/chi) | `167e1e3bd039d060696b99c8da4e876ae04f42c1` |
| [Tracing](https://github.com/tokio-rs/tracing) | `d9d4c542de10f5d3a711b7a45ffe450fd0666437` |
| [kotlinx.serialization](https://github.com/Kotlin/kotlinx.serialization) | `938b86dd400a3a75f390009052e72569b947fc2a` |
| [GuardClauses](https://github.com/ardalis/GuardClauses) | `f96b823e4228252b2927cce3effa550c16b558a5` |
| [Guzzle](https://github.com/guzzle/guzzle) | `93939470950a9b11e2e84204166ef5e048c55fe4` |
| [dry-types](https://github.com/dry-rb/dry-types) | `5f39e313d298c586a40ffb51fbd653914e63c113` |

## Scope and limits

**Humanizer remains an unresolved provider-bound setup failure.** The user explicitly selected keeping the five-minute budget. Healthy embedding work exhausted that deadline; paired provider experiments did not justify a code-only throughput fix. No readiness fix, longer budget, reduced corpus, changed model or partial-completion success is claimed. Previous studies and their error outcomes remain unchanged.

Initial Nodemailer acquisition proved production TypeScript rather than the intended JavaScript slot. Mongoose replaced it for source-language eligibility **before task/protocol freeze and without participant feedback**; initial acquisition and rejection evidence are retained.

Assistant-authored source questions and internal AI author QA are **not independent review**. Historical/pretraining/maintainer exposure and representativeness are unestablished. File discovery is not implementation-span correctness or coding productivity; new-cohort scores cannot establish causal old/new improvement or SOTA.

Identical canonical Git archives do not imply identical indexed coverage. Local Node packages and runtime entrypoints are hash-bound; direct file-backed Node libraries are recorded, but transitive OS/Homebrew linkage and the OS shared cache remain unbound. This is not a portable runtime image. Results were unavailable at registration.

## Observed outcomes

The frozen 63-cell run completed **2026-10-07T11:47:21.297Z**; the published analysis replayed all raw rankings and exactly reproduced the primary report. It verifies **3,858** embedded published evidence hashes, including all **92** frozen registration files. The evidence archive contains all seven programs, 63 cells, 2,100 query-pass records, and 700 primary outcomes.

| Condition | Explicit-symbol Hit@5 | Natural-language Hit@5 |
|---|---:|---:|
| OCBI hybrid | 35/54 (64.8%) | 31/46 (67.4%) |
| OCBI structural | 47/54 (87.0%) | 32/46 (69.6%) |
| CodeGraph | 53/54 (98.1%) | 19/46 (41.3%) |
| Codebase Memory | 46/54 (85.2%) | Unsupported (46/46) |
| grepai | 38/54 (70.4%) | 36/46 (78.3%) |
| Literal unindexed | 48/54 (88.9%) | 0/46 |
| Whole-file BM25 | 50/54 (92.6%) | 29/46 (63.0%) |

Supported setup errors remain in the denominator as zero: **117 errors** over supported tasks; **138 Codebase Memory natural-language passes** were unsupported and are not reported as supported-track zeros. The four failed setup cells were Mongoose/OCBI hybrid (33 pass errors), Mongoose/grepai (33), kotlinx.serialization/OCBI hybrid (33), and kotlinx.serialization/Codebase Memory (18). No query-phase errors occurred. Exact recorded errors and raw outputs remain in the evidence archive.

The predeclared paired explicit-symbol Hit@5 differences (`OCBI hybrid − rival`) were −33.3 percentage points versus CodeGraph, −20.4 pp versus Codebase Memory, and −5.6 pp versus grepai. Their multiplicity-adjusted 98.333% repository-cluster bootstrap intervals were respectively **[−66.7, 0.0]**, **[−55.6, +5.6]**, and **[−38.9, +22.2]**. Each includes zero. These exploratory outcomes do not establish a winner or general ranking. Self-curation, source-span relevance, runtime-closure limits and all other preregistered caveats still apply.

Artifacts: [`report.json`](./report.json) contains task, track, pairing, coverage and latency analysis; [`per-task-outcomes.csv`](./per-task-outcomes.csv) preserves each primary task with unsupported metrics blank; [`results-evidence.json.gz`](./results-evidence.json.gz) contains hash-verified normalized raw run, source and runtime evidence; [`verification.json`](./verification.json) records deterministic replay of the published evidence (not independent review or a participant-tool rerun).

## Narrative errata — 2026-10-07

The archived `post-score-coverage-notes.json` contains two wording errors: Mongoose and kotlinx.serialization each have **11** target paths, not 12; hybrid explicit-symbol errors are **six per failed repository, 12 total**, not 12 for Mongoose plus six for Kotlin. The program inventory above should read **six** execution/publication programs, not seven. The machine-derived report, CSV, raw records, scores, intervals and frozen archives are correct and unchanged. This erratum corrects the prose without rewriting historical evidence.
