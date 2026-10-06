# Maintainer exposure register, 2026-10-06

## Status and audit limits

This is a **partial, evidence-backed disclosure of development exposure**, supplied for the independent review request in [issue #420](https://github.com/Helweg/open-codebase-index/issues/420). It is not an independent novelty audit, approval or exhaustive account of all developer/model history. Unknown exposure must remain unknown, not be converted into a novel/held-out decision.

The registry covers currently inspected repository fixtures, published benchmark reports and a recovered maintainer experiment record. It does not claim to inspect every private session, deleted scratch experiment, contributor environment, upstream model-training dataset or repository fork/shared ancestry. No private prompt transcripts, local absolute paths, credentials or user indexes are published here.

## Confirmed real-repository exposure

All nine repositories below are development-exposed. A new query or revision does not automatically restore repository-held-out status. The revisions are the currently checked-in expanded-cohort pins; the independent reviewer must also compare the September source lock and any earlier revisions/forks.

| Name | Upstream | Expanded-cohort revision |
|---|---|---|
| axios | https://github.com/axios/axios | `d8233d9e8e9a64bfba9bbe01d475ba417510b82b` |
| express | https://github.com/expressjs/express | `2cd372e34cd6613f4d00836c2ee122f28bddfcb3` |
| click | https://github.com/pallets/click | `00e592cea702e0b2caa0dee42489fdb1c22cd845` |
| cobra | https://github.com/spf13/cobra | `adbc8813901bba65827259daa8e22ff94ec1f30e` |
| ripgrep | https://github.com/BurntSushi/ripgrep | `3fce3b5bb0236da2df6d99672afb8a719642eca7` |
| gson | https://github.com/google/gson | `119818bc666d3b9f897d6c0ca7546ce28e9bbcac` |
| newtonsoft-json | https://github.com/JamesNK/Newtonsoft.Json | `13f774fa5a984374295c67bf5610e379135067db` |
| symfony-console | https://github.com/symfony/console | `8a42f59125da6a5d4bde376e5df6411a3de807fe` |
| sinatra | https://github.com/sinatra/sinatra | `cb22afd7902b566b6eaba6c4ea89739494a65d12` |

Evidence:

- [`expanded-cross-repo/cohort.json`](../../benchmarks/golden/expanded-cross-repo/cohort.json) and its nine task datasets: reviewed mixed-intent development cohort, 100 queries.
- [`cross-repo/`](../../benchmarks/golden/cross-repo/): earlier axios and express task datasets.
- [September competitive results](2026-09-10-competitive-results.md) and [`source-lock.json`](../../benchmarks/competitive/2026-09-10/source-lock.json): five-configuration development study, not a blind holdout.
- [August cross-repo baseline](2026-08-13-cross-repo-100-query-nomic-baseline.md), [mixed-intent pilot](2026-08-09-expanded-cross-repo-mixed-intent-pilot.md) and [identifier-promotion study](2026-09-13-identifier-promotion.md): additional disclosed evaluation history.
- A recovered October 5 maintainer session reports an October 2 Kev experiment and subsequent retrieval diagnosis using local fixtures and the same nine-repository cohort. This is **maintainer-reported session evidence**, not an independently reproduced experiment in this registry; it reinforces exposure, not performance or novelty claims. Hosted Jev was not reported as tested.

OCBI's own repository is also development-exposed: it is the implementation under active development and supplies local retrieval/evidence fixtures. Do not treat its source as a fresh independent repository.

## Confirmed local and synthetic fixture exposure

Treat these existing inputs as development/calibration data:

- [`benchmarks/golden/`](../../benchmarks/golden/): local representative, agent-context, architecture-context, pre-edit-context and small/medium/large datasets, plus the external cohorts above.
- [`benchmarks/fixtures/`](../../benchmarks/fixtures/) and [`benchmarks/baselines/`](../../benchmarks/baselines/): existing ranking, effectiveness and indexing fixtures/baselines.
- [`conformance.json`](../../benchmarks/competitive/2026-09-10/conformance.json): hand-authored `js-orders` and `py-payments` graph/freshness fixtures. They are bounded public adapter controls, not fresh repository-quality evidence.
- Existing coding-pilot cases and their reference/evaluator material are exposed development controls; the September coding pilot cannot supply independently held-out coding tasks.
- The October 6 synthetic approval-hash fixture and historical diagnostic replay are software integrity controls/derived artifacts, not a novel cohort.

Any current participant calibration or broker/evaluator feasibility work must stay labelled development-only. Its fixtures become part of the exposure record, not candidates for later confirmatory scoring.

## Snapshot fingerprints

SHA-256 values identify inspected bytes, not reviewer endorsement. Later fixture changes require a new snapshot and disclosure; preserving the source histories matters as well as the current hashes.

| Repository-relative artifact | SHA-256 |
|---|---|
| `benchmarks/golden/expanded-cross-repo/cohort.json` | `9e58596dd9988d8453a0621117d50a460f99f16c36858487d4a39ab1789cc583` |
| `benchmarks/competitive/2026-09-10/source-lock.json` | `7a3ee6a08e750433ef847705ddc5d583e57292b297ba35340cb33d319283aff1` |
| `benchmarks/competitive/2026-09-10/conformance.json` | `5efc78b9d136c6843f4349318d05a630d453fbf172f4da296cf522bd7c18f979` |
| `benchmarks/golden/representative.json` | `6598ad4a41f07e63a21c47e498740773849f72d445f168fd97ee50f86122a90e` |
| `benchmarks/golden/agent-context.json` | `9ff9622181eca3063b9fbfe996681f74bde326412866495622d638f3e1480b02` |

## Required reviewer work

Audit proposed repositories against this register and relevant disclosed histories, including exact identity, forks, shared ancestry, tasks and revisions. Request missing exposure evidence before accepting novelty. Record what was searched, what was inaccessible and how unresolved overlap affects the intended claim. Selection, sample-size rationale, sealed task/evaluator hashes and actual approval remain the independent curator/reviewer's responsibility under the [handoff](2026-10-06-independent-review-handoff.md).
