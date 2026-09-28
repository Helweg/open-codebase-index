# Factual-safety guidance: prospective installed-host comparison

Study `OCI-FACTUAL-SAFETY-20260927-01`, reported 2026-09-28.

## Result and product decision

**NEGATIVE: the added guidance failed all six quality directions in both the primary and complete-pair sensitivity analyses.** Baseline `be26a13022e8631d025d4b910d8255b1665620bd` outperformed candidate `a31b6671e69853c4bf91676d9b9bedd88a82c799` on this sample's factual coverage, exactly supported keyed coverage, wrong claims per answer and per claim, and unsupported claims per answer and per claim. All 32 scheduled answers completed, with zero failures and 16 complete pairs. This is not an overall factual-improvement result.

The candidate's added factual-safety wording was removed in follow-up commit `d938592e20cdf59ba5294669c2759b4793b18338`, restoring the runtime and routing-test bytes to `be26a13`. The previously verified guidance-lifetime mechanism and full repository-relative-path guidance remain. Restored-code validation is reported below, separately from candidate validation. No extension, regrading, replacement answer or answering retry was used to improve the result.

The [earlier lifetime study](answer-guidance-lifetime-study.md) remains separate: its genuine citation-support benefit and factual/error trade-off are unchanged. Its observations motivated this candidate, so the wording was development-informed. New questions, keys and methods were frozen before new inference, with runtime and analysis freezes before heldout execution. Neither study is pooled into the other.

## Endpoints and fixed joint gate

Factual coverage credits substantively correct frozen key facts, regardless of citations. Exactly supported keyed coverage additionally requires genuinely supporting evidence with an exact repository-relative path and explicit in-bounds line interval. Locator validity measures reference occurrences, not truth or entailment. Citation entailment counts distinct claim-reference associations or joint evidence bundles. A resolvable but nonconforming reference can support a claim without satisfying exact location requirements.

All distinct factual propositions, including additional assertions, count toward the claim endpoints. Correct but uncited claims are unsupported, not automatically wrong. Wrong and unsupported can overlap and are never summed into a penalty. Repeated identical propositions and associations are deduplicated within each answer. Zero-denominator precision is N/A, never perfect.

The frozen gate is a conjunction, not a composite score or statistical noninferiority test. In **both** all-scheduled and complete-pair analyses, factual and exactly supported keyed coverage must not decrease, wrong claims per answer and pooled wrong-claim rate must each strictly decrease, unsupported claims per answer and pooled unsupported-claim rate must not increase, failures must not increase, every topic must retain a complete pair, and both claim-rate denominators must be defined. A safety stop or incomplete scoring precludes completed-study success.

| Gated quality endpoint | Baseline | Candidate | Candidate minus baseline | Required direction | Result in both analyses |
|---|---:|---:|---:|---|---|
| Factual coverage | 124/128 (96.875%) | 121/128 (94.53125%) | -2.34375 pp | Nondecreasing | Fail |
| Exactly supported keyed coverage | 64/128 (50%) | 58/128 (45.3125%) | -4.6875 pp | Nondecreasing | Fail |
| Wrong claims per answer | 9/16 = 0.5625 | 13/16 = 0.8125 | +0.25 | Strictly lower | Fail |
| Pooled wrong-claim rate | 9/455 (1.98%) | 13/422 (3.08%) | +1.10 pp | Strictly lower | Fail |
| Unsupported claims per answer | 74/16 = 4.625 | 101/16 = 6.3125 | +1.6875 | Nonincreasing | Fail |
| Pooled unsupported-claim rate | 74/455 (16.26%) | 101/422 (23.93%) | +7.67 pp | Nonincreasing | Fail |

Coverage and per-answer gate metrics give each of the eight questions equal weight, averaging its repetitions first. With two completed repetitions per question, these equal the answer-weighted means and, for eight facts per answer, pooled factual fractions. Complete-pair sensitivity excludes neither answers nor pairs here, so every endpoint and gate result is identical to primary. Surviving-answer-weighted diagnostics are therefore also identical, not an alternative favorable weighting.

| Separate descriptive endpoint | Baseline | Candidate |
|---|---:|---:|
| All distinct factual claims | 455 | 422 |
| Claims per answer | 28.4375 | 26.375 |
| Exact-valid reference occurrences | 96/237 (40.51%) | 94/202 (46.53%) |
| Invalid reference occurrences | 141 | 108 |
| Supported claim-reference associations | 459/532 (86.28%) | 373/461 (80.91%) |
| Exact and supporting associations | 208/532 (39.10%) | 207/461 (44.90%) |
| Completed answers / scheduled | 16/16 | 16/16 |
| Runtime failures | 0/16 | 0/16 |
| Failure-to-answer | 0/16 | 0/16 |

The higher syntax-valid-reference percentage does **not** establish genuine support or factual improvement. Even its numerator fell, from 96 to 94. The exact-and-supporting association percentage rose with a smaller denominator, while exactly supported keyed coverage fell. The candidate made fewer claims overall but more wrong and unsupported claims in both count and pooled rate.

## All eight topics

Q1 through Q8 are the public topic IDs `prospective-01` through `prospective-08`, not private answer IDs. They cover environment-reference substitution, ordered file batching, configuration-path serialization, Markdown command loading, filesystem path canonicalization, language identifier conversion, vector batch validation/mutation, and UTF-8 markup text splitting, respectively. Each row pools two repetitions per arm. B means baseline and C means candidate. Coverage differences are percentage points (pp). W and U are wrong and unsupported distinct claims, respectively.

| Topic | Facts B → C (each /16) | Exact-supported B → C (each /16) | Δ factual pp | Δ exact pp | Claims B → C | W B → C | U B → C |
|---|---:|---:|---:|---:|---:|---:|---:|
| Q1 | 16 → 16 | 10 → 16 | 0 | +37.5 | 52 → 66 | 0 → 4 | 3 → 4 |
| Q2 | 14 → 16 | 11 → 10 | +12.5 | -6.25 | 50 → 42 | 1 → 1 | 2 → 6 |
| Q3 | 15 → 14 | 0 → 0 | -6.25 | 0 | 48 → 51 | 3 → 4 | 25 → 28 |
| Q4 | 16 → 16 | 8 → 0 | 0 | -50 | 41 → 44 | 0 → 0 | 0 → 8 |
| Q5 | 16 → 15 | 15 → 12 | -6.25 | -18.75 | 60 → 48 | 1 → 2 | 3 → 6 |
| Q6 | 16 → 16 | 0 → 0 | 0 | 0 | 84 → 70 | 4 → 0 | 37 → 44 |
| Q7 | 15 → 14 | 7 → 14 | -6.25 | +43.75 | 73 → 61 | 0 → 1 | 1 → 3 |
| Q8 | 16 → 14 | 13 → 6 | -12.5 | -43.75 | 47 → 40 | 0 → 1 | 3 → 2 |

## Both repetitions

Each row contains eight completed answers, one per topic, with zero failures. These are descriptive repetitions of the same selected topics, not independent task samples. Repetition 1 favored the candidate on factual coverage, exact support and wrong claims, but not unsupported claims. Repetition 2 reversed the coverage and wrong-claim directions.

| Rep / arm | Facts | Exact-supported | Claims / answer | W / answer | W / claims | U / answer | U / claims |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 / B | 60/64 (93.75%) | 27/64 (42.1875%) | 28.375 | 0.75 | 6/227 (2.64%) | 4 | 32/227 (14.10%) |
| 1 / C | 61/64 (95.3125%) | 30/64 (46.875%) | 26.75 | 0.5 | 4/214 (1.87%) | 7.375 | 59/214 (27.57%) |
| 2 / B | 64/64 (100%) | 37/64 (57.8125%) | 28.5 | 0.375 | 3/228 (1.32%) | 5.25 | 42/228 (18.42%) |
| 2 / C | 60/64 (93.75%) | 28/64 (43.75%) | 26 | 1.125 | 9/208 (4.33%) | 5.25 | 42/208 (20.19%) |

| Rep / arm | Valid references | Invalid references | Supported associations | Exact and supporting associations |
|---|---:|---:|---:|---:|
| 1 / B | 41/116 | 75 | 240/273 | 95/273 |
| 1 / C | 51/102 | 51 | 168/211 | 107/211 |
| 2 / B | 55/121 | 66 | 219/259 | 113/259 |
| 2 / C | 43/100 | 57 | 205/250 | 100/250 |

## Per-answer counts and rates

Factual and exact-supported denominators are eight keyed facts per answer. W and U percentages divide their counts by that answer's total distinct claims, not by references or keys. Every row completed without runtime or answer failure.

| Topic | Rep | Arm | Facts | Exact-supported | Claims | W (claim rate) | U (claim rate) |
|---|---:|---|---:|---:|---:|---:|---:|
| Q1 | 1 | B | 8/8 | 2/8 | 24 | 0 (0.00%) | 2 (8.33%) |
| Q1 | 1 | C | 8/8 | 8/8 | 30 | 0 (0.00%) | 0 (0.00%) |
| Q1 | 2 | B | 8/8 | 8/8 | 28 | 0 (0.00%) | 1 (3.57%) |
| Q1 | 2 | C | 8/8 | 8/8 | 36 | 4 (11.11%) | 4 (11.11%) |
| Q2 | 1 | B | 6/8 | 6/8 | 21 | 1 (4.76%) | 1 (4.76%) |
| Q2 | 1 | C | 8/8 | 8/8 | 20 | 0 (0.00%) | 0 (0.00%) |
| Q2 | 2 | B | 8/8 | 5/8 | 29 | 0 (0.00%) | 1 (3.45%) |
| Q2 | 2 | C | 8/8 | 2/8 | 22 | 1 (4.55%) | 6 (27.27%) |
| Q3 | 1 | B | 7/8 | 0/8 | 25 | 2 (8.00%) | 4 (16.00%) |
| Q3 | 1 | C | 7/8 | 0/8 | 26 | 2 (7.69%) | 24 (92.31%) |
| Q3 | 2 | B | 8/8 | 0/8 | 23 | 1 (4.35%) | 21 (91.30%) |
| Q3 | 2 | C | 7/8 | 0/8 | 25 | 2 (8.00%) | 4 (16.00%) |
| Q4 | 1 | B | 8/8 | 0/8 | 22 | 0 (0.00%) | 0 (0.00%) |
| Q4 | 1 | C | 8/8 | 0/8 | 22 | 0 (0.00%) | 5 (22.73%) |
| Q4 | 2 | B | 8/8 | 8/8 | 19 | 0 (0.00%) | 0 (0.00%) |
| Q4 | 2 | C | 8/8 | 0/8 | 22 | 0 (0.00%) | 3 (13.64%) |
| Q5 | 1 | B | 8/8 | 7/8 | 30 | 1 (3.33%) | 3 (10.00%) |
| Q5 | 1 | C | 7/8 | 7/8 | 27 | 2 (7.41%) | 4 (14.81%) |
| Q5 | 2 | B | 8/8 | 8/8 | 30 | 0 (0.00%) | 0 (0.00%) |
| Q5 | 2 | C | 8/8 | 5/8 | 21 | 0 (0.00%) | 2 (9.52%) |
| Q6 | 1 | B | 8/8 | 0/8 | 41 | 2 (4.88%) | 21 (51.22%) |
| Q6 | 1 | C | 8/8 | 0/8 | 39 | 0 (0.00%) | 24 (61.54%) |
| Q6 | 2 | B | 8/8 | 0/8 | 43 | 2 (4.65%) | 16 (37.21%) |
| Q6 | 2 | C | 8/8 | 0/8 | 31 | 0 (0.00%) | 20 (64.52%) |
| Q7 | 1 | B | 7/8 | 7/8 | 42 | 0 (0.00%) | 0 (0.00%) |
| Q7 | 1 | C | 7/8 | 7/8 | 30 | 0 (0.00%) | 1 (3.33%) |
| Q7 | 2 | B | 8/8 | 0/8 | 31 | 0 (0.00%) | 1 (3.23%) |
| Q7 | 2 | C | 7/8 | 7/8 | 31 | 1 (3.23%) | 2 (6.45%) |
| Q8 | 1 | B | 8/8 | 5/8 | 22 | 0 (0.00%) | 1 (4.55%) |
| Q8 | 1 | C | 8/8 | 0/8 | 20 | 0 (0.00%) | 1 (5.00%) |
| Q8 | 2 | B | 8/8 | 8/8 | 25 | 0 (0.00%) | 2 (8.00%) |
| Q8 | 2 | C | 6/8 | 6/8 | 20 | 1 (5.00%) | 1 (5.00%) |

## All 16 matched-pair differences

Every difference is C minus B. Positive coverage is favorable, positive W or U is unfavorable. All pairs are complete and every failure-count difference is zero.

| Topic / rep | Δ factual pp | Δ exact pp | Δ claims | Δ W | Δ U |
|---|---:|---:|---:|---:|---:|
| Q1 / 1 | 0 | +75 | +6 | 0 | -2 |
| Q1 / 2 | 0 | 0 | +8 | +4 | +3 |
| Q2 / 1 | +25 | +25 | -1 | -1 | -1 |
| Q2 / 2 | 0 | -37.5 | -7 | +1 | +5 |
| Q3 / 1 | 0 | 0 | +1 | 0 | +20 |
| Q3 / 2 | -12.5 | 0 | +2 | +1 | -17 |
| Q4 / 1 | 0 | 0 | 0 | 0 | +5 |
| Q4 / 2 | 0 | -100 | +3 | 0 | +3 |
| Q5 / 1 | -12.5 | 0 | -3 | +1 | +1 |
| Q5 / 2 | 0 | -37.5 | -9 | 0 | +2 |
| Q6 / 1 | 0 | 0 | -2 | -2 | +3 |
| Q6 / 2 | 0 | 0 | -12 | -2 | +4 |
| Q7 / 1 | 0 | 0 | -12 | 0 | +1 |
| Q7 / 2 | -12.5 | +87.5 | 0 | +1 | +1 |
| Q8 / 1 | 0 | -62.5 | -2 | 0 | 0 |
| Q8 / 2 | -25 | -25 | -5 | +1 | -1 |

Candidate factual coverage wins/ties/losses are **1/11/4** and exact-supported coverage **3/8/5**. Mean paired differences are -2.34375 and -4.6875 pp, respectively. The negative overall result is not a claim that every topic or repetition worsened.

## Execution, grading and failure accounting

The actual compiled host was **OpenCode 1.18.32**, model **`opencode-go/deepseek-v4.1-flash`**, build agent, identical host-default sampling and system-role guidance. Both builds inspected corpus `675300c129b70ffb3a28e3c454204ee65c422a34`. Installed packages had complete matched dependencies and the same native binary. Eight read-only tool contracts matched. Every one of 34 cells had fresh source/Git, independent pristine index and HOME/XDG state: two development qualifications and 32 heldouts. The two development cells were readiness checks, never scored with heldouts. Topic order was Q1 through Q8 in each repetition. Baseline went first for odd topics and candidate for even topics in repetition 1, with that order reversed in repetition 2. Only each assigned question entered its answering session, without keys, rubric or synthetic treatment text.

The only intended runtime addition was generic factual-safety wording. Existing full-path guidance, lifetime behavior, retrieval and schemas were retained. Local scripted-provider probes through the actual compiled host showed the intended addition on initial and post-tool turns, otherwise matching normalized messages and full tool contracts, with baseline guidance retained across turns. These probes are direct mechanism evidence, not model-quality evidence. Paid-slot guidance exposure is **inferred/unobserved**, not directly captured. Tool consumption is only a proxy.

All scheduled heldouts ran once, without interruptions, replacements, answering retries or safety stops. There were no unstarted, empty, off-topic, refusal, timeout or infrastructure-failure slots. Both arms retained all eight topics and all 16 pairs. Under the fixed rules, empty/unstarted slots would contribute zero coverage, incomplete relevant answers would be graded as delivered, and sensitivity would remove both members when either failed, not silently select the successful arm.

Eight accepted initial GPT-6 grading batches and eight separate final GPT-6 adjudications were label-blinded. All 32 grades, covering 256 keyed fact judgments, were final and source-adjudicated before unblinding. Final structural/hash validation completed at 2026-09-28T06:21:42.073Z, the grade-lock file was created at 06:23:19Z, and mapping/status verification and aggregation began only afterward at 06:24:00Z. Two initial grading-provider streams failed before accepted output and were recovered outcome-blind, followed by separate adjudication. That recovery was not an answering retry or score-selected regrading. No post-lock grade, key, criterion or sample changes were made.

## Validation status

- **Candidate validation, recorded evidence:** 99 focused tests passed. Full suite: 2,433 passed and six skipped, in 137 passing files and one skipped file. Full build, typecheck and lint passed. Built-artifact MCP lifecycle smoke passed. Packed clean-install checks covered CLI help and estimate-only execution, **not a packed MCP handshake**. These are local-platform results, not all-platform release or main-branch validation.
- **Execution metadata audit:** 42,359 checks passed, zero failed, including 13,045 shared immutable pin rehashes. This validates recorded provenance, accounting and execution metadata, not answers or paid request contents. It does not independently establish OS-wide process history, provider-internal retries, live process cleanup, or the unrecorded whole-invocation timeout interval. Frozen analysis machinery reported 75 analysis and 43 blinding tests plus syntax checks passing, not evidence of answer correctness.
- **Independent arithmetic audit: passed.** A separately prepared checker recomputed the locked data before reading the primary aggregation output. All 3,172 compared scalar and identity/schema checks agreed, including every primary/sensitivity criterion and exact integer cross-products for pooled rate gates. Both cohort gates and the joint gate are false. The coordinator also independently recounted raw arm totals and cross-products. This confirms arithmetic, not a fresh source-truth judgment or statistical inference. Audit SHA-256: `5249f67051358b3b5cc78da8da2835cb195da7da68ea75cb5cd0334bb5e0be46`.
- **Restored-code validation: passed.** The coordinator independently inspected the removal and verified that `src/routing-hints.ts` and its routing tests exactly match `be26a13`, with no remaining `src/` or `native/` diff against that baseline. All **96 focused tests** passed (69 routing, 12 plugin hooks, 15 v2). A fresh full build, typecheck, lint, full regression suite and packed clean-install CLI smoke all passed after restoration: **2,430 tests passed, six skipped; 137 test files passed, one skipped**. The three-test count reduction reverses the rejected addition's expanded test matrix, not failing tests. Built smoke exercised MCP lifecycle behavior; packed smoke covered installed CLI help/estimate paths, not MCP handshakes. No release publication or merge into main is claimed.

## Costs and limitations

Reported heldout cost was **$0.085250556**, development **$0.011729568**, total **$0.096980124**. Durable conservative reservations were **$3.20 + $0.20 = $3.40**, not actual spend or a provider-enforced billing hard cap. These are host-reported costs, not verified invoices, and exclude engineering/grading agents and previous attempts. Per-cell controls included a 480-second runtime and stream/process limits, with telemetry-dependent soft thresholds of 64 tools, 300,000 tokens and $0.10. No budget remainder authorized extra calls.

This is a finite exploratory comparison of **eight selected implementation topics, one answering model and two repetitions**, not 32 independent tasks or a universal/statistical proof. It supports rejecting this addition on the fixed observations, not a population-wide effect estimate. Same-family GPT-6 judging can share biases. Neutral labels do not guarantee perceptual blinding because writing style can reveal condition. No same-UID sandbox is claimed for fresh directories and read-only tool permissions.

After candidate, prompts and methods were frozen, a method-review retrieval exposed a partial key/anchor fragment to the coordinator. No answering worker or grader received that context, and no frozen-study product, prompt, key, scoring-rule or order changes followed. Perfect coordinator key-blinding is not claimed. Local SHA chains are consistency evidence, not tamper-proof remote attestations. Public reporting deliberately omits private paths, prompt/answer text and neutral-ID mappings.

A preparation test was accidentally started in an earlier scratch workspace and then stopped. A synthetic fixture and inert child were identified; the child was stopped, prior runner/test hashes remained unchanged, and that test did not invoke the study model. This preparation incident is separate from the completed 32-slot run.

## Artifact traceability

SHA-256 identifiers below preserve the frozen result's lineage without publishing private artifacts. The listed bytes were hash-checked. Runtime/analysis freeze hashes identify the recorded manifests, not a claim that spent profiles remained pristine.

| Artifact | SHA-256 |
|---|---|
| Protocol | `4197c9d200f3fbbb79416240650f35b86bfdd9d9174219504e1c9be78a7e99ea` |
| Runtime freeze | `fac51ce9dbe8c1cf731d21cf612f50019fdc890c2215ead6ab21d8b193fe87c2` |
| Analysis freeze | `d9e2ce8010853209b7b1a61c6cf5636571c151ab91508edc45ec6b9140d76b5b` |
| Final grade lock | `624716e0dc4d6aa698fd7b9b551b3f9381cc50a449e392c5d4415b3f1b8f8ffd` |
| Final aggregation | `ee018feccace02b9269767aa2367d4a775decd71e3e57df782a7772e6792cdcd` |
| Execution metadata audit | `8b3100cb6e535329505fd4b345be87c5e66ca48c3dab2d1038ac9898c2a7d919` |
| Independent arithmetic audit | `5249f67051358b3b5cc78da8da2835cb195da7da68ea75cb5cd0334bb5e0be46` |
| Independent recomputation | `86a3847ad5d9980552f971cf9cea074167e89e703cd3c1d3d47f06316e5c184c` |
