# Competitive evidence plan, 2026-10-06

Status: evaluation preparation and historical diagnostic replay, not a new superiority result. Accepted OCBI reference: v0.35.3, commit `261f5d0a9ac9b4ebb758326136aed0737b36b372`. No retrieval/ranking change is part of this work.

## What the existing evidence establishes

The [September study](2026-09-10-competitive-results.md) already compares five configurations on 100 tasks across nine pinned repositories. That cohort has been used during OCBI development and tuning. It remains **development-only**. Replaying its saved responses with more detailed reporting creates neither new quality observations nor a held-out dataset.

The prior coding feasibility pilot produced no valid repairs. It cannot establish that retrieval improves coding outcomes. Existing file-level Hit@5 measures file discovery, not correct implementation spans, exact symbol resolution or task completion. Existing cross-interface timings are not comparable speed evidence.

This work extends the existing report with task-level outcomes while preserving its scoring, primary denominator, repository-cluster bootstrap and original raw artifacts. It also requires fresh-study approvals to match an actual novelty evidence file before source acquisition. Hash matching establishes artifact integrity, **not** the truth of novelty claims or reviewer independence.

## Dated baseline inventory

Official release metadata inspected on 2026-10-06:

| System | September evaluated version | Current advertised version at inspection | Primary source |
|---|---|---|---|
| OCBI | `0.27.0+ebd0702` | `0.35.3` | [release](https://github.com/Helweg/open-codebase-index/releases/tag/v0.35.3) |
| CodeGraph | `1.6.0` | `1.6.2` | [npm](https://www.npmjs.com/package/@colbymchenry/codegraph), [upstream](https://github.com/colbymchenry/codegraph) |
| codebase-memory-mcp | `0.10.8` | `0.11.0` | [npm](https://www.npmjs.com/package/codebase-memory-mcp), [upstream](https://github.com/DeusData/codebase-memory-mcp) |
| grepai | `0.36.1` | `0.37.0` | [release](https://github.com/yoanbernabeu/grepai/releases/tag/v0.37.0) |

These are candidate participants, not evidence they were evaluated at the newer versions. Refresh the inventory and calibrate documented public interfaces before freezing a fresh study. Include an unindexed literal-search baseline and a declared lexical/BM25 baseline; do not call OCBI structural mode a pure BM25 baseline. Do not select each system's best configuration after seeing task outcomes.

## Independent holdout gate

No independently approved fresh cohort is currently supplied. Participant/runner source acquisition, indexing and scored execution remain blocked. An independent curator may obtain and inspect pinned sources solely to prepare and validate the sealed package, under applicable access permissions and in an isolated workspace outside participant-visible roots. That curation permission is not participant acquisition authorization. Do not label existing tasks held-out to work around the approval prerequisite.

A curator/reviewer independent of OCBI tuning must provide:

1. A pinned cohort manifest and provenance for repository/task selection. Audit overlap with the existing nine-repository cohort, other evaluation fixtures, prior experiments and tuning history; disclose the audit's coverage and limitations. Different questions from an already exposed repository are not repository-held-out evidence.
2. Task inputs and source-grounded answers separated from participant access. Keep reference fixes and private evaluator tests outside agent-visible source/index roots. Record whether tasks are public, externally curated or private; public tasks have possible model-pretraining contamination even if held out from OCBI development.
3. Dated novelty evidence and an approval containing the reviewer identity, exact cohort digest, exact evidence digest, pinned repository set and source-acquisition authorization. Use the [fresh-study validator](../benchmarking-cross-repo.md#fresh-study-novelty-gate) with both approval and evidence paths. Software cannot authenticate an arbitrary reviewer string as independent human review.
4. Frozen tool/runtime/model/configuration hashes, interface mappings, budgets, scorer, task order and statistical analysis before scored execution. Commit the preregistration and locks before the run. Preserve every later amendment and rerun affected conditions uniformly, never selectively.

Once outcomes are inspected, that cohort is consumed for confirmatory purposes. Failures may guide development, but a tuned candidate needs another untouched cohort for a new confirmatory claim. Do not claim model-training contamination has been eliminated.

## Task families and fair inputs

Keep exact user-supplied symbols separate from natural-language questions. Cover conceptual implementation discovery, cross-file dependencies, lifecycle/configuration behavior, bug localization, pre-edit evidence, ambiguous/short symbols, large-file fallback, scope restrictions and no-result cases. Include misleading comments, wrappers and test/documentation mentions without manufacturing a query-specific exception.

All participants get the same pinned checkout, question, user-supplied identifiers and declared source scope. Never pass gold paths, `expected.symbol`, answer commits or hidden tests to a participant. Record each system's actual indexed coverage, truncation, file/depth caps and readiness; absence from the index is not a ranking failure.

For file-discovery calibration, retain the existing shared request bound of 50 raw hits and score the first ten distinct files in returned order, disclosing smaller public API caps. This is a file-level track only.

For implementation evidence and agent outcomes, preregister a common context/token budget and accounting for every search result, source read and graph follow-up. Score only evidence actually delivered within that budget. A path citation does not prove the agent received implementation content. Do not promote raw candidates omitted from the final response into credited evidence.

## Execution and failures

Use isolated copies and local indexing; do not touch user indexes or upload source to hosted indexing services. Preserve raw requests/responses, normalized outputs, source/interface/model hashes and errors. Execute quality measurements serially without competing builds/indexers; randomize blocked condition order with a declared seed.

Distinguish successful misses, setup/transport/timeouts/malformed-output errors, unsupported interfaces and ambiguous/manual outcomes. Supported operational errors remain unsuccessful outcomes in the supported denominator. Show conditional-on-success scores separately. Unsupported families are not zero-quality ranking observations or after-the-fact exclusions. The existing explicit-symbol primary report rejects unsupported primary cells instead of silently changing its denominator.

Use the report's task-level comparisons to inspect losses as well as wins. Hit@5 ties can still differ in MRR/nDCG, so retain metric deltas and both ranked path lists. A gain caused by a rival setup failure is an operational difference, not proof of better ranking.

Prefer matched persistent interfaces, or compare complete process invocation for all systems. Otherwise label latency incomparable. Record cold indexing, first query and warm repeats separately. Repeats are not independent quality observations. Measure memory and disk footprint directly; workspace bytes including source are not index size. Estimated tokens/cost are not measured billing.

## Agent-task feasibility before a larger study

Repair and validate the existing matched-model broker/evaluator pipeline before expanding its failed pilot. Use identical model/provider, prompt, tools, call/token/time limits and one declared attempt per condition. Validate each owned task's failing initial state and passing reference fix before model execution; do not expose reference material to participants.

A bounded feasibility pilot remains descriptive even if it succeeds. Task success requires actual independent tests and patch validity, not retrieval scores or model prose. Do not increase caps or retry only failed conditions after inspecting outcomes. Any broker change requires a dated amendment and uniform affected-condition rerun. No unbounded model spend or credential copying.

## Claim policy

Only a completed, independently reviewed held-out study can support a confirmatory comparative claim. Before running it, freeze a primary endpoint, practically meaningful effect, repository-level sample/power rationale, multiplicity correction and resource limits. For continuity, the September file-discovery endpoint uses a five-percentage-point Hit@5 advantage and a positive 98.333% repository-cluster-bootstrap lower bound for each of three preregistered rival comparisons. It is not a substitute for agent-task success and cannot retroactively certify a development cohort.

Report repository-level sensitivity, per-task losses, coverage/errors and uncertainty. All compared systems must meet the same declared context, latency and cost constraints for a resource-constrained claim. Missing measurements or unsupported task families narrow the claim, not silently disappear.

Permitted wording, only when earned: **“OCBI outperformed the evaluated pinned systems on the named held-out task family under the declared constraints, as of [date].”** A lead on one endpoint is not proof of universal superiority, every-query improvement, best coding productivity or all-market SOTA. Until those conditions are met: **no SOTA claim**.

## Observed historical diagnostic replay

The updated report CLI was executed against all nine preserved `results-corrected/*-run` directories. It loaded 500 first-repeat quality rows for 100 tasks and produced 300 OCBI-hybrid-versus-rival task comparisons. The original `cohort`, `exploratory`, `tracks` and `primaryPairs` fields—including confidence intervals—matched the original corrected report exactly.

These observations evaluate September's **OCBI `0.27.0+ebd0702`**, not current `0.35.3`. No retrieval, indexing or model execution was repeated.

| Rival | Track | OCBI wins | OCBI losses | Hit@5 ties | Unsupported pairs | Rival operational errors |
|---|---|---:|---:|---:|---:|---:|
| codebase-memory | Explicit symbol | 0 | 5 | 49 | 0 | 0 |
| codebase-memory | Natural language | 0 | 0 | 0 | 46 | 0 |
| CodeGraph | Explicit symbol | 0 | 5 | 49 | 0 | 0 |
| CodeGraph | Natural language | 6 | 5 | 35 | 0 | 0 |
| grepai | Explicit symbol | 15 | 5 | 34 | 0 | 9 |
| grepai | Natural language | 10 | 4 | 32 | 0 | 9 |

Wins/losses compare paired Hit@5, not overall superiority. Errors remain supported unsuccessful observations; the error column overlaps wins/losses/ties rather than adding another denominator. Unsupported natural-language codebase-memory pairs are not counted as wins, losses or ties. The September study's depth-excluded Gson definitions and grepai setup failure remain coverage/operational limitations, not evidence that ranking alone caused the differences.

Published artifacts:

- [Complete task diagnostic replay](../../benchmarks/results/competitive-2026-10-06/task-diagnostic-replay.json): both ranked path lists, statuses, outcomes and metric deltas.
- [Provenance and runtime evidence](../../benchmarks/results/competitive-2026-10-06/provenance.json): SHA-256 for all 518 consumed manifest/input/quality files, the report, report script and original corrected aggregate report; actual CLI commands and synthetic integrity-gate smoke outputs.

Published provenance normalizes repository paths and uses `${STUDY}`, `${SMOKE}` and `${SMOKE_REALPATH}` placeholders instead of private machine paths. Commands and error text retain the original execution structure; content digests still identify the original unmodified artifacts.

Replay, with the preserved study directory available:

```bash
STUDY=/path/to/preserved-study
npx tsx scripts/competitive-report.ts \
  "$STUDY/results-corrected/axios-run" \
  "$STUDY/results-corrected/express-run" \
  "$STUDY/results-corrected/click-run" \
  "$STUDY/results-corrected/cobra-run" \
  "$STUDY/results-corrected/ripgrep-run" \
  "$STUDY/results-corrected/gson-run" \
  "$STUDY/results-corrected/newtonsoft-json-run" \
  "$STUDY/results-corrected/symfony-console-run" \
  "$STUDY/results-corrected/sinatra-run"
```

Verification: 39 targeted tests passed; ESLint passed for both changed scripts and test files; the repository's `npm run typecheck` passed. An additional strict check including script dependencies found three existing `TS2740` errors in unchanged `scripts/cross-repo-benchmark.ts` at lines 755, 1820 and 1882. That file is byte-identical to starting main `261f5d0`; this check is not reported as passing.

A synthetic local Git fixture demonstrated the approval gap before and after: the old validator accepted a matching cohort approval without checking the tampered evidence; the new validator rejected the mismatch before workspace creation. Exact evidence passed, and unreadable/unpaired evidence failed before acquisition. The historical verifier's initial macOS `/tmp` realpath entry-point mismatch was corrected before counting acceptance; the provenance preserves that failed verifier attempt. Synthetic approvals are not novelty audits.

**Remaining prerequisite:** an independently curated and approved fresh cohort, followed by frozen current participant configurations and scored execution. Agent-task evidence also needs a successful, uniformly controlled broker/evaluator feasibility run. This replay supplies neither prerequisite and supports no current comparative or SOTA claim.


## Independent review request

The [curator/reviewer handoff](2026-10-06-independent-review-handoff.md) specifies selection and overlap review, the sealed task/evaluator package, exact artifact hashes, roles, acceptance checks and the required review response. It is a request for independent review, not an approved cohort or acquisition authorization.
