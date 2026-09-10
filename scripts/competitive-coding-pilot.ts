#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:net";
import * as path from "node:path";

export const PILOT_LABEL = "synthetic-regression-pilot";
export const OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
export const OLLAMA_MODEL = "gemma4:26b-a4b-it-q4_K_M";
export const OLLAMA_DIGEST = "5571076f3d70050487b26b341705799e0ab29b808164f90d20d4cf84f699d251";
export const MAX_TOOL_CALLS = 12;
export const MAX_GENERATED_TOKENS = 16_000;
export const MAX_RUN_MS = 20 * 60_000;
export const REQUEST_TIMEOUT_MS = 120_000;
export const EVALUATOR_TIMEOUT_MS = 10_000;
export const MAX_EVALUATOR_OUTPUT_BYTES = 64 * 1024;
export const OLLAMA_SEED = 20_260_910;
export const OLLAMA_CONTEXT_TOKENS = 32_768;
export const PILOT_SYSTEM_PROMPT = "You are repairing one seeded regression. Use only the provided repository tools. Do not modify tests. Make the smallest correct source change, then stop.";

const MAX_READ_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 20;
const MAX_REPLACEMENT_BYTES = 16 * 1024;
const MAX_MODEL_RESPONSE_BYTES = 2 * 1024 * 1024;
export const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([".git", ".codebase-index", ".opencode", ".codegraph", ".grepai", ".claude", ".codex", ".jcode", ".competitive-pilot", "tests", "test", "__tests__"]);
export const EVALUATOR_NODE_SHA256 = "1ee75375e33b94fc34b3b19aede049e11dae90efb63b374dc96d6bdace70c4b8";

export function isForbiddenSourceSegment(segment: string): boolean {
  return FORBIDDEN_SEGMENTS.has(segment) || /\.(?:test|spec)\.[^.]+$/i.test(segment);
}

export interface PilotTask {
  id: string;
  label: typeof PILOT_LABEL;
  repository: "axios";
  revision: string;
  prompt: string;
  mutation: {
    file: string;
    oldText: string;
    newText: string;
  };
  evaluatorInputs: unknown[][];
  hiddenExpectedOutputs: unknown[];
}

export interface PilotManifest {
  schemaVersion: 1;
  label: typeof PILOT_LABEL;
  frozenBeforeCalls: true;
  model: {
    name: typeof OLLAMA_MODEL;
    digest: typeof OLLAMA_DIGEST;
    endpoint: typeof OLLAMA_ENDPOINT;
    seed: typeof OLLAMA_SEED;
    numCtx: typeof OLLAMA_CONTEXT_TOKENS;
    temperature: 0;
    think: "high";
    systemPrompt: typeof PILOT_SYSTEM_PROMPT;
  };
  limits: {
    maxToolCalls: typeof MAX_TOOL_CALLS;
    maxGeneratedTokens: typeof MAX_GENERATED_TOKENS;
    maxRunMs: typeof MAX_RUN_MS;
    requestTimeoutMs: typeof REQUEST_TIMEOUT_MS;
  };
  conditions: Array<{ id: string; search: string }>;
  tasks: PilotTask[];
}

export const AXIOS_REVISION = "d8233d9e8e9a64bfba9bbe01d475ba417510b82b";

export const PILOT_MANIFEST: PilotManifest = {
  schemaVersion: 1,
  label: PILOT_LABEL,
  frozenBeforeCalls: true,
  model: {
    name: OLLAMA_MODEL,
    digest: OLLAMA_DIGEST,
    endpoint: OLLAMA_ENDPOINT,
    seed: OLLAMA_SEED,
    numCtx: OLLAMA_CONTEXT_TOKENS,
    temperature: 0,
    think: "high",
    systemPrompt: PILOT_SYSTEM_PROMPT,
  },
  limits: {
    maxToolCalls: MAX_TOOL_CALLS,
    maxGeneratedTokens: MAX_GENERATED_TOKENS,
    maxRunMs: MAX_RUN_MS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  },
  conditions: [
    { id: "literal-unindexed", search: "bounded case-insensitive literal substring search over the frozen allowed source files" },
    { id: "ocbi-hybrid", search: "injected OCBI hybrid adapter pinned to ebd0702" },
    { id: "codegraph", search: "injected CodeGraph adapter pinned to 1.6.0" },
  ],
  tasks: [
    {
      id: "axios-rfc3986-scheme",
      label: PILOT_LABEL,
      repository: "axios",
      revision: AXIOS_REVISION,
      prompt: "Axios treats URLs whose scheme begins with a digit as absolute. Fix the regression so scheme detection follows RFC 3986 while continuing to accept valid custom schemes, uppercase schemes, and protocol-relative URLs. Keep the change focused and do not modify tests.",
      mutation: {
        file: "lib/helpers/isAbsoluteURL.js",
        oldText: "return /^([a-z][a-z\\d+\\-.]*:)?\\/\\//i.test(url);",
        newText: "return /^([a-z\\d][a-z\\d+\\-.]*:)?\\/\\//i.test(url);",
      },
      evaluatorInputs: [
        ["https://api.github.com/users"],
        ["custom-scheme-v1.0://example.com/"],
        ["HTTP://example.com/"],
        ["//example.com/"],
        ["123://example.com/"],
        ["9custom://example.com/"],
        ["!valid://example.com/"],
        ["/relative"],
      ],
      hiddenExpectedOutputs: [true, true, true, true, false, false, false, false],
    },
    {
      id: "axios-repeated-boundary-slashes",
      label: PILOT_LABEL,
      repository: "axios",
      revision: AXIOS_REVISION,
      prompt: "Axios can leave duplicate slashes when combining a base URL with a relative path that contains repeated leading slashes. Normalize all repeated slashes at the join boundary while preserving empty relative URLs and the root relative path. Keep the change focused and do not modify tests.",
      mutation: {
        file: "lib/helpers/combineURLs.js",
        oldText: "baseURL.replace(/\\/?\\/$/, '') + '/' + relativeURL.replace(/^\\/+/, '')",
        newText: "baseURL.replace(/\\/?\\/$/, '') + '/' + relativeURL.replace(/^\\//, '')",
      },
      evaluatorInputs: [
        ["https://api.example.com", "/users"],
        ["https://api.example.com/", "///users"],
        ["https://api.example.com/", "////users"],
        ["https://api.example.com/users", ""],
        ["https://api.example.com/users", "/"],
      ],
      hiddenExpectedOutputs: [
        "https://api.example.com/users",
        "https://api.example.com/users",
        "https://api.example.com/users",
        "https://api.example.com/users",
        "https://api.example.com/users/",
      ],
    },
  ],
};

export interface SearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  score?: number;
}

export type SearchAdapter = (input: {
  root: string;
  query: string;
  limit: number;
  allowedFiles: readonly string[];
}) => Promise<SearchResult[]>;

export const literalSearchAdapter: SearchAdapter = async ({ root, query, limit, allowedFiles }) => {
  const needle = query.toLocaleLowerCase("en-US");
  const results: SearchResult[] = [];
  for (const filePath of allowedFiles) {
    if (results.length >= limit) break;
    const absolute = existingRealPath(root, filePath);
    if (assertSafeRegularFile(absolute).size > MAX_READ_BYTES) continue;
    const content = fs.readFileSync(absolute, "utf8");
    const index = content.toLocaleLowerCase("en-US").indexOf(needle);
    if (index < 0) continue;
    const startLine = content.slice(0, index).split("\n").length;
    results.push({ filePath, startLine, endLine: startLine, score: 1 });
  }
  return results;
};

export type BrokerToolName = "list" | "read" | "replace_unique" | "search";

export interface BrokerToolCall {
  name: BrokerToolName;
  arguments: Record<string, unknown>;
}

export interface BrokerToolResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelative(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === "." || path.posix.isAbsolute(normalized)) {
    throw new Error("path must be a non-empty repository-relative path");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || isForbiddenSourceSegment(segment))) {
    throw new Error("path contains a forbidden segment");
  }
  return normalized;
}

function requireString(value: unknown, name: string, maxBytes = MAX_READ_BYTES): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  if (Buffer.byteLength(value) > maxBytes) throw new Error(`${name} exceeds byte limit`);
  return value;
}

function existingRealPath(root: string, relativePath: string): string {
  const normalized = normalizeRelative(relativePath);
  const lexical = path.resolve(root, normalized);
  if (!isWithin(root, lexical)) throw new Error("path escapes repository root");
  assertNoSymlinkComponents(root, lexical);
  const real = fs.realpathSync(lexical);
  if (!isWithin(root, real)) throw new Error("resolved path escapes repository root");
  return real;
}

function assertNoSymlinkComponents(root: string, target: string): void {
  const relative = path.relative(root, target);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("symlink paths are forbidden");
  }
}

function assertSafeRegularFile(target: string): fs.Stats {
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error("path is not a regular file");
  if (stat.nlink !== 1) throw new Error("hardlinked files are forbidden");
  return stat;
}

export function fileSearchResult(root: string, filePath: string): SearchResult {
  const realRoot = fs.realpathSync(root);
  const target = existingRealPath(realRoot, filePath);
  if (assertSafeRegularFile(target).size > MAX_READ_BYTES) throw new Error("search result file exceeds read limit");
  return {
    filePath: path.relative(realRoot, target).replace(/\\/g, "/"),
    startLine: 1,
    endLine: Math.min(50, fs.readFileSync(target, "utf8").split("\n").length),
    score: 0,
  };
}

function listAllowedFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (isForbiddenSourceSegment(entry.name) || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && fs.statSync(absolute).nlink === 1) {
        files.push(path.relative(root, absolute).replace(/\\/g, "/"));
      }
      if (files.length > MAX_LIST_ENTRIES) throw new Error("repository file cap exceeded");
    }
  };
  visit(root);
  return files.sort();
}

export class PilotBroker {
  readonly root: string;
  readonly allowedFiles: readonly string[];
  private toolCalls = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(root: string, private readonly searchAdapter: SearchAdapter) {
    this.root = fs.realpathSync(root);
    this.allowedFiles = Object.freeze(listAllowedFiles(this.root));
  }

  get callCount(): number {
    return this.toolCalls;
  }

  execute(call: BrokerToolCall): Promise<BrokerToolResult> {
    const run = this.queue.then(() => this.executeSerial(call));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async executeSerial(call: BrokerToolCall): Promise<BrokerToolResult> {
    this.toolCalls += 1;
    if (this.toolCalls > MAX_TOOL_CALLS) return { ok: false, error: "tool call limit exceeded" };
    try {
      switch (call.name) {
        case "list": return { ok: true, output: this.list(call.arguments) };
        case "read": return { ok: true, output: this.read(call.arguments) };
        case "replace_unique": return { ok: true, output: this.replaceUnique(call.arguments) };
        case "search": return { ok: true, output: await this.search(call.arguments) };
        default: return { ok: false, error: "unknown tool" };
      }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private list(args: Record<string, unknown>): string[] {
    const requested = args.path === undefined ? null : requireString(args.path, "path", 4096);
    if (requested === null || requested === "." || requested === "./") return [...this.allowedFiles];
    const target = existingRealPath(this.root, requested);
    assertNoSymlinkComponents(this.root, target);
    const stat = fs.statSync(target);
    if (stat.isFile()) {
      assertSafeRegularFile(target);
      const canonicalRelative = path.relative(this.root, target).replace(/\\/g, "/");
      if (!this.allowedFiles.includes(canonicalRelative)) throw new Error("path is not an allowed file");
      return [canonicalRelative];
    }
    if (!stat.isDirectory()) throw new Error("path is not a file or directory");
    const prefix = path.relative(this.root, target).replace(/\\/g, "/");
    return this.allowedFiles.filter((file) => file === prefix || file.startsWith(`${prefix}/`));
  }

  private read(args: Record<string, unknown>): { filePath: string; content: string } {
    const relative = requireString(args.path, "path", 4096);
    const target = existingRealPath(this.root, relative);
    assertNoSymlinkComponents(this.root, target);
    const stat = assertSafeRegularFile(target);
    const canonicalRelative = path.relative(this.root, target).replace(/\\/g, "/");
    if (!this.allowedFiles.includes(canonicalRelative)) throw new Error("path is not an allowed file");
    if (stat.size > MAX_READ_BYTES) throw new Error("file exceeds read limit");
    return { filePath: canonicalRelative, content: fs.readFileSync(target, "utf8") };
  }

  private replaceUnique(args: Record<string, unknown>): { filePath: string; replacements: 1 } {
    const relative = normalizeRelative(requireString(args.path, "path", 4096));
    if (!relative.startsWith("lib/") || !relative.endsWith(".js")) throw new Error("writes are limited to existing lib/*.js files");
    const oldText = requireString(args.oldText, "oldText", MAX_REPLACEMENT_BYTES);
    const newText = requireString(args.newText, "newText", MAX_REPLACEMENT_BYTES);
    const target = existingRealPath(this.root, relative);
    assertNoSymlinkComponents(this.root, target);
    assertSafeRegularFile(target);
    const canonicalRelative = path.relative(this.root, target).replace(/\\/g, "/");
    if (!this.allowedFiles.includes(canonicalRelative)) throw new Error("write target is not an allowed file");
    const content = fs.readFileSync(target, "utf8");
    const first = content.indexOf(oldText);
    if (first < 0) throw new Error("oldText was not found");
    if (content.indexOf(oldText, first + oldText.length) >= 0) throw new Error("oldText is not unique");
    const updated = content.slice(0, first) + newText + content.slice(first + oldText.length);
    if (Buffer.byteLength(updated) > MAX_READ_BYTES) throw new Error("updated file exceeds size limit");
    fs.writeFileSync(target, updated, { encoding: "utf8", flag: "w" });
    return { filePath: relative, replacements: 1 };
  }

  private async search(args: Record<string, unknown>): Promise<SearchResult[]> {
    const query = requireString(args.query, "query", 4096);
    const requestedLimit = args.limit === undefined ? 10 : args.limit;
    if (!Number.isInteger(requestedLimit) || (requestedLimit as number) < 1 || (requestedLimit as number) > MAX_SEARCH_RESULTS) {
      throw new Error("limit must be an integer between 1 and 20");
    }
    const results = await this.searchAdapter({ root: this.root, query, limit: requestedLimit as number, allowedFiles: this.allowedFiles });
    if (!Array.isArray(results) || results.length > (requestedLimit as number)) throw new Error("search adapter violated result cap");
    return results.map((result) => {
      const target = existingRealPath(this.root, requireString(result.filePath, "result.filePath", 4096));
      assertNoSymlinkComponents(this.root, target);
      const relative = path.relative(this.root, target).replace(/\\/g, "/");
      if (!this.allowedFiles.includes(relative)) throw new Error("search adapter returned a forbidden file");
      const stat = assertSafeRegularFile(target);
      if (stat.size > MAX_READ_BYTES) throw new Error("search result file exceeds read limit");
      if (!Number.isInteger(result.startLine) || !Number.isInteger(result.endLine)
        || result.startLine < 1 || result.endLine < result.startLine || result.endLine - result.startLine > 49) {
        throw new Error("search adapter returned an invalid line range");
      }
      if (result.score !== undefined && !Number.isFinite(result.score)) throw new Error("search adapter returned an invalid score");
      const lines = fs.readFileSync(target, "utf8").split("\n");
      if (result.endLine > lines.length) throw new Error("search adapter line range exceeds file");
      const content = lines.slice(result.startLine - 1, result.endLine).join("\n");
      if (Buffer.byteLength(content) > MAX_READ_BYTES) throw new Error("derived search snippet exceeds limit");
      return { filePath: relative, startLine: result.startLine, endLine: result.endLine, ...(result.score === undefined ? {} : { score: result.score }), content };
    });
  }
}

export interface ModelDriverContext {
  prompt: string;
  broker: PilotBroker;
  deadlineMs: number;
  maxGeneratedTokens: number;
  requestTimeoutMs: number;
}

export interface ModelDriverResult {
  text: string;
  promptTokens: number;
  generatedTokens: number;
  transcript: unknown[];
}

export class PilotModelError extends Error {
  constructor(
    message: string,
    readonly transcript: readonly unknown[],
    readonly promptTokens: number,
    readonly generatedTokens: number,
  ) {
    super(message);
    this.name = "PilotModelError";
  }
}

export interface ModelDriver {
  run(context: ModelDriverContext): Promise<ModelDriverResult>;
}

export interface FetchLike {
  (input: string, init: RequestInit): Promise<Response>;
}

export class OllamaModelDriver implements ModelDriver {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async run(context: ModelDriverContext): Promise<ModelDriverResult> {
    const transcript: unknown[] = [];
    let promptTokens = 0;
    let generatedTokens = 0;
    try {
      await this.verifyPinnedModel(this.remainingTimeout(context));
      const messages: Array<Record<string, unknown>> = [
        { role: "system", content: PILOT_SYSTEM_PROMPT },
        { role: "user", content: context.prompt },
      ];
      while (Date.now() < context.deadlineMs) {
        if (generatedTokens >= context.maxGeneratedTokens) throw new Error("generated token limit exhausted");
        const response = await this.post("/api/chat", {
        model: OLLAMA_MODEL,
        messages,
        stream: false,
        think: "high",
        keep_alive: "5m",
        options: {
          num_predict: context.maxGeneratedTokens - generatedTokens,
          temperature: 0,
          seed: OLLAMA_SEED,
          num_ctx: OLLAMA_CONTEXT_TOKENS,
        },
        tools: OLLAMA_TOOLS,
        }, this.remainingTimeout(context));
        const promptEvalCount = response.prompt_eval_count;
        const evalCount = response.eval_count;
        transcript.push({
          type: "model_response",
          usage: {
            promptEvalCount,
            promptEvalCachedCount: response.prompt_eval_cached_count,
            evalCount,
            totalDuration: response.total_duration,
          },
          response,
        });
        if (!Number.isInteger(promptEvalCount) || (promptEvalCount as number) < 0) {
          throw new Error("Ollama response has invalid prompt_eval_count");
        }
        promptTokens += promptEvalCount as number;
        if (!Number.isInteger(evalCount) || (evalCount as number) < 0) throw new Error("Ollama response has invalid eval_count");
        generatedTokens += evalCount as number;
        if (generatedTokens > context.maxGeneratedTokens) throw new Error("generated token limit exceeded");
        const message = response.message;
        if (!isRecord(message)) throw new Error("malformed Ollama response message");
        messages.push(message);
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (calls.length === 0) {
          return { text: typeof message.content === "string" ? message.content : "", promptTokens, generatedTokens, transcript };
        }
        for (const rawCall of calls) {
          const call = parseOllamaToolCall(rawCall);
          transcript.push({ type: "tool_request", call });
          const result = await withTimeout(context.broker.execute(call), this.remainingTimeout(context), "tool request timed out");
          transcript.push({ type: "tool_response", call, result });
          if (result.error === "tool call limit exceeded") throw new Error("tool call limit exceeded");
          messages.push({ role: "tool", tool_name: call.name, content: JSON.stringify(result) });
        }
      }
      throw new Error("pilot deadline exceeded");
    } catch (error: unknown) {
      throw new PilotModelError(error instanceof Error ? error.message : String(error), transcript, promptTokens, generatedTokens);
    }
  }

  private remainingTimeout(context: ModelDriverContext): number {
    const remaining = context.deadlineMs - Date.now();
    if (remaining <= 0) throw new Error("pilot deadline exceeded");
    return Math.min(context.requestTimeoutMs, remaining);
  }

  async verifyPinnedModel(timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<void> {
    const tags = await this.get("/api/tags", timeoutMs);
    const models = Array.isArray(tags.models) ? tags.models : [];
    const match = models.find((entry) => isRecord(entry) && entry.name === OLLAMA_MODEL);
    if (!isRecord(match) || match.digest !== OLLAMA_DIGEST) throw new Error("pinned Ollama model digest is unavailable");
  }

  private async get(route: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return this.request(`${OLLAMA_ENDPOINT}${route}`, { method: "GET" }, timeoutMs);
  }

  private async post(route: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    return this.request(`${OLLAMA_ENDPOINT}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, timeoutMs);
  }

  private async request(url: string, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!url.startsWith(`${OLLAMA_ENDPOINT}/`)) throw new Error("Ollama endpoint must remain loopback-pinned");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`Ollama request failed with HTTP ${response.status}`);
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_MODEL_RESPONSE_BYTES) throw new Error("Ollama response exceeds byte limit");
      const text = await readBoundedResponse(response, MAX_MODEL_RESPONSE_BYTES);
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new Error("Ollama returned malformed JSON"); }
      if (!isRecord(value)) throw new Error("Ollama returned malformed JSON");
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Ollama response exceeds byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

const OLLAMA_TOOLS = [
  { type: "function", function: { name: "list", description: "List allowed repository files", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "read", description: "Read one allowed repository file", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "replace_unique", description: "Replace one unique text occurrence in an existing lib JavaScript file", parameters: { type: "object", required: ["path", "oldText", "newText"], properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } } } } },
  { type: "function", function: { name: "search", description: "Search repository source through the condition-specific adapter", parameters: { type: "object", required: ["query"], properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS } } } } },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOllamaToolCall(value: unknown): BrokerToolCall {
  if (!isRecord(value) || !isRecord(value.function)) throw new Error("malformed Ollama tool call");
  const name = value.function.name;
  if (name !== "list" && name !== "read" && name !== "replace_unique" && name !== "search") throw new Error("Ollama requested an unknown tool");
  const args = value.function.arguments;
  if (!isRecord(args)) throw new Error("malformed Ollama tool arguments");
  return { name, arguments: args };
}

export function applyTaskMutation(workspace: string, task: PilotTask): void {
  const root = fs.realpathSync(workspace);
  const target = existingRealPath(root, task.mutation.file);
  assertSafeRegularFile(target);
  const content = fs.readFileSync(target, "utf8");
  const first = content.indexOf(task.mutation.oldText);
  if (first < 0 || content.indexOf(task.mutation.oldText, first + task.mutation.oldText.length) >= 0) {
    throw new Error(`task mutation precondition failed for ${task.id}`);
  }
  fs.writeFileSync(target, content.slice(0, first) + task.mutation.newText + content.slice(first + task.mutation.oldText.length));
}

export interface EvaluatorResult {
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}

export interface SandboxProbeResult {
  outsideReadDenied: boolean;
  outsideWriteDenied: boolean;
  networkDenied: boolean;
  childProcessDenied: boolean;
}

export interface EvaluatorRuntime {
  path: string;
  expectedSha256: string;
  expectedVersion: string;
}

export interface PilotEvaluationOptions {
  privateRoot: string;
  runtime: EvaluatorRuntime;
}

export class PilotEvaluatorError extends Error {
  constructor(message: string, readonly result?: EvaluatorResult) {
    super(message);
    this.name = "PilotEvaluatorError";
  }
}

export interface PilotRuntimeVerification {
  evaluator: { path: string; sha256: string; version: string };
  model: { name: string; digest: string; endpoint: string };
}

function sandboxProfile(workspace: string, nodeBinary: string): string {
  const quote = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const ancestors: string[] = [];
  let parent = path.dirname(workspace);
  while (true) {
    ancestors.push(`(literal "${quote(parent)}")`);
    if (parent === path.dirname(parent)) break;
    parent = path.dirname(parent);
  }
  return `(version 1)\n(deny default)\n(import "system.sb")\n(deny process-fork)\n(allow process-exec (literal "${quote(nodeBinary)}"))\n(allow file-read-metadata ${ancestors.join(" ")})\n(allow file-read* (literal "${quote(nodeBinary)}") (subpath "${quote(workspace)}"))\n(allow file-write* (subpath "${quote(workspace)}"))\n(deny network*)\n`;
}

function verifyEvaluatorRuntime(runtime: EvaluatorRuntime): { path: string; sha256: string; version: string } {
  if (runtime.expectedSha256 !== EVALUATOR_NODE_SHA256 || !/^v24\./.test(runtime.expectedVersion)) {
    throw new Error("evaluator requires the frozen standalone Node 24 runtime");
  }
  if (!path.isAbsolute(runtime.path) || !fs.existsSync(runtime.path)) throw new Error("pinned standalone evaluator runtime is unavailable");
  assertNoSymlinkComponents(path.parse(runtime.path).root, runtime.path);
  const real = fs.realpathSync(runtime.path);
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("pinned standalone evaluator runtime must be a unique regular file");
  const digest = createHash("sha256").update(fs.readFileSync(real)).digest("hex");
  if (digest !== runtime.expectedSha256) throw new Error("pinned standalone evaluator runtime hash mismatch");
  const version = execFileSync(real, ["--version"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    timeout: 5_000,
    maxBuffer: 4_096,
  }).trim();
  if (version !== runtime.expectedVersion) throw new Error("pinned standalone evaluator runtime version mismatch");
  return { path: real, sha256: digest, version };
}

export async function verifyPilotRuntime(runtime: EvaluatorRuntime): Promise<PilotRuntimeVerification> {
  const evaluator = verifyEvaluatorRuntime(runtime);
  await new OllamaModelDriver().verifyPinnedModel();
  return { evaluator, model: { name: OLLAMA_MODEL, digest: OLLAMA_DIGEST, endpoint: OLLAMA_ENDPOINT } };
}

function privateEvaluatorRoot(workspace: string, options?: PilotEvaluationOptions): string {
  if (!options) throw new Error("explicit evaluator runtime and private root are required");
  const root = fs.realpathSync(options.privateRoot);
  const candidate = fs.realpathSync(workspace);
  if (!fs.statSync(root).isDirectory() || isWithin(candidate, root) || isWithin(root, candidate)) {
    throw new Error("private evaluator root must be outside and disjoint from candidate source");
  }
  return root;
}

function minimalEnvironment(workspace: string): NodeJS.ProcessEnv {
  const home = path.join(workspace, ".pilot-home");
  const temp = path.join(workspace, ".pilot-tmp");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", HOME: home, TMPDIR: temp };
}

async function runSandboxedNode(options: {
  workspace: string;
  source: string;
  timeoutMs: number;
  runtime: EvaluatorRuntime;
  useNodePermissions?: boolean;
}): Promise<EvaluatorResult> {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) throw new Error("safe evaluator requires macOS sandbox-exec");
  const workspace = fs.realpathSync(options.workspace);
  const verifiedRuntime = verifyEvaluatorRuntime(options.runtime);
  const nodeBinary = path.join(workspace, `.pilot-runtime-node-${process.pid}-${Date.now()}`);
  fs.copyFileSync(verifiedRuntime.path, nodeBinary, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(nodeBinary, 0o500);
  const copiedDigest = createHash("sha256").update(fs.readFileSync(nodeBinary)).digest("hex");
  if (copiedDigest !== verifiedRuntime.sha256) throw new Error("isolated evaluator runtime copy hash mismatch");
  const profilePath = path.join(workspace, `.pilot-sandbox-${process.pid}-${Date.now()}.sb`);
  const evaluatorPath = path.join(workspace, `.pilot-evaluator-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(profilePath, sandboxProfile(workspace, nodeBinary), { mode: 0o600 });
  fs.writeFileSync(evaluatorPath, options.source, { mode: 0o600 });
  const nodeArgs = ["--experimental-vm-modules", "--max-old-space-size=256"];
  if (options.useNodePermissions !== false) {
    nodeArgs.push(
      "--permission",
      `--allow-fs-read=${workspace}`,
      `--allow-fs-write=${workspace}`,
    );
  }
  const args = ["-f", profilePath, nodeBinary, ...nodeArgs, path.basename(evaluatorPath)];
  let execution: EvaluatorResult | undefined;
  let executionError: unknown;
  try {
    execution = await new Promise<EvaluatorResult>((resolve) => {
      const child = spawn("/usr/bin/sandbox-exec", args, {
        cwd: workspace,
        env: minimalEnvironment(workspace),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let terminalError: Error | undefined;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const capture = (chunks: Buffer[], chunk: Buffer): void => {
        const remaining = Math.max(0, MAX_EVALUATOR_OUTPUT_BYTES - outputBytes);
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        outputBytes += chunk.length;
        if (outputBytes > MAX_EVALUATOR_OUTPUT_BYTES) {
          terminalError ??= new Error("sandboxed evaluator output limit exceeded");
          child.kill("SIGKILL");
          return;
        }
      };
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.on("error", (error) => {
        terminalError ??= error;
      });
      child.on("close", (code, signal) => finish(() => {
        resolve({
          passed: code === 0 && !terminalError,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: code,
          signal,
          ...(terminalError ? { error: terminalError.message } : {}),
        });
      }));
      const timer = setTimeout(() => {
        terminalError ??= new Error("sandboxed evaluator timed out");
        child.kill("SIGKILL");
      }, options.timeoutMs);
      child.stdin.end();
    });
  } catch (error: unknown) {
    executionError = error;
  }
  const errors: string[] = [];
  for (const file of [profilePath, evaluatorPath, nodeBinary]) {
    try { fs.rmSync(file, { force: true }); }
    catch (error: unknown) { errors.push(String(error)); }
  }
  if (errors.length) throw new PilotEvaluatorError(`evaluator cleanup failed: ${errors.join("; ")}${executionError === undefined ? "" : `; execution failed: ${String(executionError)}`}`, execution);
  if (executionError !== undefined) throw executionError;
  if (!execution) throw new Error("sandboxed evaluator produced no execution result");
  return execution;
}

export async function proveSandboxDenials(workspace: string, options?: PilotEvaluationOptions): Promise<SandboxProbeResult> {
  const privateRoot = privateEvaluatorRoot(workspace, options);
  const root = fs.mkdtempSync(path.join(privateRoot, "competitive-pilot-probe-"));
  const outsideDirectory = fs.mkdtempSync(path.join(privateRoot, "competitive-pilot-sentinel-"));
  const outsideReadPath = path.join(outsideDirectory, "outside-read.txt");
  const outsideWritePath = path.join(outsideDirectory, "outside-write.txt");
  fs.writeFileSync(outsideReadPath, "sentinel");
  const server = createServer(socket => {
    socket.on("error", () => socket.destroy());
    socket.end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("owned network sentinel did not bind");
    const source = `
import fs from "node:fs";
import net from "node:net";
import { execFileSync } from "node:child_process";
const result = { outsideReadDenied: false, outsideWriteDenied: false, networkDenied: false, childProcessDenied: false };
const denied = error => error && ["EPERM", "EACCES"].includes(error.code);
try { fs.readFileSync(${JSON.stringify(outsideReadPath)}, "utf8"); } catch (error) { result.outsideReadDenied = denied(error); }
try { fs.writeFileSync(${JSON.stringify(outsideWritePath)}, "escape"); } catch (error) { result.outsideWriteDenied = denied(error); }
result.networkDenied = await new Promise(resolve => {
  const socket = net.createConnection({ host: "127.0.0.1", port: ${address.port} });
  socket.setTimeout(1000);
  socket.once("connect", () => { socket.destroy(); resolve(false); });
  socket.once("timeout", () => { socket.destroy(); resolve(false); });
  socket.once("error", error => { socket.destroy(); resolve(denied(error)); });
});
try { execFileSync("/usr/bin/true"); } catch (error) { result.childProcessDenied = denied(error); }
console.log(JSON.stringify(result));
`;
    const execution = await runSandboxedNode({
      workspace: root,
      source,
      timeoutMs: EVALUATOR_TIMEOUT_MS,
      useNodePermissions: false,
      runtime: options!.runtime,
    });
    if (!execution.passed) {
      throw new PilotEvaluatorError(`sandbox probe process failed (exit ${execution.exitCode}, signal ${execution.signal ?? "none"}): ${execution.error ?? (execution.stderr || execution.stdout)}`, execution);
    }
    const result: unknown = JSON.parse(execution.stdout.trim());
    if (!isRecord(result)) throw new Error("sandbox probe returned malformed output");
    const probe: SandboxProbeResult = {
      outsideReadDenied: result.outsideReadDenied === true,
      outsideWriteDenied: result.outsideWriteDenied === true,
      networkDenied: result.networkDenied === true,
      childProcessDenied: result.childProcessDenied === true,
    };
    if (!Object.values(probe).every(Boolean) || fs.existsSync(outsideWritePath)
      || fs.readFileSync(outsideReadPath, "utf8") !== "sentinel") throw new Error("sandbox denial probe failed closed");
    return probe;
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(outsideDirectory, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export async function evaluateCandidate(candidateWorkspace: string, task: PilotTask, options?: PilotEvaluationOptions): Promise<EvaluatorResult> {
  const privateRoot = privateEvaluatorRoot(candidateWorkspace, options);
  const original = existingRealPath(fs.realpathSync(candidateWorkspace), task.mutation.file);
  if (assertSafeRegularFile(original).size > MAX_READ_BYTES) throw new Error("candidate source exceeds byte limit");
  const freshCandidate = fs.mkdtempSync(path.join(privateRoot, "competitive-pilot-eval-"));
  const candidatePath = path.join(freshCandidate, task.mutation.file);
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  fs.copyFileSync(original, candidatePath, fs.constants.COPYFILE_EXCL);
  const source = `
import fs from "node:fs";
import vm from "node:vm";
const candidateSource = fs.readFileSync(${JSON.stringify(candidatePath)}, "utf8");
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
const candidateModule = new vm.SourceTextModule(candidateSource, {
  context,
  identifier: ${JSON.stringify(candidatePath)},
  initializeImportMeta: () => {},
  importModuleDynamically: async () => { throw new Error("candidate dynamic imports are forbidden"); },
});
await candidateModule.link(async () => { throw new Error("candidate imports are forbidden"); });
await candidateModule.evaluate();
const candidate = candidateModule.namespace.default;
if (typeof candidate !== "function") throw new Error("candidate must retain a default function export");
const inputs = ${JSON.stringify(task.evaluatorInputs)};
const outputs = [];
for (const args of inputs) outputs.push(await candidate(...args));
process.stdout.write(JSON.stringify(outputs));
`;
  let result: EvaluatorResult | undefined;
  let evaluationError: unknown;
  try {
    result = await runSandboxedNode({ workspace: freshCandidate, source, timeoutMs: EVALUATOR_TIMEOUT_MS, runtime: options!.runtime });
    let outputs: unknown;
    try { outputs = JSON.parse(result.stdout); } catch { outputs = undefined; }
    const passed = result.passed && JSON.stringify(outputs) === JSON.stringify(task.hiddenExpectedOutputs);
    result = { ...result, passed };
  } catch (error: unknown) {
    if (error instanceof PilotEvaluatorError) result = error.result;
    evaluationError = error;
  }
  try { fs.rmSync(freshCandidate, { recursive: true, force: true }); }
  catch (error: unknown) { throw new PilotEvaluatorError(`candidate cleanup failed: ${String(error)}${evaluationError === undefined ? "" : `; evaluation failed: ${String(evaluationError)}`}`, result); }
  if (evaluationError !== undefined) throw evaluationError;
  if (!result) throw new Error("candidate evaluator produced no result");
  return result;
}

export interface PilotRunResult {
  taskId: string;
  model: ModelDriverResult;
  evaluator: EvaluatorResult;
  toolCalls: number;
}

export async function runPilotTask(options: {
  workspace: string;
  task: PilotTask;
  searchAdapter: SearchAdapter;
  modelDriver: ModelDriver;
  evaluation?: PilotEvaluationOptions;
}): Promise<PilotRunResult> {
  await proveSandboxDenials(options.workspace, options.evaluation);
  const broker = new PilotBroker(options.workspace, options.searchAdapter);
  const deadlineMs = Date.now() + MAX_RUN_MS;
  const model = await options.modelDriver.run({
    prompt: options.task.prompt,
    broker,
    deadlineMs,
    maxGeneratedTokens: MAX_GENERATED_TOKENS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (Date.now() > deadlineMs) throw new Error("pilot deadline exceeded");
  if (model.generatedTokens > MAX_GENERATED_TOKENS) throw new Error("generated token limit exceeded");
  const evaluator = await evaluateCandidate(options.workspace, options.task, options.evaluation);
  return { taskId: options.task.id, model, evaluator, toolCalls: broker.callCount };
}
