# PDF foundation validation, 2026-09-09

Foundation implementation: `41c9711`. Shared indexing integration was completed in
the subsequent working tree and validated through public CLI and MCP workflows.

## Shared indexing acceptance, 2026-09-09

- Explicit `additionalInclude: ["**/*.pdf"]` remains required. Defaults still do
  not discover PDFs.
- Public `cbi index --dry-run` on the published W3C PDF reported 1 file, 1 chunk,
  and 22 locally estimated Ollama tokens. No index files were written by dry-run.
- Public force indexing with live `nomic-embed-text:latest` embedded one extracted
  chunk. A separate public `cbi search "Dummy PDF file"` process returned the exact
  text with the truthful citation `dummy.pdf, p. 1`.
- An unchanged incremental run embedded zero chunks. Deleting the PDF removed one
  stale chunk and a subsequent public search returned no result.
- Replacing the indexed PDF with malformed bytes removed its stale passage while
  indexing continued and reported the per-file typed extraction diagnostic publicly.
- Page locations and exact extracted snippet text are persisted in vector metadata,
  failed embedding records, and the SQLite chunk catalog. PDF search, find-similar,
  context packs and reranker inputs do not reread binary bytes as UTF-8.
- PDF chunks do not create symbols, calls or Git blame. Semantic-only mode retains
  document chunks, and duplicate text on separate pages receives distinct IDs and
  citations.

## Real document and public CLI observations

Downloaded the public W3C PDF from:
<https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf>

- 13,264 bytes.
- SHA-256: `3df79d34abbca99308e79cb94461c1893582604d68329a41fd4bec1885e6adb4`.
- This document contains compressed content and an embedded TrueType font.
- Calling `extractPdfText` on its original bytes returned exactly
  `{ "pages": [{ "pageNumber": 1, "text": "Dummy PDF file" }], "pageCount": 1 }`.
  This independently confirms the extractor output used by the public pipeline.

### Historical pre-integration baseline

Before the shared ingestion wiring was implemented, the real built `cbi` CLI was
run with an isolated project and explicit PDF include. That historical run observed
seven binary-derived chunks and established the defect that this integration fixed.
It is retained as regression context only and does not describe the final tree.

### Final public acceptance

The final tree was exercised through the real built `cbi` CLI, MCP stdio tools,
OpenCode plugin factory, supported CJS package entry point, and Bun plugin runtime.
The CLI flow used an isolated project, an external knowledge base, explicit
`additionalInclude: ["**/*.pdf"]`, and live Ollama
`nomic-embed-text:latest` embeddings. Representative commands included:

```sh
node dist/cbi.js index --project "$PROJECT" --host jcode \
  --config "$CONFIG" --dry-run
```

Observed:

1. Default discovery remained unchanged and did not discover the PDF.
2. An independent explicit-include dry-run reported **1 file, 1 chunk, 25 estimated
   tokens**. A separate final-tree run reported 22 locally estimated tokens. Both
   selected the same extracted passage and wrote no index during dry-run.
3. Force indexing embedded one chunk. A separate search process returned exactly
   `Dummy PDF file` with `dummy.pdf, p. 1`.
4. MCP stdio initialized 19 tools. `codebase_search`, `codebase_peek`,
   `codebase_context`, and `find_similar` returned page-aware PDF results.
5. Public indexing and search passed on Node 22.13 and Node 24. The OpenCode plugin
   factory passed through the supported CJS package entry point and through Bun.
6. SQLite schema 8 persisted `documentKind`, physical page range, and source text.
   Restarted search reconstructed the same text and page citation.
7. An unchanged run embedded zero chunks. Valid replacement, encrypted replacement,
   restoration, and deletion all removed stale chunks as appropriate. Extraction
   failures remained per-file and surfaced actionable diagnostics.

## Requirement-to-observation map

| Requirement or changed output | Check | Observed result |
|---|---|---|
| Plan and implement opt-in PDF indexing | `docs/pdf-indexing-plan.md`, extractor and shared ingestion implementation | Milestones 1–3 and the opt-in integration portion of milestone 4 delivered; deferred release gates remain explicit |
| Local text extraction and page numbering | Published W3C document plus real-parser multi-page test | Correct W3C text on page 1; multi-page test returns pages 1/2/3 with blank page 2 preserved |
| Preserve line breaks and repeated page text | `extracts text from multiple pages and keeps empty pages`; `preserves a nonzero-offset byte view and repeated page text` | Expected newline and distinct page numbers asserted and passed |
| Byte/page/aggregate text limits | Limit tests and `accepts exact byte, page and aggregate character limits` | Exact boundaries accepted, over-limit inputs return the matching typed code |
| Validate configured limits | Parameterized invalid-limit test for all three options | Zero, negatives, fractions, NaN, infinity and unsafe integers rejected |
| Protected PDF diagnostic | Real encrypted fixture, also opened independently using its known password | Extractor returns `ENCRYPTED_PDF`; PDF.js opens the same valid document with the password |
| Malformed/no-text diagnostics | Malformed, blank and whitespace-only document tests | `INVALID_PDF` or `NO_EXTRACTABLE_TEXT`, as applicable |
| Input bytes remain caller-owned | Buffer and nonzero-offset view tests | Original backing bytes preserved |
| Cancellation/stall semantics and cleanup | Separate lifecycle tests plus real-parser cancellation test | Active loading/text work cancelled; shared interruption object preserved; page/task cleanup called; cleanup failure does not replace primary parse failure |
| No mandatory native canvas for text extraction | Subprocess deliberately blocks loading `@napi-rs/canvas` | Real PDF text extraction succeeds on Node 22.13 and 24 |
| Preserve package/runtime compatibility | TypeScript/native builds, typecheck/lint, package smoke checks, Node 22.13/24, Bun and CJS public flows | Passed; package identities and public tool names unchanged |
| Preserve current default public behavior | Real CLI with and without the W3C PDF | Identical dry-run output; PDF is not newly discovered |
| Truthful changelog and capability claims | Changelog and configuration docs describe opt-in support and unchanged defaults | Matches delivered behavior and limits |
| End-to-end PDF ingestion, incremental reindexing and search | Real CLI with W3C and IRS PDFs, invalid/encrypted replacements, restore and delete | Met; extracted text is searchable, stale chunks are removed, and failures are actionable |
| Persisted PDF page citations across hosts/restarts | SQLite schema 8 inspection plus restarted CLI/MCP searches | Met; physical pages and source text survive restart |
| Additive schema 7→8 migration, rollback and read-only compatibility | `pdf-database.test.ts` plus native schema migration, atomic rollback, idempotence, catalog-preservation and read-only compatibility tests | Existing schema-7 source rows remain intact with absent PDF fields; schema 8 publishes document fields atomically and remains readable across restart |
| Metadata-only search output | `PDF Indexer integration > indexes, persists, restarts, skips unchanged files, and removes invalid replacements` restarts with `includeContext: false` | The result retains physical page metadata while public `content` is intentionally empty, matching the existing no-context contract |
| Search, peek and context citation formatting | Focused formatter tests plus real MCP `search`, `peek`, `context`, and `find_similar` | Met; PDF results use `p.`/`pp.` and ordinary code retains line ranges |
| Page-aware context deduplication | Regression test with identical local line ranges on separate PDF pages | Met; both physical pages remain in the context pack |
| Failed embedding persistence and retry fields | `PDF Indexer integration > persists PDF retry fields and restores page-aware search after retry` reads the isolated JSONL checkpoint, closes the writer, creates a new `Indexer`, and calls `retryFailedBatches()` through the real indexer interface with deterministic mocked Ollama HTTP responses | `content`, `documentLocation.kind`, physical page range, and `sourceText` survived the checkpoint/restart; retry cleared the failure and restored page-aware search. This is representative local interface coverage, not a live third-party outage |
| Reranker PDF snippets and hard scope | `PDF Indexer integration > sends persisted PDF text and page metadata to the reranker after hard scope filters` force-indexes, restarts, then searches with `fileType: "pdf"` and a deterministic mocked custom reranker HTTP endpoint | Every transmitted candidate path was a PDF, source code was absent, and transmitted documents contained persisted physical-page metadata plus extracted PDF snippet text. No paid or remote reranker was called |
| Definition and graph exclusion | Public MCP `implementation_lookup` and `call_graph` against a PDF-only index, plus `PDF Indexer integration > excludes PDF passages from definition intent while retaining code definitions` | The public check exposed a defect where semantic definition fallback returned a PDF. Definition-intent candidate filtering was fixed below adapters; the repeated MCP check returned no PDF definition, call graph remained not-found, and a mixed index still returned the ordinary source definition |
| Semantic-only, symbols, calls and blame | `prepareDocument` real-parser regression, semantic-only `PDF Indexer` integration, database metadata inspection, and public graph checks | PDF chunks survive `semanticOnly: true`; preparation emits no symbols; public graph lookup finds no PDF symbol/edge; persisted PDF/search metadata contains no fabricated Git blame or line citation. Source files retain normal symbols and line behavior |
| Extractor-version invalidation | `versions PDF chunk identities` plus changed-file hash-path inspection (`sourceHash` combined with `PDF_EXTRACTION_VERSION`) | PDF chunk IDs and cached file hashes are versioned while ordinary source hashes are not. A source-level constant-bump rebuild was not performed because it would mutate production behavior solely for a test |
| Branch switching and rename | Real built CLI with live local Ollama in an isolated Git repository (`pdf-branch-acceptance-Ifx7NX/acceptance.log`) | Main indexed the PDF; a feature branch reused the same text/page with zero embedding tokens; rename removed one stale old-path chunk and returned only the new path; returning to main restored only the main path/text/page |
| Linked worktree materialization | Real built CLI with live local Ollama in an isolated linked Git worktree (`pdf-branch-acceptance-Ifx7NX/worktree.log`) | Worktree indexing reused the branch-aware PDF chunk with zero embedding tokens and returned exact text with page 1 |
| Default discovery, explicit include/exclude and size gate | Real CLI dry-runs (`pdf-discovery-V67hNC/acceptance.log`) plus isolated `dryRunCost()` regression | Defaults selected only `source.ts` (1 file/1 chunk/14 tokens); explicit include selected source plus PDF (2/2/30); PDF exclusion and `maxFileSize: 1000` each produced output byte-identical to the default run |
| Watcher and manual-index consistency | PDF uses the existing shared discovery predicates; existing watcher snapshot/reconciliation suites cover include/exclude configuration changes, while the real CLI and `Indexer` checks cover manual indexing | No host-specific PDF watcher branch was added. A PDF-specific live filesystem-event acceptance was not run, so watcher coverage is representative shared-path coverage rather than direct PDF event acceptance |
| Per-file diagnostics without collateral failure | Real CLI mixed directory (`pdf-discovery-V67hNC/mixed-failures.log`) and typed extractor/indexer tests | Valid source and PDF indexed while malformed, protected, and blank PDFs independently reported `INVALID_PDF`, `ENCRYPTED_PDF`, and `NO_EXTRACTABLE_TEXT`; valid results remained searchable |
| Restarted semantic-weighted, keyword-weighted and fused retrieval | Separate real CLI processes with weighted fusion at hybrid weights 0, 1, and 0.5 (`pdf-branch-acceptance-Ifx7NX/retrieval-modes.log`) | Every mode returned exact W3C text and `guide.pdf, p. 1` after restart. These labels describe weighting; both candidate generators may still execute |
| Local extraction, provider privacy and index-owned plaintext | Configuration documentation review plus index artifact/database inspection | PDFs are read from local bytes only; no remote download or password path exists. Extracted text is stored inside the index and sent only to the configured embedding/reranker providers. No plaintext sidecar is written beside the PDF and tests use isolated temporary directories |
| Dependency pin and license disclosure | Installed package metadata and bundled license inspection | `pdfjs-dist` is pinned at 6.3.289, declares Apache-2.0, and includes its Apache 2.0 `LICENSE`. No new public tool or renamed compatibility surface was introduced |

## Whole-result revalidation after completing the requirement map

The complete implementation at `30af7df` was rebuilt and revalidated after the
requirement map and definition-boundary correction were complete. This was not a
relabeling of earlier incremental checks:

- `npm run build && npm run typecheck && npm run lint && npx vitest run --no-file-parallelism && cargo test --manifest-path native/Cargo.toml --lib && npm run smoke:package`
  passed as one final gate on 2026-09-09: 1,818 TypeScript tests in 114 files,
  130 native tests, native and TypeScript builds, and clean packed installations.
- The coordinator then invoked the rebuilt public CLI and actual MCP stdio server
  with live Ollama. Unchanged indexing did no new embedding work. Search, peek,
  context and find-similar each returned the published W3C text with physical page 1.
  Definition lookup returned zero results rather than treating the PDF as code.
- The measurable improvement over the historical raw-byte baseline is correct
  extracted text and a truthful physical-page citation instead of seven chunks of
  binary-derived text. The whole-suite rerun also re-exercised the mapped extraction,
  cancellation, migration, retry, reranker, discovery and formatting regressions.
- An additional bulk lifecycle/runtime rerun was attempted after this gate but
  rejected by the execution safety gate before running (reported protected path
  `/`). Removing file deletion from the attempted command did not clear the denial.
  No alternate execution path was used to bypass it. Consequently, the table's
  earlier real lifecycle/branch/runtime observations remain valid evidence, but are
  not represented as a fresh, complete post-map rerun. Only the complete build/test/
  packaging gate and direct final CLI/MCP observations above were rerun successfully.
- Evidence boundaries remain as marked in the table. Synthetic provider tests are
  not live remote-service acceptance, and unrun release-platform checks are not
  promoted to passing by this rerun.

## Regression results and limits

- 22 real-parser/boundary tests and 5 isolated lifecycle tests passed.
- Final independent definition-boundary/evidence-closure gate: **1,818 tests in
  114 files passed serially**, with typecheck and lint passing. The updated build
  also passed, and actual MCP rechecks returned no definition for the PDF-only
  index while ordinary PDF search still returned the exact text and page 1.
- Earlier integration gate: build, typecheck, lint, and **1,811 tests in 114 files
  passed serially**. After adding three citation/deduplication regressions, the
  five affected suites passed **119/119**, with typecheck and lint passing again.
- Independent `cargo test --lib` passed **130/130**, including atomic schema-8
  rollback, idempotence, catalog preservation and read-only compatibility tests.
  `cargo fmt --check` and `git diff --check` also passed.
- Parallel runs encountered separate existing temporary-directory races in
  `mcp-operation-execution.test.ts` and `effectiveness-ci.test.ts`. Targeted checks
  and the serial full run passed. No unrelated concurrency code was changed.
- Build/native build, typecheck, lint and the packed smoke suite (27.4 seconds)
  passed.
- Real W3C and IRS documents covered extraction, public search, update, invalid and
  encrypted replacement, restart persistence, deletion, branch switching, rename,
  linked-worktree materialization, discovery gates, and weighted retrieval modes.
- Persisted failed-provider recovery and reranker payload/scope now have deterministic
  mocked-provider tests across a real `Indexer` restart. They are synthetic provider
  boundaries, not claims of a live external outage or paid reranker acceptance.
- Externally unavailable release gates remain: packaged acceptance on Windows x64
  MSVC, Linux x64/ARM64 GNU, and macOS x64; a broader Unicode/CMap-heavy committed
  corpus; a live third-party failed-provider recovery; and a live remote reranker.
  The current macOS ARM64 Node 22.13/24, Bun, CJS, CLI and MCP evidence must not be
  generalized to those platforms or services.
