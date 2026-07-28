import { execFileSync } from "child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import {
  getIndexLogs,
  getIndexMetrics,
  initializeTools,
  isToolEffectivenessEnabled,
  recordToolEffectiveness,
  refreshIndexerForDirectory,
} from "../src/tools/operations.js";
import {
  EffectivenessMetrics,
  EFFECTIVENESS_HOST_MODES,
  EFFECTIVENESS_LATENCY_BUCKETS,
  EFFECTIVENESS_OUTCOMES,
  EFFECTIVENESS_RESULT_COUNT_BUCKETS,
  EFFECTIVENESS_SCOPE_RELAXATION_BUCKETS,
  EFFECTIVENESS_TOOL_ROUTES,
  EFFECTIVENESS_RETURNED_TOKEN_BUCKETS,
  formatEffectivenessMetrics,
  getProcessEffectivenessMetrics,
  isProcessEffectivenessCollectorAllocated,
  MAX_EFFECTIVENESS_COUNTER,
  resetProcessEffectivenessMetrics,
  type EffectivenessMetricEvent,
} from "../src/utils/effectiveness-metrics.js";
import { Logger } from "../src/utils/logger.js";

const tempDirectories: string[] = [];

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function allFileContents(root: string): string {
  const contents: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const filePath = path.join(directory, name);
      if (statSync(filePath).isDirectory()) visit(filePath);
      else contents.push(readFileSync(filePath, "utf8"));
    }
  };
  visit(root);
  return contents.join("\n");
}

beforeEach(() => {
  resetProcessEffectivenessMetrics();
});

afterEach(() => {
  resetProcessEffectivenessMetrics();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("privacy-safe effectiveness metrics", () => {
  it("is independently opt-in and cannot activate raw logging or persist secret-bearing data", async () => {
    const projectRoot = tempDirectory("effectiveness-privacy-");
    writeFileSync(path.join(projectRoot, "preexisting.txt"), "safe fixture", "utf8");
    const config = parseConfig({ effectivenessMetrics: { enabled: true } });
    initializeTools(projectRoot, config, "jcode");

    const secrets = [
      "sk-live-DO_NOT_PERSIST-123456",
      "秘密🔐-δοκιμή-निजी",
      "/Users/alice/SuperSecretRepo/src/passwords.ts",
      "RepositoryNameThatMustNotPersist",
      "stable-user-550e8400-e29b-41d4-a716-446655440000",
      "SensitiveSymbolName",
      "const PRIVATE_SOURCE = 'never persist me';",
    ];
    recordToolEffectiveness(projectRoot, "jcode", {
      route: secrets[0],
      host: secrets[1],
      outcome: secrets[2],
      scopeRelaxation: secrets[3],
      query: secrets[4],
      symbol: secrets[5],
      sourceCode: secrets[6],
      filePath: secrets[2],
      repositoryName: secrets[3],
      stableIdentifier: secrets[4],
    } as unknown as EffectivenessMetricEvent);

    const logs = await getIndexLogs(projectRoot, "jcode", {});
    const metrics = await getIndexMetrics(projectRoot, "jcode");
    const serializedOutput = JSON.stringify({ logs, metrics });
    const persistedContents = allFileContents(projectRoot);

    expect(config.debug.enabled).toBe(false);
    expect(config.effectivenessMetrics.enabled).toBe(true);
    expect(logs.kind).toBe("disabled");
    expect(metrics.metricsEnabled).toBe(false);
    expect(metrics.effectivenessMetricsEnabled).toBe(true);
    expect(metrics.text).toContain("Privacy-safe effectiveness (schema v3)");
    expect(getProcessEffectivenessMetrics().totalCalls).toBe(1);
    for (const secret of secrets) {
      expect(serializedOutput).not.toContain(secret);
      expect(persistedContents).not.toContain(secret);
    }
  });

  it("preserves explicit debug search logging only when the user separately enables it", () => {
    const legacyNestedOptIn = parseConfig({ debug: { effectivenessMetrics: true } });
    expect(legacyNestedOptIn.debug.enabled).toBe(false);
    expect(legacyNestedOptIn.effectivenessMetrics.enabled).toBe(false);

    const logger = new Logger({
      ...parseConfig(undefined).debug,
      enabled: true,
      logSearch: true,
    });
    logger.search("info", "Search complete", { query: "explicit-debug-query" });

    expect(JSON.stringify(logger.getLogs())).toContain("explicit-debug-query");
  });

  it("tracks fixed-cardinality aggregate and per-route histogram counters", () => {
    const collector = new EffectivenessMetrics();
    collector.record({
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
    collector.record({
      route: "search",
      host: "pi",
      outcome: "no-result",
      resultCount: 0,
      latencyMs: 1200,
      returnedTokenEstimate: 16,
    });

    const metrics = collector.getSnapshot();
    expect(metrics.schemaVersion).toBe(3);
    expect(metrics.retention).toEqual({
      storage: "memory-only",
      lifetime: "process",
      reset: "index_metrics-reset-or-process-exit",
      maxCounterValue: MAX_EFFECTIVENESS_COUNTER,
      dimensions: "bounded-route-and-bucketed-performance-only",
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
    expect(metrics.returnedTokenEstimate["512-1199"]).toBe(1);
    expect(metrics.exactHandoffEmitted.yes).toBe(1);
    expect(metrics.scopeRelaxation.both).toBe(1);

    expect(metrics.routeOutcome["context-conceptual"].success).toBe(1);
    expect(metrics.routeOutcome["search"]["no-result"]).toBe(1);
    expect(metrics.routeLatency["context-conceptual"]["50-199ms"]).toBe(1);
    expect(metrics.routeLatency.search["1s+"]).toBe(1);
    expect(metrics.routeResultCount["context-conceptual"]["6-10"]).toBe(1);
    expect(metrics.routeResultCount.search["0"]).toBe(1);
    expect(metrics.routeReturnedTokenEstimate["context-conceptual"]["512-1199"]).toBe(1);
    expect(metrics.routeReturnedTokenEstimate.search["1-127"]).toBe(1);

    for (const route of EFFECTIVENESS_TOOL_ROUTES) {
      expect(Object.keys(metrics.routeOutcome[route]).sort()).toEqual([...EFFECTIVENESS_OUTCOMES].sort());
      expect(Object.keys(metrics.routeLatency[route]).sort()).toEqual([...EFFECTIVENESS_LATENCY_BUCKETS].sort());
      expect(Object.keys(metrics.routeResultCount[route]).sort()).toEqual(
        [...EFFECTIVENESS_RESULT_COUNT_BUCKETS].sort(),
      );
      expect(Object.keys(metrics.routeReturnedTokenEstimate[route]).sort()).toEqual(
        [...EFFECTIVENESS_RETURNED_TOKEN_BUCKETS].sort(),
      );
    }
    expect(Object.keys(metrics.toolRoute)).toEqual(EFFECTIVENESS_TOOL_ROUTES);
    expect(Object.keys(metrics.hostMode)).toEqual(EFFECTIVENESS_HOST_MODES);
    expect(Object.keys(metrics.outcome)).toEqual(EFFECTIVENESS_OUTCOMES);
    expect(Object.keys(metrics.scopeRelaxation)).toEqual(EFFECTIVENESS_SCOPE_RELAXATION_BUCKETS);
    expect(formatEffectivenessMetrics(metrics)).toContain("bounded-route-and-bucketed-performance-only");
    expect(formatEffectivenessMetrics(metrics)).toContain("Route outcome buckets");
  });

  it("is concurrency-safe for interleaved Promise completions", async () => {
    const collector = new EffectivenessMetrics();
    await Promise.all(Array.from({ length: 500 }, async (_, index) => {
      await Promise.resolve();
      collector.record({
        route: index % 2 === 0 ? "peek" : "search",
        host: "jcode",
        outcome: "success",
        resultCount: index % 3,
        latencyMs: index % 250,
        returnedTokenEstimate: index,
      });
    }));

    const metrics = collector.getSnapshot();
    expect(metrics.totalCalls).toBe(500);
    expect(metrics.toolRoute.peek).toBe(250);
    expect(metrics.toolRoute.search).toBe(250);
    expect(Object.values(metrics.resultCount).reduce((sum, count) => sum + count, 0)).toBe(500);
  });

  it("resets explicitly and a fresh process starts empty", async () => {
    const projectRoot = tempDirectory("effectiveness-reset-");
    const config = parseConfig({ effectivenessMetrics: { enabled: true } });
    initializeTools(projectRoot, config, "jcode");
    recordToolEffectiveness(projectRoot, "jcode", {
      route: "peek",
      host: "jcode",
      outcome: "success",
      resultCount: 1,
    });

    expect(getProcessEffectivenessMetrics().totalCalls).toBe(1);
    const reset = await getIndexMetrics(projectRoot, "jcode", { reset: true });
    expect(reset.text).toContain("Metrics reset.");
    expect(getProcessEffectivenessMetrics().totalCalls).toBe(0);
    expect(isProcessEffectivenessCollectorAllocated()).toBe(false);
    const resetSnapshot = getProcessEffectivenessMetrics();
    for (const route of EFFECTIVENESS_TOOL_ROUTES) {
      expect(Object.values(resetSnapshot.routeOutcome[route]).reduce((sum, value) => sum + value, 0)).toBe(0);
      expect(Object.values(resetSnapshot.routeLatency[route]).reduce((sum, value) => sum + value, 0)).toBe(0);
      expect(Object.values(resetSnapshot.routeResultCount[route]).reduce((sum, value) => sum + value, 0)).toBe(0);
      expect(Object.values(resetSnapshot.routeReturnedTokenEstimate[route]).reduce((sum, value) => sum + value, 0)).toBe(
        0,
      );
    }

    const childOutput = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        "import { getProcessEffectivenessMetrics } from './src/utils/effectiveness-metrics.ts'; console.log(getProcessEffectivenessMetrics().totalCalls);",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    ).trim();
    expect(childOutput).toBe("0");
  });

  it("saturates every counter at its configured cap", () => {
    const metrics = new EffectivenessMetrics(2);
    const event: EffectivenessMetricEvent = {
      route: "peek",
      host: "opencode",
      outcome: "success",
      resultCount: 1,
      latencyMs: 1,
      returnedTokenEstimate: 1,
    };
    metrics.record(event);
    metrics.record(event);
    metrics.record(event);

    const snapshot = metrics.getSnapshot();
    expect(snapshot.retention.maxCounterValue).toBe(2);
    expect(snapshot.totalCalls).toBe(2);
    expect(snapshot.toolRoute.peek).toBe(2);
    expect(snapshot.hostMode.opencode).toBe(2);
    expect(snapshot.outcome.success).toBe(2);
    expect(snapshot.routeOutcome.peek.success).toBe(2);
    expect(snapshot.routeLatency.peek["<10ms"]).toBe(2);
    expect(snapshot.routeResultCount.peek["1"]).toBe(2);
    expect(snapshot.routeReturnedTokenEstimate.peek["1-127"]).toBe(2);
    expect(snapshot.recoveryUsed.no).toBe(2);
    expect(snapshot.resultCount["1"]).toBe(2);
    expect(snapshot.latency["<10ms"]).toBe(2);
    expect(snapshot.tokenBudget.none).toBe(2);
    expect(snapshot.returnedTokenEstimate["1-127"]).toBe(2);
    expect(snapshot.exactHandoffEmitted.no).toBe(2);
    expect(snapshot.scopeRelaxation.none).toBe(2);
  });

  it("does not keep unbounded per-route keys for invalid input", () => {
    const collector = new EffectivenessMetrics();
    collector.record({
      route: "not-a-route" as EffectivenessMetricEvent["route"],
      host: "not-a-host" as EffectivenessMetricEvent["host"],
      outcome: "not-an-outcome" as EffectivenessMetricEvent["outcome"],
      resultCount: 999,
      latencyMs: 999,
      returnedTokenEstimate: 8192,
    });

    const metrics = collector.getSnapshot();
    expect(metrics.toolRoute.other).toBe(1);
    expect(metrics.outcome.error).toBe(1);
    expect(metrics.routeOutcome.other.error).toBe(1);
    expect(metrics.routeLatency.other["200-999ms"]).toBe(1);
    expect(metrics.routeResultCount.other["21+"]).toBe(1);
    expect(metrics.routeReturnedTokenEstimate.other["4000+"]).toBe(1);

    for (const route of EFFECTIVENESS_TOOL_ROUTES) {
      expect(Object.keys(metrics.routeOutcome[route]).sort()).toEqual([...EFFECTIVENESS_OUTCOMES].sort());
      expect(Object.keys(metrics.routeLatency[route]).sort()).toEqual([...EFFECTIVENESS_LATENCY_BUCKETS].sort());
      expect(Object.keys(metrics.routeResultCount[route]).sort()).toEqual([...
        EFFECTIVENESS_RESULT_COUNT_BUCKETS,
      ].sort());
      expect(Object.keys(metrics.routeReturnedTokenEstimate[route]).sort()).toEqual(
        [...EFFECTIVENESS_RETURNED_TOKEN_BUCKETS].sort(),
      );
    }

    const snapshotText = formatEffectivenessMetrics(metrics);
    expect(snapshotText).toContain("Route outcome buckets");
    expect(snapshotText).not.toContain("not-a-route");
    expect(snapshotText).not.toContain("not-a-host");
    expect(snapshotText).not.toContain("not-an-outcome");
  });

  it("keeps the disabled recording path allocation-free with bounded overhead", () => {
    const projectRoot = tempDirectory("effectiveness-disabled-");
    initializeTools(projectRoot, parseConfig(undefined), "jcode");
    expect(isToolEffectivenessEnabled(projectRoot, "jcode")).toBe(false);

    const startedAt = performance.now();
    for (let index = 0; index < 100_000; index++) {
      recordToolEffectiveness(projectRoot, "jcode", {
        route: "peek",
        host: "jcode",
        outcome: "success",
      });
    }
    const elapsedMs = performance.now() - startedAt;

    expect(isProcessEffectivenessCollectorAllocated()).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
  });

  it("survives Indexer/cache replacement used by config refresh without retaining project identity", () => {
    const firstProject = tempDirectory("effectiveness-refresh-a-");
    const secondProject = tempDirectory("effectiveness-refresh-b-");
    const config = parseConfig({ effectivenessMetrics: { enabled: true } });

    initializeTools(firstProject, config, "jcode");
    recordToolEffectiveness(firstProject, "jcode", {
      route: "search",
      host: "jcode",
      outcome: "success",
    });
    refreshIndexerForDirectory(firstProject, "jcode", config);
    initializeTools(secondProject, config, "jcode");
    recordToolEffectiveness(firstProject, "jcode", {
      route: "peek",
      host: "jcode",
      outcome: "no-result",
    });
    recordToolEffectiveness(secondProject, "jcode", {
      route: "context-conceptual",
      host: "jcode",
      outcome: "success",
    });

    const snapshot = getProcessEffectivenessMetrics();
    const serialized = JSON.stringify(snapshot);
    expect(snapshot.totalCalls).toBe(3);
    expect(snapshot.hostMode.jcode).toBe(3);
    expect(snapshot.toolRoute.search).toBe(1);
    expect(snapshot.toolRoute.peek).toBe(1);
    expect(snapshot.toolRoute["context-conceptual"]).toBe(1);
    expect(serialized).not.toContain(firstProject);
    expect(serialized).not.toContain(secondProject);
  });
});
