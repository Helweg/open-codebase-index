import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ApiFetchUsageData, ApiRouteUsageData } from "../native/index.js";
import { extractApiUsages } from "../native/index.js";
import { isTestPath } from "../indexer/intent-aware-ranking.js";
import type { OperationControl } from "../utils/operation-control.js";
import { throwIfOperationAborted } from "../utils/operation-control.js";

const SUPPORTED_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
export const API_IMPACT_MAX_INDEXED_FILES = 200;
export const API_IMPACT_MAX_FILE_BYTES = 256 * 1024;
export const API_IMPACT_MAX_MATCHES = 20;

export interface ApiImpactTarget {
  symbol: string;
  filePath: string;
  startLine: number;
}

export interface ApiImpactEvidence {
  text: string;
  scannedFileCount: number;
  candidateFileCount: number;
  routeCount: number;
  consumerCount: number;
  candidateTestCount: number;
  truncated: boolean;
}

interface FileUsage {
  filePath: string;
  fetches: ApiFetchUsageData[];
}

function languageForFile(filePath: string): "typescript" | "javascript" | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "javascript";
  return undefined;
}

function normalizedRelativePath(projectRoot: string, filePath: string): string | undefined {
  const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(projectRoot, filePath);
  const relative = path.relative(projectRoot, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

async function readScopedFile(projectRoot: string, relativePath: string): Promise<string | undefined> {
  const absolute = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const stat = await fs.stat(absolute).catch(() => undefined);
  if (!stat?.isFile() || stat.size > API_IMPACT_MAX_FILE_BYTES) return undefined;
  const realRoot = await fs.realpath(projectRoot).catch(() => undefined);
  const realFile = await fs.realpath(absolute).catch(() => undefined);
  if (!realRoot || !realFile) return undefined;
  const realRelative = path.relative(realRoot, realFile);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) return undefined;
  const handle = await fs.open(realFile, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(API_IMPACT_MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > API_IMPACT_MAX_FILE_BYTES) return undefined;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function routeMatchesTarget(route: ApiRouteUsageData, target: ApiImpactTarget): boolean {
  return (route.handlerName === target.symbol
      && target.startLine >= route.handlerStartLine
      && target.startLine <= route.handlerEndLine)
    || (!route.handlerName && target.startLine >= route.handlerStartLine && target.startLine <= route.handlerEndLine);
}

function signature(route: ApiRouteUsageData): string {
  return `${route.method} ${route.path}`;
}

function formatRoute(filePath: string, route: ApiRouteUsageData, ambiguous: boolean): string {
  const handler = route.handlerName ?? `<inline ${route.handlerStartLine}-${route.handlerEndLine}>`;
  return `- ${route.method} ${route.path} at ${filePath}:${route.line} handler=${handler} [syntactic_route_registration${ambiguous ? ", ambiguous_duplicate_signature" : ""}]`;
}

export async function buildApiImpactEvidence(
  projectRoot: string,
  target: ApiImpactTarget,
  indexedFilePaths: string[],
  control?: OperationControl,
): Promise<ApiImpactEvidence> {
  throwIfOperationAborted(control?.signal);
  const targetPath = normalizedRelativePath(projectRoot, target.filePath);
  const limitations = "Limitations: Express only; literal import/require, app construction, HTTP method/path, and local named/inline handlers only. Mount prefixes, routers, dynamic paths, imported handlers, reassignment/shadowing, wrapper clients, dynamic fetch inputs, base URLs, and cross-file handler association are unsupported. Fetch matches are syntactic evidence, never resolved call edges. Files labeled as candidate tests are not proven runtime coverage.";
  if (!targetPath || !SUPPORTED_EXTENSIONS.has(path.extname(targetPath).toLowerCase())) {
    return { text: `## API impact evidence\nNo supported JavaScript/TypeScript target file was resolved.\n\n${limitations}`, scannedFileCount: 0, candidateFileCount: 0, routeCount: 0, consumerCount: 0, candidateTestCount: 0, truncated: false };
  }

  const targetContent = await readScopedFile(projectRoot, targetPath);
  if (!targetContent) {
    return { text: `## API impact evidence\nThe resolved target file could not be safely read from the current tree.\n\n${limitations}`, scannedFileCount: 0, candidateFileCount: 0, routeCount: 0, consumerCount: 0, candidateTestCount: 0, truncated: false };
  }

  const language = languageForFile(targetPath);
  const targetExtraction = language ? extractApiUsages(targetContent, language) : { routes: [], fetches: [] };
  const associatedRoutes = targetExtraction.routes.filter((route) => routeMatchesTarget(route, target));
  if (associatedRoutes.length === 0) {
    return { text: `## API impact evidence\nNo proven local Express route registration was associated with ${target.symbol} at ${targetPath}:${target.startLine}.\n\n${limitations}`, scannedFileCount: 1, candidateFileCount: 1, routeCount: 0, consumerCount: 0, candidateTestCount: 0, truncated: false };
  }

  const allBySignature = new Map<string, ApiRouteUsageData[]>();
  for (const route of targetExtraction.routes) {
    const routes = allBySignature.get(signature(route)) ?? [];
    routes.push(route);
    allBySignature.set(signature(route), routes);
  }
  const routeSignatures = new Set(associatedRoutes.map(signature));
  const normalizedCandidates = [...new Set(indexedFilePaths
    .map((filePath) => normalizedRelativePath(projectRoot, filePath))
    .filter((filePath): filePath is string => Boolean(filePath))
    .filter((filePath) => SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())))]
    .sort();
  if (!normalizedCandidates.includes(targetPath)) normalizedCandidates.unshift(targetPath);
  const limitedCandidates = normalizedCandidates.slice(0, API_IMPACT_MAX_INDEXED_FILES);
  const truncatedByFiles = normalizedCandidates.length > limitedCandidates.length;
  const usages: FileUsage[] = [];
  let scannedFileCount = 0;

  for (const filePath of limitedCandidates) {
    throwIfOperationAborted(control?.signal);
    const fileLanguage = languageForFile(filePath);
    const content = await readScopedFile(projectRoot, filePath);
    if (!fileLanguage || content === undefined) continue;
    scannedFileCount += 1;
    const extraction = extractApiUsages(content, fileLanguage);
    const fetches = extraction.fetches.filter((fetch) => routeSignatures.has(`${fetch.method} ${fetch.path}`));
    if (fetches.length > 0) usages.push({ filePath, fetches });
    await control?.heartbeat?.();
  }

  const matches = usages.flatMap(({ filePath, fetches }) => fetches.map((fetch) => ({ filePath, fetch })))
    .sort((left, right) => left.filePath.localeCompare(right.filePath) || left.fetch.line - right.fetch.line);
  const displayedMatches = matches.slice(0, API_IMPACT_MAX_MATCHES);
  const truncated = truncatedByFiles || matches.length > displayedMatches.length;
  const candidateTests = new Set(displayedMatches.filter((match) => isTestPath(match.filePath)).map((match) => match.filePath));
  const lines = [
    "## API impact evidence",
    ...associatedRoutes.map((route) => formatRoute(targetPath, route, (allBySignature.get(signature(route))?.length ?? 0) > 1)),
    "",
    `Active-branch indexed files considered: ${normalizedCandidates.length}; scanned: ${scannedFileCount}; caps: ${API_IMPACT_MAX_INDEXED_FILES} files, ${API_IMPACT_MAX_FILE_BYTES} bytes/file, ${API_IMPACT_MAX_MATCHES} displayed matches.${truncated ? " Results were truncated by a cap." : ""}`,
    "",
    "### Exact relative fetch consumers",
    ...(displayedMatches.length === 0 ? ["None found in the bounded indexed-file scope."] : displayedMatches.map(({ filePath, fetch }) => {
      const testLabel = isTestPath(filePath) ? ", candidate_test_file" : "";
      return `- ${fetch.method} ${fetch.path} at ${filePath}:${fetch.line} [exact_relative_fetch_match${testLabel}]`;
    })),
    "",
    limitations,
  ];
  return {
    text: lines.join("\n"),
    scannedFileCount,
    candidateFileCount: normalizedCandidates.length,
    routeCount: associatedRoutes.length,
    consumerCount: matches.length,
    candidateTestCount: candidateTests.size,
    truncated,
  };
}
