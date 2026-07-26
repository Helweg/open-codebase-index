---
description: Trace callers, callees, or paths using the call graph
---

Trace function dependencies using the `call_graph` and `call_graph_path` tools.

User input: $ARGUMENTS

Interpret input as follows:
- If input asks for a path, connection, route, chain, or "from X to Y", use `call_graph_path`.
- Default to `direction="callers"` unless input asks for callees/calls/makes calls.
- `name=<function>` or plain text function name sets `name`.
- The symbol name is sufficient for callers and callees.
- Parse optional `file=<path>` or `directory=<path>` only when the tool reports multiple exact-name definitions.
- For path queries, parse `from=<function>`, `to=<function>`, optional `fromFile`, `fromDirectory`, `toFile`, `toDirectory`, and optional `maxDepth=<number>`.

Execution flow:
1. If input asks for a path and has source/target names, call `call_graph_path` with `{ from, to, fromFile?, fromDirectory?, toFile?, toDirectory?, maxDepth? }`.
2. If direction is `callers`, call `call_graph` with `{ name, direction: "callers" }`.
3. If direction is `callees`, call `call_graph` with `{ name, direction: "callees" }`.
4. If `call_graph` reports ambiguity, retry with the listed `file` or a unique containing `directory`. If `call_graph_path` reports ambiguity, retry with the corresponding `fromFile`/`fromDirectory` or `toFile`/`toDirectory`. Never choose a candidate silently.

Examples:
- `/call-graph Database` → callers for `Database`
- `/call-graph callers name=Indexer` → callers for `Indexer`
- `/call-graph callees name=Database` → callees for the unique indexed `Database`
- `/call-graph callees name=handle file=src/api.ts` → callees for the selected same-name definition
- `/call-graph path from=createOrder to=chargeCard` → shortest known path between the two symbols
- `/call-graph path from=handle fromDirectory=src/jobs to=save toFile=src/db/save.ts` → path between selected same-name definitions

If output says no indexed symbol was found, check the exact name and suggest running `/index force` if the index is stale.
