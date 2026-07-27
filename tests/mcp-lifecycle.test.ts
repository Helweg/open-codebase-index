import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseConfig } from "../src/config/schema.js";
import { createMcpServer } from "../src/mcp-server.js";
import { resetAutoIndexCoordinatorsForTests } from "../src/utils/auto-index.js";

const autoIndexMocks = vi.hoisted(() => ({
  startAutoIndex: vi.fn(),
  stopAutoIndex: vi.fn(async () => {}),
}));

vi.mock("../src/utils/auto-index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/auto-index.js")>(
    "../src/utils/auto-index.js",
  );
  return {
    ...actual,
    startAutoIndex: autoIndexMocks.startAutoIndex,
    stopAutoIndex: autoIndexMocks.stopAutoIndex,
  };
});

function pendingStop(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("MCP automatic indexing lifecycle", () => {
  beforeEach(() => {
    autoIndexMocks.startAutoIndex.mockReset();
    autoIndexMocks.stopAutoIndex.mockReset();
    autoIndexMocks.stopAutoIndex.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await resetAutoIndexCoordinatorsForTests();
  });

  it("awaits coordination shutdown from the high-level server close", async () => {
    const stop = pendingStop();
    autoIndexMocks.stopAutoIndex.mockReturnValueOnce(stop.promise);
    const server = createMcpServer("/tmp/mcp-close-project", parseConfig({}), "jcode");

    let settled = false;
    const closing = server.close().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(autoIndexMocks.stopAutoIndex).toHaveBeenCalledWith("/tmp/mcp-close-project", "jcode");
    expect(settled).toBe(false);
    stop.resolve();
    await closing;
    expect(settled).toBe(true);
  });

  it("awaits coordination shutdown from the low-level server close", async () => {
    const stop = pendingStop();
    autoIndexMocks.stopAutoIndex.mockReturnValueOnce(stop.promise);
    const server = createMcpServer("/tmp/mcp-shutdown-project", parseConfig({}), "claude");

    let settled = false;
    const closing = server.server.close().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(autoIndexMocks.stopAutoIndex).toHaveBeenCalledWith("/tmp/mcp-shutdown-project", "claude");
    expect(settled).toBe(false);
    stop.resolve();
    await closing;
    expect(settled).toBe(true);
  });

  it("stops coordination when the MCP transport shuts down", async () => {
    const server = createMcpServer("/tmp/mcp-transport-project", parseConfig({}), "codex");
    const client = new Client({ name: "lifecycle-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.close();

    await vi.waitFor(() => {
      expect(autoIndexMocks.stopAutoIndex).toHaveBeenCalledWith("/tmp/mcp-transport-project", "codex");
    });
  });
});
