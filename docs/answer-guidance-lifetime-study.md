# Answer-guidance lifetime: installed-host comparison

## Scope

This study compares baseline `675300c129b70ffb3a28e3c454204ee65c422a34` with candidate `be26a13022e8631d025d4b910d8255b1665620bd`. It evaluates retaining the existing answer instructions after discovery tools, not adding a new citation style or changing retrieval ranking. Both arms already contain the same instruction to verify claims and cite full repository-relative paths with supporting line ranges.

## Result: stronger source support, not an overall accuracy win

**The candidate substantially improved exact, genuinely supporting citations on this sample. It did not establish better factual accuracy.** After removing the entire administratively interrupted pair, mean exact supporting key-fact coverage increased from **29.67% to 82.28%**. That gain also remained when excluding all post-pause pairs. However, complete-pair factual coverage decreased from **97.80% to 96.70%**, and the candidate produced more wrong and unsupported claims. Do not describe this as a general answer-quality winner or factual noninferiority proof.

### Coverage and interruption sensitivity

These percentages are means of answer-level fractions, not pooled fact counts. Each row includes both arms of every retained pair.

| Analysis | Scheduled slots / pairs | Factual coverage, baseline | Factual coverage, candidate | Exact supporting key-fact coverage, baseline | Exact supporting key-fact coverage, candidate |
|---|---:|---:|---:|---:|---:|
| All scheduled | 28 / 14 | 90.82% | 96.94% | 27.55% | 81.51% |
| Whole interrupted pair excluded | 26 / 13 | 97.80% | 96.70% | 29.67% | 82.28% |
| Pre-interruption pairs only | 22 / 11 | 98.70% | 97.40% | 32.47% | 81.66% |

The apparent all-scheduled factual advantage is explained by the retained empty baseline slot. It disappears and reverses in the complete-pair views. For the 13 complete pairs, exact supporting coverage improved in **9 pairs**, tied in **4**, and worsened in **0**. Factual coverage improved in **0**, tied in **12**, and worsened in **1**. In the 11 pre-interruption pairs, supporting coverage improved in 7 and tied in 4; factual coverage tied in 10 and worsened in 1.

The sensitivity cohorts no longer have equal repetition counts per question. Giving each of the seven questions equal weight instead yields complete-pair factual coverage **97.96% versus 95.92%** and supporting coverage **31.63% versus 82.53%**. In the pre-interruption cohort these are **97.96% versus 95.92%**, and **36.73% versus 77.42%**, respectively. Neither weighting changes the direction of the findings.

### Citation and claim counts, kept separate

Each cell below is a numerator/denominator, not a composite score. Wrong and unsupported claim counts can overlap. More claims also mean more opportunities for error.

| Endpoint | Baseline, all scheduled | Candidate, all scheduled | Baseline, 13 complete pairs | Candidate, 13 complete pairs |
|---|---:|---:|---:|---:|
| Exact-valid reference occurrences | 20/171 (11.70%) | 105/214 (49.07%) | 20/171 (11.70%) | 92/198 (46.46%) |
| Invalid reference occurrences | 151 | 109 | 151 | 106 |
| Supported claim-reference associations | 261/299 | 429/461 | 261/299 | 409/439 |
| Exact and supporting associations | 70/299 | 280/461 | 70/299 | 264/439 |
| Wrong distinct claims | 3/217 | 8/287 | 3/217 | 8/270 |
| Unsupported distinct claims | 11/217 | 17/287 | 11/217 | 17/270 |
| Delivered final answers | 13/14 | 14/14 | 13/13 | 13/13 |

The candidate's citation gain is not merely better-looking paths: the keyed coverage endpoint requires cited source text that actually supports the correct fact. Nevertheless, the candidate still supplied invalid references and incorrect claims. Four of its eight wrong claims were in the symbol-inference topic, despite correct coverage of that topic's frozen keys. Keyed completeness does not measure every assertion an answer adds.

### All-scheduled task breakdown

Each topic had two slots per arm. Counts below are descriptive; use the answer-level means above for the predeclared condition comparison.

| Topic | Correct facts, baseline | Correct facts, candidate | Exact-supported facts, baseline | Exact-supported facts, candidate |
|---|---:|---:|---:|---:|
| Q1: URL error sanitization | 12/12 | 12/12 | 6/12 | 12/12 |
| Q2: Native hashing | 12/12 | 12/12 | 6/12 | 12/12 |
| Q3: Exact-symbol inference | 16/16 | 16/16 | 0/16 | 15/16 |
| Q4: Community summaries | 16/16 | 16/16 | 0/16 | 10/16 |
| Q5: Latency-budget gates | 7/14 | 13/14 | 4/14 | 11/14 |
| Q6: Nested interruption recognition | 12/14 | 12/14 | 2/14 | 5/14 |
| Q7: Lexical search candidates | 14/14 | 14/14 | 7/14 | 14/14 |

Q5 includes the empty, externally interrupted baseline slot. The one factual loss on a complete pair is Q5 repetition 1. It must not be hidden by that unrelated administrative failure.

**Product conclusion:** the lifetime bug is fixed and the installed-host mechanism is directly verified. The measured product comparison supports a bounded **auditability improvement**, with a factual/error trade-off that remains unresolved. This is enough to document the specific benefit, not to advertise universally better or more accurate answers. No post-unblinding guidance tuning, regrading, retries or additional answer sampling was used to seek a more favorable result.

## What was actually broken

Two different issues had obscured earlier comparisons:

1. **The earlier loose-file deployment did not load the plugin in the compiled host.** A direct Bun import succeeded, but actual OpenCode 1.18.32 failed to resolve `zod` from the staged `dist/index.js`. Matching configured plugin origins and a matching 13-tool inventory had not proved plugin exposure: that inventory contained built-in tools, not OCBI tools. The older incomplete trial remains preserved and is not pooled here. See [the corrected historical report](agent-task-ab-answer-guidance-followup.md).
2. **Answer instructions had the lifetime of discovery routing.** After a discovery tool, `RoutingHintController.markToolUsed` consumed the one-shot routing hint. OpenCode reconstructs the system context for subsequent requests, so the embedded answer instructions disappeared too. The fix retains only those already-delivered answer instructions for the current eligible turn. It does not repeat discovery routing. New user observations reset the retained instructions, and bootstrap, definition, unrelated, superseded and evicted sessions do not inherit stale instructions.

Both study packages were packed and installed with their runtime dependencies. A separate actual compiled-host probe used a neutral local scripted provider response, not a model-generated answer. It captured the following serialized requests from the installed packages:

| Request | Baseline | Candidate |
|---|---|---|
| First request | Answer instructions and discovery routing present | Same |
| After actual `index_status` | Both absent | Answer instructions retained, discovery routing absent |
| Registered tools | 20 OCBI and 10 built-in tools | Identical full tool definitions |

The status response showed a ready, compatible 6,771-chunk index on branch `675300c`. This is direct mechanism evidence in the public host, not answer-quality evidence by itself. Paid study requests did not capture the injected system context. Their exposure is therefore **inferred, not directly observed per turn**. Observed eligible tool use is a consumption proxy, not proof of injection.

## Fixed comparison

Before scored inference, a separate designer froze seven new source-backed questions, private factual keys and condition-neutral prompts. The coordinator selected the fixed counterbalanced order, which was then hash-pinned and checked against that rule before scored output. This is coordinator-recorded order provenance, not an independently timestamped designer selection. The topics were URL error sanitization, native hashing, exact-symbol inference, community summaries, latency-budget gates, nested interruption recognition, and lexical search candidates. There were 49 keyed facts across the seven questions.

Each question was scheduled twice per arm: **28 slots, 14 matched pairs**. The first repetition alternated the first arm by question, and the second reversed that order. No failures were retried, no new questions were selected after outcomes, and earlier study answers were not reused as scored tasks.

| Control | Applied configuration |
|---|---|
| Host and model | OpenCode 1.18.32, `opencode-go/deepseek-v4.1-flash`, build agent, system-role routing hints |
| Corpus | Full 512-file tracked corpus at `675300c`, same source and local Git state per cell |
| Index | Independent copies of the same ready compatible index, Ollama/nomic-embed-text, 768 dimensions |
| Installation | Actual packed and clean-installed baseline/candidate packages, pinned dependency, JavaScript and native bytes |
| Mutable state | Fresh HOME/XDG/cache/session/profile/work/index copies per scheduled cell |
| Configuration | Project config disabled, explicit singleton plugin, fixed environment allowlist and locale/timezone, indexing and watching disabled |
| Tools | Equal contracts and read-only permissions, no shell, write or web tools |
| Limits | 480 seconds and stream/process limits, 64 tools, 300,000 reported tokens and USD 0.10 per cell; USD 3 heldout aggregate |
| Accounting | Token/cost/tool thresholds are observed soft limits, not provider-side hard ceilings. Unknown usage is not recorded as zero. |

Four separate development qualification cells completed before scored execution. Both arms used real `codebase_context`, read source and returned final text with valid usage. Their USD 0.022133184 reported cost is excluded from scored results and had a separate USD 0.40 allocation. No private factual keys were supplied to the runner or model.

## Administrative interruption and continuation

The enclosing execution tool killed the original study process at its unexpected 600-second limit, despite the requested longer timeout. The first 23 slots had completed. Slot 24, baseline Q5 repetition 2, did not retain a final answer or usage. The study did not retry it or reconstruct an answer from session storage. A process audit found no surviving study-owned host.

An independent reviewer approved an answer-independent administrative amendment to execute **only the four originally scheduled, never-started slots 25 through 28**. Their untouched input/profile pins and the original budgets remained in force. The original ledger was not rewritten. All four completed, and a derived ledger links their original artifacts while retaining slot 24 as an empty, externally interrupted observation with unknown usage.

The original run was interrupted at approximately 09:11 UTC on September 27. Continuation occurred at approximately 16:38 to 16:41 UTC. This substantial pause is a protocol deviation, not a pristine uninterrupted prospective comparison. Results are descriptive and exploratory. The empty baseline answer cannot be treated as evidence of model or plugin weakness.

Three views must be reported together:

- **All scheduled:** 28 slots, 14 pairs, including the empty interrupted slot as predeclared.
- **Complete-pair sensitivity:** remove the entire Q5 repetition-2 pair, not only the interrupted answer, leaving 26 slots and 13 pairs.
- **Pre-interruption sensitivity:** also remove both continued Q6/Q7 repetition-2 pairs, leaving 22 slots and 11 pairs.

No historical attempt is pooled with these observations. The known heldout reported cost was USD 0.054850176. Actual total heldout cost is unknown because interrupted-slot usage was not retained. Development plus known heldout cost was USD 0.076983360, excluding the interrupted usage, earlier attempts and engineering/grading-agent costs.

## Blinding and separate endpoints

An independent extraction worker verified the source-ledger hashes and byte equality of every retained answer. All 28 slots were included, with fresh random IDs and no arm, order, repetition, runtime or failure-cause metadata in the grading packet. The interrupted answer remained empty. The arm mapping was held separately until final source-backed judgments were locked. This is **label-blinding**, not guaranteed perceptual blinding: answer wording or citation style can suggest a condition.

Four model-based initial graders and four separate model-based blind adjudicators (GPT-6 agents) used the same pinned source, unchanged keys and frozen method. This was not human adjudication, and shared model-family judgment errors remain possible. The endpoints are not combined into a winner score:

1. **Factual coverage:** mean answer-level fraction of keyed facts stated correctly, regardless of citation format. Missing or contradicted facts receive zero.
2. **Exact supporting key-fact coverage:** mean answer-level fraction of all keyed facts that are correct and accompanied by exact, supporting source citations.
3. **Locator validity:** valid existing repository-relative path plus explicit in-bounds line interval, divided by all attempted reference occurrences. Basename-only, path-only and malformed references remain in the denominator.
4. **Actual evidentiary support:** supported claim-reference associations and the subset both exact and supporting, counted separately from locator validity. Explicit joint evidence is one support bundle.
5. **Wrong and unsupported claims:** distinct deduplicated factual propositions, with uncited, unresolvable and non-supporting citation reasons distinguished. Correct but uncited is not a factual error.
6. **Failure to answer:** all scheduled empty, refused or off-topic nonanswers retained. Relevant partial or incomplete final answers are scored as delivered, not treated as automatic nonanswers or silently excluded. Empty answers have zero keyed coverage. Zero citation/claim denominators are N/A, never perfect precision.

Primary means weight scheduled answers equally, equivalent to equal question weight in the balanced design. Sensitivity views also report equal-question means because questions then have different numbers of repetitions. Pair differences and win/tie/loss counts are descriptive; two repetitions of seven questions are not 14 independent task families. No statistical-significance or general noninferiority claim is made.

## Requirement-to-observation checks

| Requirement | Concrete observation | Boundary |
|---|---|---|
| Plugin actually loads with its dependencies | Clean installed packages loaded 20 OCBI tools in the compiled OpenCode host; full serialized contracts matched | Config-origin equality alone was insufficient in the older deployment |
| Preserve answer instructions through discovery without repeating routing | Captured first/post-`index_status` requests showed the baseline/candidate lifetime difference | Neutral scripted provider proves transport, not model compliance |
| Reset instructions between turns and avoid stale asynchronous state | Routing tests cover new conceptual/definition/unrelated turns, unready/incompatible/failed status, parallel late results and session eviction | Deterministic unit coverage, not a claim about every host version |
| Preserve adapter behavior | 96 focused routing and legacy/v2 adapter tests passed, including real controller use through adapter hooks | V2 and developer-role hook tests use test contexts; the measured host uses the working system-role legacy path |
| Preserve broader behavior | Full build, typecheck, lint and regression gate passed: 137 test files passed, 1 skipped; 2,430 tests passed, 6 skipped | Skips remain disclosed |
| Preserve actual packaging/public entry points | Built CLI smoke passed MCP initialization, concurrent connections, CJS idle/resume, ESM EOF/signal shutdown, CLI help and CJS export checks. Packed smoke clean-installed both staged package identities and passed CLI help/index-estimate checks through their installed binaries. | Local supported-platform validation, not a fresh all-platform release. The packed smoke does not perform an MCP handshake |
| Demonstrate real workflow readiness | Four development qualification cells completed with real OCBI retrieval, source reads and final answers | Separate development evidence, not scored quality data |
| Measure answers rather than instruction generation | 27 completed heldout answers plus one preserved administrative failure, independently extracted and label-blind graded | Single host/model/repository, small task set and interruption deviation |
| Avoid arithmetic/denominator drift | Deterministic aggregation validated IDs, fact vectors, count constraints, N/A denominators and whole-pair sensitivities; 44 synthetic tests passed | Source judgment remains adjudicator-dependent |

The code fix is committed as `be26a13` on the release worktree. This report does not assert publication, merge into main, or cross-platform release completion.

## Audit anchors

Detailed prompts, private keys, neutral answers and mappings remain owner-only local artifacts, not committed answer or credential dumps. The main evidence directory is `~/.jcode/scratch/ocbi-answer-guidance-lifetime-20260927T0833Z/`, with `grades-final/BLIND-LOCK.json` and `analysis-results/summary.json` identifying the locked analysis. The following hashes identify the evidence used here:

| Artifact | SHA-256 |
|---|---|
| Original scored plan | `102bc68e3caf63cd5fa7840e45914ad0417e31b5d3aa19651bd99b1bb4e8f195` |
| Study runner | `3048068923f2052ed344ec8ea82e5e2fd9f159b7db64216035d201304981a35a` |
| Frozen protocol | `6d86aafb6d5b97fdd382ae57f4ea2a04224e4b6a46d4b3c96481087c60565825` |
| Arm-neutral grading method | `7af5c36508d3ad5c22a4390e080770ea5cb1b935b854f8d0fd1dd5bfefd26f2b` |
| Arm-neutral private keys | `c7dafd51e483143b959300290c640beaeb45c35a7bd3abc6133f54665b0fe6c4` |
| Administrative continuation amendment | `3d6feb2f9cdc59749b7797ad0f1302aa27d7454f1e98e261f1c4f7304cc82751` |
| Derived all-28 ledger | `2b0e1cf9263903da29cdc2c49a173056700a67b660e48a4b1d8c4fd2ee5e1fcd` |
| Neutral grading packet | `0df25ccde170a578687d2766c27033f3501f0b698788fa30c2a2944d3fcb0a48` |
| Aggregation implementation | `8232a7757bb41bad5a58d9431da2ed2ce0a2298e87e3a464ec5c60f9c52bcd2b` |
| Locked blind adjudication manifest | `68eaa70035237528f933d595f4445b99936b7552a969a10ab5ed640792c7cd34` |
| Final all-cohort quantitative summary | `1719df82d391998ee6a2a49e250a78bcdb062082930e27a83b838b4155b4c205` |
| Independent arithmetic-check evidence | `173af3a2a21c9ba90567df9ed9349b8bfa26e715afb931761fe38817d23969c2` |

All four adjudication shards and their correction notes are pinned by the blind lock. Corrections were source-backed and applied before the condition mapping was opened at 18:59 UTC on September 27. No factual key was changed. The coordinator independently verified neutral-ID membership, all 196 fact positions, all seven keyed source blobs, schema/count constraints and the final hashes. The locked quantitative summary contains per-slot and per-pair values for all three cohorts. No grade was changed after unblinding. A separate arithmetic implementation recomputed every reported numeric field across all three cohorts with zero discrepancies, and an independent report reviewer checked the tables, rounding, weighting and bounded conclusions against the locked summary.
