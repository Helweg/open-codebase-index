# Independent competitive-study review handoff, 2026-10-06

## Historical independent-review route

Outside recruitment was withdrawn at the maintainer's direction; [issue #420](https://github.com/Helweg/open-codebase-index/issues/420) was closed as not planned, not fulfilled. The current work is an [assistant-run, self-curated exploratory comparison](2026-10-06-self-curated-study.md). This document records the separate independent-review requirements, not the current execution gate. No independently approved cohort, acquisition authorization or performance claim is supplied by this handoff.

The [independent-study protocol](2026-10-06-competitive-evidence-plan.md) defines that route's fair inputs, approval gates and claim limits. September's nine-repository study is exposed development data; its diagnostic replay is not a holdout. [Current participant calibration](2026-10-06-current-participant-calibration.md) and the separately frozen self-curated study do not establish independent approval.

## Roles and independence

- **Maintainer:** supplies the exposure register, frozen candidate commit and public interface documentation; does not select tasks based on candidate results.
- **Curator:** selects repositories/tasks independently of OCBI tuning, records selection and exclusions, and may obtain and inspect pinned sources solely for curation under applicable source-access permissions. Curation uses an isolated workspace outside participant-visible roots; sources, questions and reference answers are not handed to the runner before final approval.
- **Reviewer:** discloses involvement in OCBI development or comparator development, checks overlap and task validity, and explicitly accepts or rejects novelty and source acquisition. Prefer a reviewer separate from the curator; disclose any combined role and its limitations.
- **Runner:** executes approved frozen inputs uniformly, preserves every outcome and does not tune against the held-out answers.

Identity strings and matching hashes cannot prove independence. Review must be attributable to a real reviewer, with the scope and limitations stated. Do not publish private prompts, credentials, user indexes or undisclosed task answers to establish independence.

## Phase A: selection and overlap review

Before participant source acquisition or scored execution, return a selection proposal with:

1. Repository names, upstream URLs, immutable commit revisions, licenses and permitted source-access method. State the target population and selection rule; log exclusions and reasons before inspecting participant results.
2. Repository-level sample size and a statistical rationale for the chosen primary endpoint and practically meaningful effect. Tasks from one repository are not independent repository samples. Do not reuse September's 100-task count as a power calculation.
3. Planned coverage of exact-symbol and natural-language questions, implementation discovery, cross-file dependencies, lifecycle/configuration behavior and pre-edit evidence. Include scope/no-result, ambiguous identifiers and large-file coverage cases; keep unsupported interfaces explicit.
4. An overlap matrix against the exposed repositories below, repository fixtures under `benchmarks/`, prior evaluation reports and maintainer-disclosed tuning/experiment history. Record exact identity, forks, shared ancestry, revisions and reused tasks. Unknown history is a limitation, not proof of novelty.
5. A documented curation process recording source-access permissions, pinned revisions and the isolated curator workspace. The independent curator may acquire and inspect those sources to prepare and validate the sealed task/reference package before final study approval. This permission does not authorize participant/runner acquisition, indexing or scored execution; those remain gated on approval of the completed package.

Known exposed September repositories: **axios, express, click, cobra, ripgrep, gson, newtonsoft-json, symfony-console and sinatra**. This is a starting exclusion register, not an exhaustive history audit. Maintainers must disclose additional exposure relevant to the proposed cohort through a sanitized register.

The [partial maintainer exposure register](2026-10-06-exposure-register.md) records confirmed pins, fixture families, source fingerprints and audit limitations. It supplies starting evidence for the reviewer, not an independent novelty decision.

The reviewer should reject repository-held-out status for a previously exposed repository even if the query is new. Public tasks may have model-training contamination; do not claim that review eliminates it.

## Phase B: sealed study package and approval

The final handoff must contain actual artifacts, not example approvals:

| Artifact | Required content |
|---|---|
| `cohort.json` | Validator-compatible repository manifest: unique names, URLs, pinned revisions and dataset paths. |
| Task datasets | Stable IDs, task family, participant-visible question and only user-supplied identifiers/scopes; source-grounded expected answers in the evaluator package. |
| Answer/evaluator package | Correct file/span or dependency evidence and rationale; for coding tasks, reference fixes and independent tests. Keep it outside participant source/index roots. |
| Package digest manifest | Exact-byte SHA-256 of every task dataset, reference artifact and evaluator file. The validator's cohort digest alone does not bind dataset contents. |
| Novelty evidence | Dated selection/exclusion log, exposure matrix, audit sources, reviewer disclosures, unresolved overlap and contamination limitations. |
| Study approval | Actual reviewer identity/date, exact cohort/evidence digests, exact approved repository set, explicit novelty decision and source-acquisition authorization. |
| Preregistration and locks | Frozen candidate/comparator versions and hashes, configurations, coverage, interfaces, budgets, scoring, execution order/seed, resource accounting and statistical analysis. |

Use the existing [approval contract](../benchmarking-cross-repo.md#fresh-study-novelty-gate); do not invent a second approval schema. The reviewer must hash the final bytes, not a subsequently reformatted copy. Archive the signed-off package and record amendments. Approval is invalidated by changed cohort pins or evidence bytes; changed task/evaluator bytes also require renewed review and a new frozen package digest.

The validator's source check confirms that definition symbols occur in the named files. It is **not** semantic validation of reference answers or a hidden-test quality check. The independent reviewer must perform those checks separately.

## Acceptance before scored execution

- [ ] Reviewer identity, independence disclosures and audit limitations are recorded.
- [ ] Selection rule, exclusions, repository-level sample rationale and primary endpoint are frozen.
- [ ] Overlap review accepts the intended holdout status; unsupported or unknown coverage is disclosed.
- [ ] Cohort, evidence, tasks, reference material and evaluator hashes match the reviewed package.
- [ ] Private answers, fixes and tests are inaccessible to participant tools and models.
- [ ] Current public participant interfaces have passed calibration on development-only fixtures; no scored-cohort tuning occurred.
- [ ] Candidate commit, comparator lock, settings, budgets and analysis are committed before scored execution.
- [ ] Both approval and evidence paths are supplied to the acquisition gate; a rejection stops acquisition rather than triggering an integrity-only bypass.
- [ ] For coding outcomes, a separate development-only broker/evaluator smoke proves a valid patch reaches the evaluator, and each task's initial failure/reference success is independently verified.

Run the approved source-integrity gate only when the real package is ready:

```bash
npx tsx scripts/validate-cross-repo-cohort.ts \
  --cohort-dir /path/to/approved-cohort \
  --study-approval /path/to/study-approval.json \
  --novelty-evidence /path/to/novelty-evidence \
  --work-dir /path/to/isolated-study-workspace
```

## Reviewer response

Return a dated **accept / reject / needs revision** decision, supporting evidence, independence disclosures, audited package digests, approved repository set and explicit authorization status. A request for review is not acceptance. Do not increase caps, retry selected failures or remove losing tasks after outcomes become visible.

Once scored results are inspected, the cohort is consumed for confirmatory purposes. It can inform subsequent development, but an improved candidate needs another untouched cohort for a new confirmatory claim. Report only a dated lead over the evaluated pinned systems on the declared task family and constraints when the preregistered evidence supports it; never promise universal SOTA.
