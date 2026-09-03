import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseConfig } from "../src/config/schema.js";
import { getHostProjectConfigRelativePath } from "../src/config/paths.js";
import type { HostMode } from "../src/config/host.js";
import { createMcpServer } from "../src/mcp-server.js";

const { indexerInstances, MockIndexer } = vi.hoisted(() => {
  const indexerInstances: Array<{
    projectRoot: string;
    config: Record<string, unknown>;
    getStatus: ReturnType<typeof vi.fn>;
  }> = [];

  class MockIndexer {
    public readonly projectRoot: string;
    public readonly config: Record<string, unknown>;
    public getStatus = vi.fn().mockResolvedValue({
      indexed: true,
      vectorCount: 0,
      provider: "ollama",
      model: "nomic-embed-text",
      indexPath: "/tmp/index",
      currentBranch: "main",
      baseBranch: "main",
    });

    public constructor(projectRoot: string, config: Record<string, unknown>) {
      this.projectRoot = projectRoot;
      this.config = config;
      indexerInstances.push({
        projectRoot,
        config,
        getStatus: this.getStatus,
      });
    }
  }

  return { indexerInstances, MockIndexer };
});

vi.mock("../src/indexer/index.js", () => ({
  Indexer: MockIndexer,
}));

interface Bootstrap {
  client: Client;
  close: () => Promise<void>;
}

function expectedConfigPath(projectRoot: string, host: HostMode): string {
  return path.join(projectRoot, getHostProjectConfigRelativePath(host));
}

function readConfigKnowledgeBases(configPath: string): string[] {
  if (!fs.existsSync(configPath)) {
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { knowledgeBases?: unknown };
  return Array.isArray(parsed.knowledgeBases) ? (parsed.knowledgeBases as string[]) : [];
}

describe("MCP knowledge-base tools", () => {
  let tempDir: string;
  let kbDir: string;

  beforeEach(() => {
    indexerInstances.length = 0;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-kb-test-"));
    kbDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-kb-source-"));
    vi.stubEnv("HOME", path.join(tempDir, "home"));
    vi.stubEnv("USERPROFILE", path.join(tempDir, "home"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
  });

  async function bootstrap(host: HostMode): Promise<Bootstrap & { configPath: string }> {
    const config = parseConfig({ indexing: { autoIndex: false, watchFiles: false } });
    const server = createMcpServer(tempDir, config, host);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    return {
      client,
      configPath: expectedConfigPath(tempDir, host),
      close: async () => {
        await client.close();
      },
    };
  }

  it("writes the knowledge base to the project-local claude host config and refreshes the indexer", async () => {
    const { client, configPath, close } = await bootstrap("claude");
    try {
      const baselineInstances = indexerInstances.length;

      const result = await client.callTool({
        name: "add_knowledge_base",
        arguments: { path: kbDir },
      });

      const content = result.content as Array<{ type: string; text?: string }>;
      expect(result.isError).not.toBe(true);
      expect(content[0].text).toContain(path.normalize(kbDir));
      expect(content[0].text).toContain("Total knowledge bases: 1");

      // The local config file is created at the host-specific path and holds the KB path.
      expect(configPath).toBe(path.join(tempDir, ".claude", "codebase-index.json"));
      expect(fs.existsSync(configPath)).toBe(true);
      const stored = readConfigKnowledgeBases(configPath);
      expect(stored).toHaveLength(1);
      expect(path.resolve(tempDir, stored[0])).toBe(path.resolve(kbDir));

      // refreshIndexerForDirectory constructed a new indexer with the updated knowledgeBases.
      expect(indexerInstances.length).toBe(baselineInstances + 1);
      expect(indexerInstances.at(-1)?.projectRoot).toBe(tempDir);
      expect(indexerInstances.at(-1)?.config.knowledgeBases).toEqual([path.normalize(kbDir)]);
    } finally {
      await close();
    }
  });

  it("writes the knowledge base to the project-local codebase-index host config for codex", async () => {
    const { client, configPath, close } = await bootstrap("codex");
    try {
      const result = await client.callTool({
        name: "add_knowledge_base",
        arguments: { path: kbDir },
      });

      const content = result.content as Array<{ type: string; text?: string }>;
      expect(result.isError).not.toBe(true);
      expect(content[0].text).toContain(path.normalize(kbDir));

      expect(configPath).toBe(path.join(tempDir, ".codebase-index", "config.json"));
      expect(fs.existsSync(configPath)).toBe(true);
      const stored = readConfigKnowledgeBases(configPath);
      expect(stored).toHaveLength(1);
      expect(path.resolve(tempDir, stored[0])).toBe(path.resolve(kbDir));
    } finally {
      await close();
    }
  });

  it("lists, removes, and persists the empty knowledge base list back to the local config", async () => {
    const { client, configPath, close } = await bootstrap("codex");
    try {
      await client.callTool({ name: "add_knowledge_base", arguments: { path: kbDir } });

      const listed = await client.callTool({ name: "list_knowledge_bases", arguments: {} });
      const listContent = listed.content as Array<{ type: string; text?: string }>;
      expect(listed.isError).not.toBe(true);
      expect(listContent[0].text).toContain(path.normalize(kbDir));
      expect(listContent[0].text).toContain("Exists");

      const removed = await client.callTool({
        name: "remove_knowledge_base",
        arguments: { path: kbDir },
      });
      const removeContent = removed.content as Array<{ type: string; text?: string }>;
      expect(removed.isError).not.toBe(true);
      expect(removeContent[0].text).toContain("Removed");
      expect(readConfigKnowledgeBases(configPath)).toEqual([]);

      const afterRemove = await client.callTool({ name: "list_knowledge_bases", arguments: {} });
      const afterContent = afterRemove.content as Array<{ type: string; text?: string }>;
      expect(afterContent[0].text).toContain("No knowledge bases configured");
    } finally {
      await close();
    }
  });

  it("returns a redacted structured error for a missing path without writing config or refreshing", async () => {
    const { client, configPath, close } = await bootstrap("claude");
    try {
      const baselineInstances = indexerInstances.length;
      const missingPath = path.join(tempDir, "does-not-exist");

      const result = await client.callTool({
        name: "add_knowledge_base",
        arguments: { path: missingPath },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          schemaVersion: 1,
          code: "INTERNAL_ERROR",
          operation: "add_knowledge_base",
          retryable: false,
        },
      });
      expect(JSON.stringify(result)).not.toContain(missingPath);
      expect(JSON.stringify(result)).not.toContain("Directory does not exist");
      expect(fs.existsSync(configPath)).toBe(false);
      expect(indexerInstances.length).toBe(baselineInstances);
    } finally {
      await close();
    }
  });

  it("treats a remove of an unconfigured knowledge base as a successful not-found result", async () => {
    const { client, close } = await bootstrap("claude");
    try {
      const result = await client.callTool({
        name: "remove_knowledge_base",
        arguments: { path: path.join(tempDir, "never-configured") },
      });

      const content = result.content as Array<{ type: string; text?: string }>;
      // "Knowledge base not found" is informational, not an "Error:"-prefixed failure.
      expect(result.isError).not.toBe(true);
      expect(content[0].text).toContain("Knowledge base not found");
    } finally {
      await close();
    }
  });

  it("rejects add_knowledge_base when the required path argument is missing", async () => {
    const { client, close } = await bootstrap("claude");
    try {
      const result = await client.callTool({ name: "add_knowledge_base", arguments: {} });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
