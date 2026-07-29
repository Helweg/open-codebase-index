import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerMcpPrompts(server: McpServer): void {
  server.prompt(
    "search",
    "Search codebase by meaning using semantic search",
    { query: z.string().describe("What to search for in the codebase") },
    (args) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Search the codebase for: "${args.query}"\n\nUse the codebase_search tool with this query. If you need just locations first, use codebase_peek instead to save tokens.`,
        },
      }],
    }),
  );

  server.prompt(
    "find",
    "Find code using hybrid approach (semantic + grep)",
    { query: z.string().describe("What to find in the codebase") },
    (args) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Find code related to: "${args.query}"\n\nUse a hybrid approach:\n1. First use codebase_peek to find semantic matches by meaning\n2. Then use grep for exact identifier matches\n3. Combine results for comprehensive coverage`,
        },
      }],
    }),
  );

  server.prompt(
    "index",
    "Index the codebase for semantic search",
    { options: z.string().optional().describe("Options: 'force' to rebuild, 'estimate' to check costs") },
    (args) => {
      const opts = args.options?.toLowerCase() ?? "";
      let instruction = "Use the index_codebase tool to index the codebase for semantic search.";
      if (opts.includes("force")) {
        instruction = "Use the index_codebase tool with force=true to rebuild the entire index from scratch.";
      } else if (opts.includes("estimate")) {
        instruction = "Use the index_codebase tool with estimateOnly=true to check the cost estimate before indexing.";
      }
      return {
        messages: [{
          role: "user",
          content: { type: "text", text: instruction },
        }],
      };
    },
  );

  server.prompt(
    "status",
    "Check if the codebase is indexed and ready",
    {},
    () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "Use the index_status tool to check if the codebase index is ready and show its current state.",
        },
      }],
    }),
  );

  server.prompt(
    "definition",
    "Find where a symbol is defined in the codebase",
    { query: z.string().describe("Symbol name or description to find the definition of") },
    (args) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Find the definition of: "${args.query}"\n\nUse the implementation_lookup tool to find where this symbol is defined. This prioritizes real implementation files over tests, docs, and examples. If no definition is found, fall back to codebase_search for broader discovery.`,
        },
      }],
    }),
  );
}
