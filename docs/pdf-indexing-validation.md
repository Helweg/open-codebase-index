# PDF foundation validation, 2026-09-09

Implementation: `41c9711`. This report distinguishes the completed **plan and
implementation start** from the unfinished **end-to-end PDF indexing** outcome.

## Real document and public CLI observations

Downloaded the public W3C PDF from:
<https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf>

- 13,264 bytes.
- SHA-256: `3df79d34abbca99308e79cb94461c1893582604d68329a41fd4bec1885e6adb4`.
- This document contains compressed content and an embedded TrueType font.
- Calling the new internal `extractPdfText` on its original bytes returned exactly
  `{ "pages": [{ "pageNumber": 1, "text": "Dummy PDF file" }], "pageCount": 1 }`.
  This is useful extraction evidence, **not** public indexing acceptance.

Used the real built `cbi` CLI, not a copied implementation or mocked indexer, with
an isolated project, an external knowledge base containing this PDF and one text
file, and an explicit configuration. Ran:

```sh
node dist/cbi.js index --project "$PROJECT" --host jcode \
  --config "$CONFIG" --dry-run
```

Observed:

1. Default includes: **1 file, 1 chunk, 35 estimated tokens**. Removing the PDF
   from the knowledge base and repeating produced byte-identical CLI output.
   Thus default public discovery remains unchanged and does not enable PDFs.
2. Explicit `include: ["**/*.pdf"]`: **1 file, 7 chunks, 3,767 estimated tokens**.
   The public pipeline still processes the PDF as raw text rather than using the
   new extractor. This is a concrete failed integration acceptance check, not PDF
   support. **Do not opt in with PDF globs yet.**
3. The project directory still contained only its initial `package.json` after
   these dry-runs. The configured custom embedding endpoint was an unavailable
   loopback endpoint, and the command completed without needing that service.

The improvement is narrow and measurable: the new extractor obtains the correct
14-character text and page from a real compressed/font-embedded PDF, while the
current public pipeline produces seven binary-derived chunks when forced to read
that same document. Wiring these paths together remains work to do.

## Requirement-to-observation map

| Requirement or changed output | Check | Observed result |
|---|---|---|
| Plan the work and start implementation | `docs/pdf-indexing-plan.md`, implementation commit, actual extraction above | Four milestones documented and internal extraction implemented |
| Local text extraction and page numbering | Published W3C document plus real-parser multi-page test | Correct W3C text on page 1; multi-page test returns pages 1/2/3 with blank page 2 preserved |
| Preserve line breaks and repeated page text | `extracts text from multiple pages and keeps empty pages`; `preserves a nonzero-offset byte view and repeated page text` | Expected newline and distinct page numbers asserted and passed |
| Byte/page/aggregate text limits | Limit tests and `accepts exact byte, page and aggregate character limits` | Exact boundaries accepted, over-limit inputs return the matching typed code |
| Validate configured limits | Parameterized invalid-limit test for all three options | Zero, negatives, fractions, NaN, infinity and unsafe integers rejected |
| Protected PDF diagnostic | Real encrypted fixture, also opened independently using its known password | Extractor returns `ENCRYPTED_PDF`; PDF.js opens the same valid document with the password |
| Malformed/no-text diagnostics | Malformed, blank and whitespace-only document tests | `INVALID_PDF` or `NO_EXTRACTABLE_TEXT`, as applicable |
| Input bytes remain caller-owned | Buffer and nonzero-offset view tests | Original backing bytes preserved |
| Cancellation/stall semantics and cleanup | Separate lifecycle tests plus real-parser cancellation test | Active loading/text work cancelled; shared interruption object preserved; page/task cleanup called; cleanup failure does not replace primary parse failure |
| No mandatory native canvas for text extraction | Subprocess deliberately blocks loading `@napi-rs/canvas` | Real PDF text extraction succeeds on Node 22.13 and 24 |
| Preserve package/runtime compatibility | TypeScript/native builds, typecheck/lint, both packed-package smoke checks, Node 22.13/24 PDF tests | Passed; original plugin pin remains 1.3.13; package identities and public tool names unchanged |
| Preserve current default public behavior | Real CLI with and without the W3C PDF | Identical dry-run output; PDF is not newly discovered |
| Truthful changelog and capability claims | Changelog explicitly says internal foundation, no PDF discovery/indexing/citations | Matches the observed public integration gap |
| End-to-end PDF ingestion, incremental reindexing, retries and search | Real CLI explicitly including the W3C PDF | **Not met:** raw-text chunks, no extractor integration |
| Persisted PDF page citations across hosts/restarts | No integrated implementation yet | **Not met:** pending milestones 2–4, not covered by the extractor tests |

## Regression results and limits

- 22 real-parser/boundary tests and 5 isolated lifecycle tests passed.
- Complete suite: **1,801 tests in 111 files passed serially**.
- Parallel runs encountered separate existing temporary-directory races in
  `mcp-operation-execution.test.ts` and `effectiveness-ci.test.ts`. Targeted checks
  and the serial full run passed. No unrelated concurrency code was changed.
- Build/native build, typecheck, lint and both package-install smoke checks passed.
- Cross-platform PDF indexing, Unicode/CMap-heavy documents, large real document
  corpora, search quality and incremental PDF lifecycle acceptance remain pending.
- The missing end-to-end acceptance is an **implementation/scope gap**, not an
  external-service blocker. The full PDF-indexing feedback loop is still open.
