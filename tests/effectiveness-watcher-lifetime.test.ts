import type { Indexer } from "../src/indexer/index.js";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import {
  initializeTools,
  recordToolEffectiveness,
} from "../src/tools/operations.js";
import {
  getProcessEffectivenessMetrics,
  resetProcessEffectivenessMetrics,
} from "../src/utils/effectiveness-metrics.js";
import { createWatcherWithIndexer } from "../src/watcher/index.js";

describe("effectiveness metrics across config watcher refresh", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(os.tmpdir(), "effectiveness-watcher-lifetime-"));
    resetProcessEffectivenessMetrics();
  });

  afterEach(() => {
    resetProcessEffectivenessMetrics();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("preserves the process collector when a config change replaces the cached Indexer", async () => {
    const config = parseConfig({ effectivenessMetrics: { enabled: true } });
    initializeTools(projectRoot, config, "jcode");
    recordToolEffectiveness(projectRoot, "jcode", {
      route: "search",
      host: "jcode",
      outcome: "success",
    });
    const configDirectory = path.join(projectRoot, ".codebase-index");
    const configPath = path.join(configDirectory, "config.json");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ effectivenessMetrics: { enabled: true } }));

    const index = vi.fn().mockResolvedValue(undefined);
    const watcherIndexer = { index } as unknown as Indexer;
    const watcher = createWatcherWithIndexer(
      () => watcherIndexer,
      projectRoot,
      config,
      "jcode",
    );

    try {
      await watcher.whenReady();
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(
        configPath,
        JSON.stringify({
          effectivenessMetrics: { enabled: true },
          include: ["src/**/*.ts"],
        }),
      );

      await vi.waitFor(() => expect(index).toHaveBeenCalled(), { timeout: 4000 });
      recordToolEffectiveness(projectRoot, "jcode", {
        route: "peek",
        host: "jcode",
        outcome: "no-result",
      });

      const snapshot = getProcessEffectivenessMetrics();
      expect(snapshot.totalCalls).toBe(2);
      expect(snapshot.toolRoute.search).toBe(1);
      expect(snapshot.toolRoute.peek).toBe(1);
    } finally {
      await watcher.stop();
    }
  });
});
