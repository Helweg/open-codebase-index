import { describe, expect, it } from "vitest";

import { buildArchitectureContext } from "../src/tools/architecture-context.js";

describe("architecture_context", () => {
  const communities = [
    { symbolId: "a", symbolName: "Api", filePath: "src/api.ts", communityId: 1, communityLabel: "API", crossCommunityConnections: 1 },
    { symbolId: "b", symbolName: "Store", filePath: "src/store.ts", communityId: 2, communityLabel: "Storage", crossCommunityConnections: 1 },
    { symbolId: "c", symbolName: "Fixture", filePath: "tests/fixture.ts", communityId: 3, communityLabel: "Tests", crossCommunityConnections: 0 },
  ];
  const centrality = [
    { symbolId: "a", symbolName: "Api", filePath: "src/api.ts", callerCount: 2, calleeCount: 1, totalConnections: 3 },
    { symbolId: "b", symbolName: "Store", filePath: "src/store.ts", callerCount: 1, calleeCount: 2, totalConnections: 3 },
  ];
  const couplings = [{ communityA: 1, communityB: 2, count: 2, relationships: [{ fromSymbolId: "a", fromSymbolName: "Api", fromFilePath: "src/api.ts", toSymbolId: "b", toSymbolName: "Store", toFilePath: "src/store.ts" }] }];

  it("is deterministic and cites every architectural claim", () => {
    const first = buildArchitectureContext({}, communities, centrality, couplings);
    const second = buildArchitectureContext({}, communities, centrality, couplings);
    expect(first).toEqual(second);
    expect(first.text).toContain("Api (src/api.ts)");
    expect(first.text).toContain("Api (src/api.ts) -> Store (src/store.ts)");
    expect(first.text).toContain("Recommended next steps");
  });

  it("keeps a directory scope strict and reports sparse graph uncertainty", () => {
    const result = buildArchitectureContext({ directory: "src/missing" }, communities, centrality, couplings);
    expect(result.modules).toEqual([]);
    expect(result.text).toContain("No graph symbols matched the requested scope");
    expect(result.text).not.toContain("Fixture");
  });
});
