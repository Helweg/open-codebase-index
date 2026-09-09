import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { OperationCancelledError, OperationStallTimeoutError } from "../src/utils/operation-control.js";
import {
  DEFAULT_PDF_MAX_BYTES,
  DEFAULT_PDF_MAX_PAGES,
  DEFAULT_PDF_MAX_TEXT_CHARS,
  PdfExtractionError,
  extractPdfText,
} from "../src/documents/pdf.js";
import {
  buildMalformedPdfFixture,
  buildEncryptedPdfFixture,
  buildPdfFixture,
} from "./fixtures/pdf.js";

describe("extractPdfText", () => {
  it("extracts text from multiple pages and keeps empty pages", async () => {
    const pdf = buildPdfFixture([
      { lines: ["Line one", "Line two"] },
      { empty: true },
      { lines: ["Final"] },
    ]);

    const result = await extractPdfText(pdf);

    expect(result.pageCount).toBe(3);
    expect(result.pages).toEqual([
      { pageNumber: 1, text: "Line one\nLine two" },
      { pageNumber: 2, text: "" },
      { pageNumber: 3, text: "Final" },
    ]);
  });

  it("reports malformed documents as invalid", async () => {
    const invalid = buildMalformedPdfFixture();

    const result = extractPdfText(invalid);

    await expect(result).rejects.toMatchObject({
      details: { code: "INVALID_PDF" },
    });
  });

  it("rejects over-long PDFs by bytes", async () => {
    const pdf = buildPdfFixture([{ lines: ["tiny"] }]);
    const oversize = new Uint8Array(pdf.length + 1);
    oversize.set(pdf);

    await expect(extractPdfText(oversize, { maxBytes: pdf.length })).rejects.toMatchObject({
      details: { code: "LIMIT_BYTES" },
    });
  });

  it("rejects over-long page count", async () => {
    const pdf = buildPdfFixture([
      { lines: ["first"] },
      { lines: ["second"] },
      { lines: ["third"] },
    ]);

    await expect(extractPdfText(pdf, { maxPages: 2 })).rejects.toMatchObject({
      details: { code: "LIMIT_PAGES" },
    });
  });

  it("rejects when total text exceeds the configured char limit", async () => {
    const pdf = buildPdfFixture([{ lines: ["one", "two", "three"] }]);

    await expect(extractPdfText(pdf, { maxTextChars: 4 })).rejects.toMatchObject({
      details: { code: "LIMIT_TEXT_CHARS" },
    });
  });

  it("rejects documents with no extractable text", async () => {
    const pdf = buildPdfFixture([{ empty: true }, { empty: true }]);

    await expect(extractPdfText(pdf)).rejects.toMatchObject({
      details: { code: "NO_EXTRACTABLE_TEXT" },
    });
  });

  it("rejects invalid options", async () => {
    const pdf = buildPdfFixture([{ lines: ["A"] }]);

    await expect(extractPdfText(pdf, { maxPages: 0 })).rejects.toMatchObject({
      details: { code: "INVALID_OPTIONS" },
    });
  });

  it("preserves caller Buffer and never mutates it", async () => {
    const source = Buffer.from(buildPdfFixture([{ lines: ["Hello"] }]));
    const copy = Buffer.from(source);
    const result = await extractPdfText(source);

    expect(result.pages).toHaveLength(1);
    expect(Buffer.compare(source, copy)).toBe(0);
  });

  it("rejects operation cancellations", async () => {
    const pdf = buildPdfFixture([{ lines: ["cancel"] }]);
    const controller = new AbortController();
    const rejectPromise = (async () => {
      controller.abort(new OperationCancelledError());
      return extractPdfText(pdf, { signal: controller.signal });
    })();

    await expect(rejectPromise).rejects.toBeInstanceOf(OperationCancelledError);
  });

  it("validates against defaults", async () => {
    expect(DEFAULT_PDF_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(DEFAULT_PDF_MAX_PAGES).toBe(500);
    expect(DEFAULT_PDF_MAX_TEXT_CHARS).toBe(2_000_000);
    expect(new PdfExtractionError({ code: "INVALID_PDF", message: "x" })).toBeInstanceOf(PdfExtractionError);
  });
});


describe("PDF boundary regressions", () => {
  it("extracts text without the optional canvas native dependency", () => {
    const extractor = new URL("../src/documents/pdf.ts", import.meta.url).href;
    const fixtures = new URL("./fixtures/pdf.ts", import.meta.url).href;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import Module from 'node:module';
      const originalLoad = Module._load;
      let blockedCanvas = false;
      Module._load = function(id, ...args) {
        if (id === '@napi-rs/canvas') {
          blockedCanvas = true;
          throw new Error('Canvas deliberately unavailable for this test');
        }
        return originalLoad.call(this, id, ...args);
      };
      const { extractPdfText } = await import(${JSON.stringify(extractor)});
      const { buildPdfFixture } = await import(${JSON.stringify(fixtures)});
      const result = await extractPdfText(buildPdfFixture([{ lines: ['Canvas-free text'] }]));
      if (!blockedCanvas || result.pages[0].text !== 'Canvas-free text') process.exit(1);
      console.log('CANVAS_FREE_OK');
    `], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
    expect(output).toContain("CANVAS_FREE_OK");
  });

  it("rejects a real password-protected PDF, and verifies its password fixture", async () => {
    const bytes = buildEncryptedPdfFixture();
    await expect(extractPdfText(bytes)).rejects.toMatchObject({ details: { code: "ENCRYPTED_PDF" } });
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({ data: new Uint8Array(bytes), password: "secret", verbosity: 0 });
    try { expect((await task.promise).numPages).toBe(1); }
    finally { await task.destroy(); }
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid limits %s", async (value) => {
    const bytes = buildPdfFixture([{ lines: ["A"] }]);
    for (const option of ["maxBytes", "maxPages", "maxTextChars"]) {
      await expect(extractPdfText(bytes, { [option]: value })).rejects.toMatchObject({ details: { code: "INVALID_OPTIONS" } });
    }
  });

  it("accepts exact byte, page and aggregate character limits", async () => {
    const bytes = buildPdfFixture([{ lines: ["abc"] }, { lines: ["def"] }]);
    expect((await extractPdfText(bytes, { maxBytes: bytes.length, maxPages: 2, maxTextChars: 6 })).pageCount).toBe(2);
    await expect(extractPdfText(bytes, { maxTextChars: 5 })).rejects.toMatchObject({ details: { code: "LIMIT_TEXT_CHARS" } });
  });

  it("rejects whitespace-only text", async () => {
    await expect(extractPdfText(buildPdfFixture([{ lines: ["   "] }]))).rejects.toMatchObject({ details: { code: "NO_EXTRACTABLE_TEXT" } });
  });

  it("preserves a nonzero-offset byte view and repeated page text", async () => {
    const bytes = buildPdfFixture([{ lines: ["Same"] }, { lines: ["Same"] }]);
    const backing = new Uint8Array(bytes.length + 20);
    backing.set(bytes, 10);
    const before = backing.slice();
    const result = await extractPdfText(backing.subarray(10, 10 + bytes.length));
    expect(result.pages).toEqual([{ pageNumber: 1, text: "Same" }, { pageNumber: 2, text: "Same" }]);
    expect(backing).toEqual(before);
  });

  it("cancels an in-flight call and preserves stall reasons", async () => {
    const bytes = buildPdfFixture([{ lines: ["A"] }]);
    const controller = new AbortController();
    const task = extractPdfText(bytes, { signal: controller.signal });
    const reason = new OperationStallTimeoutError();
    controller.abort(reason);
    await expect(task).rejects.toBe(reason);
    expect((await extractPdfText(bytes)).pages[0].text).toBe("A");
  });
});
