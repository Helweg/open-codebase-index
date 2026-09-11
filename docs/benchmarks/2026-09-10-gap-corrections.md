# Corrections following the 2026-09-10 competitive study

These are post-study product corrections, not a rescore of the frozen competitive benchmark. The original results and comparator configurations remain unchanged. Recovering known failures is acceptance evidence, not held-out evidence of superiority.

## Deep source discovery

The default traversal depth is now unlimited (`indexing.maxDepth: -1`). Explicit limits still apply. This removes the former five-directory cutoff without changing ignored/hidden/build paths, symlink handling, maximum file size, or the per-directory file cap. Hybrid users may index more source and consume more embedding tokens. Set `maxDepth: 5` to retain the former bound.

### Public acceptance

Using the pinned Gson revision `119818bc666d3b9f897d6c0ca7546ce28e9bbcac`, a fresh isolated source checkout and a structural configuration with **no explicit depth setting**:

1. Before the correction, public `cbi index` indexed 20 files and 104 chunks. Separate public `cbi definition` processes found none of the five expected production definitions.
2. After rebuilding the corrected CLI, **normal indexing of the same index, without `--force`**, processed 281 files, added 4,469 chunks and retained 104 unchanged chunks. All five definitions were found at their exact expected files:
   - `gson/src/main/java/com/google/gson/Gson.java`
   - `gson/src/main/java/com/google/gson/GsonBuilder.java`
   - `gson/src/main/java/com/google/gson/JsonParser.java`
   - `gson/src/main/java/com/google/gson/JsonObject.java`
   - `gson/src/main/java/com/google/gson/internal/bind/ReflectiveTypeAdapterFactory.java`
3. A subsequent unchanged public index skipped work. Setting an explicit depth of 5 and normally indexing excluded the deep Gson definition. Restoring the default and normally indexing recovered it again.

Commands used the built `dist/cbi.js`, `--project <isolated-source> --host opencode --config <config>`, with `index`, `definition <symbol>` and `status`. Configuration:

```json
{"indexing":{"mode":"structural","autoIndex":false,"watchFiles":false,"requireProjectMarker":false}}
```

### Requirement-to-check mapping

| Requirement | Check | Observed result |
|---|---|---|
| Discover deep production source by default | Public Gson before/after normal indexing and exact-file definition lookups | 0/5 before, 5/5 after |
| Preserve explicit depth limits | Public depth-5 lifecycle plus `tests/deep-discovery.test.ts` and configuration tests | Deep definition excluded with explicit limit, recovered after restoring default; explicit 0/5/9 and unlimited values preserved |
| Preserve exclusions and traversal safety | Deep-discovery tests for ignored, hidden, dependency/build paths, symlinks, per-directory cap, additional roots and cancellation | All nine tests passed on macOS |
| Remain incremental | Public unchanged index and existing-index normal recovery | Unchanged work skipped; additional source discovered without force |
| Keep prior discovery/configuration behavior covered | Config, files, watcher-snapshot and deep-discovery suites | 163 tests passed |

Local raw acceptance evidence is retained under `~/.jcode/scratch/ocbi-gap-fixes-20260910/`: `before/`, `after/`, `depth-lifecycle.json`, and `gson-acceptance.mjs`. These scratch paths are evidence locations, not shipped runtime dependencies.

## Python relative-import call resolution

The original failure also occurred in fresh indexes in both modes, so it was not solely incremental staleness. Both `format_payment` and `record_audit` were unresolved. The correction adds bounded resolution of direct calls through single-line explicit relative imports, including aliases, to unique indexed top-level functions. It does not execute Python imports or promise general dynamic-language resolution.

The shared resolver now checks package boundaries, ambiguity, shadowing, Unicode NFKC rebinding and detected dynamic binding operations. Complex interpolation, unsupported imports and uncertain targets cause abstention. Graph resolution version 10 triggers normal migration. Python source additions, changes and deletions refresh Python graph sources in both indexing modes.

### Public acceptance

The exact post-change Python fixture from the study was copied into new isolated directories. No original study source, index or result was changed. The coordinator independently ran the rebuilt MCP stdio server through the actual `index_codebase` and `call_graph` tools, using structural mode and hybrid mode with local Ollama `nomic-embed-text`.

Across both modes, **36 public graph checks and 36 read-only SQLite endpoint checks passed**. Fresh indexing, incremental importer modification, process restart, target-line edits, target-file rename, restoration and deletion all produced the expected persisted bindings:

- Existing imports returned `[resolved]` for both calls, with non-null `to_symbol_id` values joining exactly to `payments/formatting.py` and `payments/audit.py`.
- Renaming or deleting the audit module removed its resolved target. The public response reported `[unresolved]`, the persisted target ID was null, and restarting did not restore stale evidence.
- Restoring the audit module recovered its correct target through normal indexing.

This explicitly checks stored import edges, rather than inferring resolution from a graph query's requested subject or fallback. Historical conformance passes were query-interface observations and should not be interpreted as proof that these import edges were already persisted correctly.

| Requirement | Check | Observed result |
|---|---|---|
| Resolve the measured Python calls | Fresh and incremental public MCP calls plus direct SQLite endpoint joins, both modes | Both calls resolve to the exact indexed modules |
| Retain correct graph state on restart | Close/reopen public MCP process after indexing and target transitions | Current targets preserved; deleted/renamed targets remain unresolved |
| Refresh target-only changes | Public target-line edit, rename, restoration and deletion, with normal indexing | Current endpoint IDs retained or cleared appropriately |
| Upgrade existing graph metadata | Actual pre-fix version-9 acceptance indexes migrated through public `cbi index`, after saving exact index snapshots; separate integration regression starts with two unresolved persisted edges | Both modes changed from unresolved to resolved without force or new embedded chunks; integration restart checks also passed |
| Avoid invented bindings | Dedicated negative tests plus independent reproductions for NFKC shadowing, `vars()` mutation, intermediate non-package modules and reused-quote f-string rebinding | All reproduced false positives now abstain; positive baseline still resolves |
| Keep unsupported cases conservative | Tests for missing/ambiguous targets, duplicate imports, local/parameter/comprehension/lambda rebinding, absolute imports, decorated targets and package escape | Unsupported or ambiguous bindings remain unresolved |

The dedicated Python suite has 32 tests, including lifecycle coverage in both modes. Local coordinator evidence: `~/.jcode/scratch/python-import-fix-20260910/coordinator-final-1152-{structural,hybrid}.json`. The retained `final-acceptance.mjs` driver runs a new unique-labeled copy and asserts public results and SQLite joins. Earlier `before-{structural,hybrid}.json` evidence remains untouched.

## Validation scope

Both production corrections are committed separately: `07db5ad` (discovery) and `96c2721` (Python resolution). Native build, TypeScript build and built-CLI smoke, typecheck, lint, clean packed-install smoke and all 142 release-profile native tests passed. The final full serial TypeScript suite passed: **129 files, 2,171 tests passed, 5 skipped**. Its first run exposed stale current-version markers in two branch/PR test fixtures; `a5e37c2` aligns those markers with graph version 10 while preserving deliberate old-version migration cases. The entire suite was then rerun successfully. No release, publication or replacement competitive score is implied by these checks.

Public migration evidence is recorded in `~/.jcode/scratch/python-import-fix-20260910/coordinator-public-migration-1154.json`; exact pre-migration acceptance index snapshots were saved before upgrading those owned scratch indexes. Original competitive benchmark code, configurations and report artifacts have no changes relative to `845318a`.
