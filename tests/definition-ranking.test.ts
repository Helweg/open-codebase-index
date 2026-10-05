import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { analyzeQueryIntent, extractIntentIdentifierHints, isExplicitIdentifierLookup, rankIntentAwareCandidates } from "../src/indexer/intent-aware-ranking.js";
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
import { resolveSearchContext } from "../src/tools/context-search.js";
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
  it("distinguishes explicit identifier lookup from multi-term source prose", () => {
    expect(isExplicitIdentifierLookup("PaymentValidator")).toBe(true);
    expect(isExplicitIdentifierLookup("`PaymentValidator`")).toBe(true);
    expect(isExplicitIdentifierLookup("find `PaymentValidator`")).toBe(true);
    expect(isExplicitIdentifierLookup("where is PaymentValidator defined")).toBe(true);
    expect(isExplicitIdentifierLookup("find PaymentValidator implementation")).toBe(true);
    expect(isExplicitIdentifierLookup("PaymentValidator validates payment requests")).toBe(false);
    expect(isExplicitIdentifierLookup("explain `PaymentValidator` request validation")).toBe(false);
    expect(analyzeQueryIntent("find tests for `PaymentValidator`").preferSourcePaths).toBe(false);
    expect(analyzeQueryIntent("find docs for 'PaymentValidator'").preferSourcePaths).toBe(false);
    expect(isExplicitIdentifierLookup("conceptual view of how a JsonReader token stream is validated")).toBe(false);
  });

  it.each([
    "How does file walking apply .ignore and .gitignore files, hidden-file filtering, and explicit glob overrides, and where is matching precedence implemented?",
    "Where does Axios merge instance defaults with request options, and where is the merge implementation?",
    "Where is command short help generated, and how are options and arguments formatted?",
  ])("does not manufacture identifier operands from ordinary questions: %s", (query) => {
    expect(extractIntentIdentifierHints(query)).toEqual([]);
    expect(isExplicitIdentifierLookup(query)).toBe(false);
    const evidence = candidate("behavior", "src/policy.ts", "resolvePolicy", "function_declaration", 0.95);
    const unrelated = ["does", "file", "walking", "command", "short", "help"].map((name) =>
      candidate(name, `src/${name}.ts`, name, "function_declaration", 0.4));
    expect(rankIntentAwareCandidates(query, [...unrelated, evidence], 10)[0]?.id).toBe("behavior");
  });

  it.each([
    "PaymentValidator",
    "`PaymentValidator`",
    "where is PaymentValidator defined",
    "find PaymentValidator implementation",
    "where is payment implemented",
    "get_name",
    "api.get_name",
    "where is api.get_name defined",
    "where is Namespace::get_name implemented",
  ])("retains genuine single-operand identifier lookup: %s", (query) => {
    expect(isExplicitIdentifierLookup(query)).toBe(true);
  });

  it("keeps prose identifiers useful without interpreting prose as exact lookup", () => {
    const query = "How does PaymentValidator apply get_name before the validation implementation returns?";
    expect(extractIntentIdentifierHints(query)).toEqual(["paymentvalidator", "get_name"]);
    expect(isExplicitIdentifierLookup(query)).toBe(false);
    expect(analyzeQueryIntent(query).preferSourcePaths).toBe(true);
  });

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

  it.each([0, 0.9])("keeps the semantic implementation visible when prose matches many declaration names (minScore %s)", async (minScore) => {
    const tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "conceptual-name-promotion-")));
    const sourcePath = path.join(tempDir, "app", "merge.ts");
    const query = "combine instance defaults with request configuration";
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "export function mergeConfiguration(defaults: object, request: object) { return { ...defaults, ...request }; }");
    for (let index = 0; index < 30; index += 1) {
      fs.writeFileSync(path.join(tempDir, "app", `noise-${index}.ts`),
        `export function combine() { return "unrelated item ${index}"; }`);
    }

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
      const texts = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      return new Response(JSON.stringify({
        data: texts.map((text) => ({
          embedding: text.includes("mergeConfiguration") || text.includes(query)
            ? [1, 0, 0, 0, 0, 0, 0, 0]
            : [0, 1, 0, 0, 0, 0, 0, 0],
        })),
        usage: { total_tokens: texts.length },
      }), { status: 200 });
    });
    const indexer = new Indexer(tempDir, parseConfig({
      embeddingProvider: "custom",
      customProvider: { baseUrl: "http://localhost:11434/v1", model: "mock-model", dimensions: 8 },
      indexing: { watchFiles: false, requireProjectMarker: false },
      search: { minScore, fusionStrategy: "rrf", rrfK: 60, rerankTopN: 20 },
    }), "opencode");

    try {
      await indexer.index();
      const context = await resolveSearchContext({ query, limit: 5, tokenBudget: 1200 }, {
        lookup: (symbol, limit, scope) => indexer.search(symbol, limit, {
          ...scope, metadataOnly: true, definitionIntent: true,
        }),
        search: (searchQuery, limit, scope, _trace, options) => indexer.search(searchQuery, limit, {
          ...scope, metadataOnly: true, definitionIntent: false,
          prioritizeSourcePaths: options?.prioritizeSourcePaths,
        }),
      });
      expect(context.details?.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ filePath: fs.realpathSync.native(sourcePath), name: "mergeConfiguration" }),
      ]));
    } finally {
      await indexer.close();
      fetchSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([0, 0.9])("routes ordinary questions through scoped hybrid evidence rather than a related exact symbol (minScore %s)", async (minScore) => {
    const tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "natural-question-routing-")));
    const cases = [
      {
        query: "How does file walking apply .ignore and .gitignore files, hidden-file filtering, and explicit glob overrides, and where is matching precedence implemented?",
        name: "walkPolicy",
        content: "file walking ignore gitignore hidden-file filtering explicit glob overrides matching precedence",
      },
      {
        query: "Where does Axios merge instance defaults with request options, and where is the merge implementation?",
        name: "mergePolicy",
        content: "Axios merge instance defaults request options implementation",
      },
      {
        query: "Where is command short help generated, and how are options and arguments formatted?",
        name: "helpPolicy",
        content: "command short help generated options arguments formatted",
      },
    ];
    fs.mkdirSync(path.join(tempDir, "app"));
    fs.mkdirSync(path.join(tempDir, "excluded"));
    for (const item of cases) {
      fs.writeFileSync(path.join(tempDir, "app", `${item.name}.ts`),
        `// ${item.content}\nfunction ${item.name}() { return "${item.content}"; }\n`);
    }
    for (const name of ["does", "file", "walking", "command", "short", "help", "Axios", "merge"]) {
      fs.writeFileSync(path.join(tempDir, "app", `${name}.ts`), `function ${name}() { return "unrelated"; }\n`);
    }
    fs.writeFileSync(path.join(tempDir, "excluded", "walkPolicy.ts"),
      'function walkPolicy() { return "outside requested scope"; }\n');

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
      const texts = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      return new Response(JSON.stringify({
        data: texts.map((text) => {
          const match = cases.findIndex((item) => text.includes(item.name) || text.includes(item.query));
          return { embedding: Array.from({ length: 8 }, (_, index) => index === (match < 0 ? 7 : match) ? 1 : 0) };
        }),
        usage: { total_tokens: texts.length },
      }), { status: 200 });
    });
    const indexer = new Indexer(tempDir, parseConfig({
      embeddingProvider: "custom",
      customProvider: { baseUrl: "http://localhost:11434/v1", model: "mock-model", dimensions: 8 },
      indexing: { watchFiles: false, requireProjectMarker: false },
      search: { minScore, fusionStrategy: "rrf", rerankTopN: 20 },
    }), "opencode");

    try {
      await indexer.index();
      for (const item of cases) {
        const lookup = (symbol: string, limit: number, scope: { directory?: string; fileType?: string }) =>
          indexer.search(symbol, limit, { ...scope, metadataOnly: true, filterByBranch: false, definitionIntent: true });
        const context = await resolveSearchContext({
          query: item.query, limit: 5, tokenBudget: 1800, directory: "app", fileType: "ts",
        }, {
          lookup,
          search: (query, limit, scope, _trace, options) => indexer.search(query, limit, {
            ...scope, metadataOnly: true, filterByBranch: false, definitionIntent: false,
            prioritizeSourcePaths: options?.prioritizeSourcePaths,
          }),
        });
        expect(context.details?.route).toBe("conceptual");
        expect(context.details?.routedQuery).toBe(item.query);
        expect(context.details?.results?.slice(0, 3)).toEqual(expect.arrayContaining([
          expect.objectContaining({ filePath: path.join(tempDir, "app", `${item.name}.ts`), name: item.name }),
        ]));
        expect(context.details?.results?.every((result) => result.filePath.startsWith(path.join(tempDir, "app") + path.sep))).toBe(true);
      }
    } finally {
      await indexer.close();
      fetchSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps hybrid evidence ahead of identifier lanes for multi-term identifier prose", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "identifier-prose-search-"));
    const sourcePath = path.join(tempDir, "Src", "Library", "DefaultContractResolver.cs");
    const testPath = path.join(tempDir, "Src", "Library.Tests", "ContractResolverTests.cs");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    const fillerMethods = Array.from({ length: 120 }, (_, index) =>
      `  public void Filler${index}() { var value = ${index}; }`
    ).join("\n");
    fs.writeFileSync(sourcePath, `public class DefaultContractResolver {
${fillerMethods}
  public void CreateProperties() {
    GetSerializableMembers();
    NamingStrategy.ResolveContractProperties();
  }
}
`, "utf-8");
    fs.writeFileSync(testPath, Array.from({ length: 20 }, (_, index) => `
public class NamingStrategy${index} {
  public void CreateProperties() { NamingStrategy.ResolveContractProperties(); }
}
`).join(""), "utf-8");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
      const texts = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      return new Response(JSON.stringify({
        data: texts.map(() => ({ embedding: Array.from({ length: 8 }, () => 0.125) })),
        usage: { total_tokens: Math.max(1, texts.length) },
      }), { status: 200 });
    });
    const indexer = new Indexer(tempDir, parseConfig({
      embeddingProvider: "custom",
      customProvider: { baseUrl: "http://localhost:11434/v1", model: "mock-model", dimensions: 8 },
      indexing: { watchFiles: false },
      search: { maxResults: 50, minScore: 0 },
    }), "opencode");

    try {
      await indexer.index();
      const results = await indexer.search(
        "CreateProperties GetSerializableMembers NamingStrategy resolve contract properties",
        50,
        { metadataOnly: true, filterByBranch: false },
      );
      const sourceResult = results.slice(0, 5).find((result) => result.filePath === sourcePath);
      expect(sourceResult).toBeDefined();

      const loneIdentifier = await indexer.search("NamingStrategy0", 10, {
        metadataOnly: true,
        filterByBranch: false,
      });
      expect(loneIdentifier[0]).toMatchObject({
        filePath: testPath,
        name: "NamingStrategy0",
        chunkType: "class_declaration",
      });

      const explicitDefinition = await indexer.search("NamingStrategy0", 10, {
        definitionIntent: true,
        metadataOnly: true,
        filterByBranch: false,
      });
      expect(explicitDefinition[0]).toMatchObject({
        filePath: testPath,
        name: "NamingStrategy0",
        chunkType: "class_declaration",
      });
    } finally {
      await indexer.close();
      fetchSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
