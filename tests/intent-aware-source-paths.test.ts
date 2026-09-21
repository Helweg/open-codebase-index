import { describe, expect, it } from "vitest";

import type { RankedCandidate } from "../src/indexer/intent-aware-ranking.js";
import { analyzeQueryIntent, rankIntentAwareCandidates } from "../src/indexer/intent-aware-ranking.js";

function candidate(
  id: string,
  score: number,
  filePath: string,
  chunkType: string,
): RankedCandidate {
  return {
    id,
    score,
    metadata: {
      filePath,
      startLine: 1,
      endLine: 5,
      chunkType,
      language: "typescript",
      hash: id,
    },
  };
}

describe("intent-aware source path preference", () => {
  it("only promotes implementation evidence for an explicit source preference", () => {
    const candidates = [
      candidate("test", 0.82, "tests/search-ranking.test.ts", "function"),
      candidate("source", 0.55, "src/indexer/search-ranking.ts", "function"),
    ];
    const query = "explain how semantic and keyword rankings are combined";

    expect(rankIntentAwareCandidates(query, candidates, candidates.length).map(({ id }) => id))
      .toEqual(["test", "source"]);
    expect(rankIntentAwareCandidates(query, candidates, candidates.length, { prioritizeSourcePaths: true }).map(({ id }) => id))
      .toEqual(["source", "test"]);
  });

  it.each([
    ["how does the indexer combine semantic and keyword rankings", "implementation"],
    ["where does the client merge request configuration", "config"],
    ["how do I configure a custom embedding provider", "docs"],
    ["how can I add a nested command", "docs"],
    ["how does authentication work conceptually", "conceptual"],
  ])("classifies natural artifact grammar without weakening guardrails: %s", (query, primary) => {
    expect(analyzeQueryIntent(query)).toMatchObject({ primary });
  });

  it("prefers implementation source for natural mechanism-location questions", () => {
    const candidates = [
      candidate("guide", 0.95, "docs/search-ranking.md", "other"),
      candidate("tests", 0.7, "tests/search-ranking.test.ts", "function"),
      candidate("source", 0.55, "src/indexer/search-ranking.ts", "function"),
    ];

    expect(rankIntentAwareCandidates(
      "how does the indexer combine semantic and keyword rankings",
      candidates,
      candidates.length,
    ).map(({ id }) => id)).toEqual(["source", "guide", "tests"]);

    const clientCandidates = [
      candidate("guide", 0.72, "docs/client-usage.md", "other"),
      candidate("source", 0.55, "src/client/request.ts", "function"),
    ];
    expect(rankIntentAwareCandidates(
      "where does the client merge request configuration",
      clientCandidates,
      clientCandidates.length,
    ).map(({ id }) => id)).toEqual(["source", "guide"]);
  });

  it("prefers documentation for natural first-person usage questions", () => {
    const candidates = [
      candidate("source", 0.8, "src/providers/embedding-provider.ts", "function"),
      candidate("guide", 0.65, "docs/configuration.md", "other"),
      candidate("registry", 0.6, "src/commands/registry.ts", "function"),
    ];

    expect(rankIntentAwareCandidates(
      "how do I configure a custom embedding provider",
      candidates,
      candidates.length,
    ).map(({ id }) => id)).toEqual(["guide", "source", "registry"]);

    const commandCandidates = [
      candidate("registry", 0.8, "src/commands/registry.ts", "function"),
      candidate("tutorial", 0.65, "README.md", "other"),
    ];
    expect(rankIntentAwareCandidates(
      "how can I add a nested command",
      commandCandidates,
      commandCandidates.length,
    ).map(({ id }) => id)).toEqual(["tutorial", "registry"]);
  });

  it("keeps explicit artifact precedence above natural grammar", () => {
    expect(analyzeQueryIntent("how do I find tests for the client")).toMatchObject({
      primary: "test",
      preferSourcePaths: false,
    });
    expect(analyzeQueryIntent("how does the config call graph work")).toMatchObject({
      primary: "config",
      preferSourcePaths: false,
    });
    expect(analyzeQueryIntent("how does the client call flow work")).toMatchObject({
      primary: "call-flow",
      preferSourcePaths: true,
    });
    expect(analyzeQueryIntent("how does the client definition work")).toMatchObject({
      primary: "definition",
      preferSourcePaths: true,
    });
  });
});
