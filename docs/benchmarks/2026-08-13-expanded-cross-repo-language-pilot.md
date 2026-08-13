# Expanded cross-repository language pilot

The frozen mixed-intent cohort now includes nine repositories and 81 reviewed
queries. Each repository contributes five exact-definition queries, two
keyword-heavy queries, one implementation-intent query, and one conceptual
query.

## Added repositories

| Language | Repository | Revision |
|---|---|---|
| Java | Gson | `119818bc666d3b9f897d6c0ca7546ce28e9bbcac` |
| C# | Newtonsoft.Json | `13f774fa5a984374295c67bf5610e379135067db` |
| PHP | Symfony Console | `8a42f59125da6a5d4bde376e5df6411a3de807fe` |
| Ruby | Sinatra | `cb22afd7902b566b6eaba6c4ea89739494a65d12` |

The full manifest is [`cohort.json`](../../benchmarks/golden/expanded-cross-repo/cohort.json).
Every added path and definition symbol was checked against its pinned local
checkout before adding the dataset.

## Acceptance exercise

The public cross-repository runner was exercised with Nomic and forced
reindexing for the four new repositories. The runner loaded all fixed datasets
and completed Gson, Symfony Console, Sinatra, and a corrected standalone
Newtonsoft.Json run. The initial four-repository invocation exposed a missing
`args.symbol` contract field in the C# definition queries. The dataset was
corrected, and the standalone rerun completed successfully at 66.67% Hit@5.
It also exposed that the runner's controlled config inherited the ordinary
five-level traversal limit, which excluded Gson production source files below
`gson/src/main/java`. The controlled benchmark config now sets `maxDepth: -1`
while retaining its `maxParseFiles` cap. A forced-reindex Gson rerun then
completed at 88.89% Hit@5.

The early quality results are intentionally not treated as a product claim:
Gson reached 88.89% Hit@5 after the depth fix, Symfony Console reached 88.89%,
and Sinatra reached 44.44% in the initial single local Nomic run. These results
confirm the cohort distinguishes language and retrieval behavior rather than
saturating at 100% Hit@5. They also identify Ruby retrieval as a candidate for
separate diagnosis before making ranking claims.

Reproduce the exercise with the checked-out pinned repositories:

```bash
npx tsx scripts/cross-repo-benchmark.ts \
  --repos /path/to/gson,/path/to/newtonsoft-json,/path/to/symfony-console,/path/to/sinatra \
  --dataset-dir benchmarks/golden/expanded-cross-repo \
  --embedding-model nomic-embed-text \
  --reindex --skip-ripgrep --skip-sg
```
