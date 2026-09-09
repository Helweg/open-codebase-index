import type { DocumentInitParameters, TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api.js";
import type { PDFDocumentLoadingTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  isOperationInterruption,
  raceWithOperationSignal,
  throwIfOperationAborted,
} from "../utils/operation-control.js";

export const DEFAULT_PDF_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_PDF_MAX_PAGES = 500;
export const DEFAULT_PDF_MAX_TEXT_CHARS = 2_000_000;

export type PdfExtractionErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_PDF"
  | "ENCRYPTED_PDF"
  | "NO_EXTRACTABLE_TEXT"
  | "LIMIT_BYTES"
  | "LIMIT_PAGES"
  | "LIMIT_TEXT_CHARS"
  | "PARSER_UNAVAILABLE";

export interface ExtractPdfTextOptions {
  maxBytes?: number;
  maxPages?: number;
  maxTextChars?: number;
  signal?: AbortSignal;
}

export interface PdfPageText {
  /** Physical, 1-based page number, including blank pages. */
  pageNumber: number;
  text: string;
}

export interface ExtractPdfTextResult {
  pages: PdfPageText[];
  pageCount: number;
}

export class PdfExtractionError extends Error {
  constructor(readonly details: { code: PdfExtractionErrorCode; message: string }) {
    super(details.message);
    this.name = "PdfExtractionError";
  }
}

function pdfError(code: PdfExtractionErrorCode, message: string): PdfExtractionError {
  return new PdfExtractionError({ code, message });
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw pdfError("INVALID_OPTIONS", `${name} must be a positive safe integer.`);
  }
  return limit;
}

function pageText(items: Array<TextItem | TextMarkedContent>, budget: number): string {
  let text = "";
  const append = (part: string): void => {
    if (part.length > budget - text.length) {
      throw pdfError("LIMIT_TEXT_CHARS", "PDF text exceeds maxTextChars. Increase the limit or split the document.");
    }
    text += part;
  };
  for (const item of items) {
    if (!("str" in item)) continue;
    // PDF.js normally supplies whitespace runs. Separate adjacent word runs when
    // it does not. This is text extraction, not exact visual-layout reconstruction.
    if (/[\p{L}\p{N}]$/u.test(text) && /^[\p{L}\p{N}]/u.test(item.str)) append(" ");
    append(item.str);
    if (item.hasEOL) append("\n");
  }
  return text;
}

/** Internal foundation only: discovery and the indexer do not use this yet.
 * Limits bound input and retained text, not all PDF.js working memory or CPU.
 */
export async function extractPdfText(
  data: Uint8Array,
  options: ExtractPdfTextOptions = {},
): Promise<ExtractPdfTextResult> {
  const { signal } = options;
  throwIfOperationAborted(signal);
  if (!(data instanceof Uint8Array)) {
    throw pdfError("INVALID_OPTIONS", "Expected PDF bytes as Uint8Array.");
  }
  const maxBytes = positiveLimit(options.maxBytes, DEFAULT_PDF_MAX_BYTES, "maxBytes");
  const maxPages = positiveLimit(options.maxPages, DEFAULT_PDF_MAX_PAGES, "maxPages");
  const maxTextChars = positiveLimit(options.maxTextChars, DEFAULT_PDF_MAX_TEXT_CHARS, "maxTextChars");
  if (data.byteLength > maxBytes) {
    throw pdfError("LIMIT_BYTES", "PDF size exceeds maxBytes. Increase the limit or split the document.");
  }

  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    pdfjs = await raceWithOperationSignal(import("pdfjs-dist/legacy/build/pdf.mjs"), signal);
  } catch (error: unknown) {
    if (isOperationInterruption(error)) throw error;
    throw pdfError("PARSER_UNAVAILABLE", "The PDF parser could not load. Check the pdfjs-dist installation and Node.js version.");
  }
  throwIfOperationAborted(signal);

  let loadingTask: PDFDocumentLoadingTask | undefined;
  let cleanupFailed = false;
  let result: ExtractPdfTextResult;
  try {
    const parameters: DocumentInitParameters = {
      // PDF.js owns its input and rejects Node Buffers. Always copy into a plain
      // Uint8Array, including when the caller supplies a subarray or Buffer.
      data: new Uint8Array(data),
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      stopAtErrors: true,
      verbosity: 0,
    };
    loadingTask = pdfjs.getDocument(parameters);
    const document = await raceWithOperationSignal(loadingTask.promise, signal);
    throwIfOperationAborted(signal);
    if (document.numPages > maxPages) {
      throw pdfError("LIMIT_PAGES", "PDF page count exceeds maxPages. Increase the limit or split the document.");
    }

    const pages: PdfPageText[] = [];
    let remaining = maxTextChars;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      throwIfOperationAborted(signal);
      const page = await raceWithOperationSignal(document.getPage(pageNumber), signal);
      try {
        const content = await raceWithOperationSignal(page.getTextContent(), signal);
        throwIfOperationAborted(signal);
        const text = pageText(content.items, remaining);
        remaining -= text.length;
        pages.push({ pageNumber, text });
      } finally {
        page.cleanup();
      }
    }
    throwIfOperationAborted(signal);
    if (pages.every((page) => page.text.trim().length === 0)) {
      throw pdfError("NO_EXTRACTABLE_TEXT", "The PDF has no extractable text. Blank or scanned PDFs need text/OCR before indexing.");
    }
    result = { pages, pageCount: document.numPages };
  } catch (error: unknown) {
    throwIfOperationAborted(signal);
    if (isOperationInterruption(error) || error instanceof PdfExtractionError) throw error;
    if (error instanceof Error && error.name === "PasswordException") {
      throw pdfError("ENCRYPTED_PDF", "The PDF requires a password. Supply an unprotected copy. Password entry is not supported.");
    }
    throw pdfError("INVALID_PDF", "The PDF could not be parsed. Check that it is a valid, undamaged PDF.");
  } finally {
    try {
      await loadingTask?.destroy();
    } catch {
      // The pending parse/cancellation error wins if extraction already failed.
      cleanupFailed = true;
    }
  }
  throwIfOperationAborted(signal);
  if (cleanupFailed) {
    throw pdfError("PARSER_UNAVAILABLE", "The PDF parser failed to release its resources. Retry the operation.");
  }
  return result;
}
