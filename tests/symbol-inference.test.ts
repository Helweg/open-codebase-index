import { describe, it, expect } from "vitest";

import { inferExactSymbolFromQuery } from "../src/tools/symbol-inference.js";

describe("inferExactSymbolFromQuery", () => {
  it("infers a backticked identifier", () => {
    expect(inferExactSymbolFromQuery("Where is `getStatus` defined?"))
      .toBe("getStatus");
  });

  it("infers a quoted identifier", () => {
    expect(inferExactSymbolFromQuery("Where is 'rerankResults' defined?"))
      .toBe("rerankResults");
  });

  it("infers camelCase identifier from definition-style language", () => {
    expect(inferExactSymbolFromQuery("where is function getStatus defined"))
      .toBe("getStatus");
  });

  it("infers PascalCase and snake_case candidates", () => {
    expect(inferExactSymbolFromQuery("Where is the Indexer class defined?"))
      .toBe("Indexer");
    expect(inferExactSymbolFromQuery("Definition for RerankResults"))
      .toBe("RerankResults");
    expect(inferExactSymbolFromQuery("Find definition for rerank_results"))
      .toBe("rerank_results");
  });

  it("does not infer ambiguous or non-symbol queries", () => {
    expect(inferExactSymbolFromQuery("find where auth logic is handled"))
      .toBeUndefined();
    expect(inferExactSymbolFromQuery("get status then define"))
      .toBeUndefined();
    expect(inferExactSymbolFromQuery("compare getStatus and forceIndex definitions"))
      .toBeUndefined();
  });
});
