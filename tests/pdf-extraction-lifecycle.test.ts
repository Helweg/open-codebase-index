import { beforeEach, describe, expect, it, vi } from "vitest";
import { OperationCancelledError, OperationStallTimeoutError } from "../src/utils/operation-control.js";
import { extractPdfText } from "../src/documents/pdf.js";

// These tests isolate lifecycle failure paths. The separate extraction suite
// exercises real PDF.js with real PDF bytes, including password protection.
const parser = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => parser);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => { parser.getDocument.mockReset(); });

describe("PDF parser lifecycle", () => {
  it.each([new OperationCancelledError(), new OperationStallTimeoutError()])(
    "destroys an active loading task and preserves %s", async (reason) => {
      const started = deferred<void>();
      const destroy = vi.fn().mockResolvedValue(undefined);
      parser.getDocument.mockImplementation(() => {
        started.resolve();
        return { promise: new Promise(() => undefined), destroy };
      });
      const controller = new AbortController();
      const result = extractPdfText(new Uint8Array([37]), { signal: controller.signal });
      const rejection = expect(result).rejects.toBe(reason);
      await started.promise;
      controller.abort(reason);
      await rejection;
      expect(destroy).toHaveBeenCalledOnce();
    },
  );

  it("cleans the page and destroys the document when text extraction is cancelled", async () => {
    const started = deferred<void>();
    const cleanup = vi.fn();
    const destroy = vi.fn().mockResolvedValue(undefined);
    parser.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1, getPage: async () => ({
        cleanup,
        getTextContent: () => { started.resolve(); return new Promise(() => undefined); },
      }) }),
      destroy,
    });
    const controller = new AbortController();
    const reason = new OperationCancelledError();
    const result = extractPdfText(new Uint8Array([37]), { signal: controller.signal });
    const rejection = expect(result).rejects.toBe(reason);
    await started.promise;
    controller.abort(reason);
    await rejection;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("preserves a parse diagnostic when destruction also fails", async () => {
    const destroy = vi.fn().mockRejectedValue(new Error("private cleanup details"));
    parser.getDocument.mockReturnValue({
      promise: Promise.reject(Object.assign(new Error("private password details"), { name: "PasswordException" })),
      destroy,
    });
    await expect(extractPdfText(new Uint8Array([37]))).rejects.toMatchObject({ details: { code: "ENCRYPTED_PDF" } });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("reports destruction failure after otherwise successful extraction", async () => {
    parser.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1, getPage: async () => ({
        cleanup: vi.fn(),
        getTextContent: async () => ({ items: [{ str: "text", hasEOL: false }] }),
      }) }),
      destroy: vi.fn().mockRejectedValue(new Error("private cleanup details")),
    });
    await expect(extractPdfText(new Uint8Array([37]))).rejects.toMatchObject({ details: { code: "PARSER_UNAVAILABLE" } });
  });
});
