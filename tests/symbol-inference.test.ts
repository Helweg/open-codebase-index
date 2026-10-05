import { describe, it, expect } from "vitest";

import { inferExactSymbolFromQuery } from "../src/tools/symbol-inference.js";

describe("inferExactSymbolFromQuery", () => {
  it("does not mistake A/B terminology for an exact symbol", () => {
    expect(inferExactSymbolFromQuery("Where is the executable multi-repository agent task A/B runner implemented and how are repositories pinned?"))
      .toBeUndefined();
    expect(inferExactSymbolFromQuery("Where is B defined?"))
      .toBe("B");
  });
  it("does not infer symbols from slash-delimited compound terms", () => {
    expect(inferExactSymbolFromQuery("Where is A/BRunner defined?"))
      .toBeUndefined();
    expect(inferExactSymbolFromQuery("Where is A/B/C defined?"))
      .toBeUndefined();
    expect(inferExactSymbolFromQuery("Where is A/B defined?"))
      .toBeUndefined();
  });

  it("preserves exact and quoted single-symbol inference around slash terms", () => {
    expect(inferExactSymbolFromQuery("Where is B defined?"))
      .toBe("B");
    expect(inferExactSymbolFromQuery("Where is `BRunner` defined?"))
      .toBe("BRunner");
    expect(inferExactSymbolFromQuery("Where is 'BRunner' defined?"))
      .toBe("BRunner");
  });

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

  it.each([
    "How does file walking apply .ignore and .gitignore files, hidden-file filtering, and explicit glob overrides, and where is matching precedence implemented?",
    "Where does Axios merge instance defaults with request options, and where is the merge implementation?",
    "Where is command short help generated, and how are options and arguments formatted?",
    "Where does PaymentValidator apply request validation in the implementation?",
    "explain `getStatus` implementation and error handling",
    "How does payment processing logic handle authorization?",
  ])("does not turn behavior questions into exact symbol routing: %s", (query) => {
    expect(inferExactSymbolFromQuery(query)).toBeUndefined();
  });

  it.each([
    ["PaymentValidator", "PaymentValidator"],
    ["find PaymentValidator implementation", "PaymentValidator"],
    ["where is payment implemented", "payment"],
    ["`payment`", "payment"],
    ["get_name", "get_name"],
    ["api.get_name", "api.get_name"],
    ["where is api.get_name defined", "api.get_name"],
    ["where is Namespace::get_name implemented", "Namespace::get_name"],
  ])("preserves the original spelling of genuine single-operand lookups: %s", (query, expected) => {
    expect(inferExactSymbolFromQuery(query)).toBe(expected);
  });

  it("does not route explicit test, docs, config, or call-flow queries to definition lookup", () => {
    expect(inferExactSymbolFromQuery("tests for `getStatus`"))
      .toBeUndefined();
    expect(inferExactSymbolFromQuery("where is getStatus documentation"))
      .toBeUndefined();
    expect(inferExactSymbolFromQuery("getStatus configuration settings"))
      .toBeUndefined();
    expect(inferExactSymbolFromQuery("who calls getStatus"))
      .toBeUndefined();
  });
});
