import * as fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

const CURRENT_FAILED_BATCH_VERSION = 1;
const DEFAULT_MALFORMED_LINE_ACTION = "skip" as const;

export type MalformedLineAction = "skip" | "fail";

export interface FailedBatchRecordInput<TChunk = unknown> {
  readonly chunks: TChunk[];
  readonly error: string;
  readonly attemptCount: number;
  readonly lastAttempt: string;
}

export interface FailedBatchRecord<TChunk = unknown> extends FailedBatchRecordInput<TChunk> {
  readonly version: number;
}

export interface FailedBatchReadOptions {
  readonly malformedLineAction?: MalformedLineAction;
  readonly onMalformedLine?: (error: Error, line: string, lineNumber: number, filePath: string) => void;
}

export interface FailedBatchWriter<TChunk = unknown> {
  write: (record: FailedBatchRecordInput<TChunk>) => void;
  commit: () => void;
  cleanup: () => void;
  readonly temporaryPath: string;
}

export function* readFailedBatchRecords<TChunk = unknown>(
  filePath: string,
  options: FailedBatchReadOptions = {},
): Generator<FailedBatchRecord<TChunk>, void, void> {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const fileFormat = detectFailedBatchFileFormat(filePath);
  if (fileFormat === "legacy") {
    yield* readLegacyFailedBatchRecords(filePath, options);
    return;
  }

  yield* readJsonlFailedBatchRecords(filePath, options);
}

export function createFailedBatchWriter<TChunk = unknown>(targetPath: string): FailedBatchWriter<TChunk> {
  const temporaryPath = createTemporaryPath(targetPath);
  let finalized = false;

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.closeSync(fs.openSync(temporaryPath, "w"));

  const write = (record: FailedBatchRecordInput<TChunk>): void => {
    if (finalized) {
      throw new Error("Failed batch writer has been finalized");
    }

    const lines = record.chunks.map((chunk) => {
      const lineRecord: FailedBatchRecord<TChunk> = {
        version: CURRENT_FAILED_BATCH_VERSION,
        chunks: [chunk],
        error: record.error,
        attemptCount: record.attemptCount,
        lastAttempt: record.lastAttempt,
      };
      return JSON.stringify(lineRecord);
    });

    if (lines.length === 0) {
      return;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.appendFileSync(temporaryPath, `${lines.join("\n")}\n`, "utf-8");
  };

  const commit = (): void => {
    if (finalized) {
      return;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.renameSync(temporaryPath, targetPath);
    finalized = true;
  };

  const cleanup = (): void => {
    if (finalized) {
      return;
    }
    fs.rmSync(temporaryPath, { force: true });
  };

  return {
    write,
    commit,
    cleanup,
    temporaryPath,
  };
}

export function writeFailedBatchRecords<TChunk = unknown>(
  targetPath: string,
  records: Iterable<FailedBatchRecordInput<TChunk>>,
): void {
  const writer = createFailedBatchWriter<TChunk>(targetPath);
  try {
    for (const record of records) {
      writer.write(record);
    }
    writer.commit();
  } catch (error) {
    writer.cleanup();
    throw error;
  }
}

function* readLegacyFailedBatchRecords<TChunk = unknown>(
  filePath: string,
  options: FailedBatchReadOptions,
): Generator<FailedBatchRecord<TChunk>, void, void> {
  const rawData = fs.readFileSync(filePath, "utf-8");
  const trimmed = stripLeadingBomAndWhitespace(rawData).trim();
  if (trimmed.length === 0) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    handleMalformedLine(filePath, 1, trimmed, error, options);
    return;
  }

  if (!Array.isArray(parsed)) {
    handleMalformedLine(filePath, 1, trimmed, new Error("Expected legacy failed-batch file to contain a JSON array"), options);
    return;
  }

  for (const entry of parsed) {
    const normalized = normalizeFailedBatchRecord<TChunk>(entry);
    if (normalized) {
      yield normalized;
    }
  }
}

function* readJsonlFailedBatchRecords<TChunk = unknown>(
  filePath: string,
  options: FailedBatchReadOptions,
): Generator<FailedBatchRecord<TChunk>, void, void> {
  const handle = fs.openSync(filePath, "r");
  const decoder = new StringDecoder("utf8");
  const readBuffer = Buffer.allocUnsafe(64 * 1024);
  let buffer = "";
  let lineNumber = 0;

  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(handle, readBuffer, 0, readBuffer.length, null);
      buffer += decoder.write(readBuffer.subarray(0, bytesRead));

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        lineNumber += 1;

        const normalized = parseFailedBatchLine<TChunk>(rawLine, filePath, lineNumber, options);
        if (normalized) {
          yield normalized;
        }

        newlineIndex = buffer.indexOf("\n");
      }
    } while (bytesRead > 0);

    buffer += decoder.end();

    const finalLine = buffer.trimEnd();
    if (finalLine.length > 0) {
      lineNumber += 1;
      const normalized = parseFailedBatchLine<TChunk>(finalLine, filePath, lineNumber, options);
      if (normalized) {
        yield normalized;
      }
    }
  } finally {
    fs.closeSync(handle);
  }
}

function parseFailedBatchLine<TChunk = unknown>(
  rawLine: string,
  filePath: string,
  lineNumber: number,
  options: FailedBatchReadOptions,
): FailedBatchRecord<TChunk> | null {
  const line = rawLine.trimEnd();
  if (line.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(line);
    const normalized = normalizeFailedBatchRecord<TChunk>(parsed);
    if (!normalized) {
      handleMalformedLine(filePath, lineNumber, line, new Error("Malformed failed-batch record"), options);
      return null;
    }
    return normalized;
  } catch (error) {
    handleMalformedLine(filePath, lineNumber, line, error, options);
    return null;
  }
}

function normalizeFailedBatchRecord<TChunk = unknown>(rawRecord: unknown): FailedBatchRecord<TChunk> | null {
  if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) {
    return null;
  }

  const typed = rawRecord as {
    chunks?: unknown;
    error?: unknown;
    attemptCount?: unknown;
    lastAttempt?: unknown;
    version?: unknown;
  };

  const chunks = Array.isArray(typed.chunks) ? typed.chunks : null;
  if (!chunks || chunks.length === 0) {
    return null;
  }

  return {
    version: typeof typed.version === "number" && Number.isFinite(typed.version) ? typed.version : CURRENT_FAILED_BATCH_VERSION,
    chunks: chunks as TChunk[],
    error: typeof typed.error === "string" ? typed.error : "Unknown embedding error",
    attemptCount: typeof typed.attemptCount === "number" && Number.isFinite(typed.attemptCount) ? typed.attemptCount : 1,
    lastAttempt: typeof typed.lastAttempt === "string" ? typed.lastAttempt : new Date().toISOString(),
  };
}

type FailedBatchFileFormat = "legacy" | "jsonl";

function detectFailedBatchFileFormat(filePath: string): FailedBatchFileFormat {
  const handle = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return "jsonl";
    }

    const prefix = stripLeadingBomAndWhitespace(buffer.subarray(0, bytesRead).toString("utf-8"));
    return prefix.startsWith("[") ? "legacy" : "jsonl";
  } finally {
    fs.closeSync(handle);
  }
}

function stripLeadingBomAndWhitespace(value: string): string {
  let result = value.trimStart();
  if (result.charCodeAt(0) === 0xfeff) {
    result = result.slice(1);
  }
  return result;
}

function createTemporaryPath(targetPath: string): string {
  const randomId = createHash("sha1")
    .update(`${Date.now()}:${randomBytes(8).toString("hex")}`)
    .digest("hex");
  const targetDir = path.dirname(targetPath);
  const baseName = path.basename(targetPath);
  return path.join(targetDir, `.${baseName}.${randomId}.tmp`);
}

function handleMalformedLine(
  filePath: string,
  lineNumber: number,
  line: string,
  error: unknown,
  options: FailedBatchReadOptions,
): void {
  const action = options.malformedLineAction ?? DEFAULT_MALFORMED_LINE_ACTION;
  const normalizedError = error instanceof Error ? error : new Error(String(error));

  if (options.onMalformedLine) {
    options.onMalformedLine(normalizedError, line, lineNumber, filePath);
  }

  if (action === "fail") {
    throw normalizedError;
  }
}
