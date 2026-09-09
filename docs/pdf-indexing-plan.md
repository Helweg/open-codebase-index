# PDF text indexing implementation plan

Status: opt-in shared indexing integration implemented and accepted on the tested
macOS public runtimes, 2026-09-09. Cross-platform release-matrix and advanced-corpus
acceptance remain deferred.
Target: a future 0.x release after 0.27.0.

## Outcome and scope

Search text-based PDFs in configured knowledge bases using the existing retrieval
and embedding pipeline, returning extracted text with accurate, 1-based PDF page
citations. No new public tool is required. Initial integration should be opt-in,
respect existing include/exclude rules and knowledge-base scope, and remain shared
below host adapters.

Out of scope: OCR, rendering, attachments, PDF JavaScript/actions, password entry,
remote document downloads, layout-perfect/table reconstruction, and multimodal
embedding. A page means its physical position in the PDF, not a printed page label.
Mixed documents retain their text pages and preserve empty-page numbering. Fully
image-only or blank documents produce an actionable no-text diagnostic.

Extraction runs locally. This does not make the entire indexing pipeline local:
extracted text still goes to the user's configured embedding provider and, when
enabled, reranker under the same scope/privacy rules as existing source text.

## Milestone 1: internal extraction foundation

Implement `src/documents/pdf.ts` and real-PDF extraction tests before changing file
discovery or persisted index formats.

- Lazy-load the pinned `pdfjs-dist` dependency. Keep normal source indexing and CLI
  startup independent of PDF initialization.
- Accept bytes, not UTF-8 strings or URLs. Copy inputs so parser ownership cannot
  detach or mutate caller buffers.
- Return page count and ordered `{ pageNumber, text }` entries, including empty
  pages. Preserve explicit text line endings and separate text runs.
- Validate finite positive limits before parsing: initially 20 MiB input, 500 pages,
  and 2,000,000 extracted characters. These are internal safety ceilings, not a
  change to the existing 1 MiB `indexing.maxFileSize` default.
- Do not invoke PDF JavaScript/actions or unnecessary fetching/rendering features.
  PDF.js 6 no longer exposes the older `isEvalSupported` option. Reject protected,
  malformed, oversized and no-text documents with typed, actionable diagnostics.
- Preserve shared cancellation/stall error semantics. Clean up parser resources on
  success, failure, and cancellation.
- Test real multi-page PDFs, blank pages, malformed input, limits, input ownership,
  and cancellation. The encrypted fixture uses a real password and is independently
  opened with that password in tests before accepting its rejection diagnostic.

Implemented in `src/documents/pdf.ts`. The real-PDF suite covers extraction and
boundary behavior, including a subprocess where the optional native canvas module
is deliberately unavailable. A separate mocked lifecycle suite exercises active
loading/page-extraction cancellation and cleanup failure precedence. Text extraction
has been verified on Node 22.13 and Node 24 on macOS ARM64. This does not substitute
for the later cross-platform packaged indexing acceptance gate.

Historical milestone boundary: this foundation alone did **not** enable PDF
indexing. The subsequent milestones now wire it into explicit-include discovery.
Limits bound admitted input and retained text, not all parser CPU/memory usage.
Cooperative cancellation is not a hard execution deadline. If hostile-document
workloads require hard limits, use worker/process isolation in a later design.

## Milestone 2: one binary-aware document ingestion path

Introduce a shared document loader/preparer used by all relevant indexer routes,
not ad hoc PDF branches inside host adapters:

- `Indexer.index` changed-file batches and incremental file descriptors.
- `Indexer.dryRunCost`, preserving exact token accounting through the same chunk
  preparation and embedding-text functions as real indexing.
- Failed embedding retries and branch/worktree materialization.
- Search snippets, context-line expansion, `find_similar`, and reranker documents,
  which currently reconstruct snippets by rereading source as UTF-8.

Hash original PDF bytes for change detection. Version extraction/chunking behavior
so a parser upgrade reparses PDFs without invalidating unchanged code embeddings.
Use bounded, page-local text chunks with deterministic identifiers including page
position and chunk position. Identical text on different pages must not collide.
Do not create call graph symbols/edges or line-based Git blame for PDF content.

Avoid reparsing every PDF for every search hit. Decide on an index-owned extracted
text cache keyed by source hash and extractor version, with atomic publication,
branch-aware lookup, source/scope validation, and deletion/GC semantics. Cached
extracted text has the same privacy sensitivity as the original document. Never
write plaintext sidecars next to user PDFs or mutate originals.

Failure policy must explicitly cover replacing a previously indexed valid PDF
with an encrypted, invalid, or no-text file: stale searchable content must not
silently survive. One bad PDF must not fail unrelated indexing. Cancellation must
still propagate and honor existing rollback/lease behavior.

## Milestone 3: truthful citations and persistence

Keep existing line fields meaningful for code and add optional document-location
metadata rather than overloading `startLine`/`endLine` with page numbers. Proposed
PDF location shape: document kind plus 1-based page start/end. Final public naming
must be settled before adapter/schema changes.

Audit `CodeChunk`, `ChunkMetadata`, `ChunkData`, search contracts, SQLite/NAPI,
vector metadata, BM25 reconstruction, pending retries, and branch cloning. Page
metadata must survive persistence/restart and both keyword and vector retrieval.
A vector-only field is insufficient if database fallback drops it.

Centralize page-aware citation formatting for context packs, search, peek,
pre-edit context where applicable, CLI, OpenCode, MCP, and Pi. Show `file.pdf, p. 3`
(or a page range), never fictional source lines. Preserve existing code citations
and public tool names. Definition and graph tools must not treat PDF text as code.

## Milestone 4: opt-in integration and release acceptance

Only enable PDF discovery once ingestion, snippets and citations work together.
Decide whether existing `additionalInclude` is sufficient or an explicit PDF
configuration is needed. Do not silently increase global file-size limits or index
all binary files. Keep watcher, include/exclude, scope, and manual-index behavior
consistent.

Acceptance checks:

1. A temporary knowledge base containing two text PDFs and code indexes through the
   public shared operation with deterministic embeddings and returns the expected
   text/page for known queries. PDF passages remain excluded from code definitions.
2. Unchanged reindex performs no new embedding work. Modify, replace, rename and
   delete PDFs and confirm old passages disappear. Duplicate text on separate pages
   remains correctly cited.
3. Dry-run source chunks and token totals match force indexing with the same
   provider/token limits. No embedding calls or index writes occur during dry-run.
4. Restart the indexer and test vector, keyword and fused retrieval, snippet context,
   reranking inputs, and page citations. Exercise external knowledge bases and
   branch/worktree materialization.
5. Invalid, protected, blank/scanned and over-limit PDFs report useful diagnostics
   without affecting valid files. Verify cancellation/stalls and failed-batch retry.
6. Verify extraction with optional native canvas unavailable, and document any
   parser limitation rather than pretending it is an OCR requirement. Packed ESM
   and CJS startup/loading must pass on Node 22.13 and 24. Cross-platform release
   coverage remains all five supported native targets.
7. Run the full build/typecheck/lint/test gate, targeted retrieval regression checks,
   and a small committed page-answer acceptance dataset. Do not change benchmark
   baselines merely to hide regressions.
8. Update configuration, knowledge-base/host docs, dependency license disclosures,
   and CHANGELOG only with the capability actually delivered.

## Primary integration locations

- `src/indexer/index.ts`: ingestion, dry-run, reranker text, snippets, retries.
- `src/utils/files.ts`, `src/config/`, `src/watcher/`: discovery and limits.
- `src/native/types.ts`, `native/src/`: location metadata persistence contracts.
- `src/tools/context-pack.ts`, shared tool contracts/formatters, host adapters:
  evidence and citation rendering.
- `tests/`: real PDF fixtures, ingestion lifecycle, host contracts and packaging.

## Completion rule

Milestone 1 by itself was not user-facing PDF support. Milestones 2 and 3 and the
opt-in portion of milestone 4 are now delivered and publicly validated. Default PDF
globs remain disabled. Five-target native release packaging, broader Unicode/CMap
corpora, live failed-provider retry, and remote reranker acceptance remain deferred
release-quality gates and must not be inferred from the completed local acceptance.

## Validation evidence

See [the requirement-by-requirement validation report](pdf-indexing-validation.md).
The shared ingestion path now extracts explicitly included PDFs from bytes, preserves
page-aware chunk metadata and exact extracted snippets, and keeps default discovery
unchanged. PDF globs remain opt-in through existing include configuration.
