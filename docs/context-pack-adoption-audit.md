# Context-pack adoption audit

## Decision

Do not add a new context-pack tool, CLI command, or storage/runtime layer.

OCI already provides the relevant portable composition through `codebase_edit_context`: a token-bounded target implementation, direct callers and callees, and a risk-marked conceptual fallback. It is registered for OpenCode, MCP clients, and Pi, and is evaluated by the existing pre-edit context suite.

The smallest plausible gap is **discoverability after a change target becomes known**, not retrieval capability.

## Evidence

- `codebase_context` already routes conceptual discovery, symbol definitions, and `from`/`to` dependency paths through shared operations with a 128 to 4000 token budget.
- `codebase_edit_context` already composes authoritative source with direct graph evidence and an unresolved-target fallback. It is a portable tool registered by OpenCode, MCP, and Pi adapters.
- The MCP server instructs agents to use `codebase_context`, then `implementation_lookup`, `codebase_search`, and graph tools. Pi additionally recommends a compact, optional first-pass context lookup.
- Public tool-selection documentation does not currently include `codebase_edit_context` in its recommended selection order, and host guidance does not consistently identify it as the optional transition from discovery to modification.
- The existing pre-edit evaluation asserts target retrieval, graph-neighbor recall, bounded output, and safe unresolved fallback. It does not establish agent task-resolution impact.

## Explicit non-goals

- Do not force retrieval for every coding task.
- Do not add a second context-pack interface or a standalone `contextd`-style runtime.
- Do not claim test-to-symbol certainty. OCI has no durable test-relationship graph.
- Do not change the stable response shape or token behavior of `codebase_context`.

## Minimal experiment

1. Add a narrowly scoped, optional guidance sentence in each host's existing routing guidance:
   - for a requested code change with a known or suspected target symbol, `codebase_edit_context` is an optional pre-edit next step;
   - otherwise retain the current compact discovery flow;
   - never require a tool call.
2. Add host-conformance tests that assert the sentence is present and does not replace the existing compact/discretionary wording.
3. Exercise the existing deterministic `pre-edit-context` evaluation to ensure no retrieval, route, graph-neighbor, or response-token regression.
4. Only then run a frozen agent-task comparison with the same repository/task set, existing indexes preserved, and the following reported separately:
   - resolved tasks;
   - billed tokens;
   - retrieval calls;
   - returned context tokens;
   - wall-clock time.

## Decision gate

Keep the guidance only if it improves task resolution or materially reduces unnecessary discovery steps without an unacceptable token increase. The previous small agent pilot is a warning against forced retrieval: optional compact guidance improved resolution but used more billed tokens, while forced retrieval was less effective than optional guidance. A convenience claim without an agent-level comparison is insufficient.

## Follow-up after a successful experiment

If the optional guidance passes the gate, document the selection rule in `docs/tools.md` and host skills. Do not add a new public tool unless an evaluated task exposes information that `codebase_edit_context` cannot supply.
