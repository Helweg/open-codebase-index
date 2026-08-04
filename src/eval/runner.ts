import * as crypto from "node:crypto";
import { existsSync } from "fs";
import * as path from "path";
import { performance } from "perf_hooks";

import { Indexer, type SearchResult } from "../indexer/index.js";
import type { CallEdgeData, SymbolData } from "../native/index.js";
import { DEFAULT_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT } from "../tools/contracts.js";
import { resolveSearchContext } from "../tools/context.js";
import { resolveCodebaseEditContextWithDependencies } from "../tools/edit-context.js";
import {
  getCallGraphDataForIndexer,
  type CallGraphDataResult,
  type CallGraphSymbolResolution,
} from "../tools/operations.js";
import { DEFAULT_CONTEXT_PACK_TOKEN_BUDGET } from "../tools/utils.js";

import { evaluateBudgetGate } from "./budget.js";
import { compareSummaries } from "./compare.js";
import { buildPerQueryResult, computeEvalMetrics } from "./metrics.js";
import {
  clearIndexRoot,
  ensureLocalEvalProjectConfig,
  getEmbeddingCostPer1MTokens,
  loadParsedConfig,
  resolveSearchConfig,
  toAbsolute,
} from "./runner-config.js";
import {
  createSummaryMarkdown,
  createRunDirectory,
  loadSummary,
  writeJson,
  writeText,
  buildPerQueryArtifact,
} from "./reports.js";
import { loadBudget, loadGoldenDataset } from "./schema.js";
import type {
  EvalComparison,
  EvalGateResult,
  EvalRunOptions,
  EvalSearchResult,
  GoldenDataset,
  GoldenQuery,
  EvalSummary,
  PerQueryEvalResult,
  SweepAggregateReport,
  SweepDefinition,
  SweepRunSummary,
} from "./types.js";

function normalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForFingerprint(entry));
  }

  if (value && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const normalizedValue = normalizeForFingerprint((value as Record<string, unknown>)[key]);
      if (normalizedValue !== undefined) {
        normalized[key] = normalizedValue;
      }
    }

    return normalized;
  }

  return value;
}

function buildDatasetFingerprint(dataset: GoldenDataset): string {
  const canonical = JSON.stringify(normalizeForFingerprint(dataset));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function pathsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizedPath(left);
  const normalizedRight = normalizedPath(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.endsWith(`/${normalizedRight}`)
    || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function toEvalSearchResult(result: SearchResult): EvalSearchResult {
  return {
    filePath: result.filePath,
    startLine: result.startLine,
    endLine: result.endLine,
    score: result.score,
    chunkType: result.chunkType,
    name: result.name,
  };
}

function selectResolvedTarget(
  definitions: SearchResult[],
  resolution: CallGraphSymbolResolution | undefined,
): SearchResult | undefined {
  if (resolution?.status !== "resolved") return definitions[0];
  return definitions.find((result) => pathsMatch(result.filePath, resolution.filePath)
    && result.startLine <= resolution.startLine
    && result.endLine >= resolution.startLine)
    ?? definitions.find((result) => pathsMatch(result.filePath, resolution.filePath)
      && result.name === resolution.name)
    ?? definitions[0];
}

function callerResult(edge: CallEdgeData): EvalSearchResult | undefined {
  if (!edge.fromSymbolFilePath) return undefined;
  return {
    filePath: edge.fromSymbolFilePath,
    startLine: edge.line,
    endLine: edge.line,
    score: 0,
    chunkType: "graph-caller",
    name: edge.fromSymbolName,
    graphDirection: "caller",
  };
}

function calleeResult(edge: CallEdgeData, symbols: SymbolData[]): EvalSearchResult | undefined {
  const symbol = edge.toSymbolId
    ? symbols.find((candidate) => candidate.id === edge.toSymbolId)
    : symbols.filter((candidate) => candidate.name === edge.targetName).length === 1
      ? symbols.find((candidate) => candidate.name === edge.targetName)
      : undefined;
  if (!symbol) return undefined;
  return {
    filePath: symbol.filePath,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    score: 0,
    chunkType: "graph-callee",
    name: symbol.name,
    graphDirection: "callee",
  };
}

async function runEditContextQuery(
  indexer: Indexer,
  projectRoot: string,
  query: GoldenQuery,
): Promise<{
  results: EvalSearchResult[];
  resolvedRoute: "search" | "definition";
  routedQuery: string;
  context: {
    tokenBudget: number;
    responseTokens: number;
    candidateCount: number;
    deduplicatedCount: number;
    omittedCount: number;
  };
}> {
  let definitions: SearchResult[] = [];
  let conceptual: SearchResult[] = [];
  let callers: CallGraphDataResult | undefined;
  let callees: CallGraphDataResult | undefined;

  const editContext = await resolveCodebaseEditContextWithDependencies({
    query: query.query,
    symbol: query.args?.symbol,
    filePath: query.args?.filePath ?? query.expected.filePath,
    callerLimit: query.args?.callerLimit,
    calleeLimit: query.args?.calleeLimit,
    tokenBudget: query.args?.tokenBudget,
  }, {
    searchCodebase: async (searchQuery, options) => {
      conceptual = await indexer.search(searchQuery, options?.limit, {
        filterByBranch: !!query.expected.branch,
      });
      return conceptual;
    },
    implementationLookup: async (symbol, options) => {
      definitions = await indexer.search(symbol, options?.limit, {
        filterByBranch: !!query.expected.branch,
        definitionIntent: true,
      });
      return definitions;
    },
    getCallGraphData: async (params) => {
      const result = await getCallGraphDataForIndexer(indexer, projectRoot, params);
      if (params.direction === "callers") callers = result;
      else callees = result;
      return result;
    },
  });

  const resolution = callers?.resolution;
  const target = selectResolvedTarget(definitions, resolution);
  const targetCandidates = target ? [target] : [...definitions, ...conceptual];
  const results = targetCandidates
    .filter((candidate) => (
      resolution?.status !== "resolved" || editContext.details.sourceIncluded
    ) && editContext.text.includes(
      `${candidate.filePath}:${candidate.startLine}-${candidate.endLine}`,
    ))
    .map(toEvalSearchResult);

  if (query.expected.graphNeighbor) {
    const symbols = await indexer.getCallGraphSymbols();
    const callerLimit = query.args?.callerLimit ?? DEFAULT_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT;
    const calleeLimit = query.args?.calleeLimit ?? DEFAULT_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT;
    const publishedCallers = (callers?.callers ?? []).slice(0, callerLimit).filter((edge) =>
      editContext.text.includes(
        `${edge.fromSymbolName ?? "<unknown>"} at ${edge.fromSymbolFilePath ?? "<unknown file>"}:${edge.line} (${edge.callType}, ${edge.isResolved ? "resolved" : "unresolved"})`,
      ));
    const publishedCallees = (callees?.callees ?? []).slice(0, calleeLimit).filter((edge) =>
      resolution?.status === "resolved"
      && editContext.text.includes(
        `${edge.targetName} from ${resolution.filePath}:${edge.line} (${edge.callType}, ${edge.isResolved ? "resolved" : "unresolved"})`,
      ));
    results.push(
      ...publishedCallers.map(callerResult).filter((item): item is EvalSearchResult => item !== undefined),
      ...publishedCallees.map((edge) => calleeResult(edge, symbols)).filter((item): item is EvalSearchResult => item !== undefined),
    );
  }

  return {
    results,
    resolvedRoute: resolution?.status === "resolved" ? "definition" : "search",
    routedQuery: query.args?.symbol ?? query.query,
    context: {
      tokenBudget: editContext.details.tokenBudget,
      responseTokens: editContext.details.tokenEstimate,
      candidateCount: results.length,
      deduplicatedCount: results.length,
      omittedCount: 0,
    },
  };
}

export interface EvalRunResult {
  outputDir: string;
  summary: EvalSummary;
  perQuery: PerQueryEvalResult[];
  comparison?: EvalComparison;
  gate?: EvalGateResult;
}

export async function runEvaluation(options: EvalRunOptions): Promise<EvalRunResult> {
  const datasetPath = toAbsolute(options.projectRoot, options.datasetPath);
  const againstPath = options.againstPath ? toAbsolute(options.projectRoot, options.againstPath) : undefined;
  const budgetPath = options.budgetPath ? toAbsolute(options.projectRoot, options.budgetPath) : undefined;

  const dataset = loadGoldenDataset(datasetPath);

  const resolvedEvalConfigPath = options.reindex
    ? ensureLocalEvalProjectConfig(options.projectRoot, options.configPath)
    : options.configPath;

  const parsedConfig = loadParsedConfig(options.projectRoot, resolvedEvalConfigPath);
  const effectiveConfig = resolveSearchConfig(parsedConfig, options.searchOverrides);

  if (options.reindex) {
    clearIndexRoot(options.projectRoot, effectiveConfig.scope);
  }

  const indexer = new Indexer(options.projectRoot, effectiveConfig, "opencode");

  try {
    await indexer.index();

    if (options.ciMode) {
      const indexStatus = await indexer.getStatus();
      if (!indexStatus.indexed || indexStatus.vectorCount === 0) {
        const failedBatchDetails = indexStatus.failedBatchesCount > 0
          ? ` ${indexStatus.failedBatchesCount} embedding batch(es) failed; diagnostics: ${indexStatus.failedBatchesPath ?? "unavailable"}.`
          : "";
        throw new Error(
          `Evaluation reindex produced no searchable vectors.${failedBatchDetails} Check the embedding provider and indexing diagnostics before evaluating retrieval quality.`
        );
      }
    }

    const perQuery: PerQueryEvalResult[] = [];

    for (const query of dataset.queries) {
      if (query.expected.branch && query.expected.branch !== indexer.getCurrentBranch()) {
        throw new Error(
          `Query '${query.id}' expects branch '${query.expected.branch}', but current branch is '${indexer.getCurrentBranch()}'. Switch branch before running this dataset.`
        );
      }

      const start = performance.now();
      const editContextResult = query.retrievalMode === "edit-context"
        ? await runEditContextQuery(indexer, options.projectRoot, query)
        : undefined;
      const contextResult = query.retrievalMode === "context"
        ? await resolveSearchContext({
          query: query.query,
          symbol: query.args?.symbol,
          fileType: query.args?.fileType,
          directory: query.args?.directory,
          limit: 10,
          tokenBudget: DEFAULT_CONTEXT_PACK_TOKEN_BUDGET,
        }, {
          lookup: (symbol, limit, scope) => indexer.search(symbol, limit, {
            metadataOnly: true,
            filterByBranch: !!query.expected.branch,
            definitionIntent: true,
            fileType: scope.fileType,
            directory: scope.directory,
          }),
          search: (searchQuery, limit, scope) => indexer.search(searchQuery, limit, {
            metadataOnly: true,
            filterByBranch: !!query.expected.branch,
            definitionIntent: false,
            fileType: scope.fileType,
            directory: scope.directory,
          }),
        })
        : undefined;
      const result = editContextResult?.results
        ?? contextResult?.details?.results
        ?? await indexer.search(query.query, 10, {
          metadataOnly: true,
          filterByBranch: !!query.expected.branch,
          fileType: query.args?.fileType,
          directory: query.args?.directory,
        });
      const elapsed = performance.now() - start;
      const resolvedRoute = editContextResult?.resolvedRoute
        ?? (contextResult?.details?.route === "definition" ? "definition" : "search");
      const routedQuery = editContextResult?.routedQuery
        ?? contextResult?.details?.routedQuery
        ?? query.query;
      const successfulRecoveryAttempt = contextResult?.details?.recovery?.successfulAttemptIndex;
      const recoveryAttempts = contextResult?.details?.recovery?.attempts ?? [];
      const recoveryRelaxed = successfulRecoveryAttempt === undefined
        ? false
        : (recoveryAttempts[successfulRecoveryAttempt]?.relaxedFields.length ?? 0) > 0;
      const recoveryUsed = recoveryAttempts.length > 1
        || recoveryAttempts.some((attempt) => attempt.relaxedFields.length > 0);

      const materialized: EvalSearchResult[] = result.map((item) => {
        const graphDirection: EvalSearchResult["graphDirection"] = "graphDirection" in item
          && (item.graphDirection === "caller" || item.graphDirection === "callee")
          ? item.graphDirection
          : undefined;
        return {
          filePath: item.filePath,
          startLine: item.startLine,
          endLine: item.endLine,
          score: item.score,
          chunkType: item.chunkType,
          name: item.name,
          graphDirection,
        };
      });

      const contextMeasurement = editContextResult?.context ?? (contextResult?.details ? {
        tokenBudget: contextResult.details.tokenBudget,
        responseTokens: contextResult.details.tokenEstimate,
        candidateCount: contextResult.details.candidateCount ?? 0,
        deduplicatedCount: contextResult.details.deduplicatedCount ?? 0,
        omittedCount: contextResult.details.omittedCount ?? 0,
        recoveryUsed,
        recoveryRelaxed,
      } : undefined);

      perQuery.push(buildPerQueryResult(query, materialized, elapsed, 10, {
        resolvedRoute,
        routedQuery,
      }, contextMeasurement));
    }

    const logger = indexer.getLogger();
    const metricSnapshot = logger.getMetrics();

    const costPer1MTokensUsd = getEmbeddingCostPer1MTokens(effectiveConfig.embeddingProvider);

    const summary: EvalSummary = {
      generatedAt: new Date().toISOString(),
      projectRoot: options.projectRoot,
      datasetPath,
      datasetName: dataset.name,
      datasetVersion: dataset.version,
      datasetFingerprint: buildDatasetFingerprint(dataset),
      queryCount: dataset.queries.length,
      topK: 10,
      searchConfig: {
        fusionStrategy: effectiveConfig.search.fusionStrategy,
        hybridWeight: effectiveConfig.search.hybridWeight,
        rrfK: effectiveConfig.search.rrfK,
        rerankTopN: effectiveConfig.search.rerankTopN,
      },
      metrics: computeEvalMetrics(
        dataset.queries,
        perQuery,
        metricSnapshot.embeddingApiCalls,
        metricSnapshot.embeddingTokensUsed,
        costPer1MTokensUsd
      ),
    };

    const outputDir = createRunDirectory(toAbsolute(options.projectRoot, options.outputRoot));
    const perQueryArtifact = buildPerQueryArtifact(perQuery);

    writeJson(path.join(outputDir, "summary.json"), summary);
    writeJson(path.join(outputDir, "per-query.json"), perQueryArtifact);

    let comparison: EvalComparison | undefined;
    if (againstPath) {
      const baseline = loadSummary(againstPath);
      comparison = compareSummaries(summary, baseline, againstPath);
      writeJson(path.join(outputDir, "compare.json"), comparison);
    }

    let gate: EvalGateResult | undefined;
    if (options.ciMode) {
      if (!budgetPath) {
        throw new Error("CI mode requires --budget path");
      }
      const budget = loadBudget(budgetPath);

      if (!comparison && budget.baselinePath) {
        const resolvedBaseline = toAbsolute(options.projectRoot, budget.baselinePath);
        if (existsSync(resolvedBaseline)) {
          const baselineSummary = loadSummary(resolvedBaseline);
          comparison = compareSummaries(summary, baselineSummary, resolvedBaseline);
          writeJson(path.join(outputDir, "compare.json"), comparison);
        } else if (budget.failOnMissingBaseline) {
          throw new Error(
            `Budget baseline is missing: ${resolvedBaseline}. Set failOnMissingBaseline=false to allow CI run without baseline.`
          );
        }
      }

      gate = evaluateBudgetGate(budget, summary, comparison);
    }

    const markdown = createSummaryMarkdown(summary, comparison, gate);
    writeText(path.join(outputDir, "summary.md"), markdown);

    return { outputDir, summary, perQuery, comparison, gate };
  } finally {
    await indexer.close();
  }
}

export async function runSweep(
  options: EvalRunOptions,
  sweep: SweepDefinition
): Promise<{ outputDir: string; aggregate: SweepAggregateReport }> {
  const fusionValues: Array<"rrf" | "weighted" | undefined> =
    sweep.fusionStrategy && sweep.fusionStrategy.length > 0
      ? [...sweep.fusionStrategy]
      : [undefined];
  const weightValues: Array<number | undefined> =
    sweep.hybridWeight && sweep.hybridWeight.length > 0 ? [...sweep.hybridWeight] : [undefined];
  const rrfValues: Array<number | undefined> =
    sweep.rrfK && sweep.rrfK.length > 0 ? [...sweep.rrfK] : [undefined];
  const rerankValues: Array<number | undefined> =
    sweep.rerankTopN && sweep.rerankTopN.length > 0 ? [...sweep.rerankTopN] : [undefined];

  const runs: SweepRunSummary[] = [];

  for (const fusion of fusionValues) {
    for (const hybridWeight of weightValues) {
      for (const rrfK of rrfValues) {
        for (const rerankTopN of rerankValues) {
          const run = await runEvaluation({
            ...options,
            searchOverrides: {
              ...(fusion !== undefined ? { fusionStrategy: fusion } : {}),
              ...(hybridWeight !== undefined ? { hybridWeight } : {}),
              ...(rrfK !== undefined ? { rrfK } : {}),
              ...(rerankTopN !== undefined ? { rerankTopN } : {}),
            },
          });

          runs.push({
            searchConfig: run.summary.searchConfig,
            summary: run.summary,
            comparison: run.comparison,
            gate: run.gate,
          });
        }
      }
    }
  }

  const bestByHitAt5 = [...runs].sort(
    (a, b) => b.summary.metrics.hitAt5 - a.summary.metrics.hitAt5
  )[0];
  const bestByMrrAt10 = [...runs].sort(
    (a, b) => b.summary.metrics.mrrAt10 - a.summary.metrics.mrrAt10
  )[0];
  const bestByP95Latency = [...runs].sort(
    (a, b) => a.summary.metrics.latencyMs.p95 - b.summary.metrics.latencyMs.p95
  )[0];

  const outputDir = createRunDirectory(toAbsolute(options.projectRoot, options.outputRoot));
  const failedGateRuns = runs.filter((run) => run.gate && !run.gate.passed).length;
  const gatePassed = failedGateRuns === 0;
  const aggregate: SweepAggregateReport = {
    generatedAt: new Date().toISOString(),
    againstPath: options.againstPath,
    runCount: runs.length,
    runs,
    gatePassed,
    failedGateRuns,
    bestByHitAt5,
    bestByMrrAt10,
    bestByP95Latency,
  };

  writeJson(path.join(outputDir, "compare.json"), aggregate);
  const md = createSummaryMarkdown(
    bestByHitAt5?.summary ?? runs[0].summary,
    bestByHitAt5?.comparison,
    undefined,
    aggregate
  );
  writeText(path.join(outputDir, "summary.md"), md);
  writeJson(path.join(outputDir, "summary.json"), bestByHitAt5?.summary ?? runs[0].summary);

  return { outputDir, aggregate };
}
