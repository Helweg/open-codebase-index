import type { CodeChunk, DynamicBatchOptions } from "./types.js";

// Token estimation: ~4 chars per token for code (conservative)
const CHARS_PER_TOKEN = 4;
const MAX_BATCH_TOKENS = 7500; // Leave buffer under 8192 API limit
const MAX_SINGLE_CHUNK_TOKENS = 2000; // Default truncation cap for individual chunks

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function getEmbeddingHeaderParts(chunk: CodeChunk, filePath: string): string[] {
  const parts: string[] = [];

  const fileName = filePath.split("/").pop() || filePath;
  const dirPath = filePath.split("/").slice(-3, -1).join("/");

  const langDescriptors: Record<string, string> = {
    typescript: "TypeScript",
    javascript: "JavaScript",
    python: "Python",
    rust: "Rust",
    swift: "Swift",
    go: "Go",
    java: "Java",
  };

  const typeDescriptors: Record<string, string> = {
    function_declaration: "function",
    function: "function",
    arrow_function: "arrow function",
    method_definition: "method",
    method_declaration: "method",
    protocol_function_declaration: "protocol requirement",
    init_declaration: "initializer",
    deinit_declaration: "deinitializer",
    subscript_declaration: "subscript",
    class_declaration: "class",
    actor_declaration: "actor",
    extension_declaration: "extension",
    protocol_declaration: "protocol",
    struct_declaration: "struct",
    interface_declaration: "interface",
    type_alias_declaration: "type alias",
    enum_declaration: "enum",
    export_statement: "export",
    lexical_declaration: "variable declaration",
    function_definition: "function",
    class_definition: "class",
    function_item: "function",
    impl_item: "implementation",
    struct_item: "struct",
    enum_item: "enum",
    trait_item: "trait",
  };

  const lang = langDescriptors[chunk.language] || chunk.language;
  const typeDesc = typeDescriptors[chunk.chunkType] || chunk.chunkType;

  if (chunk.name) {
    parts.push(`${lang} ${typeDesc} "${chunk.name}"`);
  } else {
    parts.push(`${lang} ${typeDesc}`);
  }

  if (dirPath) {
    parts.push(`in ${dirPath}/${fileName}`);
  } else {
    parts.push(`in ${fileName}`);
  }

  const semanticHints = extractSemanticHints(chunk.name || "", chunk.content);
  if (semanticHints.length > 0) {
    parts.push(`Purpose: ${semanticHints.join(", ")}`);
  }

  return parts;
}

function buildEmbeddingText(
  headerParts: string[],
  content: string,
  partIndex?: number,
  partCount?: number,
): string {
  const parts = [...headerParts];
  if (partCount && partCount > 1 && partIndex) {
    parts.push(`Part ${partIndex}/${partCount}`);
  }
  parts.push("");
  parts.push(content);
  return parts.join("\n");
}

function splitOversizedContent(content: string, maxContentChars: number): string[] {
  if (content.length <= maxContentChars) {
    return [content];
  }

  const overlapChars = Math.max(
    CHARS_PER_TOKEN * 32,
    Math.min(Math.floor(maxContentChars * 0.15), CHARS_PER_TOKEN * 128),
  );
  const stepChars = Math.max(1, maxContentChars - overlapChars);
  const segments: string[] = [];

  for (let start = 0; start < content.length; start += stepChars) {
    const end = Math.min(content.length, start + maxContentChars);
    segments.push(content.slice(start, end));
    if (end >= content.length) {
      break;
    }
  }

  return segments;
}

export function createEmbeddingTexts(
  chunk: CodeChunk,
  filePath: string,
  maxChunkTokens = MAX_SINGLE_CHUNK_TOKENS,
): string[] {
  const headerParts = getEmbeddingHeaderParts(chunk, filePath);
  const headerLength = buildEmbeddingText(headerParts, "", 1, 9).length;
  const maxContentChars = Math.max(1, maxChunkTokens * CHARS_PER_TOKEN - headerLength);
  const segments = splitOversizedContent(chunk.content, maxContentChars);

  if (segments.length === 1) {
    return [buildEmbeddingText(headerParts, segments[0])];
  }

  return segments.map((segment, index) =>
    buildEmbeddingText(headerParts, segment, index + 1, segments.length),
  );
}

export function createEmbeddingText(
  chunk: CodeChunk,
  filePath: string,
  maxChunkTokens = MAX_SINGLE_CHUNK_TOKENS,
): string {
  const text = createEmbeddingTexts(chunk, filePath, maxChunkTokens)[0];
  if (!text) {
    return "";
  }

  const maxChars = maxChunkTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(0, Math.max(0, maxChars - 17)) + "\n... [truncated]";
}

export function createDynamicBatches<T extends { text: string; tokenCount?: number }>(
  chunks: T[],
  options: DynamicBatchOptions = {},
): T[][] {
  const batches: T[][] = [];
  let currentBatch: T[] = [];
  let currentTokens = 0;
  const maxBatchTokens = Math.max(1, options.maxBatchTokens ?? MAX_BATCH_TOKENS);
  const maxBatchItems = Math.max(1, options.maxBatchItems ?? Number.MAX_SAFE_INTEGER);

  for (const chunk of chunks) {
    const chunkTokens = chunk.tokenCount ?? estimateTokens(chunk.text);

    if (
      currentBatch.length > 0
      && (currentTokens + chunkTokens > maxBatchTokens || currentBatch.length >= maxBatchItems)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push(chunk);
    currentTokens += chunkTokens;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function extractSemanticHints(name: string, content: string): string[] {
  const hints: string[] = [];
  const combined = `${name} ${content}`.toLowerCase();

  const signature = extractFunctionSignature(content);
  if (signature) {
    hints.push(signature);
  }

  const patterns: Array<[RegExp, string]> = [
    [/auth|login|logout|signin|signout|credential/i, "authentication"],
    [/password|hash|bcrypt|argon/i, "password handling"],
    [/token|jwt|bearer|oauth/i, "token management"],
    [/user|account|profile|member/i, "user management"],
    [/permission|role|access|authorize/i, "authorization"],
    [/validate|verify|check|assert/i, "validation"],
    [/error|exception|throw|catch/i, "error handling"],
    [/log|debug|trace|info|warn/i, "logging"],
    [/cache|memoize|store/i, "caching"],
    [/fetch|request|response|api|http/i, "HTTP/API"],
    [/database|db|query|sql|mongo/i, "database"],
    [/file|read|write|stream|path/i, "file operations"],
    [/parse|serialize|json|xml/i, "data parsing"],
    [/encrypt|decrypt|crypto|secret|cipher|cryptographic/i, "encryption/cryptography"],
    [/test|spec|mock|stub|expect/i, "testing"],
    [/config|setting|option|env/i, "configuration"],
    [/route|endpoint|handler|controller|middleware/i, "routing/middleware"],
    [/render|component|view|template/i, "UI rendering"],
    [/state|redux|store|dispatch/i, "state management"],
    [/hook|effect|memo|callback/i, "React hooks"],
  ];

  for (const [pattern, hint] of patterns) {
    if (pattern.test(combined) && !hints.includes(hint)) {
      hints.push(hint);
    }
  }

  return hints.slice(0, 6);
}

function extractFunctionSignature(content: string): string | null {
  const tsJsPatterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?::\s*([^{]+))?/,
    /(?:export\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=>{]+))?\s*=>/,
    /(?:export\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)/,
  ];

  const pyPatterns = [
    /def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/,
    /async\s+def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/,
  ];

  const goPatterns = [/func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:\(([^)]+)\)|([^{\n]+))?/];

  const rustPatterns = [/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?/];

  for (const pattern of [...tsJsPatterns, ...pyPatterns, ...goPatterns, ...rustPatterns]) {
    const match = content.match(pattern);
    if (match) {
      const funcName = match[1];
      const params = match[2]?.trim() || "";
      const returnType = (match[3] || match[4])?.trim();

      const paramNames = extractParamNames(params);

      let sig = `${funcName}(${paramNames.join(", ")})`;
      if (returnType && returnType.length < 50) {
        sig += ` -> ${returnType.replace(/\s+/g, " ").trim()}`;
      }

      if (sig.length < 100) {
        return sig;
      }
    }
  }

  return null;
}

function extractParamNames(params: string): string[] {
  if (!params.trim()) return [];

  const names: string[] = [];
  const parts = params.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const tsMatch = trimmed.match(/^(\w+)\s*[?:]?/);
    const pyMatch = trimmed.match(/^(\w+)\s*(?::|=)/);
    const goMatch = trimmed.match(/^(\w+)\s+\w/);
    const rustMatch = trimmed.match(/^(\w+)\s*:/);

    const match = tsMatch || pyMatch || goMatch || rustMatch;
    if (match && match[1] !== "self" && match[1] !== "this") {
      names.push(match[1]);
    }
  }

  return names.slice(0, 5);
}
