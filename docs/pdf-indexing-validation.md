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
| Search, peek and context citation formatting | Focused formatter tests plus real MCP `search`, `peek`, `context`, and `find_similar` | Met; PDF results use `p.`/`pp.` and ordinary code retains line ranges |
| Page-aware context deduplication | Regression test with identical local line ranges on separate PDF pages | Met; both physical pages remain in the context pack |
| Failed embedding retry, branch references and reranker reconstruction | Shared metadata reconstruction inspection and PDF database branch-reference regression | Page/source metadata is preserved by shared storage paths; no live failed-provider retry or remote reranker acceptance was run |

## Regression results and limits

- 22 real-parser/boundary tests and 5 isolated lifecycle tests passed.
- Complete independent gate: build, typecheck, lint, and **1,811 tests in 114 files
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
  encrypted replacement, restart persistence, and deletion. Cross-platform native
  release packaging, broader Unicode/CMap-heavy corpus evaluation, live
  failed-provider retry, and remote reranker acceptance remain future release-quality
  work, not blockers for the opt-in integration.
