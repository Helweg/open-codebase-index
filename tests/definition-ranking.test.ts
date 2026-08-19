import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyzeQueryIntent } from "../src/indexer/intent-aware-ranking.js";
import { vi } from "vitest";
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
import { Indexer } from "../src/indexer/index.js";
import { parseConfig } from "../src/config/schema.js";
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

  it("prefers same-name exact candidates whose module path matches the requested identifier", () => {
    const matchesModule = candidate("module", "examples/error/index.js", "error", "function_declaration", 0.5);
    const matchesDifferentModule = candidate("other", "lib/other/error-utils/index.ts", "error", "function_declaration", 0.9);

    const ranked = buildDeterministicIdentifierPass(
      "where is error implementation",
      [matchesDifferentModule, matchesModule],
      5,
    );

    expect(ranked.map((entry) => entry.id)).toEqual(["module", "other"]);
  });

  it("keeps explicit file-path-hinted candidates above module-affinity candidates", () => {
    const hinted = candidate("hinted", "src/error/index.js", "error", "function_declaration", 0.2);
    const sameNameWithAffinity = candidate("affine", "packages/error/utils/index.js", "error", "function_declaration", 0.95);

    const ranked = buildDeterministicIdentifierPass(
      "where is error implementation in src/error/index.js",
      [sameNameWithAffinity, hinted],
      5,
    );

    expect(ranked.map((entry) => entry.id)).toEqual(["hinted", "affine"]);
    expect(ranked[0]?.score).toBe(0.995);
  });

  it("does not promote partial identifier matches above exact identifier matches", () => {
    const exact = candidate("exact", "services/error.ts", "error", "function_declaration", 0.1);
    const partial = candidate("partial", "examples/error/index.js", "errorCode", "function_declaration", 0.99);

    const ranked = buildDeterministicIdentifierPass(
      "where is error implementation",
      [partial, exact],
      5,
    );

    expect(ranked.map((entry) => entry.id)).toEqual(["exact", "partial"]);
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

  it("finds definition results in a scoped fixture directory when definitionIntent includes fileType and directory", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "definition-ranking-search-"));
    const fixtureDir = path.join(__dirname, "fixtures", "call-graph");
    const fixtureSource = path.join(fixtureDir, "php-simple-calls.php");
    const targetFile = path.join(tempDir, "tests", "fixtures", "call-graph", "php-simple-calls.php");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(fixtureSource, targetFile);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }

        return {
          embedding: Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997),
        };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 },
      );
    });

    const indexer = new Indexer(tempDir, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
      },
    }), "opencode");

    try {
      await indexer.index();

      const results = await indexer.search("where is helper definition", 10, {
        definitionIntent: true,
        directory: "tests/fixtures/call-graph",
        fileType: "php",
        metadataOnly: true,
        filterByBranch: false,
      });

      expect(results.some((result) => result.filePath === targetFile && result.name === "helper")).toBe(true);
    } finally {
      await indexer.close();
      fetchSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("finds a Ruby module definition when definitionIntent is requested", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "definition-ranking-ruby-"));
    const rubyFilePath = path.join(tempDir, "sinatra.rb");
    const rubyContent = `module Sinatra
  module NotFound
    module Templates
      def self.call
      end
    end
  end
end
`;
    fs.writeFileSync(rubyFilePath, rubyContent, "utf-8");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
      const texts = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      return new Response(
        JSON.stringify({
          data: texts.map(() => ({ embedding: Array.from({ length: 8 }, () => 0.125) })),
          usage: { total_tokens: Math.max(1, texts.length) },
        }),
        { status: 200 },
      );
    });

    const indexer = new Indexer(tempDir, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
      },
    }), "opencode");

    try {
      await indexer.index();

      const results = await indexer.search("where is Templates definition", 10, {
        definitionIntent: true,
        fileType: "rb",
        metadataOnly: true,
        filterByBranch: false,
      });

      expect(results.some((result) =>
        result.name === "Templates" &&
        result.chunkType === "module" &&
        result.filePath === rubyFilePath
      )).toBe(true);
    } finally {
      await indexer.close();
      fetchSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
