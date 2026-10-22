import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { HostMode } from "./config/host.js";
import { createHistoryMcpServer } from "./adapters/mcp/history-server.js";

/** Separate bundle: CLI help and local cache lifecycle cannot acquire SDK/native dependencies. */
export async function runHistoryWorker(projectRoot: string, host: HostMode): Promise<void> {
  const server = createHistoryMcpServer(projectRoot, host);
  await server.connect(new StdioServerTransport());
}
