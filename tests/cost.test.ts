import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  formatBytes,
  estimateChunksFromFiles,
  estimateCost,
  formatCostEstimate,
  formatDryRunEstimate,
  parseConfirmationResponse,
  formatConfirmationPrompt,
  CostEstimate,
  DryRunEstimate,
} from "../src/utils/cost.js";

describe("cost utilities", () => {
  describe("estimateTokens", () => {
    it("should estimate tokens from text length", () => {
      const text = "a".repeat(100);
      const tokens = estimateTokens(text);

      expect(tokens).toBe(25);
    });

    it("should round up for partial tokens", () => {
      const text = "a".repeat(101);
      const tokens = estimateTokens(text);

      expect(tokens).toBe(26);
    });

    it("should handle empty string", () => {
      expect(estimateTokens("")).toBe(0);
    });

    it("should handle single character", () => {
      expect(estimateTokens("a")).toBe(1);
    });

    it("should handle exactly 4 characters", () => {
      expect(estimateTokens("abcd")).toBe(1);
    });
  });

  describe("formatBytes", () => {
    it("should format bytes correctly", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(100)).toBe("100 B");
      expect(formatBytes(1024)).toBe("1 KB");
      expect(formatBytes(1536)).toBe("1.5 KB");
      expect(formatBytes(1048576)).toBe("1 MB");
      expect(formatBytes(1073741824)).toBe("1 GB");
    });

    it("should handle fractional values", () => {
      expect(formatBytes(512)).toBe("512 B");
      expect(formatBytes(2048)).toBe("2 KB");
      expect(formatBytes(1572864)).toBe("1.5 MB");
    });
  });

  describe("estimateChunksFromFiles", () => {
    it("should estimate chunks based on file sizes", () => {
      const files = [
        { path: "a.ts", size: 400 },
        { path: "b.ts", size: 800 },
        { path: "c.ts", size: 1200 },
      ];

      const chunks = estimateChunksFromFiles(files);

      expect(chunks).toBeGreaterThan(0);
      expect(chunks).toBeLessThan(20);
    });

    it("should return at least 1 chunk per file", () => {
      const files = [{ path: "tiny.ts", size: 10 }];

      const chunks = estimateChunksFromFiles(files);

      expect(chunks).toBeGreaterThanOrEqual(1);
    });

    it("should handle empty file list", () => {
      const chunks = estimateChunksFromFiles([]);

      expect(chunks).toBe(0);
    });

    it("should calculate correctly for exact chunk size multiple", () => {
      // avgChunkSize is 400
      const files = [
        { path: "a.ts", size: 400 }, // 1 chunk
        { path: "b.ts", size: 800 }, // 2 chunks
      ];

      const chunks = estimateChunksFromFiles(files);

      expect(chunks).toBe(3);
    });

    it("should round up partial chunks", () => {
      const files = [{ path: "a.ts", size: 401 }]; // Just over 1 chunk
      const chunks = estimateChunksFromFiles(files);
      expect(chunks).toBe(2);
    });
  });

  describe("estimateCost", () => {
    it("should calculate cost for free provider", () => {
      const modelInfo = {
        provider: "ollama",
        model: "nomic-embed-text",
        dimensions: 768,
        maxTokens: 2048,
        costPer1MTokens: 0,
      } as const;

      const cost = estimateCost(1000000, modelInfo);
      expect(cost).toBe(0);
    });

    it("should calculate cost for paid provider", () => {
      const modelInfo = {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        maxTokens: 8191,
        costPer1MTokens: 0.02,
      } as const;

      const cost = estimateCost(1000000, modelInfo);
      expect(cost).toBe(0.02);
    });

    it("should calculate proportional cost", () => {
      const modelInfo = {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        maxTokens: 8191,
        costPer1MTokens: 0.02,
      } as const;

      const cost = estimateCost(500000, modelInfo);
      expect(cost).toBe(0.01);
    });

    it("should handle zero tokens", () => {
      const modelInfo = {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1536,
        maxTokens: 8191,
        costPer1MTokens: 0.02,
      } as const;

      const cost = estimateCost(0, modelInfo);
      expect(cost).toBe(0);
    });
  });

  describe("formatCostEstimate", () => {
    it("should format free provider estimate", () => {
      const estimate: CostEstimate = {
        filesCount: 100,
        totalSizeBytes: 1048576,
        estimatedChunks: 500,
        estimatedTokens: 75000,
        estimatedCost: 0,
        provider: "GitHub Copilot",
        model: "text-embedding-3-small",
        isFree: true,
      };

      const formatted = formatCostEstimate(estimate);

      expect(formatted).toContain("100 files");
      expect(formatted).toContain("1 MB");
      expect(formatted).toContain("~500 chunks");
      expect(formatted).toContain("~75,000 tokens");
      expect(formatted).toContain("GitHub Copilot");
      expect(formatted).toContain("text-embedding-3-small");
      expect(formatted).toContain("Free");
    });

    it("should format paid provider estimate", () => {
      const estimate: CostEstimate = {
        filesCount: 50,
        totalSizeBytes: 512000,
        estimatedChunks: 250,
        estimatedTokens: 37500,
        estimatedCost: 0.00075,
        provider: "OpenAI",
        model: "text-embedding-3-small",
        isFree: false,
      };

      const formatted = formatCostEstimate(estimate);

      expect(formatted).toContain("50 files");
      expect(formatted).toContain("OpenAI");
      expect(formatted).toContain("~$0.0008"); // Rounded to 4 decimal places
    });

    it("should include box drawing characters", () => {
      const estimate: CostEstimate = {
        filesCount: 1,
        totalSizeBytes: 100,
        estimatedChunks: 1,
        estimatedTokens: 150,
        estimatedCost: 0,
        provider: "Ollama (Local)",
        model: "nomic-embed-text",
        isFree: true,
      };

      const formatted = formatCostEstimate(estimate);

      expect(formatted).toContain("┌");
      expect(formatted).toContain("┐");
      expect(formatted).toContain("├");
      expect(formatted).toContain("┤");
      expect(formatted).toContain("└");
      expect(formatted).toContain("┘");
      expect(formatted).toContain("│");
    });
  });

  describe("formatDryRunEstimate", () => {
    it("should format the file/chunk/token totals with locale grouping", () => {
      const estimate: DryRunEstimate = {
        filesCount: 970,
        chunksCount: 72488,
        tokensToEmbed: 76509389,
      };

      const formatted = formatDryRunEstimate(estimate);

      expect(formatted).toContain("Files to embed:   970");
      expect(formatted).toContain("Chunks to embed:  72,488");
      expect(formatted).toContain("Tokens to embed:  76,509,389");
    });

    it("should state the dry-run did not write embeddings or change the index", () => {
      const formatted = formatDryRunEstimate({ filesCount: 1, chunksCount: 1, tokensToEmbed: 1 });

      expect(formatted).toContain("No embeddings were written");
      expect(formatted).toContain("index was not changed");
      // The percent-denominator basis note ci relies on.
      expect(formatted).toContain("estimateTokens(text) basis");
    });

    it("should distinguish force-index exactness from incremental upper bound", () => {
      const formatted = formatDryRunEstimate({ filesCount: 0, chunksCount: 0, tokensToEmbed: 0 });

      expect(formatted).toContain("force index");
      expect(formatted).toContain("upper bound");
    });
  });

  describe("formatConfirmationPrompt", () => {
    it("should return prompt with all options", () => {
      const prompt = formatConfirmationPrompt();

      expect(prompt).toContain("[Y/n/always]");
      expect(prompt).toContain("Y");
      expect(prompt).toContain("n");
      expect(prompt).toContain("always");
    });
  });

  describe("parseConfirmationResponse", () => {
    it("should confirm for empty string", () => {
      const result = parseConfirmationResponse("");
      expect(result.confirmed).toBe(true);
      expect(result.rememberChoice).toBe(false);
    });

    it("should confirm for 'y'", () => {
      const result = parseConfirmationResponse("y");
      expect(result.confirmed).toBe(true);
      expect(result.rememberChoice).toBe(false);
    });

    it("should confirm for 'Y'", () => {
      const result = parseConfirmationResponse("Y");
      expect(result.confirmed).toBe(true);
      expect(result.rememberChoice).toBe(false);
    });

    it("should confirm for 'yes'", () => {
      const result = parseConfirmationResponse("yes");
      expect(result.confirmed).toBe(true);
      expect(result.rememberChoice).toBe(false);
    });

    it("should confirm for 'YES' (case insensitive)", () => {
      const result = parseConfirmationResponse("YES");
      expect(result.confirmed).toBe(true);
      expect(result.rememberChoice).toBe(false);
    });

    it("should confirm with remember for 'always'", () => {
      const result = parseConfirmationResponse("always");
      expect(result.confirmed).toBe(true);
      expect(result.rememberChoice).toBe(true);
    });

    it("should confirm with remember for 'a'", () => {
      const result = parseConfirmationResponse("a");
      expect(result.confirmed).toBe(true);
      expect(result.rememberChoice).toBe(true);
    });

    it("should confirm with remember for 'ALWAYS' (case insensitive)", () => {
      const result = parseConfirmationResponse("ALWAYS");
      expect(result.confirmed).toBe(true);
      expect(result.rememberChoice).toBe(true);
    });

    it("should reject for 'n'", () => {
      const result = parseConfirmationResponse("n");
      expect(result.confirmed).toBe(false);
      expect(result.rememberChoice).toBe(false);
    });

    it("should reject for 'no'", () => {
      const result = parseConfirmationResponse("no");
      expect(result.confirmed).toBe(false);
      expect(result.rememberChoice).toBe(false);
    });

    it("should reject for any other input", () => {
      expect(parseConfirmationResponse("x").confirmed).toBe(false);
      expect(parseConfirmationResponse("cancel").confirmed).toBe(false);
      expect(parseConfirmationResponse("nope").confirmed).toBe(false);
    });

    it("should handle whitespace", () => {
      expect(parseConfirmationResponse("  y  ").confirmed).toBe(true);
      expect(parseConfirmationResponse("\talways\n").confirmed).toBe(true);
      expect(parseConfirmationResponse("\talways\n").rememberChoice).toBe(true);
    });
  });
});
