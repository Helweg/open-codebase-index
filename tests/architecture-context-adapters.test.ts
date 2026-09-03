import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeArchitectureContext = vi.hoisted(() => vi.fn());

vi.mock("../src/tools/execute-common.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/tools/execute-common.js")>(),
  executeArchitectureContext,
}));

import codebaseIndexPiExtension from "../src/pi-extension.js";
import { registerMcpTools } from "../src/adapters/mcp/register-tools.js";
import { McpRuntimeDiagnostics } from "../src/adapters/mcp/runtime-diagnostics.js";
import { architecture_context } from "../src/adapters/opencode/tools.js";
import { TOOL_NAME } from "../src/tools/tool-names.js";

interface RegisteredPiTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
    context: { cwd?: string },
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

const args = {
  query: "authentication architecture",
  directory: "src/auth",
  depth: 3,
  includeRecentActivity: true,
  tokenBudget: 900,
};

const details = {
  modules: [{
    id: "community-1",
    label: "Auth",
    symbolCount: 1,
    source: "community",
    evidence: [{
      symbolId: "auth",
      symbol: "validateToken",
      filePath: "src/auth/token.ts",
      line: 4,
      excerpt: "Validates authentication tokens.",
    }],
  }],
  boundaries: [],
  hubs: [],
  recentActivity: [],
  coverage: {
    symbols: 1,
    communities: 1,
    scoped: true,
    graphSparse: true,
    sourceFallback: false,
    note: "No resolved cross-module coupling was available in this scope.",
  },
  recommendations: ["implementation_lookup"],
  tokenBudget: 900,
  tokenEstimate: 120,
  omitted: { modules: 0, boundaries: 0, hubs: 0, recentActivity: 0 },
};

describe("architecture_context host execution contracts", () => {
  beforeEach(() => {
    executeArchitectureContext.mockReset().mockResolvedValue({
      text: "source-backed architecture response",
      details,
    });
  });

  it("executes the same portable contract through OpenCode, MCP, and Pi", async () => {
    const openCodeResult = await architecture_context.execute(
      args,
      { worktree: "/repo/opencode" } as Parameters<typeof architecture_context.execute>[1],
    );
    expect(openCodeResult).toBe("source-backed architecture response");
    expect(executeArchitectureContext).toHaveBeenNthCalledWith(1, "/repo/opencode", "opencode", args);

    const mcpServer = new McpServer({ name: "architecture-contract", version: "1.0.0" });
    registerMcpTools(mcpServer, {
      projectRoot: "/repo/mcp",
      host: "codex",
      diagnostics: new McpRuntimeDiagnostics(path.join(os.tmpdir(), "architecture-context-adapters-index")),
    });
    const client = new Client({ name: "architecture-contract-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const mcpResult = await client.callTool({ name: TOOL_NAME.ARCHITECTURE_CONTEXT, arguments: args });
      expect(mcpResult.content).toEqual([{ type: "text", text: "source-backed architecture response" }]);
    } finally {
      await client.close();
      await mcpServer.close();
    }
    expect(executeArchitectureContext).toHaveBeenNthCalledWith(
      2,
      "/repo/mcp",
      "codex",
      args,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const piTools = new Map<string, RegisteredPiTool>();
    codebaseIndexPiExtension({
      registerTool(tool) {
        piTools.set(tool.name, tool as unknown as RegisteredPiTool);
      },
      on() {},
    } as Pick<ExtensionAPI, "registerTool" | "on">);
    const piResult = await piTools.get(TOOL_NAME.ARCHITECTURE_CONTEXT)!.execute(
      "architecture-call",
      args,
      new AbortController().signal,
      () => {},
      { cwd: "/repo/pi" },
    );

    expect(piResult.content).toEqual([{ type: "text", text: "source-backed architecture response" }]);
    expect(piResult.details).toEqual(details);
    expect(executeArchitectureContext).toHaveBeenNthCalledWith(3, "/repo/pi", "pi", args);
  });
});
