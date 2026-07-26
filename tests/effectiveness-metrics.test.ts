import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import {
  EFFECTIVENESS_HOST_MODES,
  EFFECTIVENESS_OUTCOMES,
  EFFECTIVENESS_SCOPE_RELAXATION_BUCKETS,
  EFFECTIVENESS_TOOL_ROUTES,
  MAX_EFFECTIVENESS_COUNTER,
  type EffectivenessMetricEvent,
} from "../src/utils/effectiveness-metrics.js";
import { Logger } from "../src/utils/logger.js";

const tempDirectories: string[] = [];

function enabledLogger(): Logger {
  return new Logger({
    enabled: true,
    logLevel: "debug",
    logSearch: false,
    logEmbedding: false,
    logCache: false,
    logGc: false,
    logBranch: false,
    metrics: true,
    effectivenessMetrics: true,
  });
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("privacy-safe effectiveness metrics", () => {
  it("is disabled by default and requires explicit debug-local opt-in", () => {
    const defaults = parseConfig(undefined);
    expect(defaults.debug.enabled).toBe(false);
    expect(defaults.debug.effectivenessMetrics).toBe(false);

    const logger = new Logger({
      ...defaults.debug,
      enabled: true,
      metrics: true,
    });
    logger.recordEffectiveness({
      route: "peek",
      host: "opencode",
      outcome: "success",
      resultCount: 1,
    });

    expect(logger.getEffectivenessMetrics().totalCalls).toBe(0);
    expect(logger.formatMetrics()).toContain("Privacy-safe effectiveness: disabled");
  });

  it("records only fixed-cardinality counters and histograms", () => {
    const logger = enabledLogger();
    logger.recordEffectiveness({
      route: "context-conceptual",
      host: "opencode",
      outcome: "success",
      recoveryUsed: true,
      resultCount: 7,
      latencyMs: 75,
      tokenBudget: 1200,
      returnedTokenEstimate: 640,
      exactHandoffEmitted: true,
      scopeRelaxation: "both",
    });
    logger.recordEffectiveness({
      route: "search",
      host: "pi",
      outcome: "no-result",
      resultCount: 0,
      latencyMs: 1200,
      returnedTokenEstimate: 16,
    });

    const metrics = logger.getEffectivenessMetrics();
    expect(metrics.schemaVersion).toBe(1);
    expect(metrics.retention).toEqual({
      storage: "memory-only",
      lifetime: "process",
      reset: "index_metrics-reset-or-process-exit",
      maxCounterValue: MAX_EFFECTIVENESS_COUNTER,
    });
    expect(metrics.totalCalls).toBe(2);
    expect(metrics.toolRoute["context-conceptual"]).toBe(1);
    expect(metrics.toolRoute.search).toBe(1);
    expect(metrics.hostMode.opencode).toBe(1);
    expect(metrics.hostMode.pi).toBe(1);
    expect(metrics.outcome.success).toBe(1);
    expect(metrics.outcome["no-result"]).toBe(1);
    expect(metrics.recoveryUsed.yes).toBe(1);
    expect(metrics.resultCount["6-10"]).toBe(1);
    expect(metrics.resultCount["0"]).toBe(1);
    expect(metrics.latency["50-199ms"]).toBe(1);
    expect(metrics.latency["1s+"]).toBe(1);
    expect(metrics.tokenBudget["1200-1999"]).toBe(1);
    expect(metrics.tokenBudget.none).toBe(1);
    expect(metrics.returnedTokenEstimate["512-1199"]).toBe(1);
    expect(metrics.returnedTokenEstimate["1-127"]).toBe(1);
    expect(metrics.exactHandoffEmitted.yes).toBe(1);
    expect(metrics.scopeRelaxation.both).toBe(1);

    expect(Object.keys(metrics.toolRoute)).toEqual(EFFECTIVENESS_TOOL_ROUTES);
    expect(Object.keys(metrics.hostMode)).toEqual(EFFECTIVENESS_HOST_MODES);
    expect(Object.keys(metrics.outcome)).toEqual(EFFECTIVENESS_OUTCOMES);
    expect(Object.keys(metrics.scopeRelaxation)).toEqual(EFFECTIVENESS_SCOPE_RELAXATION_BUCKETS);
    expect(logger.formatMetrics()).toContain("Privacy-safe effectiveness (schema v1)");
    expect(logger.formatMetrics()).toContain("memory-only, process-lifetime");
  });

  it("is concurrency-safe for interleaved Promise completions", async () => {
    const logger = enabledLogger();
    await Promise.all(Array.from({ length: 500 }, async (_, index) => {
      await Promise.resolve();
      logger.recordEffectiveness({
        route: index % 2 === 0 ? "peek" : "search",
        host: "jcode",
        outcome: "success",
        resultCount: index % 3,
        latencyMs: index % 250,
        returnedTokenEstimate: index,
      });
    }));

    const metrics = logger.getEffectivenessMetrics();
    expect(metrics.totalCalls).toBe(500);
    expect(metrics.toolRoute.peek).toBe(250);
    expect(metrics.toolRoute.search).toBe(250);
    expect(metrics.hostMode.jcode).toBe(500);
    expect(metrics.outcome.success).toBe(500);
    expect(Object.values(metrics.resultCount).reduce((sum, count) => sum + count, 0)).toBe(500);
  });

  it("drops adversarial content and identifiers from snapshots, logs, formatted output, and persisted snapshots", () => {
    const logger = enabledLogger();
    const secrets = [
      "sk-live-DO_NOT_PERSIST-123456",
      "秘密🔐-δοκιμή-निजी",
      "/Users/alice/SuperSecretRepo/src/passwords.ts",
      "RepositoryNameThatMustNotPersist",
      "stable-user-550e8400-e29b-41d4-a716-446655440000",
      "SensitiveSymbolName",
      "const PRIVATE_SOURCE = 'never persist me';",
      "Q".repeat(20_000),
    ];
    const adversarialEvent = {
      route: secrets[0],
      host: secrets[1],
      outcome: secrets[2],
      recoveryUsed: true,
      resultCount: Number.MAX_SAFE_INTEGER,
      latencyMs: Number.POSITIVE_INFINITY,
      tokenBudget: Number.NaN,
      returnedTokenEstimate: Number.MAX_SAFE_INTEGER,
      exactHandoffEmitted: true,
      scopeRelaxation: secrets[3],
      query: secrets[4],
      sourceCode: secrets[5],
      symbol: secrets[6],
      filePath: secrets[7],
      repositoryName: secrets[3],
      stableIdentifier: secrets[4],
    } as unknown as EffectivenessMetricEvent;

    logger.recordEffectiveness(adversarialEvent);

    const serialized = JSON.stringify({
      metrics: logger.getEffectivenessMetrics(),
      logs: logger.getLogs(),
      output: logger.formatMetrics(),
    });
    const directory = mkdtempSync(path.join(os.tmpdir(), "effectiveness-privacy-"));
    tempDirectories.push(directory);
    const persistedPath = path.join(directory, "snapshot.json");
    writeFileSync(persistedPath, serialized, "utf8");
    const persisted = readFileSync(persistedPath, "utf8");

    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
      expect(persisted).not.toContain(secret);
    }
    expect(logger.getLogs()).toEqual([]);
    expect(logger.getEffectivenessMetrics().toolRoute.other).toBe(1);
    expect(logger.getEffectivenessMetrics().hostMode.other).toBe(1);
    expect(logger.getEffectivenessMetrics().outcome.error).toBe(1);
    expect(logger.getEffectivenessMetrics().scopeRelaxation.none).toBe(1);
  });

  it("resets operational and effectiveness metrics together", () => {
    const logger = enabledLogger();
    logger.recordCacheHit();
    logger.recordEffectiveness({
      route: "peek",
      host: "claude",
      outcome: "success",
      resultCount: 2,
    });

    logger.resetMetrics();

    expect(logger.getMetrics().cacheHits).toBe(0);
    expect(logger.getEffectivenessMetrics().totalCalls).toBe(0);
    expect(Object.values(logger.getEffectivenessMetrics().toolRoute).every((count) => count === 0)).toBe(true);
  });
});
