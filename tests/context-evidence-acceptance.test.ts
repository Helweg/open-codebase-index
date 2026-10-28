import type { CodebaseContextResult } from "../src/tools/context.js";
import type { CodebaseEditContextResult } from "../src/tools/edit-context.js";
import type { ArchitectureContextResult } from "../src/tools/architecture-context.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { resolveCodebaseContext } from "../src/tools/context.js";
import { resolveCodebaseEditContext } from "../src/tools/edit-context.js";
import { getArchitectureContext } from "../src/tools/operations.js";
import { configCache, getIndexerCacheKey, indexerCache } from "../src/tools/operation-runtime.js";
import { countContextTokens } from "../src/tools/context-pack.js";
import { estimateTokens } from "../src/utils/cost.js";

const TARGET = "signalGateForUnicodeEnvelopeValidationWithPreservedSourceCoordinatesAndExplicitEvidenceIdentity";
const TARGET_DIRECTORY = "src/envelopes/coordinate-preserving-transport/evidence-with-a-deliberately-long-directory-name";
const TARGET_PATH = `${TARGET_DIRECTORY}/unicode-envelope-validation-with-a-long-source-file-name.ts`;
const DUPLICATE_PATH = "src/foreign/gate.ts";
const CALLER_PATH = "src/transport.ts";
const HELPER_PATH = "src/normalize.ts";
const BUDGETS = [128, 600, 1200] as const;

interface Citation {
  filePath: string;
  startLine: number;
  endLine: number;
}

interface SourceCredit {
  citation: Citation;
  completeDeclaration: boolean;
}

let root: string;
let indexer: Indexer | undefined;
let sources: Map<string, string>;

function normalizeEol(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

// Resolve compact display paths against this fixture only, never the host filesystem.
function fixturePath(displayPath: string): string {
  const candidates = [...sources.keys()].filter((relative) => {
    const absolute = path.join(root, relative);
    return displayPath.startsWith("…")
      ? displayPath.length > 1 && absolute.endsWith(displayPath.slice(1))
      : displayPath === relative || displayPath === absolute;
  });
  expect(candidates, `fixture identity for ${displayPath}`).toHaveLength(1);
  return candidates[0];
}

function sourceLines(citation: Citation): string[] {
  const relative = fixturePath(citation.filePath);
  const lines = normalizeEol(sources.get(relative)!).trimEnd().split("\n");
  expect(Number.isInteger(citation.startLine)).toBe(true);
  expect(Number.isInteger(citation.endLine)).toBe(true);
  expect(citation.startLine).toBeGreaterThanOrEqual(1);
  expect(citation.endLine).toBeGreaterThanOrEqual(citation.startLine);
  expect(citation.endLine).toBeLessThanOrEqual(lines.length);
  return lines.slice(citation.startLine - 1, citation.endLine);
}

function identity(citation: Citation): string {
  sourceLines(citation);
  return `${fixturePath(citation.filePath)}:${citation.startLine}-${citation.endLine}`;
}

function outsideSourceLines(text: string): string[] {
  let inSource = false;
  return text.split("\n").filter((line) => {
    if (line.startsWith("```")) {
      inSource = !inSource;
      return false;
    }
    return !inSource;
  });
}

function contextCitations(text: string): Citation[] {
  return outsideSourceLines(text).flatMap((line) => {
    const match = /^\[\d+\] \S+(?: "(?:\\.|[^"\\])*")? in (.+?):(\d+)-(\d+)(?: \[origin: [^\]]+\])? \(score [^)]+\)/u.exec(line);
    return match ? [{ filePath: match[1], startLine: Number(match[2]), endLine: Number(match[3]) }] : [];
  });
}

function assertContextEvidence(response: CodebaseContextResult): Citation[] {
  const citations = contextCitations(response.text);
  const selected = response.details?.results ?? [];
  expect(citations.map(identity)).toEqual(selected.map(identity));
  expect(response.details?.selectedCount).toBe(citations.length);
  expect(countContextTokens(response.text)).toBeLessThanOrEqual(response.details!.tokenBudget);
  // Context packs expose locations, not source bodies: no declaration credit here.
  return citations;
}

function requireRetainedCitation(citations: Citation[], expected: Citation): void {
  expect(citations.map(identity), "required evidence must survive rendering").toContain(identity(expected));
}

function targetSourceCredit(text: string): SourceCredit | undefined {
  const section = /(?:^|\n)## Target implementation\n([^\n]+):(\d+)-(\d+) \([^\n]*\)\n```\n/u.exec(text);
  if (!section) return undefined;
  const citation = { filePath: section[1], startLine: Number(section[2]), endLine: Number(section[3]) };
  const expected = sourceLines(citation).join("\n").trim();
  const tail = normalizeEol(text.slice(section.index + section[0].length));
  const closing = tail.indexOf("\n```");
  const truncation = tail.startsWith("...[truncated to context token budget]")
    ? 0 : tail.indexOf("\n...[truncated to context token budget]");
  const completeBody = closing >= 0 && (truncation < 0 || closing < truncation);
  const rawBody = completeBody ? tail.slice(0, closing) : tail.slice(0, truncation < 0 ? tail.length : truncation);
  expect(expected.startsWith(rawBody.trim()), `source excerpt at ${identity(citation)}`).toBe(true);
  // A clipped final line is not a full source line; retain only verifiable lines.
  const body = completeBody ? rawBody.trim() : rawBody.slice(0, rawBody.lastIndexOf("\n") + 1).trim();
  if (!body) return undefined;
  if (completeBody && truncation < 0) expect(body).toBe(expected);
  const declaration = normalizeEol(sources.get(fixturePath(citation.filePath))!).trim();
  return {
    citation,
    completeDeclaration: completeBody && body === declaration,
  };
}

function editNeighbors(text: string): { callers: Citation[]; callees: Citation[] } {
  const callers: Citation[] = [];
  const callees: Citation[] = [];
  let section = "";
  for (const line of outsideSourceLines(text)) {
    if (line.startsWith("## ")) section = line;
    const match = /^- (\S+) (?:at|from) (.+?):(\d+) \(([^,]+), (?:resolved|unresolved)\)$/u.exec(line);
    if (!match || !["## Direct callers", "## Direct callees"].includes(section)) continue;
    const citation = { filePath: match[2], startLine: Number(match[3]), endLine: Number(match[3]) };
    const source = sourceLines(citation).join("\n");
    expect(source).toContain(section === "## Direct callers" ? `${TARGET}(` : `${match[1]}(`);
    (section === "## Direct callers" ? callers : callees).push(citation);
  }
  return { callers, callees };
}

function assertEditEvidence(response: CodebaseEditContextResult): SourceCredit | undefined {
  const source = targetSourceCredit(response.text);
  const neighbors = editNeighbors(response.text);
  expect(countContextTokens(response.text)).toBeLessThanOrEqual(response.details.tokenBudget);
  expect(response.details.sourceIncluded, "sourceIncluded credits at least one complete source line, not a header").toBe(source !== undefined);
  expect(response.details.callerCount, "callerCount credits only complete visible rows").toBe(neighbors.callers.length);
  expect(response.details.calleeCount, "calleeCount credits only complete visible rows").toBe(neighbors.callees.length);
  return source;
}

function architectureCitations(text: string): Citation[] {
  return outsideSourceLines(text).flatMap((line) => {
    const match = /^- Evidence: .+ \((.+):(\d+)\)$/u.exec(line);
    return match ? [{ filePath: match[1], startLine: Number(match[2]), endLine: Number(match[2]) }] : [];
  });
}

function assertArchitectureEvidence(response: ArchitectureContextResult): Citation[] {
  const selected = response.modules.flatMap((module) => module.evidence);
  const citations = architectureCitations(response.text);
  expect(citations.map(identity)).toEqual(selected.map((entry) => identity({
    filePath: entry.filePath, startLine: entry.line, endLine: entry.line,
  })));
  for (const entry of selected) {
    const declaration = sourceLines({ filePath: entry.filePath, startLine: entry.line, endLine: entry.line })[0];
    expect(declaration).toContain(`function ${entry.symbol}(`);
    if (entry.excerpt) {
      expect(declaration.replace(/\s+/gu, " ").trim().startsWith(entry.excerpt.replace(/\s+/gu, " ").trim())).toBe(true);
    }
  }
  const responsibilities = [...response.text.matchAll(/^- Source-backed responsibility: (.+) \[(.+) at (.+):(\d+)\]$/gmu)];
  for (const match of responsibilities) {
    const entry = selected.find((candidate) => candidate.symbol === match[2]
      && candidate.filePath === match[3] && candidate.line === Number(match[4]));
    expect(entry, "responsibility must cite retained evidence").toBeDefined();
    expect(match[1]).toBe(entry!.excerpt);
  }
  expect(responsibilities.length).toBe(response.modules.filter((module) => module.evidence.some((entry) => entry.excerpt)).length);
  expect(estimateTokens(response.text)).toBeLessThanOrEqual(response.tokenBudget);
  for (const boundary of response.boundaries) {
    for (const edge of boundary.evidence) {
      fixturePath(edge.fromFilePath);
      fixturePath(edge.toFilePath);
      expect(response.text).toContain(`  - ${edge.fromSymbol} (${edge.fromFilePath}) -> ${edge.toSymbol} (${edge.toFilePath})`);
    }
  }
  for (const hub of response.hubs) {
    fixturePath(hub.filePath);
    expect(response.text).toContain(`- ${hub.symbol} (${hub.filePath}), ${hub.connections} graph connections`);
  }
  return citations;
}

async function writeSource(relative: string, content: string): Promise<void> {
  sources.set(relative, content);
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "context-evidence-acceptance-"));
  sources = new Map();
  const config = parseConfig({
    indexing: { mode: "structural", autoIndex: false, watchFiles: false, requireProjectMarker: false },
    search: { minScore: 0 },
  });
  indexer = new Indexer(root, config, "opencode");
  const key = getIndexerCacheKey(root, "opencode");
  configCache.set(key, config);
  indexerCache.set(key, indexer);
  await writeSource(TARGET_PATH, [
    `export function ${TARGET}(input: string): string {`,
    "  let envelope = input;",
    ...Array.from({ length: 12 }, (_, index) => `  envelope = envelope.replace('é雪🙂-${index}', 'validated-${index}');`),
    "  return envelope;",
    "}",
    "",
  ].join("\r\n"));
  await writeSource(DUPLICATE_PATH, `export function ${TARGET}(input: string): string {\n  return 'foreign:' + input;\n}\n`);
  await writeSource(HELPER_PATH, "export function normalizeEnvelope(input: string): string {\n  return input.trim();\n}\n");
  await writeSource(CALLER_PATH, [
    `import { ${TARGET} } from './${TARGET_PATH.slice(4).replace(/\.ts$/u, ".js")}';`,
    "import { normalizeEnvelope } from './normalize.js';",
    "export function createTransport(input: string): string {",
    `  return ${TARGET}(normalizeEnvelope(input));`,
    "}",
    "",
  ].join("\n"));
  await indexer.index();
});

afterEach(async () => {
  try {
    await indexer?.close();
  } finally {
    const key = getIndexerCacheKey(root, "opencode");
    indexerCache.delete(key);
    configCache.delete(key);
    indexer = undefined;
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("native-backed consumer evidence acceptance", () => {
  it.each(BUDGETS)("retains only fixture citations in %i-token metadata context", async (tokenBudget) => {
    const response = await resolveCodebaseContext(root, "opencode", {
      query: TARGET, symbol: TARGET, directory: TARGET_DIRECTORY, tokenBudget,
    });
    expect(response.details?.route).toBe("definition");
    const citations = assertContextEvidence(response);
    expect(citations.map((citation) => fixturePath(citation.filePath))).toEqual([TARGET_PATH]);
    expect(citations[0].startLine).toBe(1);
    expect(response.text).not.toContain("envelope.replace(");
  });

  it.each(BUDGETS)("checks CRLF and Unicode source against retained %i-token pre-edit evidence", async (tokenBudget) => {
    const response = await resolveCodebaseEditContext(root, "opencode", {
      query: `change ${TARGET}`, symbol: TARGET, filePath: TARGET_PATH, tokenBudget,
    });
    expect(response.details.resolution).toBe("resolved");
    const source = assertEditEvidence(response);
    if (source) {
      expect(fixturePath(source.citation.filePath)).toBe(TARGET_PATH);
      expect(source.citation.startLine).toBe(1);
    }
    if (tokenBudget === 128) expect(source?.completeDeclaration ?? false).toBe(false);
    if (tokenBudget === 1200) {
      expect(source?.completeDeclaration).toBe(true);
      expect(response.text).toContain("é雪🙂-0");
      expect(editNeighbors(response.text).callers.map((citation) => fixturePath(citation.filePath))).toEqual([CALLER_PATH]);
    }
  });

  it.each(BUDGETS)("fits source and whole test-reference rows with CRLF, Unicode, and long identities at %i tokens", async (tokenBudget) => {
    const testPath = "tests/coordinate-preserving-transport/source-linked-envelope-validation-with-a-long-test-file-name.test.ts";
    await writeSource(testPath, [
      `import { ${TARGET} } from '../../${TARGET_PATH.replace(/\.ts$/u, ".js")}';`,
      "it('preserves é雪🙂 source coordinates', () => {",
      `  expect(${TARGET}('é雪🙂')).toBe('é雪🙂');`,
      "});",
      "",
    ].join("\r\n"));
    await indexer!.index();
    const response = await resolveCodebaseEditContext(root, "opencode", {
      query: `change ${TARGET}`, symbol: TARGET, filePath: TARGET_PATH, includeTests: true, tokenBudget,
    });
    assertEditEvidence(response);
    const rows = [...response.text.matchAll(/^- (.+):(\d+)-(\d+) \[(direct_target_test_reference|related_caller_test_reference)\] referencedSymbol=(\S+) referenceLine=(\d+)$/gmu)];
    expect(rows.map((row) => ({
      filePath: row[1], startLine: Number(row[2]), endLine: Number(row[3]),
      evidenceKind: row[4], referencedSymbol: row[5], referenceLine: Number(row[6]),
    }))).toEqual(response.details.testDiscovery?.results);
    for (const reference of response.details.testDiscovery!.results) {
      expect(fixturePath(reference.filePath)).toBe(testPath);
      expect([reference.startLine, reference.endLine, reference.referenceLine]).toEqual([2, 4, 3]);
      expect(sourceLines(reference)[1]).toContain(`${TARGET}('é雪🙂')`);
      expect(reference).not.toHaveProperty("content");
    }
    expect(response.text).not.toContain("it('preserves");
    expect(response.text.match(/```/gu)?.length ?? 0).toBe(response.details.sourceIncluded ? 2 : 0);
    expect(response.details.testDiscovery?.resolution).toBe("resolved");
    expect(response.details.testDiscovery?.omittedReferenceCount).toBe(1 - rows.length);
    if (tokenBudget === 1200) expect(rows.map((row) => fixturePath(row[1]))).toEqual([testPath]);
  });

  it.each(BUDGETS)("validates selected architecture locations and normalized excerpts at %i tokens", async (tokenBudget) => {
    const response = await getArchitectureContext(root, "opencode", { directory: "src", tokenBudget });
    const citations = assertArchitectureEvidence(response);
    if (tokenBudget === 1200) {
      expect(citations.map((citation) => fixturePath(citation.filePath))).toContain(TARGET_PATH);
      expect(citations.map((citation) => fixturePath(citation.filePath))).toContain(CALLER_PATH);
    }
  });

  it("keeps duplicate symbol identity explicit and does not recover outside a strict missing directory", async () => {
    const duplicate = await resolveCodebaseContext(root, "opencode", { query: TARGET, symbol: TARGET, tokenBudget: 1200 });
    expect(duplicate.details?.resolution).toBe("ambiguous");
    expect(assertContextEvidence(duplicate).map((citation) => fixturePath(citation.filePath)).sort()).toEqual([TARGET_PATH, DUPLICATE_PATH].sort());
    const edit = await resolveCodebaseEditContext(root, "opencode", { query: `change ${TARGET}`, symbol: TARGET, tokenBudget: 1200 });
    expect(edit.details.resolution).toBe("ambiguous");
    expect(targetSourceCredit(edit.text)).toBeUndefined();
    for (const tokenBudget of BUDGETS) {
      const missed = await resolveCodebaseContext(root, "opencode", {
        query: TARGET, symbol: TARGET, directory: "src/missing-scope", allowUnscopedRecovery: false, tokenBudget,
      });
      expect(missed.details?.results ?? []).toEqual([]);
      expect(contextCitations(missed.text)).toEqual([]);
      expect(countContextTokens(missed.text)).toBeLessThanOrEqual(tokenBudget);
      expect(missed.details?.recovery?.attempts.flatMap((attempt) => attempt.relaxedFields)).toEqual([]);
      const architecture = await getArchitectureContext(root, "opencode", { directory: "src/missing-scope", tokenBudget });
      expect(architecture.modules).toEqual([]);
      expect(architecture.boundaries).toEqual([]);
      expect(architecture.hubs).toEqual([]);
      expect(assertArchitectureEvidence(architecture)).toEqual([]);
    }
  });

  it("rejects a real graph neighbor omitted from the small response", async () => {
    const request = { query: `change ${TARGET}`, symbol: TARGET, filePath: TARGET_PATH };
    const larger = await resolveCodebaseEditContext(root, "opencode", { ...request, tokenBudget: 1200 });
    const smaller = await resolveCodebaseEditContext(root, "opencode", { ...request, tokenBudget: 128 });
    const caller = { filePath: CALLER_PATH, startLine: 4, endLine: 4 };
    requireRetainedCitation(editNeighbors(larger.text).callers, caller);
    expect(() => requireRetainedCitation(editNeighbors(smaller.text).callers, caller)).toThrow();
  });

  it("rejects wrong-range excerpts and paths echoed only in prose or source", async () => {
    const response = await resolveCodebaseEditContext(root, "opencode", {
      query: `change ${TARGET}`, symbol: TARGET, filePath: TARGET_PATH, tokenBudget: 1200,
    });
    const selected = targetSourceCredit(response.text);
    expect(selected?.completeDeclaration).toBe(true);
    const citation = selected!.citation;
    // Keep the real path and body; move to another valid line within the same file.
    const wrongRange = response.text.replace(`${citation.filePath}:${citation.startLine}-${citation.endLine}`, `${citation.filePath}:2-${citation.endLine}`);
    expect(() => targetSourceCredit(wrongRange)).toThrow();
    const context = await resolveCodebaseContext(root, "opencode", {
      query: TARGET, symbol: TARGET, directory: TARGET_DIRECTORY, tokenBudget: 1200,
    });
    const actual = contextCitations(context.text)[0];
    requireRetainedCitation(contextCitations(context.text), actual);
    const row = outsideSourceLines(context.text).find((line) => line.startsWith("[1] "))!;
    const prose = `Related source: ${row}`;
    const quotedSource = `\`\`\`ts\n${row}\n\`\`\``;
    expect(() => requireRetainedCitation(contextCitations(prose), actual)).toThrow();
    expect(() => requireRetainedCitation(contextCitations(quotedSource), actual)).toThrow();
  });
});
