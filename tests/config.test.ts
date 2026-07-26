import { describe, it, expect, vi } from "vitest";
import { substituteEnvReferences } from "../src/config/env-substitution.js";
import {
  parseConfig,
  getDefaultModelForProvider,
  isValidModel,
} from "../src/config/schema.js";
import {
  EMBEDDING_MODELS,
  AUTO_DETECT_PROVIDER_ORDER,
  DEFAULT_PROVIDER_MODELS,
  DEFAULT_INCLUDE,
  DEFAULT_EXCLUDE,
} from "../src/config/constants.js";

describe("config schema", () => {
  describe("substituteEnvReferences", () => {
    it("should replace an env placeholder string with the environment value", () => {
      vi.stubEnv("OPENCODE_TEST_API_KEY", "secret-key");

      expect(substituteEnvReferences("{env:OPENCODE_TEST_API_KEY}")).toBe("secret-key");

      vi.unstubAllEnvs();
    });

    it("should replace nested env placeholders in objects and arrays", () => {
      vi.stubEnv("OPENCODE_TEST_BASE_URL", "https://example.test/v1");
      vi.stubEnv("OPENCODE_TEST_API_KEY", "secret-key");

      const substituted = substituteEnvReferences({
        customProvider: {
          baseUrl: "{env:OPENCODE_TEST_BASE_URL}",
          apiKey: "{env:OPENCODE_TEST_API_KEY}",
        },
        include: ["src/**/*.ts", "{env:OPENCODE_TEST_API_KEY}"],
      });

      expect(substituted).toEqual({
        customProvider: {
          baseUrl: "https://example.test/v1",
          apiKey: "secret-key",
        },
        include: ["src/**/*.ts", "secret-key"],
      });

      vi.unstubAllEnvs();
    });

    it("should leave non-placeholder strings unchanged", () => {
      expect(substituteEnvReferences("custom-provider")).toBe("custom-provider");
    });

    it("should reject malformed env reference strings", () => {
      expect(() => substituteEnvReferences("prefix-{env:OPENCODE_TEST_API_KEY}")).toThrow(
        "Invalid environment variable reference"
      );
      expect(() => substituteEnvReferences("{env:opencode_test_api_key}")).toThrow(
        "Invalid environment variable reference"
      );
    });

    it("should throw when a referenced environment variable is missing", () => {
      expect(() => substituteEnvReferences({
        customProvider: {
          apiKey: "{env:OPENCODE_MISSING_API_KEY}",
        },
      })).toThrow("Missing environment variable 'OPENCODE_MISSING_API_KEY' referenced by config at '$root.customProvider.apiKey'.");
    });

    it("should preserve non-string values", () => {
      expect(substituteEnvReferences({
        indexing: { autoIndex: true, maxChunksPerFile: 5 },
        search: { hybridWeight: 0.5 },
      })).toEqual({
        indexing: { autoIndex: true, maxChunksPerFile: 5 },
        search: { hybridWeight: 0.5 },
      });
    });
  });

  describe("parseConfig", () => {
    it("should return defaults for undefined input", () => {
      const config = parseConfig(undefined);

      expect(config.embeddingProvider).toBe("auto");
      expect(config.embeddingModel).toBeUndefined();
      expect(config.scope).toBe("project");
      expect(config.include).toHaveLength(DEFAULT_INCLUDE.length);
      expect(config.exclude).toHaveLength(DEFAULT_EXCLUDE.length);
    });

    it("should return defaults for null input", () => {
      const config = parseConfig(null);

      expect(config.embeddingProvider).toBe("auto");
      expect(config.indexing.autoIndex).toBe(false);
    });

    it("should return defaults for non-object input", () => {
      expect(parseConfig("string").embeddingProvider).toBe("auto");
      expect(parseConfig(123).embeddingProvider).toBe("auto");
      expect(parseConfig([]).embeddingProvider).toBe("auto");
    });

    it("should parse valid embeddingProvider values", () => {
      expect(parseConfig({ embeddingProvider: "openai" }).embeddingProvider).toBe("openai");
      expect(parseConfig({ embeddingProvider: "google" }).embeddingProvider).toBe("google");
      expect(parseConfig({ embeddingProvider: "ollama" }).embeddingProvider).toBe("ollama");
      expect(parseConfig({ embeddingProvider: "github-copilot" }).embeddingProvider).toBe("github-copilot");
    });

    it("should fallback to auto for invalid embeddingProvider", () => {
      expect(parseConfig({ embeddingProvider: "auto" }).embeddingProvider).toBe("auto");
      expect(parseConfig({ embeddingProvider: "invalid" }).embeddingProvider).toBe("auto");
      expect(parseConfig({ embeddingProvider: 123 }).embeddingProvider).toBe("auto");
      expect(parseConfig({ embeddingProvider: null }).embeddingProvider).toBe("auto");
    });

    it("should parse valid scope values", () => {
      expect(parseConfig({ scope: "project" }).scope).toBe("project");
      expect(parseConfig({ scope: "global" }).scope).toBe("global");
    });

    it("should fallback to project for invalid scope", () => {
      expect(parseConfig({ scope: "invalid" }).scope).toBe("project");
      expect(parseConfig({ scope: 123 }).scope).toBe("project");
    });

    describe("embeddingModel parsing", () => {
      it("should be undefined when no provider and no model given", () => {
        expect(parseConfig({}).embeddingModel).toBeUndefined();
      });

      it("should be undefined when valid provider but no model given", () => {
        expect(parseConfig({ embeddingProvider: "openai" }).embeddingModel).toBeUndefined();
      });

      it("should keep valid model for matching provider", () => {
        const config = parseConfig({ embeddingProvider: "openai", embeddingModel: "text-embedding-3-large" });
        expect(config.embeddingModel).toBe("text-embedding-3-large");
      });

      it("should fallback to provider default for invalid model", () => {
        const config = parseConfig({ embeddingProvider: "openai", embeddingModel: "nonexistent-model" });
        expect(config.embeddingModel).toBe(DEFAULT_PROVIDER_MODELS["openai"]);
      });

      it("should fallback to provider default for model belonging to different provider", () => {
        const config = parseConfig({ embeddingProvider: "openai", embeddingModel: "nomic-embed-text" });
        expect(config.embeddingModel).toBe(DEFAULT_PROVIDER_MODELS["openai"]);
      });

      it("should be undefined when provider is invalid even if model is specified", () => {
        const config = parseConfig({ embeddingProvider: "invalid", embeddingModel: "text-embedding-3-small" });
        expect(config.embeddingProvider).toBe("auto");
        expect(config.embeddingModel).toBeUndefined();
      });

      it("should fallback to provider default for non-string embeddingModel when truthy", () => {
        expect(parseConfig({ embeddingProvider: "openai", embeddingModel: 123 }).embeddingModel).toBe(DEFAULT_PROVIDER_MODELS["openai"]);
      });

      it("should be undefined for falsy non-string embeddingModel", () => {
        expect(parseConfig({ embeddingProvider: "openai", embeddingModel: null }).embeddingModel).toBeUndefined();
        expect(parseConfig({ embeddingProvider: "openai", embeddingModel: 0 }).embeddingModel).toBeUndefined();
        expect(parseConfig({ embeddingProvider: "openai", embeddingModel: "" }).embeddingModel).toBeUndefined();
      });

      it("should handle each provider with its valid model", () => {
        expect(parseConfig({ embeddingProvider: "github-copilot", embeddingModel: "text-embedding-3-small" }).embeddingModel).toBe("text-embedding-3-small");
        expect(parseConfig({ embeddingProvider: "google", embeddingModel: "gemini-embedding-001" }).embeddingModel).toBe("gemini-embedding-001");
        expect(parseConfig({ embeddingProvider: "ollama", embeddingModel: "mxbai-embed-large" }).embeddingModel).toBe("mxbai-embed-large");
      });
    });

    it("should parse include as string array", () => {
      const config = parseConfig({ include: ["**/*.ts", "**/*.js"] });
      expect(config.include).toEqual(["**/*.ts", "**/*.js"]);
    });

    it("should fallback to defaults for non-array include", () => {
      expect(parseConfig({ include: "string" }).include).toHaveLength(DEFAULT_INCLUDE.length);
      expect(parseConfig({ include: 123 }).include).toHaveLength(DEFAULT_INCLUDE.length);
    });

    it("should fallback to defaults for include with non-string items", () => {
      expect(parseConfig({ include: [123, 456] }).include).toHaveLength(DEFAULT_INCLUDE.length);
      expect(parseConfig({ include: ["valid", 123] }).include).toHaveLength(DEFAULT_INCLUDE.length);
    });

    it("should parse exclude as string array", () => {
      const config = parseConfig({ exclude: ["**/node_modules/**"] });
      expect(config.exclude).toEqual(["**/node_modules/**"]);
    });

    describe("indexing config", () => {
      it("should parse boolean indexing options", () => {
        const config = parseConfig({
          indexing: {
            autoIndex: true,
            watchFiles: false,
            semanticOnly: true,
            autoGc: false,
          },
        });

        expect(config.indexing.autoIndex).toBe(true);
        expect(config.indexing.watchFiles).toBe(false);
        expect(config.indexing.semanticOnly).toBe(true);
        expect(config.indexing.autoGc).toBe(false);
      });

      it("should fallback to defaults for non-boolean indexing options", () => {
        const config = parseConfig({
          indexing: {
            autoIndex: "true",
            watchFiles: 1,
          },
        });

        expect(config.indexing.autoIndex).toBe(false);
        expect(config.indexing.watchFiles).toBe(true);
      });

      it("should parse numeric indexing options", () => {
        const config = parseConfig({
          indexing: {
            maxFileSize: 2000000,
            maxChunksPerFile: 50,
            retries: 5,
            retryDelayMs: 2000,
            gcIntervalDays: 14,
            gcOrphanThreshold: 200,
          },
        });

        expect(config.indexing.maxFileSize).toBe(2000000);
        expect(config.indexing.maxChunksPerFile).toBe(50);
        expect(config.indexing.retries).toBe(5);
        expect(config.indexing.retryDelayMs).toBe(2000);
        expect(config.indexing.gcIntervalDays).toBe(14);
        expect(config.indexing.gcOrphanThreshold).toBe(200);
      });

      it("should enforce minimum of 1 for maxChunksPerFile", () => {
        expect(parseConfig({ indexing: { maxChunksPerFile: 0 } }).indexing.maxChunksPerFile).toBe(1);
        expect(parseConfig({ indexing: { maxChunksPerFile: -5 } }).indexing.maxChunksPerFile).toBe(1);
      });

      it("should enforce minimum of 1 for gcIntervalDays", () => {
        expect(parseConfig({ indexing: { gcIntervalDays: 0 } }).indexing.gcIntervalDays).toBe(1);
        expect(parseConfig({ indexing: { gcIntervalDays: -1 } }).indexing.gcIntervalDays).toBe(1);
      });

      it("should enforce minimum of 0 for gcOrphanThreshold", () => {
        expect(parseConfig({ indexing: { gcOrphanThreshold: -10 } }).indexing.gcOrphanThreshold).toBe(0);
      });

      it("should handle non-object indexing", () => {
        expect(parseConfig({ indexing: "invalid" }).indexing.autoIndex).toBe(false);
        expect(parseConfig({ indexing: null }).indexing.autoIndex).toBe(false);
      });
    });

    describe("search config", () => {
      it("should parse search options", () => {
        const config = parseConfig({
          search: {
            maxResults: 50,
            minScore: 0.2,
            includeContext: false,
            hybridWeight: 0.7,
            fusionStrategy: "weighted",
            rrfK: 80,
            rerankTopN: 12,
            contextLines: 10,
          },
        });

        expect(config.search.maxResults).toBe(50);
        expect(config.search.minScore).toBe(0.2);
        expect(config.search.includeContext).toBe(false);
        expect(config.search.hybridWeight).toBe(0.7);
        expect(config.search.fusionStrategy).toBe("weighted");
        expect(config.search.rrfK).toBe(80);
        expect(config.search.rerankTopN).toBe(12);
        expect(config.search.contextLines).toBe(10);
      });

      it("should use default search ranking config values", () => {
        const config = parseConfig({});
        expect(config.search.fusionStrategy).toBe("rrf");
        expect(config.search.rrfK).toBe(60);
        expect(config.search.rerankTopN).toBe(20);
        expect(config.search.routingHints).toBe(true);
        expect(config.search.routingHintRole).toBe("system");
      });

      it("should parse routingHints boolean", () => {
        expect(parseConfig({ search: { routingHints: false } }).search.routingHints).toBe(false);
        expect(parseConfig({ search: { routingHints: true } }).search.routingHints).toBe(true);
      });

      it("should fallback routingHints to default for invalid values", () => {
        expect(parseConfig({ search: { routingHints: "nope" } }).search.routingHints).toBe(true);
      });

      it("should parse routingGraphHandoffHints values", () => {
        expect(parseConfig({ search: { routingGraphHandoffHints: true } }).search.routingGraphHandoffHints).toBe(true);
        expect(parseConfig({ search: { routingGraphHandoffHints: false } }).search.routingGraphHandoffHints).toBe(false);
      });

      it("should fallback routingGraphHandoffHints to default for invalid values", () => {
        expect(parseConfig({ search: { routingGraphHandoffHints: "nope" } }).search.routingGraphHandoffHints).toBe(false);
      });

      it("should parse routingHintRole values", () => {
        expect(parseConfig({ search: { routingHintRole: "system" } }).search.routingHintRole).toBe("system");
        expect(parseConfig({ search: { routingHintRole: "developer" } }).search.routingHintRole).toBe("developer");
      });

      it("should fallback routingHintRole to default for invalid values", () => {
        expect(parseConfig({ search: { routingHintRole: "nope" } }).search.routingHintRole).toBe("system");
      });

      it("should fallback fusionStrategy to default for invalid values", () => {
        const config = parseConfig({ search: { fusionStrategy: "invalid" } });
        expect(config.search.fusionStrategy).toBe("rrf");
      });

      it("should clamp rrfK and rerankTopN bounds", () => {
        expect(parseConfig({ search: { rrfK: 0 } }).search.rrfK).toBe(1);
        expect(parseConfig({ search: { rrfK: -10 } }).search.rrfK).toBe(1);
        expect(parseConfig({ search: { rrfK: 25.7 } }).search.rrfK).toBe(25);

        expect(parseConfig({ search: { rerankTopN: -1 } }).search.rerankTopN).toBe(0);
        expect(parseConfig({ search: { rerankTopN: 999 } }).search.rerankTopN).toBe(200);
        expect(parseConfig({ search: { rerankTopN: 10.9 } }).search.rerankTopN).toBe(10);
      });

      it("should clamp hybridWeight to 0-1 range", () => {
        expect(parseConfig({ search: { hybridWeight: -0.5 } }).search.hybridWeight).toBe(0);
        expect(parseConfig({ search: { hybridWeight: 1.5 } }).search.hybridWeight).toBe(1);
        expect(parseConfig({ search: { hybridWeight: 0.5 } }).search.hybridWeight).toBe(0.5);
      });

      it("should clamp contextLines to 0-50 range", () => {
        expect(parseConfig({ search: { contextLines: -5 } }).search.contextLines).toBe(0);
        expect(parseConfig({ search: { contextLines: 100 } }).search.contextLines).toBe(50);
        expect(parseConfig({ search: { contextLines: 25 } }).search.contextLines).toBe(25);
      });

      it("should handle non-object search", () => {
        expect(parseConfig({ search: "invalid" }).search.maxResults).toBe(20);
      });

      it("should parse reranker config when enabled", () => {
        const config = parseConfig({
          reranker: {
            enabled: true,
            provider: "cohere",
            model: "rerank-v3.5",
            apiKey: "test-key",
            topN: 12,
            timeoutMs: 4000,
          },
        });

        expect(config.reranker).toEqual({
          enabled: true,
          provider: "cohere",
          model: "rerank-v3.5",
          baseUrl: "https://api.cohere.ai/v1",
          apiKey: "test-key",
          topN: 12,
          timeoutMs: 4000,
        });
      });

      it("should require model for enabled reranker", () => {
        expect(() => parseConfig({
          reranker: {
            enabled: true,
            provider: "cohere",
            apiKey: "test-key",
          },
        })).toThrow("reranker is enabled but reranker.model is missing or invalid.");
      });

      it("should require apiKey for hosted reranker providers", () => {
        expect(() => parseConfig({
          reranker: {
            enabled: true,
            provider: "jina",
            model: "jina-reranker-v2-base-multilingual",
          },
        })).toThrow("reranker provider 'jina' requires reranker.apiKey when enabled.");
      });

      it("should require baseUrl for custom reranker provider", () => {
        expect(() => parseConfig({
          reranker: {
            enabled: true,
            provider: "custom",
            model: "custom-reranker",
          },
        })).toThrow("reranker is enabled but reranker.baseUrl is missing or invalid for provider 'custom'.");
      });

      it("should clamp reranker topN and timeoutMs", () => {
        const config = parseConfig({
          reranker: {
            enabled: true,
            provider: "custom",
            model: "custom-reranker",
            baseUrl: "https://rerank.example/v1",
            topN: 999,
            timeoutMs: 100,
          },
        });

        expect(config.reranker?.topN).toBe(50);
        expect(config.reranker?.timeoutMs).toBe(1000);
      });
    });

    describe("custom provider config", () => {
      it("should parse valid custom provider config", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "nomic-embed-text",
            dimensions: 768,
          },
        });
        expect(config.embeddingProvider).toBe("custom");
        expect(config.customProvider).toBeDefined();
        expect(config.customProvider!.baseUrl).toBe("http://localhost:11434/v1");
        expect(config.customProvider!.model).toBe("nomic-embed-text");
        expect(config.customProvider!.dimensions).toBe(768);
        expect(config.customProvider!.apiKey).toBeUndefined();
        expect(config.customProvider!.maxTokens).toBeUndefined();
      });

      it("should parse custom provider with all optional fields", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "https://api.example.com/v1",
            model: "my-model",
            dimensions: 1024,
            apiKey: "sk-test-key",
            maxTokens: 4096,
          },
        });
        expect(config.customProvider!.apiKey).toBe("sk-test-key");
        expect(config.customProvider!.maxTokens).toBe(4096);
      });

      it("should accept env-substituted custom provider credentials", () => {
        vi.stubEnv("OPENCODE_CUSTOM_PROVIDER_URL", "https://api.example.com/v1");
        vi.stubEnv("OPENCODE_CUSTOM_PROVIDER_KEY", "sk-env-key");

        const config = parseConfig(substituteEnvReferences({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "{env:OPENCODE_CUSTOM_PROVIDER_URL}",
            model: "my-model",
            dimensions: 1024,
            apiKey: "{env:OPENCODE_CUSTOM_PROVIDER_KEY}",
          },
        }));

        expect(config.customProvider!.baseUrl).toBe("https://api.example.com/v1");
        expect(config.customProvider!.apiKey).toBe("sk-env-key");

        vi.unstubAllEnvs();
      });

      it("should ignore env refs in inactive customProvider branches", () => {
        const config = parseConfig({
          embeddingProvider: "openai",
          customProvider: {
            baseUrl: "{env:EMBED_BASE_URL}",
            model: "{env:EMBED_MODEL}",
            dimensions: 768,
            apiKey: "{env:MISSING_API_KEY}",
          },
        });

        expect(config.embeddingProvider).toBe("openai");
        expect(config.customProvider).toBeUndefined();
      });

      it("should reject malformed env refs in active custom provider fields", () => {
        expect(() => parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "prefix-{env:EMBED_BASE_URL}",
            model: "test",
            dimensions: 768,
          },
        })).toThrow("Invalid environment variable reference");

        expect(() => parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768,
            apiKey: "{env:embed_api_key}",
          },
        })).toThrow("Invalid environment variable reference");
      });

      it("should throw when custom provider is selected but config is missing", () => {
        expect(() => parseConfig({
          embeddingProvider: "custom",
        })).toThrow("embeddingProvider is 'custom' but customProvider config is missing or invalid");
      });

      it("should throw when custom provider config is missing required fields", () => {
        expect(() => parseConfig({
          embeddingProvider: "custom",
          customProvider: { baseUrl: "http://localhost/v1" },
        })).toThrow("embeddingProvider is 'custom' but customProvider config is missing or invalid");
      });

      it("should throw when custom provider has wrong field types", () => {
        expect(() => parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: 123,
            model: "test",
            dimensions: 768,
          },
        })).toThrow("embeddingProvider is 'custom' but customProvider config is missing or invalid");
      });

      it("should warn when baseUrl is missing API version path", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434",
            model: "test",
            dimensions: 768,
          },
        });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("does not end with an API version path like /v1")
        );
        warnSpy.mockRestore();
      });

      it("should not warn when baseUrl ends with /v1", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768,
          },
        });
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it("should not warn when baseUrl ends with /v2", () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "https://api.example.com/v2",
            model: "test",
            dimensions: 768,
          },
        });
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it("should ignore customProvider when embeddingProvider is not 'custom'", () => {
        const config = parseConfig({
          embeddingProvider: "openai",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "nomic-embed-text",
            dimensions: 768,
          },
        });
        expect(config.embeddingProvider).toBe("openai");
        expect(config.customProvider).toBeUndefined();
      });

      it("should parse custom provider with timeoutMs", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768,
            timeoutMs: 60000,
          },
        });
        expect(config.customProvider!.timeoutMs).toBe(60000);
      });

      it("should leave timeoutMs undefined when not provided", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768,
          },
        });
        expect(config.customProvider!.timeoutMs).toBeUndefined();
      });

      it("should strip trailing slashes from baseUrl at config parse time", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1///",
            model: "test",
            dimensions: 768,
          },
        });
        expect(config.customProvider!.baseUrl).toBe("http://localhost:11434/v1");
      });

      it("should throw when dimensions is zero", () => {
        expect(() => parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 0,
          },
        })).toThrow("embeddingProvider is 'custom' but customProvider config is missing or invalid");
      });

      it("should throw when dimensions is negative", () => {
        expect(() => parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: -1,
          },
        })).toThrow("embeddingProvider is 'custom' but customProvider config is missing or invalid");
      });

      it("should throw when dimensions is a float", () => {
        expect(() => parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768.5,
          },
        })).toThrow("embeddingProvider is 'custom' but customProvider config is missing or invalid");
      });

      it("should throw when baseUrl is empty string", () => {
        expect(() => parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "",
            model: "test",
            dimensions: 768,
          },
        })).toThrow("embeddingProvider is 'custom' but customProvider config is missing or invalid");
      });

      it("should throw when baseUrl is whitespace only", () => {
        expect(() => parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "   ",
            model: "test",
            dimensions: 768,
          },
        })).toThrow("embeddingProvider is 'custom' but customProvider config is missing or invalid");
      });

      it("should throw when model is empty string", () => {
        expect(() => parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "",
            dimensions: 768,
          },
        })).toThrow("embeddingProvider is 'custom' but customProvider config is missing or invalid");
      });

      it("should parse custom provider with concurrency", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768,
            concurrency: 10,
          },
        });
        expect(config.customProvider!.concurrency).toBe(10);
      });

      it("should parse custom provider with requestIntervalMs", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768,
            requestIntervalMs: 0,
          },
        });
        expect(config.customProvider!.requestIntervalMs).toBe(0);
      });

      it("should parse custom provider with maxBatchSize", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768,
            maxBatchSize: 64,
          },
        });
        expect(config.customProvider!.maxBatchSize).toBe(64);
      });

      it("should parse custom provider with max_batch_size alias", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768,
            max_batch_size: 32,
          },
        });
        expect(config.customProvider!.maxBatchSize).toBe(32);
      });

      it("should clamp concurrency to minimum of 1", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768,
            concurrency: 0,
          },
        });
        expect(config.customProvider!.concurrency).toBe(1);
      });

      it("should clamp maxBatchSize to minimum of 1", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768,
            maxBatchSize: 0,
          },
        });
        expect(config.customProvider!.maxBatchSize).toBe(1);
      });

      it("should leave concurrency undefined when not provided", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768,
          },
        });
        expect(config.customProvider!.concurrency).toBeUndefined();
      });

      it("should trim whitespace from baseUrl before stripping slashes", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "  http://localhost:11434/v1  ",
            model: "test",
            dimensions: 768,
          },
        });
        expect(config.customProvider!.baseUrl).toBe("http://localhost:11434/v1");
      });

      it("should clamp timeoutMs to minimum of 1000", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768,
            timeoutMs: 100,
          },
        });
        expect(config.customProvider!.timeoutMs).toBe(1000);
      });

      it("should accept timeoutMs at or above 1000", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768,
            timeoutMs: 1000,
          },
        });
        expect(config.customProvider!.timeoutMs).toBe(1000);
      });

      it("should clamp negative timeoutMs to 1000", () => {
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "test",
            dimensions: 768,
            timeoutMs: -500,
          },
        });
        expect(config.customProvider!.timeoutMs).toBe(1000);
      });
    });
  });

  describe("getDefaultModelForProvider", () => {
    it("should return correct model for github-copilot", () => {
      const model = getDefaultModelForProvider("github-copilot");
      expect(model.provider).toBe("github-copilot");
      expect(model.model).toBe("text-embedding-3-small");
      expect(model.dimensions).toBe(1536);
    });

    it("should return correct model for openai", () => {
      const model = getDefaultModelForProvider("openai");
      expect(model.provider).toBe("openai");
      expect(model.model).toBe("text-embedding-3-small");
    });

    it("should return correct model for google", () => {
      const model = getDefaultModelForProvider("google");
      expect(model.provider).toBe("google");
      expect(model.model).toBe("gemini-embedding-001");
      expect(model.dimensions).toBe(1536);
    });

    it("should return correct model for ollama", () => {
      const model = getDefaultModelForProvider("ollama");
      expect(model.provider).toBe("ollama");
      expect(model.model).toBe("nomic-embed-text");
    });
  });

  describe("isValidModel", () => {
    it("should return true for valid model of a provider", () => {
      expect(isValidModel("text-embedding-3-small", "openai")).toBe(true);
      expect(isValidModel("text-embedding-3-large", "openai")).toBe(true);
      expect(isValidModel("text-embedding-3-small", "github-copilot")).toBe(true);
      expect(isValidModel("nomic-embed-text", "ollama")).toBe(true);
      expect(isValidModel("mxbai-embed-large", "ollama")).toBe(true);
      expect(isValidModel("private/embedding-model:v2", "ollama")).toBe(true);
      expect(isValidModel("text-embedding-005", "google")).toBe(true);
      expect(isValidModel("gemini-embedding-001", "google")).toBe(true);
    });

    it("should return false for model belonging to a different provider", () => {
      expect(isValidModel("nomic-embed-text", "openai")).toBe(false);
      expect(isValidModel("gemini-embedding-001", "openai")).toBe(false);
    });

    it("should return false for non-existent model", () => {
      expect(isValidModel("nonexistent-model", "openai")).toBe(false);
      expect(isValidModel("gpt-4", "openai")).toBe(false);
      expect(isValidModel("", "ollama")).toBe(false);
      expect(isValidModel("   ", "ollama")).toBe(false);
    });

    it("should return false for non-string values", () => {
      expect(isValidModel(123, "openai")).toBe(false);
      expect(isValidModel(null, "openai")).toBe(false);
      expect(isValidModel(undefined, "openai")).toBe(false);
      expect(isValidModel(true, "openai")).toBe(false);
    });
  });

  describe("EMBEDDING_MODELS", () => {
    it("should have all expected providers", () => {
      expect(EMBEDDING_MODELS).toHaveProperty("github-copilot");
      expect(EMBEDDING_MODELS).toHaveProperty("openai");
      expect(EMBEDDING_MODELS).toHaveProperty("google");
      expect(EMBEDDING_MODELS).toHaveProperty("ollama");
    });

    it("should have expected models per provider", () => {
      expect(EMBEDDING_MODELS["github-copilot"]).toHaveProperty("text-embedding-3-small");
      expect(EMBEDDING_MODELS["openai"]).toHaveProperty("text-embedding-3-small");
      expect(EMBEDDING_MODELS["openai"]).toHaveProperty("text-embedding-3-large");
      expect(EMBEDDING_MODELS["google"]).toHaveProperty("text-embedding-005");
      expect(EMBEDDING_MODELS["google"]).toHaveProperty("gemini-embedding-001");
      expect(EMBEDDING_MODELS["ollama"]).toHaveProperty("nomic-embed-text");
      expect(EMBEDDING_MODELS["ollama"]).toHaveProperty("mxbai-embed-large");
    });

    it("should have correct cost for free providers", () => {
      expect(EMBEDDING_MODELS["github-copilot"]["text-embedding-3-small"].costPer1MTokens).toBe(0);
      expect(EMBEDDING_MODELS["ollama"]["nomic-embed-text"].costPer1MTokens).toBe(0);
      expect(EMBEDDING_MODELS["ollama"]["mxbai-embed-large"].costPer1MTokens).toBe(0);
    });

    it("should use the observed effective token budget for built-in ollama models", () => {
      expect(EMBEDDING_MODELS["ollama"]["nomic-embed-text"].maxTokens).toBe(2048);
      expect(EMBEDDING_MODELS["ollama"]["mxbai-embed-large"].maxTokens).toBe(512);
    });

    it("should have non-zero cost for paid providers", () => {
      expect(EMBEDDING_MODELS["openai"]["text-embedding-3-small"].costPer1MTokens).toBeGreaterThan(0);
      expect(EMBEDDING_MODELS["openai"]["text-embedding-3-large"].costPer1MTokens).toBeGreaterThan(0);
      expect(EMBEDDING_MODELS["google"]["text-embedding-005"].costPer1MTokens).toBeGreaterThan(0);
      expect(EMBEDDING_MODELS["google"]["gemini-embedding-001"].costPer1MTokens).toBeGreaterThan(0);
    });

    it("should have taskAble property on google models", () => {
      expect(EMBEDDING_MODELS["google"]["text-embedding-005"].taskAble).toBe(false);
      expect(EMBEDDING_MODELS["google"]["gemini-embedding-001"].taskAble).toBe(true);
    });

    it("should have valid dimensions for all models", () => {
      for (const [_provider, models] of Object.entries(EMBEDDING_MODELS)) {
        for (const [_modelName, info] of Object.entries(models)) {
          expect(info.dimensions).toBeGreaterThan(0);
          expect(info.maxTokens).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("DEFAULT_PROVIDER_MODELS", () => {
    it("should reference models that exist in EMBEDDING_MODELS", () => {
      for (const [provider, model] of Object.entries(DEFAULT_PROVIDER_MODELS)) {
        const providerModels = EMBEDDING_MODELS[provider as keyof typeof EMBEDDING_MODELS];
        expect(providerModels).toBeDefined();
        expect(providerModels).toHaveProperty(model);
      }
    });

    it("should have an entry for every provider in EMBEDDING_MODELS", () => {
      const providers = Object.keys(EMBEDDING_MODELS);
      const defaultProviders = Object.keys(DEFAULT_PROVIDER_MODELS);
      expect(defaultProviders.sort()).toEqual(providers.sort());
    });

    it("should prefer Ollama before cloud providers for auto-detection", () => {
      expect(AUTO_DETECT_PROVIDER_ORDER[0]).toBe("ollama");
      expect(AUTO_DETECT_PROVIDER_ORDER.indexOf("github-copilot")).toBeGreaterThan(
        AUTO_DETECT_PROVIDER_ORDER.indexOf("ollama"),
      );
      expect(AUTO_DETECT_PROVIDER_ORDER.indexOf("google")).toBeGreaterThan(
        AUTO_DETECT_PROVIDER_ORDER.indexOf("github-copilot"),
      );
    });
  });
});
