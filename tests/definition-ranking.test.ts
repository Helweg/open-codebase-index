import { analyzeQueryIntent } from "../src/indexer/intent-aware-ranking.js";
import {
  buildDeterministicIdentifierPass,
  buildIdentifierDefinitionLane,
  classifyExternalRerankBand,
  extractFilePathHint,
  isImplementationChunkType,
  normalizeIdentifierVariants,
  pathMatchesHint,
  splitPathTokens,
  stripFilePathHint,
  tokenizeTextForRanking,
} from "../src/indexer/definition-ranking.js";
import type { RankedCandidate } from "../src/indexer/search-ranking.js";

function candidate(
  id: string,
  filePath: string,
  name: string,
  chunkType = "function_declaration",
  score = 0.5,
): RankedCandidate {
  return {
    id,
    score,
    metadata: {
      filePath,
      startLine: 1,
      endLine: 3,
      chunkType,
      name,
      language: "typescript",
      hash: `hash-${id}`,
    },
  };
}

describe("definition ranking helpers", () => {
  it("extracts, strips, and matches normalized file path hints", () => {
    const query = "where is createSystem implementation in packages/react/src/system.ts";

    expect(extractFilePathHint(query)).toBe("packages/react/src/system.ts");
    expect(stripFilePathHint(query)).toBe("where is createSystem implementation");
    expect(pathMatchesHint("C:\\repo\\packages\\react\\src\\system.ts", "packages/react/src/system.ts")).toBe(true);
  });

  it("normalizes identifier variants across camel, snake, and kebab forms", () => {
    expect(normalizeIdentifierVariants("CreateSystem")).toEqual([
      "createsystem",
      "create_system",
      "create-system",
    ]);
  });

  it("tokenizes ranking text and paths without generic stopwords", () => {
    expect(Array.from(tokenizeTextForRanking("Find the PaymentValidator implementation"))).toEqual([
      "paymentvalidator",
    ]);
    expect(Array.from(splitPathTokens("src/services/payment-validator.ts"))).toEqual([
      "src",
      "services",
      "payment",
      "validator",
      "ts",
    ]);
  });

  it("shares implementation chunk classification with call-graph symbol types", () => {
    expect(isImplementationChunkType("trigger_declaration")).toBe(true);
    expect(isImplementationChunkType("comment")).toBe(false);
  });

  it("prioritizes an exact identifier anchored to the requested file", () => {
    const exact = candidate("exact", "packages/react/src/system.ts", "createSystem", "function_declaration", 0.4);
    const other = candidate("other", "packages/vue/src/system.ts", "createSystem", "function_declaration", 0.9);

    const ranked = buildDeterministicIdentifierPass(
      "where is createSystem implementation in packages/react/src/system.ts",
      [other, exact],
      5,
    );

    expect(ranked.map((entry) => entry.id)).toEqual(["exact", "other"]);
    expect(ranked[0]?.score).toBe(0.995);
  });

  it("builds a definition lane from name and path identifier matches", () => {
    const ranked = buildIdentifierDefinitionLane(
      "find PaymentValidator implementation",
      [
        candidate("docs", "docs/payment.md", "PaymentValidator", "other", 0.9),
        candidate("partial", "src/payment-validator.ts", "Validator", "class_declaration", 0.6),
        candidate("exact", "src/payment.ts", "PaymentValidator", "class_declaration", 0.4),
      ],
      5,
    );

    expect(ranked.map((entry) => entry.id)).toEqual(["exact"]);
    expect(ranked[0]?.score).toBe(0.99);
  });

  it("classifies external rerank evidence according to query intent", () => {
    expect(classifyExternalRerankBand(
      candidate("source", "src/payment.ts", "pay"),
      analyzeQueryIntent("where is payment implemented"),
    )).toBe("implementation");
    expect(classifyExternalRerankBand(
      candidate("docs", "docs/payment.md", "payment", "other"),
      analyzeQueryIntent("find payment documentation"),
    )).toBe("documentation");
    expect(classifyExternalRerankBand(
      candidate("test", "tests/payment.test.ts", "payment test"),
      analyzeQueryIntent("find payment tests"),
    )).toBe("test");
  });
});
