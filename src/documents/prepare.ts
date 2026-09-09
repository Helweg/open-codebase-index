import type { CodeChunk, ParsedFile } from "../native/index.js";

import * as path from "node:path";

import { parseFileAsText, parseFiles } from "../native/index.js";
import { throwIfOperationAborted } from "../utils/operation-control.js";
import { extractPdfText } from "./pdf.js";

export const PDF_EXTRACTION_VERSION = "pdfjs-v1";

export interface PreparedDocument extends ParsedFile {
  kind: "source" | "pdf";
}

export interface DocumentInput {
  path: string;
  bytes: Uint8Array;
}

function isPdf(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".pdf";
}

export async function prepareDocument(
  filePath: string,
  bytes: Uint8Array,
  linesPerChunk: number,
  signal?: AbortSignal,
  maxMarkupChunks?: number,
): Promise<PreparedDocument> {
  throwIfOperationAborted(signal);
  if (!isPdf(filePath)) {
    const content = Buffer.from(bytes).toString("utf-8");
    const parsed = parseFiles([{ path: filePath, content }], linesPerChunk, maxMarkupChunks)[0];
    return { ...parsed, kind: "source" };
  }

  const extracted = await extractPdfText(bytes, { signal });
  const chunks: CodeChunk[] = extracted.pages.flatMap((page) =>
    parseFileAsText(filePath, page.text, linesPerChunk).map((chunk) => ({
      ...chunk,
      language: "pdf",
      documentLocation: {
        kind: "pdf" as const,
        pageStart: page.pageNumber,
        pageEnd: page.pageNumber,
      },
    })),
  );
  return {
    path: filePath,
    chunks,
    symbols: [],
    hash: "",
    kind: "pdf",
  };
}

export async function prepareDocuments(
  files: DocumentInput[],
  linesPerChunk: number,
  signal?: AbortSignal,
  maxMarkupChunks?: number,
): Promise<PreparedDocument[]> {
  throwIfOperationAborted(signal);
  const sourceFiles = files.filter((file) => !isPdf(file.path));
  const sourceDocuments = parseFiles(sourceFiles.map((file) => ({
    path: file.path,
    content: Buffer.from(file.bytes).toString("utf-8"),
  })), linesPerChunk, maxMarkupChunks).map((parsed) => ({ ...parsed, kind: "source" as const }));
  throwIfOperationAborted(signal);
  const pdfDocuments = await Promise.all(
    files.filter((file) => isPdf(file.path)).map((file) =>
      prepareDocument(file.path, file.bytes, linesPerChunk, signal, maxMarkupChunks)),
  );
  const byPath = new Map([...sourceDocuments, ...pdfDocuments].map((document) => [document.path, document]));
  return files.flatMap((file) => {
    const document = byPath.get(file.path);
    return document ? [document] : [];
  });
}

export function generatePreparedChunkId(filePath: string, chunk: CodeChunk, hash: (value: string) => string): string {
  const location = chunk.documentLocation
    ? `:${PDF_EXTRACTION_VERSION}:${chunk.documentLocation.pageStart}:${chunk.documentLocation.pageEnd}`
    : "";
  const sourceColumns = chunk.language === "xml" || chunk.language === "svg"
    ? `:${chunk.startCol ?? 0}:${chunk.endCol ?? 0}`
    : "";
  return `chunk_${hash(`${filePath}${location}:${chunk.startLine}:${chunk.endLine}${sourceColumns}:${chunk.content}`).slice(0, 16)}`;
}
