# Competitive benchmark preregistration (2026-09-10)

Status: protocol preparation, before new scored comparisons. OCBI implementation under test: `ebd0702` on macOS ARM64 / Node 26.6.0. No superiority result is assumed.

## Questions and claims

1. Does OCBI retrieve more correct evidence than current pinned alternatives for the same inputs?
2. Does it resolve call relationships accurately and keep results correct after source and branch changes?
3. Does improved evidence translate into more independently tested coding-task successes?

A feature difference is not task-success evidence. Existing OCBI-tuned datasets are development comparisons, not held-out proof. Results apply only to pinned tools, repositories, configurations and measured task families.

## Stage 1A: development retrieval diagnostics

- Reuse all nine repository revisions and 100 queries in `benchmarks/golden/expanded-cross-repo/cohort.json` without changing expected results. Label this entire cohort **development-only** because OCBI has previously been tuned on it.
- Verify the installed current releases of CodeGraph (`@colbymchenry/codegraph`, colbymchenry upstream), codebase-memory-mcp (DeusData upstream) and grepai from official metadata. Record version, source/release URL, executable hash and actual supported interfaces before any scored run. Historical 1.5.0/0.8.1 results are not current-version evidence.
- Freeze an explicit per-family interface mapping before scored runs. An adapter may use the question and user-supplied identifiers only, never `expected.symbol`, expected paths or graph answers. If an exact-symbol track is needed, give the same explicit symbol to every participant and report it separately from natural-language search.
- Include OCBI hybrid (local Ollama `nomic-embed-text`) and structural mode as separately named configurations, not whichever performs best per query. Use the same local embedding model for grepai where supported; record all model/configuration differences.
- Use isolated source copies at pinned SHAs. Do not touch user indexes, install global services, or upload repository contents to hosted indexing services. Tool downloads are permitted. Record source manifests and tool-specific indexed scope, truncation and exclusions.
- Freeze query order using seed 20260910. Run scored measurements serially, without concurrent builds or indexers. One cold indexing measurement (descriptive only, no runtime confidence interval), one separately recorded first query and three warm query repeats per supported cell. Randomize blocked tool order per repository with the same seed. Repeats estimate runtime variability and are not independent quality observations.
- Prefer persistent public interfaces for every participant. If a participant requires one-shot CLI calls, measure equivalent end-to-end process invocation for the comparison, or report latency as incomparable. Never compare warm in-process OCBI timing to another tool's `npx` startup time.
- Report Hit@1/5, MRR@10, graded nDCG where labels support it, output size, indexing time, p50/p95 query latency, index disk footprint and measured peak memory when available. Preserve each command/request, raw response, normalized result and error. Token estimates must be labelled as estimates with one common tokenizer/estimator.
- Keep unsupported task families, tool/setup failures, malformed outputs, out-of-scope paths and actual zero-hit answers distinct. Publish coverage and failure denominators. Within each preregistered supported track, count setup, timeout and malformed-response failures as unsuccessful operational outcomes; show conditional-on-success quality separately. Unsupported families are separate capability gaps, not retroactive exclusions. Do not silently drop failing repositories or describe unsupported natural-language search as a zero-accuracy symbol search.
- Report both query-weighted and equal-repository aggregates. For paired Hit@5 differences, use 10,000 repository-cluster bootstrap samples with seed 20260910 and report ordinary 95% intervals plus 98.333% two-sided Bonferroni-adjusted intervals for the three preregistered rival comparisons. A scoped accuracy-advantage claim requires the adjusted lower bound to exceed zero and an absolute Hit@5 gain of at least five percentage points. Development-cohort findings remain exploratory regardless of this rule; confirmatory claims require fresh held-out tasks. Report paired per-repository differences and leave-one-repository-out sensitivity. MRR, nDCG, graph and freshness are secondary/descriptive endpoints, not additional unadjusted routes to a superiority claim. Small cohorts without sufficient uncertainty resolution support descriptive results only.

## Stage 1B: newly frozen graph and freshness scenarios

Create and freeze 12 separate scenarios across two small fixture repositories and two languages before scored runs: six graph and six freshness scenarios. Report these separately from the 100-query development cohort; never pool them into a headline. These are synthetic conformance checks, not confirmatory evidence of broad superiority. Create separate task inputs and source-grounded answers before scored runs. Include positive and negative/ambiguous calls, an added symbol, rename, deletion, branch switch and a long-lived reader observing an external writer. Test documented normal refresh behavior, disclose whether an explicit index command or watcher is required, and distinguish availability from stale/incorrect results. Handwritten fixtures establish correctness of these scenarios, not broad real-repository graph precision. Do not use them alone for superiority claims.

## Stage 2: coding tasks

- Require an executable matched-model runner before claiming this stage is feasible. Record model/provider/version, system prompt, allowed tools, maximum calls, token/time budget and all transcripts.
- All participants receive identical issue text and repository revision. Only the code-indexing tool changes. Include a no-index baseline if the runner supports it. No task may use the answer commit or held-out tests as agent-visible retrieval material.
- Build independent task workspaces from public revisions, with private evaluator tests outside each agent's source/index scope. Validate each task first against the known failing starting state and a reference fix, without exposing the reference to competitors.
- Freeze tasks before agent execution. Use tasks not already employed to tune OCBI; disclose possible model training contamination rather than claiming it can be eliminated.
- Initial bounded pilot: up to eight tasks across at least two repositories, one run per tool/configuration with identical caps. This is feasibility/descriptive evidence, not statistical proof. Expand only under a recorded resource budget after the runner and evaluator work correctly.
- Primary outcome: independently executed tests plus patch validity. Record failed runs, timeouts, test tampering, token use and elapsed time. Search scores and LLM-judged plausibility do not substitute for test-verified task success.
- Do not purchase services, create credentials or initiate unbounded model spend. If the available runner cannot enforce matched budgets, tool isolation or test secrecy, report the exact blocker and do not manufacture a coding-outcome result.

## Publication and change control

Commit this protocol and version/interface lock before scored runs. Amendments must precede the affected run, retain their reason and invalidate any results influenced by the change. No tuning of OCBI or alternative configurations after inspecting scored results within the same run. Publish losses, unsupported cells, uncertainty and raw artifact hashes alongside wins. A benchmark artifact may support a narrow statement, never an unqualified claim that OCBI is universally superior.

## Pre-run clarification, 2026-09-10

No scored comparisons or coding-model calls preceded these clarifications.

- The common primary retrieval family is the 54 queries with an explicit `args.symbol`. Every tool receives that same identifier. The other 46 text-only questions form a separate descriptive family. Never compare one tool's 54-query score to another's 100-query score. The three primary pairs are OCBI hybrid against each rival on the common explicit-symbol family. Structural mode is a separately reported secondary condition.
- Request up to 50 raw hits where the public API supports it, preserve their order, deduplicate by exact repository-relative file path, and score the first ten distinct files. This is file-retrieval evaluation, not symbol-resolution accuracy. Record an API's smaller cap rather than silently expanding it through answer-dependent queries.
- A repeated-query timing is not necessarily a fully warm embedding-cache timing. Preserve the separate first invocation and label all measured interfaces. No cross-interface speed claim is authorized by this experiment.
- `conformance.json` freezes the twelve synthetic scenarios. Graph and freshness requests use identical explicit `subject`, `from`, `to`, or `queryInputs` fields for all participants. Natural-language descriptions are for readers, not an evaluated routing step. Expected edges and output paths remain evaluator-only. The Python reachability scenario has a genuine two-hop call path.
- Before the larger coding pilot, run a safety and feasibility gate with two seeded regressions in the pinned Axios revision, three conditions (no index, OCBI hybrid, CodeGraph), and one run per task/condition. This is six descriptive runs in one repository, not the planned larger multi-repository comparison. All use the already-installed local Ollama Gemma model and the same fixed budgets. Expand only after confinement and hidden-evaluator checks pass. Seeded regressions are not historical issue-resolution evidence.
- Freeze the coding task manifest and model parameters before inference. Validate that the starting mutation fails and the reference restoration passes. A successful sandbox probe is a prerequisite, not a substitute for post-run hidden tests. If the safety gate fails, report the blocker and do not execute model-produced code.
