import { describe, expect, it } from "vitest";

import {
  generatePreparedChunkId,
  PDF_EXTRACTION_VERSION,
  prepareDocument,
  prepareDocuments,
} from "../src/documents/prepare.js";
import { hashContent } from "../src/native/index.js";
import { OperationCancelledError } from "../src/utils/operation-control.js";
import { buildMalformedPdfFixture, buildPdfFixture } from "./fixtures/pdf.js";

describe("prepareDocument", () => {
  it("extracts deterministic page-local PDF chunks including duplicate text on different pages", async () => {
    const pdf = buildPdfFixture([
      { lines: ["Repeated passage"] },
      { empty: true },
      { lines: ["Repeated passage"] },
    ]);

    const prepared = await prepareDocument("docs/repeated.pdf", pdf, 20);

    expect(prepared.kind).toBe("pdf");
    expect(prepared.symbols).toEqual([]);
    expect(prepared.chunks).toHaveLength(2);
    expect(prepared.chunks.map((chunk) => chunk.documentLocation)).toEqual([
      { kind: "pdf", pageStart: 1, pageEnd: 1 },
      { kind: "pdf", pageStart: 3, pageEnd: 3 },
    ]);
    const ids = prepared.chunks.map((chunk) => generatePreparedChunkId(prepared.path, chunk, hashContent));
    expect(new Set(ids).size).toBe(2);
  });

  it("keeps ordinary source parsing unchanged", async () => {
    const prepared = await prepareDocument("src/example.ts", Buffer.from("export const value = 1;\n"), 20);

    expect(prepared.kind).toBe("source");
    expect(prepared.chunks.some((chunk) => chunk.content.includes("value"))).toBe(true);
    expect(prepared.chunks.every((chunk) => chunk.documentLocation === undefined)).toBe(true);
  });

  it("forwards the markup chunk cap through single and batch preparation", async () => {
    const xml = Buffer.from("<root><one>1</one><two>2</two><three>3</three></root>");

    const single = await prepareDocument("bounded.xml", xml, 20, undefined, 2);
    const [batch] = await prepareDocuments([{ path: "bounded.xml", bytes: xml }], 20, undefined, 2);

    expect(single.chunks).toHaveLength(2);
    expect(batch.chunks).toEqual(single.chunks);
  });

  it("preserves markup parse failures and empty semantic output in batch preparation", async () => {
    const [malformed] = await prepareDocuments([
      { path: "broken.xml", bytes: Buffer.from("<root><item></root>") },
    ], 20);
    expect(malformed.parseFailed).toBe(true);
    expect(malformed.chunks).toEqual([]);

    const [empty] = await prepareDocuments([
      { path: "empty.svg", bytes: Buffer.from("<svg><path d=\"M0 0\"/></svg>") },
    ], 20);
    expect(empty.parseFailed).not.toBe(true);
    expect(empty.chunks).toEqual([]);
  });

  it("uses source columns to distinguish same-line markup chunks", async () => {
    const prepared = await prepareDocument(
      "same-line.xml",
      Buffer.from("<root><item>same</item><item>same</item></root>"),
      20,
    );
    const duplicateChunks = prepared.chunks.filter((chunk) => chunk.content === "root/item: same");

    expect(duplicateChunks).toHaveLength(2);
    expect(duplicateChunks[0].startLine).toBe(duplicateChunks[1].startLine);
    expect(duplicateChunks[0].startCol).not.toBe(duplicateChunks[1].startCol);
    expect(new Set(duplicateChunks.map((chunk) =>
      generatePreparedChunkId(prepared.path, chunk, hashContent)
    )).size).toBe(2);
  });

  it("surfaces typed PDF extraction diagnostics", async () => {
    await expect(prepareDocument("broken.pdf", buildMalformedPdfFixture(), 20)).rejects.toMatchObject({
      details: { code: "INVALID_PDF" },
    });
  });

  it("preserves cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(prepareDocument(
      "cancelled.pdf",
      buildPdfFixture([{ lines: ["text"] }]),
      20,
      controller.signal,
    )).rejects.toBeInstanceOf(OperationCancelledError);
  });

  it("versions PDF chunk identities", () => {
    expect(PDF_EXTRACTION_VERSION).toBe("pdfjs-v1");
  });
});
