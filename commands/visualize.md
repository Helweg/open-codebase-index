---
description: Generate an offline HTML codebase explorer
---

Generate a self-contained interactive HTML codebase explorer. Start with the categorized Overview directory, drill into modules, exact files and symbols, and inspect directed caller → focus → callee relationships and original callsites. Use Analyze for snapshot activity, hotspots and cyclic groups.

User input: $ARGUMENTS

Parse input for optional parameters:
- Plain text → directory filter (e.g., `/visualize src/services`)
- `max=N` or "limit N" → sets maxNodes
- `orphans` or `include-orphans` → sets includeOrphans=true
- No input → explore the entire exported call graph, starting with Overview

Call `index_visualize` with parsed parameters.

Examples:
- `/visualize` → Overview by default, module/file/symbol drill-down, and whole-snapshot Changes, Hotspots and Cycles under Analyze
- `/visualize src/tools` → only symbols in src/tools/
- `/visualize max=1000` → limit to 1000 nodes
- `/visualize src/indexer orphans` → include disconnected nodes

If the index doesn't exist, run `index_codebase` first.

Return the generated file path and open instructions.

Terminology:
- Modules are path-based code areas, such as `src/tools` or `native`.
- Symbols are indexed named code units, such as functions, methods, classes, or Rust modules.
- Cyclic groups contain mutually reachable modules or symbols; a group is not an ordered cycle path. Single-symbol groups indicate direct recursion.

The generated file works offline without a server or external assets. Open the returned HTML path in a browser. The equivalent CLI is `npm run visualize -- --project /path/to/project`; its directory, max-node, and orphan options are unchanged.

Interaction:
- Search names, full paths, and kinds; `/` focuses search. Results are paginated, not capped.
- Overview: browse Code, Tests & fixtures, and Supporting files. Category checkboxes affect the directory only, not global search or snapshot totals.
- Open a module for incoming/outgoing module relationships and Files and symbols. Filter within the module, open an exact file disclosure, then select a symbol. File and symbol lists page at 50.
- Symbol focus shows callers, the selected definition and callees. Neighbor lanes page at 12; selecting a neighbor replaces the focus rather than growing a network. Self-calls appear once on the focus card.
- Each neighbor has separate navigation and **Inspect N calls** actions. Inspect retains the focus and lists original callsites in Details. Back/Forward and parent breadcrumbs stay within the artifact; URL fragments restore scope and evidence.
- Analyze opens whole-snapshot Changes, Hotspots or Cycles without losing the underlying scope. **Back to exploration** restores it. Use normal scrolling and browser zoom; narrow layouts provide sticky section jumps.
- On smaller screens, Search and Details open keyboard-accessible dialogs; Escape closes them and restores focus.

Scope:
- Counts describe the exported resolved-call snapshot, not all dependencies or live state. Input counts precede filtering. A persistent **Partial graph** warning indicates node-limit truncation.
- Modules use existing path-based grouping. Distinct symbol definitions remain individually navigable.
- Directed relationships represent exported calls. Module relationships aggregate cross-module records; internal calls remain available at symbol level. Original callsite lines are distinct from definition lines. Counts across module and symbol levels overlap and are not additive.
- Git activity covers the existing 90-day window and represented indexed files. **Structural context** is call-graph-derived, not recent history. Attention labels are heuristic and file paths are sampled.
- Hotspots rank incoming plus outgoing call-edge records. Missing relationships or cyclic groups do not prove their absence outside this snapshot.
- Copy location copies the definition path and line; source bodies are not embedded.
