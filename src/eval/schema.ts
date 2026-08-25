import { readFileSync } from "fs";

import type {
  EvalBudget,
  GoldenDataset,
  GoldenExpectedGraphNeighbor,
  GoldenExpected,
  GoldenGradedEvidence,
  GoldenQuery,
  GoldenQueryArgs,
  GoldenQueryDifficulty,
  GoldenQueryExpectedOutcome,
  GoldenQueryRecoveryExpectation,
  GoldenRetrievalMode,
  GoldenQueryType,
} from "./types.js";

function parseJsonFile(filePath: string): unknown {
  const content = readFileSync(filePath, "utf-8");

  try {
    return JSON.parse(content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse JSON from ${filePath}: ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asPositiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number`);
  }
  return value;
}

function parseQueryType(value: unknown, path: string): GoldenQueryType {
  if (
    value === "definition" ||
    value === "implementation-intent" ||
    value === "similarity" ||
    value === "keyword-heavy" ||
    value === "conceptual" ||
    value === "architecture"
  ) {
    return value;
  }
  throw new Error(
    `${path} must be one of: definition, implementation-intent, similarity, keyword-heavy, conceptual, architecture`
  );
}

function parseExpectedRoute(
  value: unknown,
  path: string,
): "search" | "definition" | undefined {
  if (value === undefined) return undefined;
  if (value === "search" || value === "definition") return value;
  throw new Error(`${path} must be one of: search, definition`);
}

function parseExpectedOutcome(
  value: unknown,
  path: string,
): GoldenQueryExpectedOutcome | undefined {
  if (value === undefined) return undefined;
  if (value === "results" || value === "no-results") {
    return value;
  }
  throw new Error(`${path} must be one of: results, no-results`);
}

function parseRecoveryExpectation(
  value: unknown,
  path: string,
): GoldenQueryRecoveryExpectation | undefined {
  if (value === undefined) return undefined;
  if (value === "none" || value === "filter-relaxed") {
    return value;
  }
  throw new Error(`${path} must be one of: none, filter-relaxed`);
}

function parseQueryDifficulty(
  value: unknown,
  path: string,
): GoldenQueryDifficulty | undefined {
  if (value === undefined) return undefined;
  if (value === "easy" || value === "medium" || value === "hard") {
    return value;
  }
  throw new Error(`${path} must be one of: easy, medium, hard`);
}

function parseQueryTags(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!isStringArray(value) || value.some((tag) => tag.trim().length === 0)) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
  if (value.length > 16) {
    throw new Error(`${path} must contain at most 16 tags`);
  }

  return value;
}

function parseQueryArgs(value: unknown, path: string): GoldenQueryArgs | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }

  const symbol = parseStringOrUndefined(value.symbol, `${path}.symbol`);
  const filePath = parseStringOrUndefined(value.filePath, `${path}.filePath`);
  const fileType = parseStringOrUndefined(value.fileType, `${path}.fileType`);
  const directory = parseStringOrUndefined(value.directory, `${path}.directory`);
  const callerLimit = parsePositiveIntegerOrUndefined(value.callerLimit, `${path}.callerLimit`);
  const calleeLimit = parsePositiveIntegerOrUndefined(value.calleeLimit, `${path}.calleeLimit`);
  const depth = parsePositiveIntegerOrUndefined(value.depth, `${path}.depth`);
  if (depth !== undefined && depth > 3) {
    throw new Error(`${path}.depth must be at most 3`);
  }
  const tokenBudget = parsePositiveIntegerOrUndefined(value.tokenBudget, `${path}.tokenBudget`);
  return {
    ...(symbol !== undefined ? { symbol } : {}),
    ...(filePath !== undefined ? { filePath } : {}),
    ...(fileType !== undefined ? { fileType } : {}),
    ...(directory !== undefined ? { directory } : {}),
    ...(callerLimit !== undefined ? { callerLimit } : {}),
    ...(calleeLimit !== undefined ? { calleeLimit } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  };
}

function parsePositiveIntegerOrUndefined(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value;
}

const SEMVER_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemanticVersion(value: unknown, path: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${path} must be a non-empty string`);
  }
  if (!SEMVER_VERSION_PATTERN.test(value)) {
    throw new Error(`${path} must be a valid semantic version (MAJOR.MINOR.PATCH)`);
  }

  return value;
}

function parseRetrievalMode(value: unknown, path: string): GoldenRetrievalMode {
  if (value === undefined || value === "search") return "search";
  if (value === "context" || value === "edit-context" || value === "architecture") return value;
  throw new Error(`${path} must be one of: search, context, edit-context, architecture`);
}

function parseStringOrUndefined(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isNonEmptyString(value)) {
    throw new Error(`${path} must be a non-empty string`);
  }

  return value;
}

function parseGradedEvidence(value: unknown, path: string): GoldenGradedEvidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`${path}[${index}] must be an object`);
    }

    const evidencePath = parseStringOrUndefined(entry.path, `${path}[${index}].path`);
    if (evidencePath === undefined) {
      throw new Error(`${path}[${index}].path is required`);
    }

    const symbol = parseStringOrUndefined(entry.symbol, `${path}[${index}].symbol`);
    const relevance = parseEvidenceRelevance(entry.relevance, `${path}[${index}].relevance`);

    return {
      path: evidencePath,
      ...(symbol !== undefined ? { symbol } : {}),
      relevance,
    };
  });
}

function parseEvidenceRelevance(
  value: unknown,
  path: string,
): 1 | 2 | 3 {
  if (value === undefined) {
    throw new Error(`${path} is required`);
  }
  if (value !== 1 && value !== 2 && value !== 3) {
    throw new Error(`${path} must be 1, 2, or 3`);
  }

  return value;
}

function parseExpectedGraphNeighbor(
  value: unknown,
  path: string,
): GoldenExpectedGraphNeighbor | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }

  if (value.direction !== "caller" && value.direction !== "callee") {
    throw new Error(`${path}.direction must be one of: caller, callee`);
  }
  const filePath = parseStringOrUndefined(value.filePath, `${path}.filePath`);
  const symbol = parseStringOrUndefined(value.symbol, `${path}.symbol`);
  if (filePath === undefined && symbol === undefined) {
    throw new Error(`${path} must include filePath or symbol`);
  }

  return {
    direction: value.direction,
    ...(filePath !== undefined ? { filePath } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
  };
}

function parseExpected(input: unknown, path: string): GoldenExpected {
  if (!isRecord(input)) {
    throw new Error(`${path} must be an object`);
  }

  const filePathRaw = input.filePath;
  const acceptableFilesRaw = input.acceptableFiles;
  const symbolRaw = input.symbol;
  const branchRaw = input.branch;
  const expectedRouteRaw = input.expectedRoute;
  const expectedOutcomeRaw = input.expectedOutcome;
  const recoveryExpectationRaw = input.recoveryExpectation;
  const gradedEvidenceRaw = input.gradedEvidence;
  const graphNeighborRaw = input.graphNeighbor;

  const filePath = parseStringOrUndefined(filePathRaw, `${path}.filePath`);
  const acceptableFiles = isStringArray(acceptableFilesRaw) ? acceptableFilesRaw : undefined;
  const gradedEvidence = parseGradedEvidence(gradedEvidenceRaw, `${path}.gradedEvidence`);
  const graphNeighbor = parseExpectedGraphNeighbor(graphNeighborRaw, `${path}.graphNeighbor`);

  const expectedOutcome = parseExpectedOutcome(expectedOutcomeRaw, `${path}.expectedOutcome`);
  if (
    expectedOutcome !== "no-results" &&
    !filePath &&
    (!acceptableFiles || acceptableFiles.length === 0) &&
    gradedEvidence.length === 0
  ) {
    throw new Error(
      `${path} must include expected.filePath, expected.acceptableFiles, or expected.gradedEvidence`
    );
  }

  if (acceptableFilesRaw !== undefined && !isStringArray(acceptableFilesRaw)) {
    throw new Error(`${path}.acceptableFiles must be an array of strings`);
  }

  if (symbolRaw !== undefined && typeof symbolRaw !== "string") {
    throw new Error(`${path}.symbol must be a string when provided`);
  }

  if (branchRaw !== undefined && typeof branchRaw !== "string") {
    throw new Error(`${path}.branch must be a string when provided`);
  }

  const expectedRoute = parseExpectedRoute(expectedRouteRaw, `${path}.expectedRoute`);
  const recoveryExpectation = parseRecoveryExpectation(
    recoveryExpectationRaw,
    `${path}.recoveryExpectation`
  );

  return {
    filePath,
    acceptableFiles,
    symbol: typeof symbolRaw === "string" ? symbolRaw : undefined,
    branch: typeof branchRaw === "string" ? branchRaw : undefined,
    expectedRoute,
    expectedOutcome,
    recoveryExpectation,
    ...(gradedEvidence.length > 0 ? { gradedEvidence } : {}),
    ...(graphNeighbor !== undefined ? { graphNeighbor } : {}),
  };
}

function parseQueryLanguage(value: unknown, path: string): string | undefined {
  return parseStringOrUndefined(value, path);
}

function parseQuery(input: unknown, index: number): GoldenQuery {
  const path = `queries[${index}]`;
  if (!isRecord(input)) {
    throw new Error(`${path} must be an object`);
  }

  const id = input.id;
  const query = input.query;
  const queryType = input.queryType;
  const retrievalMode = input.retrievalMode;
  const expected = input.expected;
  const language = input.language;
  const difficulty = input.difficulty;
  const tags = input.tags;
  const args = input.args;

  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`${path}.id must be a non-empty string`);
  }

  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error(`${path}.query must be a non-empty string`);
  }

  return {
    id,
    query,
      queryType: parseQueryType(queryType, `${path}.queryType`),
      retrievalMode: parseRetrievalMode(retrievalMode, `${path}.retrievalMode`),
      language: parseQueryLanguage(language, `${path}.language`),
      difficulty: parseQueryDifficulty(difficulty, `${path}.difficulty`),
      args: parseQueryArgs(args, `${path}.args`),
      tags: parseQueryTags(tags, `${path}.tags`),
      expected: parseExpected(expected, `${path}.expected`),
    };
  }

export function parseGoldenDataset(raw: unknown, sourceLabel: string): GoldenDataset {
  if (!isRecord(raw)) {
    throw new Error(`${sourceLabel} must be a JSON object`);
  }

  const version = raw.version;
  const name = raw.name;
  const description = raw.description;
  const queriesRaw = raw.queries;

  const validatedVersion = parseSemanticVersion(version, `${sourceLabel}.version`);

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`${sourceLabel}.name must be a non-empty string`);
  }

  if (description !== undefined && typeof description !== "string") {
    throw new Error(`${sourceLabel}.description must be a string when provided`);
  }

  if (!Array.isArray(queriesRaw)) {
    throw new Error(`${sourceLabel}.queries must be an array`);
  }

  if (queriesRaw.length === 0) {
    throw new Error(`${sourceLabel}.queries must contain at least one query`);
  }

  const queries = queriesRaw.map((query, idx) => parseQuery(query, idx));
  const idSet = new Set<string>();

  for (const query of queries) {
    if (idSet.has(query.id)) {
      throw new Error(`${sourceLabel}.queries has duplicate id: ${query.id}`);
    }
    idSet.add(query.id);
  }

  return {
    version: validatedVersion,
    name,
    description: typeof description === "string" ? description : undefined,
    queries,
  };
}

export function loadGoldenDataset(datasetPath: string): GoldenDataset {
  const parsed = parseJsonFile(datasetPath);
  return parseGoldenDataset(parsed, datasetPath);
}

function parseThresholdValue(
  value: unknown,
  fieldName: string,
  sourceLabel: string
): number | undefined {
  return value === undefined
    ? undefined
    : asPositiveNumber(value, `${sourceLabel}.thresholds.${fieldName}`);
}

export function parseBudget(raw: unknown, sourceLabel: string): EvalBudget {
  if (!isRecord(raw)) {
    throw new Error(`${sourceLabel} must be a JSON object`);
  }

  const name = raw.name;
  const baselinePath = raw.baselinePath;
  const failOnMissingBaseline = raw.failOnMissingBaseline;
  const thresholds = raw.thresholds;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`${sourceLabel}.name must be a non-empty string`);
  }

  if (baselinePath !== undefined && typeof baselinePath !== "string") {
    throw new Error(`${sourceLabel}.baselinePath must be a string when provided`);
  }

  if (!isRecord(thresholds)) {
    throw new Error(`${sourceLabel}.thresholds must be an object`);
  }

  return {
    name,
    baselinePath: typeof baselinePath === "string" ? baselinePath : undefined,
    failOnMissingBaseline:
      typeof failOnMissingBaseline === "boolean" ? failOnMissingBaseline : true,
    thresholds: {
      hitAt5MaxDrop: parseThresholdValue(
        thresholds.hitAt5MaxDrop,
        "hitAt5MaxDrop",
        sourceLabel
      ),
      mrrAt10MaxDrop: parseThresholdValue(
        thresholds.mrrAt10MaxDrop,
        "mrrAt10MaxDrop",
        sourceLabel
      ),
      rawDistinctTop3RatioMaxDrop: parseThresholdValue(
        thresholds.rawDistinctTop3RatioMaxDrop,
        "rawDistinctTop3RatioMaxDrop",
        sourceLabel
      ),
      p95LatencyMaxMultiplier: parseThresholdValue(
        thresholds.p95LatencyMaxMultiplier,
        "p95LatencyMaxMultiplier",
        sourceLabel
      ),
      p95LatencyMaxAbsoluteMs: parseThresholdValue(
        thresholds.p95LatencyMaxAbsoluteMs,
        "p95LatencyMaxAbsoluteMs",
        sourceLabel
      ),
      minHitAt5: parseThresholdValue(thresholds.minHitAt5, "minHitAt5", sourceLabel),
      minMrrAt10: parseThresholdValue(thresholds.minMrrAt10, "minMrrAt10", sourceLabel),
      minRawDistinctTop3Ratio: parseThresholdValue(
        thresholds.minRawDistinctTop3Ratio,
        "minRawDistinctTop3Ratio",
        sourceLabel
      ),
      minGraphNeighborRecall: parseThresholdValue(
        thresholds.minGraphNeighborRecall,
        "minGraphNeighborRecall",
        sourceLabel
      ),
      minRouteAccuracy: parseThresholdValue(
        thresholds.minRouteAccuracy,
        "minRouteAccuracy",
        sourceLabel
      ),
      minOutcomeAccuracy: parseThresholdValue(
        thresholds.minOutcomeAccuracy,
        "minOutcomeAccuracy",
        sourceLabel
      ),
      maxContextResponseTokensAverage: parseThresholdValue(
        thresholds.maxContextResponseTokensAverage,
        "maxContextResponseTokensAverage",
        sourceLabel
      ),
      maxContextResponseTokensP95: parseThresholdValue(
        thresholds.maxContextResponseTokensP95,
        "maxContextResponseTokensP95",
        sourceLabel
      ),
      maxContextResponseTokensMax: parseThresholdValue(
        thresholds.maxContextResponseTokensMax,
        "maxContextResponseTokensMax",
        sourceLabel
      ),
      maxContextDuplicateCandidateRatio: parseThresholdValue(
        thresholds.maxContextDuplicateCandidateRatio,
        "maxContextDuplicateCandidateRatio",
        sourceLabel
      ),
      minContextSelectedFileRatio: parseThresholdValue(
        thresholds.minContextSelectedFileRatio,
        "minContextSelectedFileRatio",
        sourceLabel
      ),
      minContextHitAt5Per1kResponseTokens: parseThresholdValue(
        thresholds.minContextHitAt5Per1kResponseTokens,
        "minContextHitAt5Per1kResponseTokens",
        sourceLabel
      ),
      minContextMrrAt10Per1kResponseTokens: parseThresholdValue(
        thresholds.minContextMrrAt10Per1kResponseTokens,
        "minContextMrrAt10Per1kResponseTokens",
        sourceLabel
      ),
    },
  };
}

export function loadBudget(budgetPath: string): EvalBudget {
  const parsed = parseJsonFile(budgetPath);
  return parseBudget(parsed, budgetPath);
}
