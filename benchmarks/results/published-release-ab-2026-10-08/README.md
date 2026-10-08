# Published 0.35.3 vs 0.36.1: exposed regression comparison

This new study reuses the original October 6 nine-repository, 100-task frozen cohort (54 explicit / 46 natural), already development-exposed. It is **not** an independent/representative holdout, semantic implementation or coding-productivity study. Both participants are real verified preferred npm release packages, not local builds or the readiness PR candidate.

All 36 serial cold-index cells, 400 pass-one primary rows and 1,200 query-pass records completed: zero setup/query errors, no retries. Setup budget remains 300,000 ms; query budget 60,000 ms. Pass one alone determines quality. The final freeze was committed before scoring after parent build-gate authorization.

| Mode / track | Published 0.35.3 Hit@5 | Published 0.36.1 Hit@5 | Paired wins / losses / ties |
| --- | ---: | ---: | ---: |
| Hybrid explicit | 40/54 | 54/54 | 14 / 0 / 40 |
| Hybrid natural | 22/46 | 35/46 | 13 / 0 / 33 |
| Structural explicit | 40/54 | 54/54 | 14 / 0 / 40 |
| Structural natural | 20/46 | 24/46 | 5 / 1 / 40 |

File hits do not prove complete implementation bodies. Independently derived full-declaration ranges were frozen before feedback; complete consumer-returned declaration-body Hit@5 is only 8/54 → 14/54 in both modes. Many public bodies are truncated. Natural labels are file-only, so implementation/body correctness is ungradeable. Concrete/inherited/transitive library closure and semantic correctness are not graded. No speed improvement is claimed.

## Artifacts

- [Full protocol/results/limitations](../../../docs/benchmarks/2026-10-08-published-release-ab.md).
- `preregistration.json.gz`: immutable **unscored draft**. Preserved unchanged, superseded by final freeze.
- `preregistration-final.json.gz`: **final pre-score freeze**; all tasks, pins, source/gold/config/package/model/runtime/evaluation/order bindings; API-reported index counters added before scoring, without changing labels or budgets.
- `report.json`: observed pass-one quality, paired mode/track/repository/task deltas and wins/losses/ties, descriptive cluster uncertainty, separate cold/first/warm timings, API-reported work/coverage and limitations.
- `per-task-outcomes.csv`: 400 primary rows; natural body/range metrics explicitly N/A.
- `results-evidence.json.gz`: 170 hash-checked normalized members, including all 1,200 raw tool-query records, 36 raw cell/request/status/config/stderr records, frozen declaration gold and full deterministic analysis code. Original/normalized hashes are distinguished. Not a portable runtime or latency replay.
- `evidence-verification.json`: 80 frozen bindings and 13,068 dependency bytes unchanged; 26,418 returned citations matched pinned sources/ranges across 878 files; model tag digest unchanged. Source readback does not reconstruct omitted consumer bodies.
- `verification.json`: exercised compact replay and retention receipts.
- `historical-preservation.json`: required historical 13 result files plus nine additional result/doc hashes unchanged.
- `pre-execution-supplement.json`, `node-library-receipt.json`: executable/direct library identities; no recursive system-library closure claim.
- `retention.json`: durable private full raw workspace archive, with 34,732 regular members streamed and verified byte-identically.
- `LICENSE-NOTICES.txt`: pinned upstream redistribution notices for published source snippets.

## Analysis replay

From repository root, with Python 3.12 (the recorded analysis runtime):

```sh
python3.12 benchmarks/published-release-ab-2026-10-08/replay.py \
  benchmarks/results/published-release-ab-2026-10-08/results-evidence.json.gz
```

The exercised replay verified all 170 normalized member hashes and reproduced report SHA-256 `477f894b78a66a2d68aded6330e9986fc05df3504e030b41b0996dabc6daa4ab` exactly. No model, new index/query or source build is used by replay.

Complete private originals are retained at `${USER_HOME}/.jcode/scratch/ocbi-published-release-ab-20261008-originals.tar.gz`; SHA-256 `16301559f5c7c2bcb9a4d4fe67c91dbb14cd8a1f20f0b15b2981979d724358d8`, 920,530,168 bytes. Exact canonical source archives, package/dependency/native bytes, all per-cell indexes and raw tool evidence are retained, but system runtime and shared Ollama model files are identified rather than redistributed.
