# Tools and commands

## Private GitHub repository history

The `repository_history_sync`, `repository_history_search`, `repository_history_status`, and `repository_history_clear` tools are available through OpenCode, MCP clients (including Codex, Claude Code, Jcode, and generic MCP), Pi, and omp. They use an explicit per-project opt-in in that host's project-local configuration:

```json
{
  "repositoryHistory": {
    "repositories": [
      { "repository": "owner/repo", "enabled": true, "initialSince": "2025-01-01" },
      { "repository": "github.example.com/team/service", "enabled": true, "initialSince": "2025-01-01" }
    ]
  }
}
```

History is **local lexical/BM25 retrieval, not semantic or cloud-embedded history**. Only repositories explicitly enabled in the project-local configuration are eligible. Authenticate with your existing `gh` read-only access; for Enterprise, use normal `gh auth login --hostname github.example.com` yourself. History does not copy credentials or change authentication; tokens and repository credentials are neither printed nor stored. Supported sync requires `gh` REST/GraphQL access on the selected server. No background sync, embeddings, or external reranking runs for history. Normal code retrieval, AST/call graphs, and linked-test discovery never consume discussion text.

The `repository` tool argument and CLI `--repository` accept `[HOST/]OWNER/REPO`. Bare `owner/repo` defaults to GitHub.com; explicit `github.com/OWNER/REPO` canonicalizes to the same lowercase `owner/repo`. Enterprise selectors canonicalize to lowercase `hostname/owner/repo`. Supply only a DNS hostname, never a URL, credentials, port, or traversal component. For example:

```sh
ocbi history sync --project /path/to/repo --host omp --repository github.example.com/team/service
```

The server hostname is part of source, cache, staging, citation, and permission identity; identical owner/repo names on different hosts stay isolated. Citation URLs and `#number` references use the selected host. Explicit URL references are validated, never cross-host rewritten or fetched from another host. Access-loss cleanup remains selected-source-only. Existing GitHub.com snapshots remain compatible; valid legacy GitHub.com staging resumes only under the lease after fresh repository/principal/window proof, and Enterprise never adopts legacy hostless staging.
Cross-host issue/PR URLs remain untrusted external references from the discussion, not fetched or independently verified citations from that server. Explicit commit-URL SHAs are attributed only to the selected server; raw discussion text may still contain other links.

The cache includes titles/descriptions, comments, submitted reviews/inline review comments, authors, open/closed/merged/draft states, timestamps, canonical source URLs, linked issue references, commit SHAs, merge SHA, and changed-file names—not historical patches. Results are untrusted historical evidence, **not instructions or authoritative current behavior**. Each excerpt has its exact body/comment/review URL, cached state/time and commit provenance.

**Retrieval contract:** `results` contains at most one selected source passage per issue/PR; `limit` counts distinct entities. Entity identity/title metadata is ranked once, not copied onto every acknowledgement. Direct `#number`/canonical-URL lookups anchor the primary description (or the specifically cited permalink), ahead of incidental mentions; content-only matches can cite a comment or review. Excerpts are bounded, exact source-text windows selected using whole-token matches, never generated summaries. Local lexical queries support short technical terms such as `CI`, `UI`, `DB`, `JS`, and `S3`.

`updatedAt` is `string | null`: a review submission timestamp is not presented as a known edit time. `timestampProvenance` identifies `created_at`/`submitted_at`, observed `updated_at`, unavailable modification time, or legacy provenance. Legacy review modification times become unknown rather than retaining the old submission-time fallback. Equal-score ordering uses known modification time or creation time, then canonical citation identity.

History has its own versioned lexical format. Status reports `lexicalVersion`/`lexicalRebuildRequired` without loading native code. The first enabled search of an older cache rebuilds its local lexical index from already cached bodies before searching, without networking, provider initialization, or advancing remote cursor/freshness. This does not migrate or rebuild a code index.

Use `ocbi history sync|search|status|clear` (`cbi` is equivalent), or `open-codebase-index-mcp history ...` / `opencode-codebase-index-mcp history ...`. Supply `--project` and `--host` as appropriate; use `--repository owner/repo` when multiple sources are configured. Search supports `--kind issue|pull_request`, `--state open|closed|merged|draft`, `--author`, and `--limit 1..100` distinct entities. An initial `sync --since 2026-10-01` overrides source `initialSince`; with neither, the first cycle includes all history/states/discussions. Every discovery page is filtered by created-at, including imports with nonmonotonic dates. Later omitted flags retain the stored effective window. The configured baseline is tracked separately, so unchanged configuration remains valid after an explicit initial override; changing/removing that baseline requires clear-first feedback, not silent deletion. Status exposes effective `initialSince`, current `configuredInitialSince`, and `initialSinceMismatch`. Legacy caches with unknown bound provenance require resolving a mismatch before syncing. Configuration is not inherited from global settings, another worktree, legacy host configs, or `--config` overrides.

The same selector syntax applies to all four history tools and CLI operations. `--host` selects the local integration/configuration mode, not the GitHub server: CLI `--host omp` is an alias for canonical `pi` and shares its existing `.codebase-index` config and storage.

For MCP access without a code index or embedding-provider configuration, run:

```sh
open-codebase-index-mcp --history-only --host codex --project /path/to/repo
```

This exposes the four history tools over stdio; the normal combined MCP server and OpenCode/Pi/omp integrations also expose them. Server startup, status and clear do not initialize the native code runtime. The lightweight MCP-binary CLI `history status`/`history clear` routes additionally need no MCP SDK, and their root/history help uses a lightweight facade; `ocbi`/`cbi` retain normal declared dependencies. Enabled search/sync uses the existing native BM25 implementation only, never the code Indexer or vector/embedding runtime.

**Sync correctness and request cost:** every manual cycle traverses issue/PR cursor connections and fully reconciles discussion collections, including deletions which need not update parent timestamps. Every needed REST endpoint/page is revalidated, using its published ETag when available; a first-page `304` never skips later pages or a growing tail. A `304` reuses the matching projected representation from the same identity/window-bound published cache. Without a validator, the endpoint is read normally. HTTP traversal is not delta-only and may still be expensive: conditional requests reduce unchanged response bodies, not HTTP request count. GitHub documents that authenticated GET `304` responses do not count against the primary rate limit, but secondary limits still apply; GraphQL discovery/capability POSTs are not conditional ([GitHub guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests)).

Each manual sync shares one internal request budget: at most four active GitHub calls and eight request starts in any rolling second, including discovery and fresh capability checks. Up to four entities reconcile concurrently; discovery pages and each entity's endpoint/page chain remain sequential. This hides latency across entities, not within one long collection. Staging hits do not consume network slots, and required revalidation is unchanged. Active and queued work settles before releasing the mutation lease or publishing/purging evidence; a later received access denial takes precedence over other worker failures or cancellation.

These limits are per invocation, not coordinated across processes or other credential users. GitHub [recommends serial requests to avoid secondary limits](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#avoid-concurrent-requests); bounded overlap deliberately trades some of that conservatism for latency reduction and does not guarantee immunity to throttling. Primary quotas and secondary limits still apply. A rate-limit failure stops the cycle without automatic retry; the next explicit sync can resume completed checkpoints.

Successful projected reads/pages are privately checkpointed so quota/transport interruptions resume on the next explicit sync; there is no retry daemon. Checkpoints keep only required endpoint fields, not foreign linked-issue bodies or raw API objects. Old unprojected staging is retired under the mutation lease on the first enabled operation without reading its bodies; this discards unsafe unfinished progress, not published history. Current pending reviews retain only pagination identity/state, not unsubmitted bodies. The published cache/cursor advances only after complete traversal and final checks. Edits/removals replace old evidence; unchanged lexical documents and their serialized index are reused. Partial-data errors and invalid cursors fail explicitly rather than claiming completion.

Host cancellation is checked during bounded local work and snapshot preparation, not just API waits. Cancellation observed before the atomic commit decision leaves published bytes/cursor unchanged and retains valid projected staging. A cancellation arriving after that decision cannot undo publication. An already-committed leftover stage is retired rather than replayed as a new refresh.

Commit provenance is explicitly **linked references**, not an exhaustive git-commit mirror: merge/head/base SHAs, timeline commit links, and explicit commit URLs in discussions (`commitReferenceScope: "linked"`). GitHub's REST 250-commit listing cap therefore cannot block a large PR's discussions. Changed-file references use GitHub's maximum 3000 file names, never patches; each result exposes `fileReferencesComplete` and `totalChangedFiles`, and status exposes `incompleteFileReferenceEntities`. A completed discussion sync does not claim an exhaustive file list when that flag is false.

If GitHub's PR-files endpoint returns HTTP `422` with structured error code `not_available`, sync retains the PR and all fetched discussions, publishes `files: []` with `fileReferencesComplete: false`, and continues with other entities. This applies even when the PR reports zero changed files and zero commits: an unavailable diff is not proof of a complete empty file list. Other API failures still fail the cycle without advancing the published cursor; cancellation and final atomic publication checks are unchanged. Error diagnostics never include raw GitHub response bodies.

**Freshness and permissions:** GitHub pages are not a globally atomic remote snapshot. A completed cache represents successful fetches since its cursor/start time; a resumed cycle can include older checkpointed pages. `lastSyncedAt` identifies the latest successfully published fetch cycle, not an exact remote permission/content instant. Concurrent remote changes are reconciled by a later full cycle. Search/status are offline and cannot verify real-time permissions. A detected denial/revocation/transfer blocks and purges searchable content, projected validator/body-reference cache, and unfinished staging; a received known denial dominates coincident cancellation. Transient transport/rate-limit errors preserve prior valid data with explicit error status and unchanged cursor. Snapshots, projected representations and unfinished fetches are bound to immutable repository ID, public principal and initial window. A replacement repository at the same name cannot inherit private evidence. Offline cached results are not proof of current GitHub access.

Both issue and PR read capabilities and the public authenticated `viewer.id` are freshly probed (never replayed from staging or validators) before resume and again after expensive snapshot preparation, immediately before publication. Fresh repository identity is checked at the same boundaries. No token/token hash is stored. A metadata-only credential or account switch cannot turn previous private discussions into newly authorized evidence.

Storage is host/project-local under `.opencode/history`, `.claude/history`, or `.codebase-index/history`, with source-hashed directories (0700), snapshots/checkpoints/preparations (0600), atomic publication, and an independent mutation lease. A cache-owned `.gitignore` excludes data and locks from ordinary Git adds; the root `.gitignore` is untouched. Host/config/cache symlinks are refused rather than inheriting unrelated opt-in/storage. No code-index migration, movement or deletion occurs. Clear removes the published history (including projected HTTP cache), unfinished staging, and reserved orphan snapshot preparations—even after disabling the source (supply `--repository` if no longer configured). Crashed-owner preparations are recovered under the same lease; an active writer is not purged. Disabled sync/search never access the API or read/return cached private content.

History directories are reserved code-index metadata boundaries, not opt-in source folders. Code collectors, watcher snapshots, and direct file eligibility checks reject the three host `history` trees and canonical/symlink aliases even when `includeExcluded` or `includeIgnored` broadly selects dotfiles. Ordinary explicitly selected source dotfiles retain their existing behavior.

Tool availability depends on the host mode.


## Host surface matrix

| Host / integration | Tool surface | Additional capabilities |
|---|---|---|
| `opencode` (plugin) | 24 tools (20 portable + 3 knowledge-base + 1 OpenCode-native) | Slash commands and `index_visualize` |
| MCP clients, including `codex`, `claude`, and `jcode` | 23 tools + 5 prompts (20 portable + 3 knowledge-base) | `--history-only` offers the four isolated history tools |
| `pi` (Pi extension) | 23 tools (20 portable + 3 Pi knowledge-base) | Bundled `codebase-search` skill with host-specific knowledge-base names |
| `omp` (omp extension; CLI `--host omp` aliases `pi`) | 23 tools (20 portable + 3 Pi knowledge-base) | Reuses the Pi extension surface, bundled `codebase-search` skill, and `.codebase-index` config/storage |

Codex, Claude Code, Jcode, Cursor, Windsurf, and generic MCP clients share the same MCP registrations and operation lifecycle; they are thin host/configuration integrations, not independent retrieval implementations. MCP cancellation and progress depend on the client forwarding cancellation notifications and requesting a progress token. OpenCode v1 forwards its tool `abort` signal and publishes indexing metadata; OpenCode v2 bridges its `signal` and `progress` callbacks to the same tool handlers. Pi and omp use the shared native-extension registrar.

### Portable MCP core (20 tools)

These tools are available through the MCP server and the OpenCode plugin.

- `codebase_context`
- `codebase_edit_context`
- `codebase_search`
- `codebase_peek`
- `index_codebase`
- `index_status`
- `index_health_check`
- `index_metrics`
- `index_logs`
- `find_similar`
- `implementation_lookup`
- `call_graph`
- `call_graph_path`
- `pr_impact`
- `architecture_context`
- `code_communities`
- `repository_history_sync`
- `repository_history_search`
- `repository_history_status`
- `repository_history_clear`

The MCP server also exposes five prompts:

- `search`
- `find`
- `definition`
- `index`
- `status`

### Knowledge-base tools

The MCP server and the OpenCode plugin expose the same three knowledge-base tools. The index is the union of the project code and the configured knowledge-base folders.

- `add_knowledge_base`
- `list_knowledge_bases`
- `remove_knowledge_base`

Notes for MCP clients:

- `add_knowledge_base` writes the path to the **project-local** host config of the MCP server (for example `<repo>/.claude/codebase-index.json` for the `claude` host, or `<repo>/.codebase-index/config.json` for `codex`, `jcode`, and `pi`), and refreshes the index. It is not a user-global change.
- The MCP server runs at a fixed project root for its lifetime: explicit `--project`, otherwise the nearest containing Git checkout, otherwise `process.cwd()`. Knowledge-base tools operate on that root and the server host config; they do not reroute per call. Linked worktrees retain their own checkout root.
- Different MCP hosts pointed at the same repository keep separate knowledge-base lists in separate host config files.
- `list_knowledge_bases` shows the union of project-local and user-global knowledge bases. `remove_knowledge_base` edits only the project-local config, so a knowledge base inherited from a user-global config is not removable by this tool.
- Git blame metadata is collected only for files in the project git repository. Knowledge-base files outside the repository remain searchable by content but have no blame, so `blameAuthor`, `blameSha`, and `blameSince` filters match only in-repo files.

### OpenCode-only tools and commands

OpenCode adds one extra tool beyond the shared MCP and OpenCode set:

- `index_visualize`

`index_visualize` generates a self-contained offline HTML codebase explorer. Browse categorized path-based modules, drill into exact files and symbols, and inspect directed call relationships and original callsites. Analyze offers whole-snapshot Changes, Hotspots, and Cycles without losing the underlying exploration scope.

OpenCode also exposes slash commands (see [OpenCode slash commands](#opencode-slash-commands)).

### Pi naming notes

Pi does not expose the shared knowledge-base names. It registers equivalent tools with host-specific names:

- `knowledge_base_list`
- `knowledge_base_add`
- `knowledge_base_remove`

Pi exposes all 20 portable tools, including `architecture_context`, `call_graph`, `call_graph_path`, and the four `repository_history_*` tools, plus its three host-specific knowledge-base aliases.

omp registers the same names and aliases through the shared Pi registrar, so the Pi naming notes above apply unchanged.

## Task-specific tool selection

Check `index_status` when index readiness or freshness is unknown; index only when missing, stale, or incompatible. Then choose the tool for the current task, not a mandatory sequence:

- **Unfamiliar repository orientation:** one compact `codebase_context` first pass (`tokenBudget: 600`, `limit: 5`) for layout, relevant symbols, or cross-file intent. Inspect the evidence before broad reads or searches; skip this step when scope is already known.
- **Known definition:** `implementation_lookup` directly.
- **Callers/callees or dependency paths:** `call_graph` or `call_graph_path` directly once symbols or endpoints are identified.
- **Known or suspected edit target:** optional `codebase_edit_context` for bounded target source plus direct callers/callees.
- **Metadata-only semantic locations:** `codebase_peek`.
- **Matching implementation text:** `codebase_search`.
- **Known paths or exact/exhaustive literal matches:** targeted file reads or `grep` directly.
- **Repository-scale planning:** `architecture_context` when module responsibilities and boundaries are unknown.

Do not repeat context calls or broad reads when existing evidence already answers the question.

## Core retrieval tools

### `codebase_edit_context`

Use for a known or suspected edit target. `query`, optional `symbol`/`filePath`, caller/callee limits, and a 128–4000-token budget produce target source and direct graph evidence, or a risk-marked conceptual fallback. `filePath` disambiguates the target; it does not restrict related test locations to the implementation directory. Details count only source and graph evidence retained in the response.

Target source comes from the resolved native symbol ID, not ranked body chunks. Selection checks the exact project path, name, kind, and declaration start; a same-named suffix path or enclosing declaration is not target evidence. Large declarations start at their canonical signature. Source blocks are capped at 512 tokens to reserve space for relationships and test references, while the complete response still honors the requested budget. Missing or nonunique implementation source is explicitly withheld rather than replaced with another body or an inaccessible-file marker.

Set `includeTests: true` to add current-source, AST-verified JS/TS test references using the same bounded discovery engine as `codebase_context`. `direct_target_test_reference` identifies a call/construction of the target inside a supported test callback; `related_caller_test_reference` identifies a verified one-hop caller reference. Both are static source links, **not runtime coverage or proof that a test passes**. Test rows contain exact callback citations, the canonical referenced symbol, and the reference line; drill into those locations for assertions.

Direct test rows precede graph neighbors; related caller-test rows follow them. Every complete row, source excerpt, label, and notice shares the existing token budget. MCP `structuredContent.testDiscovery` and Pi/omp details contain only rendered `results`, discovery resolution/counters/`capped`, and `omittedReferenceCount` for proved references lost to response fitting. Empty, ambiguous, unsupported, capped, or unavailable discovery is not proof that no tests exist. Omitted/false `includeTests` does not run discovery.

The existing `includeApiImpact: true` option remains separate: Express/fetch `candidate_test_file` matches are candidates, not verified test-reference labels. See [API impact](api-impact.md). MCP and Pi/omp expose structured pre-edit details; OpenCode retains its text response.

### `architecture_context`

Use `architecture_context` when an agent needs a concise repository map before focused retrieval or edits. Each module includes a responsibility excerpt derived from readable source and exact symbol/file/line citations. Cross-module boundaries include representative source and target symbols, while missing or sparse graph coverage is reported explicitly instead of inferred. Coverage includes branch-aware resolved and unresolved edge totals plus a deterministic per-language breakdown.

`query` and `directory` constrain which modules can consume the response budget. `depth` controls detail from 1 to 3, and `tokenBudget` is enforced from 128 to 4000 estimated tokens without cutting claims or citations mid-entry. When community data is unavailable, the tool can still group matching indexed symbols by source directory, but it labels that fallback and does not invent relationships.

Set `includeRecentActivity: true` to include matching Git activity from the last 90 days with commit, date, summary, and file provenance. If no matching Git history exists, the tool reports that directly and does not substitute graph importance as recent activity.

### `codebase_context`

Use for compact orientation when repository layout, relevant symbols, or cross-file intent is unfamiliar; start with `tokenBudget: 600` and `limit: 5`. It returns a bounded, deduplicated, file-diverse evidence pack. Explicit symbol-definition and `from`/`to` path routing remains supported, but known definitions and relationships can go directly to their specialized tools.

Important options include result limits, file and directory filters, path disambiguation, and a `tokenBudget` from 128 to 4000 tokens.

For definition and conceptual retrieval, `directory` and `fileType` stay in force by default, including inferred-symbol fallbacks. A scoped miss does not trigger an unscoped search. Set `allowUnscopedRecovery: true` to permit the previous behavior: retry without the supplied filters after scoped attempts find no evidence. A successful scoped lookup is not broadened, and enabling recovery without filters adds no attempt.

Opted-in relaxation remains visible in a `Recovery: … filter removed` notice and in structured recovery details. Use `diagnostic: true` to inspect the final search scope. These retrieval filters and the recovery option are not used for `from`/`to` graph paths; use `fromFilePath` and `toFilePath` to disambiguate their endpoints.

Set `diagnostic: true` when troubleshooting a surprising result. MCP returns the normal text response unchanged and provides bounded routing, retrieval, and evidence-pack traces as structured content. OpenCode and Pi render the same diagnostics alongside the normal response. Leave it unset during normal use.

Symbol-focused natural-language test requests containing one exact identifier (for example, `tests for signalGate`) use bounded caller-aware discovery. The identifier retains its original case. Requests with additional behavioral qualifiers (such as cancellation or error conditions) retain ordinary query-aware retrieval rather than being replaced by identifier-only ordering. Explicit `symbol` input still requests definitions only, even when the query mentions tests; multi-identifier questions and ordinary definition, documentation, conceptual and graph-path routes retain their existing behavior.

Discovery resolves a unique exact **executable** declaration from current source, excluding declaration-only `.d.ts` variants, erased ambient declarations and type-only names without hiding genuine runtime ambiguity. A truncated canonical lookup or stale/unreadable candidate cannot establish uniqueness and yields no linked evidence. Discovery verifies current-source one-hop caller references and searches only active-branch indexed JavaScript/TypeScript test files, including conventional standalone `test.js`/`spec.js` and their supported source extensions. A graph callback owner may use its source-verified enclosing exported declaration. Caller lookup is qualified by its known source file, so same-name owners in other files do not hide that declaration. Returned locations distinguish **Direct target test reference** (`direct_target_test_reference`) from **Related caller test** (`related_caller_test_reference`); structured selected locations also include `referencedSymbol` and `referenceLine`. A related caller reference is not direct target coverage, and neither label proves runtime execution or every invariant.

Direct target references always precede related caller references. Within the related tier, bounded test-body text is ranked by overlap with the target identifier's words, including word-prefix matches; this is a lexical relevance heuristic, not additional linkage or coverage proof. Remaining ties retain indexed lexical file order, then source order. No extra embedding requests or candidate-search calls are performed. Evidence labels follow the existing `file:line-line (score …)` citation so source-range consumers can retain their citation grammar.

References must be executable native-parsed calls or constructions inside exact `it`/`test` callback-body AST ranges, using full native UTF-8 source positions rather than merged or split retrieval chunks. Optional native module metadata shares the parsed JS/TS tree and records lexical scopes, exact declaration kinds/ranges and call positions; test-container metadata remains opt-in. Current-source bindings must resolve to the target or verified caller through the same local module resolver used by indexing, including supported workspace exports and TypeScript path aliases. Bare calls and constructions may use renamed local bindings; `referencedSymbol` records the canonical target or caller name, not the local alias. Same-file linkage compares the actual declaration at the call site with the complete current target/caller identity, not merely its name or enclosing line. Parameter, destructuring, catch, loop and local shadows remain effective; erased ambient metadata does not introduce runtime ownership.

Bounded CommonJS support accepts an immutable top-level `const Name = require('literal')` only when the importer has proved CommonJS origin and `require` is an unshadowed Node builtin. The target must have one statically available root `module.exports = Name`, either unconditional or inside the supported `typeof module !== 'undefined'` availability guard without an alternate branch, and have proved CommonJS format. `.cjs`/`.cts` are explicit CommonJS; ambiguous extensions require bounded nearest in-root package-format evidence. An ownership boundary, missing proof, runtime ESM syntax, shadowed/reassigned builtins, dynamic/conditional/competing exports or export-object escape causes abstention. ESM default import of a proved CommonJS root remains supported; requiring an ESM default is not treated as importing that function. Arbitrary compiler rewrites and CommonJS property-export patterns are not inferred.

Package selection models the default Node 22.22+ conditions: `node`, `node-addons`, `module-sync` and `default`, plus mode-specific `import` for ESM or `require` for CommonJS. Declaration order, exact/wildcard precedence and explicit blocks are retained; custom runtime condition sets and opt-out flags are not inferred from source. Legacy `require` entry points use only `main`, not bundler `module` or declaration `types`. Assignment-form `for-in`/`for-of` headers (including destructuring and `for await`) and parenthesized writes, including leading comments and nested parentheses, invalidate affected binding proofs. Ordinary functions' implicit `arguments` objects block outer bindings in parameters and bodies; arrows inherit lexical ownership. Computed method names execute in the enclosing scope and retain its constructor owner. Potential sloppy-script Annex B hoists also invalidate existing body-level function declarations without opening ambiguous parameter/var bindings. Explicit strict directives, runtime ES module syntax, class strictness and lexical declaration conflicts retain block-function isolation.

Ordinary function declarations/expressions can support construction when native syntax proves constructability. Arrow, async and generator functions do not; classes support construction, not bare calls. Same-name foreign imports, comments, strings, substring matches, import-only mentions, registration arguments and arbitrary object/`this` methods are not linked evidence. Syntax errors, unsupported runtime binding patterns or escaped runtime binding spellings, and unverified or unresolved nearer configuration fail linkage closed. Aliases outside the bounded candidate set, namespace calls, dynamic registrations and unsupported container shapes can be missed; this is discovery, not exhaustive coverage analysis. Missing or ambiguous targets return no linked evidence; missing or stale graphs cannot create caller linkage. When linked discovery misses, ordinary scoped conceptual retrieval remains available without direct/related labels.

Each discovery attempt is capped at eight graph owners (at most two enclosing declaration lookups per owner), 200 source-verified test files, 64 on-demand indexed import-module reads, 48 total unique ancestor manifest/configuration reads with at most four local configuration-loading rounds, 256 KiB per safely contained file, and 20 distinct test-reference candidates. Package-format evidence shares the same accounted configuration cache and 48-file budget; exhausting it cannot bypass the cap through a separate reader. A canonical lookup reaching its existing 100-definition bound cannot prove executable uniqueness. Candidate files begin with provider-free indexed BM25 evidence for the exact target and up to eight verified caller identifiers: each identifier has a hard 800 candidate-chunk probe, with active-branch and allowed-file eligibility enforced before file selection. If all eligible test files fit within the 200-file verification budget, append remaining indexed files in deterministic path order after ranked candidates; short import/require headers omitted from chunks cannot hide references in that bounded inventory. Larger inventories retain lexical-only selection rather than scanning the first 200 alphabetic paths. Ranked candidates use stable interleaved identifier/file lanes. Oversized, unreadable or escaping-symlink files are skipped. Source/metadata caps are disclosed through `testDiscovery.capped` and a visible notice when reached. Direct references precede related ones with stable path/line ordering; the existing result limit (default 10), token-budget defaults and 128–4000 token bounds still control selected evidence. Expansion makes no embedding calls and does not change generic BM25, vector or fusion scoring.

The bounded 20-reference set retains the strongest source-verified candidates, replacing a weaker retained reference when a later verified candidate scores higher; direct precedence and deterministic ties remain unchanged. Selected lexical test files receive configuration-probe priority over unrelated test directories. Confirmed missing configuration is distinct from unprobed, unreadable or semantically unresolved configuration, so neither a cap nor unsupported package-based `extends` can silently substitute an ancestor alias or workspace package for an unknown nearer mapping. Selected and demanded importer manifests refresh the bounded package-ambiguity table and dependent export cache before linkage; duplicate names fail closed, and an awaiting export traversal cannot repopulate a newer package epoch's cache. Request-local seeded module records and call/container associations are reused, registration text is sliced lazily, and repeated verified references in one container do not retokenize or split the whole source. Only AST-proven bare calls/constructions bypass receiver inspection; ordinary receiver and namespace-constructor behavior is unchanged.

Additional inventory scanning loads importer configuration on demand before the first bare bound call in a supported test container, instead of preloading every appended path. Ranked importer configuration is loaded first; unrelated workspace test paths without such calls do not consume that priority. Canonical-spelling calls are verified across all selected files before other alias spellings, so unrelated imported helpers cannot spend the module budget before those proofs. Source parsing and file counts remain per file, and result ranking is unchanged.

Other bound calls still share the fixed module, configuration and loading-round budgets; unrelated helpers can prevent later aliases from being proved. A capped or empty result is not an exhaustive absence claim. Package ambiguity reflects the safely discovered manifests, not a complete workspace audit.

Test locations obey normalized `directory`/`fileType` filters, including when target or caller navigation leaves the test directory. Scoped source-linked discovery and ordinary scoped conceptual fallback both precede any unscoped test discovery or retrieval. Useful scoped alias evidence may remain unlabelled without causing recovery. Unscoped test recovery requires `allowUnscopedRecovery: true` and remains explicitly disclosed; scoped success is not broadened.

### `codebase_peek`

Returns likely locations and metadata without full source bodies. Use it when you want to choose files before reading them.

### `codebase_search`

Returns full semantic search results, optionally with context lines and filters. Use when matching implementation text is needed; no preceding context or peek call is required when the task is already scoped.

### `implementation_lookup`

Use directly for known-definition questions. Finds authoritative definition locations and prefers implementation files over tests, documentation, examples, and fixtures.

`tokenBudget` optionally bounds the visible text response to an estimated 128–4,000 `cl100k_base` tokens (default: 1,200), including citations, code fences and omission notices. The response first reserves an unclipped citation for each distinct retrieved file, in first-occurrence order with its original result rank and range. If these citations exceed the budget, only a ranked prefix is retained and omitted file locations are disclosed. This keeps a large declaration or many declarations in one file from hiding later files whose citations fit.

Repository text is counted with ordinary-text encoding: literal tokenizer control spellings such as `<|endoftext|>` are preserved as source, not rejected or treated as special-token instructions.

Source bodies use the remaining budget in original result order. Retrieved source is shown in full when it fits; otherwise the response keeps a whole-line prefix, closes the fence and labels the partial body outside the source. Locations whose bodies do not fit remain as citation-only entries without inventing source. Source-body omissions and file-location omissions are reported separately. Reserving file citations can reduce visible source-body detail in a tight budget. Generic search previews retain their existing limits.

This budget does not reduce MCP structured results or Pi/omp result details, and those payloads can exceed the visible-text budget. A retrieved chunk or citation range is not proof of an independently verified complete declaration, dependency closure or compiler-valid edit context.

### `find_similar`

Finds code analogous to a supplied snippet. Useful for duplicate detection, pattern discovery, and refactoring preparation.

## Index lifecycle tools

### `index_status`

Reports stored catalog state, chunk counts, compatibility, current provider/model, and auto-index coordination separately from source freshness. Ordinary calls return `freshness: null` and `Source freshness: not checked`; a populated catalog is not proof that current source bytes or HEAD were indexed.

Pass `checkFreshness: true` to compare the selected source/configuration hashes and HEAD with the index using the existing freshness engine. Structured status returns `{ readable, current, reason }` under `freshness`, with the same facts shown in text. The check does not index, retry failed batches, request embeddings, or start watchers; explicitly enabled SCIP validation may use its configured bounded decoder. This is a point-in-time check, not an atomic snapshot. Cancelled or failed checks do not become current results.

Catalog presence and provider/model compatibility remain separate from pending storage migrations. An active catalog can be `ready` and compatible while parser, symbol, or call-graph migration markers are outdated. `migrationRequired` and a noncurrent freshness reason recommend ordinary `index_codebase` with `force: false`, not index deletion. Resolve unreadable source/index access before indexing. The CLI equivalents are `ocbi status --check-freshness` and `ocbi status --check-freshness --json` (`cbi` is equivalent). JSON contains the shared status object; MCP adds the diagnostics below, while Pi/omp return the same facts as details. Workspace status remains a bounded catalog inspection with freshness explicitly not checked.

MCP responses add `structuredContent.mcpDiagnostics` with schema version `1`. `activeOperations` reports each operation, its current phase, start and last-activity timestamps, and `active` or `suspected_stall` status. The current `index_status` call is excluded. `latestInterruptedOperation` is included only after an ordered shutdown marks an active call or a later local process confirms that the recorded PID is absent. A stale heartbeat alone is never classified as an interruption.

### `index_codebase`

Creates or updates the index. Incremental indexing is the default. Use `force: true` only for a required full rebuild. `estimateOnly` reports estimated embedding work without indexing. `dryRun` parses the real file set and reports the exact embedding token total (files, source chunks, tokens) without requesting embeddings or writing to the index — a read-only preflight.

### `index_health_check`

Removes stale references and reports orphan or artifact health.

### `index_metrics`

Returns process-lifetime operational metrics and enabled privacy-safe effectiveness aggregates.

### `index_logs`

Returns recent in-memory debug logs when debug logging is enabled.

### MCP errors and progress

Every MCP handler failure returns `isError: true`, a concise English instruction, and a redacted structured error:

```json
{
  "error": {
    "schemaVersion": 1,
    "code": "OPERATION_TIMEOUT",
    "operation": "index_codebase",
    "phase": "embedding",
    "durationMs": 123,
    "retryable": true,
    "nextAction": "Check index_status for the stalled phase, then retry the operation."
  }
}
```

Codes are `OPERATION_TIMEOUT`, `OPERATION_CANCELLED`, `PROVIDER_ERROR`, `INDEX_BUSY`, `INDEX_UNAVAILABLE`, and `INTERNAL_ERROR`. Provider timeouts, HTTP 429, and HTTP 5xx failures are retryable. Other HTTP 4xx failures and internal errors are not. Tool arguments, queries, paths, provider URLs, response bodies, raw causes, and secrets are never copied into this structure.

When the caller supplies a progress token, long-running operations reuse that exact token and emit serialized, strictly increasing progress from `0` through `100` with `total: 100`. No progress notification is emitted without a token. Raw progress still refreshes the inactivity deadline even when rounding produces no new percentage.

## Call graph and impact tools

### `call_graph`

Finds direct callers or callees for a function or method. File-path disambiguation is available when names are duplicated. For TypeScript and JavaScript, indexed call targets use current native lexical binding identity for same-file declarations and can follow local relative ES module imports, re-export chains, proved static CommonJS require/root ancestry, `tsconfig`/`jsconfig` path aliases, and project-local package imports selected by root workspace declarations or ancestor compatibility when no declaration exists. Package entry points support exact and bounded single-wildcard `exports`. Conditional exports use the default Node `node`, `node-addons`, `module-sync` and `default` conditions plus `import` for ESM or `require` for CommonJS, in declaration order. Custom condition sets and opt-out flags are not inferred. Exact, null, and unsupported export declarations block broader wildcard fallbacks, and wildcard precedence follows Node's package-export specificity. External packages, unsupported CommonJS export patterns, missing modules, malformed, encoded-traversal, `node_modules`, escaping, or unsafe package metadata, and ambiguous module, package, or star-export targets remain unresolved rather than being guessed.

JavaScript and TypeScript generator declarations and expressions are indexed as named functions, with calls assigned to the owning generator. Imported-symbol refreshes preserve already stored outgoing edges across indexing batches. Normal incremental indexing upgrades legacy graph catalogs and rebuilds affected unchanged source files without deleting the index or re-embedding unchanged chunks.

### `call_graph_path`

Finds the shortest known call path between two named symbols.

### `code_communities`

Discover call-graph communities and hub symbols, and summarize coupling between communities.

Options:

- `branch`: optional branch name to analyze.
- `minSize` (default 1): minimum number of symbols in a community.
- `limit` (default 20): maximum number of communities and hub nodes returned.
- `hubThreshold` (default 5): minimum distinct cross-community neighbors for a symbol to appear as a hub node.
- `minCoupling` (default 1): minimum distinct cross-community connection count required for a coupling entry.
- `couplingLimit` (default 20): maximum number of couplings included in results.

Output includes community summaries, hub node rows, and `Community couplings` entries with representative symbol-to-symbol relationships.

### `pr_impact`

Analyzes changed files, affected symbols, transitive dependencies, graph communities, hub nodes, conflicts, and merge risk for a branch or pull request.

Branch materialization uses invocation-unique temporary worktrees. A cross-process lease scoped to the common Git directory protects registration and deregistration, including linked-worktree callers; fetches and indexing callbacks remain concurrent. Cancellation while waiting for registration removes the unused temporary checkout, and unverified cleanup preserves its path rather than deleting potentially registered data.

Set `workingTree: true` to inspect the union of staged, unstaged, and untracked path changes. First run ordinary incremental `index_codebase` after editing: this mode uses the **current indexed dirty tree**, not the old committed graph. A stale, mismatched, missing, or migration-pending index is rejected with a refresh instruction; inspection does not refresh it automatically.

Working-tree analysis is file-level static graph reachability, not changed-line analysis, a staged-blob comparison, or a historical deletion graph. It reads local Git status with no optional locks/fsmonitor hook, preserves literal XY states and rename origins, and never fetches, invokes `gh`, creates a worktree, or stages/resets files. It is mutually exclusive with explicit `pr`, `branch`, and `checkConflicts: true`. The existing branch/PR preparation path is unchanged when the flag is false.

MCP structured content and Pi/omp details include `workingTree.headCommit`, `scope: "current_indexed_files"`, selected `entries`, `omittedFileCount`, and `unassessed` paths/reasons. Deleted files, rename source paths, unindexed or symbol-free files, non-regular/outside-project targets, and changes beyond the 200-path cap yield `riskLevel: "UNKNOWN"` rather than a false LOW. Known graph counts remain available but are partial. A clean tree reports no working-tree changes; an empty list never implies runtime safety.

Before/after status, HEAD, indexed changed-file hashes, freshness, and database publication fingerprints reject concurrent changes without automatic retries. These are bounded observations, not an atomic filesystem snapshot. Nested-project analysis retains only local rename endpoints. Unmerged status, invalid UTF-8 paths, malformed/overflowing Git output (1 MiB bound), and operational failures are explicit errors. The CLI equivalent is `ocbi impact --working-tree --json` (`cbi` is equivalent); see [Human CLI](installation.md#human-cli).

## OpenCode-native tools

OpenCode registers the portable tools, the three shared knowledge-base tools, and one OpenCode-only tool:

- `index_visualize`

`index_visualize` generates a self-contained offline HTML codebase explorer. Open the returned file in a browser; no server, CDN, or external assets are required. The CLI equivalent is `npm run visualize -- --project /path/to/project`.

Overview is the initial module directory, grouped into **Code**, **Tests & fixtures**, and **Supporting files**. Category checkboxes affect only this directory, not global search or snapshot totals. Cards show exported-symbol, represented-file, and distinct neighboring-module counts. These are path-based groups, not authoritative architecture.

Open a module for **Incoming modules → selected module → Outgoing modules**, followed by **Files and symbols**. The independent module-local filter matches full file paths, symbol names, and kinds. File disclosures create symbol rows only when opened. File and symbol lists use 50-item pages; focused neighbor lanes use 12-item pages, replacing rather than accumulating rows. Open a symbol for **Caller → focus → callee**, exact definition location, Module navigation, and Copy location. Self-calls appear once on the center card. Module edges represent cross-module calls only.

Each neighbor has separate navigation and **Inspect N calls** buttons. Inspect keeps the focus and shows navigable endpoint definitions, original caller file/callsite lines, call types, and confidence in Details. Horizontal connectors offer the same action by pointer; the native Inspect buttons remain keyboard-accessible. Narrow focus containers stack center, incoming, and outgoing sections, with sticky **Focus / Callers / Callees** jump controls (or **Incoming / Outgoing / Files** for modules). Use normal scrolling and browser zoom; there is no draggable global network.

Global search matches names, full paths, and kinds with 50-item pages; `/` focuses it. Typing highlights visible matches without rebuilding the focused scene. Back/Forward and parent breadcrumbs navigate within the artifact. **Analyze** replaces the main surface with whole-snapshot Changes, Hotspots, or Cycles; **Back to exploration** restores the same scope. Search, category choices, filters, disclosure state, pagination, and scoped scroll positions remain document-local; reload restores only the hash-selected scope and evidence. Smaller screens expose Search and Details as keyboard-accessible dialogs; Escape restores their opener.

Cards display shorter paths anchored to their exported module prefix where possible; full original locations remain in path tooltips, the symbol inspector's **Original definition path** disclosure, and **Copy location**. File-group symbol rows show definition lines without repeating the containing path. The header shows exported totals; **Export details** exposes pre-filter input counts and scope. Single-page lists omit inactive pagination controls; larger lists retain all pages.

The view describes an exported resolved-call snapshot, not all dependencies or live state. Input counts precede filtering; **Partial graph** means the node limit omitted symbols/relationships. Modules retain path-based grouping. Recent Git activity retains the 90-day/indexed-file scope; call-graph fallback records appear separately as **Structural context**. Attention is heuristic and provided file paths are sampled. Hotspots rank incoming plus outgoing edge records. Cycles show mutually reachable groups (including self-recursion), not ordered paths or a complete-program guarantee.

Pi also provides native integration for knowledge bases using `knowledge_base_list`, `knowledge_base_add`, and `knowledge_base_remove` tool names.

Tool descriptions and MCP initialization instructions include routing guidance, but the client decides whether and when to invoke tools.

## OpenCode slash commands

| Command | Purpose |
|---|---|
| `/status` | Check index readiness and provider metadata |
| `/index` | Incrementally index the repository |
| `/reindex` | Force a complete rebuild |
| `/search` | Search by meaning and return source results |
| `/peek` | Find likely locations with minimal content |
| `/find` | Combine semantic discovery with precise follow-up |
| `/definition` | Find a symbol's authoritative definition |
| `/call-graph` | Query direct callers or callees |
| `/pr-impact` | Analyze branch or pull-request impact |
| `/visualize` | Generate the interactive index visualization |

The command definitions live in [`commands/`](../commands/).

## Filters

Search tools support combinations of:

- file extension
- directory
- chunk type
- git blame author
- git blame SHA
- git blame date
- result limit
- source context lines

Branch scoping is enabled by default for repository searches.

## Exact search still matters

Semantic retrieval is not a replacement for exact text search. Prefer `grep` when:

- you know the exact identifier
- you need every occurrence
- you are searching generated data or unusual syntax
- the file is not indexed

Use semantic tools when you know the behavior or intent but not the name.

See [Installation](installation.md) for host setup and [Configuration](configuration.md) for indexing and search behavior.
