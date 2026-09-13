import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListRootsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { executeMcpOperation, hasActiveMcpExecutions } from "../../../src/adapters/mcp/operation-execution.js";
import { McpRuntimeDiagnostics } from "../../../src/adapters/mcp/runtime-diagnostics.js";
import { configCache, getIndexerCacheKey } from "../../../src/tools/operation-runtime.js";
import { parseConfig } from "../../../src/config/schema.js";

const server = new Server({ name: "cancellation-fixture", version: "1" }, { capabilities: { tools: {} } });
const projectRoot = process.argv[process.argv.indexOf("--project") + 1];
configCache.set(getIndexerCacheKey(projectRoot, "codex"), parseConfig({ mcp: { stallTimeoutMs: 0 } }));
const runtime = { projectRoot, host: "codex" as const, diagnostics: new McpRuntimeDiagnostics(projectRoot) };
let lastActivity = Date.now();
const progress = (token: string | number) => server.notification({
  method: "notifications/progress", params: { progressToken: token, progress: 1 },
});
server.setRequestHandler(CallToolRequestSchema, (request, extra) => executeMcpOperation(runtime, request.params.name, extra, async (control) => {
  try {
    if (request.params.name === "cancel" || request.params.name === "slow-cancel") {
      await progress(extra.requestId);
      await new Promise<void>((resolve) => control.signal!.addEventListener("abort", () => resolve(), { once: true }));
      if (request.params.name === "slow-cancel") await new Promise((resolve) => setTimeout(resolve, 350));
      await progress(`settled-${extra.requestId}`);
      if (Number(extra.requestId) % 2 === 0) throw new Error("Cancelled handler failed during cleanup.");
    }
    if (request.params.name === "reverse") {
      const controller = new AbortController();
      const pending = server.request({ method: "roots/list" }, ListRootsResultSchema, { signal: controller.signal });
      const timer = setTimeout(() => controller.abort(new Error("Fixture cancelled reverse request.")), 30);
      try { await pending; }
      catch (error) { if (!controller.signal.aborted) throw error; }
      finally { clearTimeout(timer); }
    }
    return { content: [{ type: "text", text: String(process.pid) }], pid: process.pid };
  } finally {
    lastActivity = Date.now();
  }
}));
await server.connect(new StdioServerTransport());
setInterval(() => process.send?.({ type: "activity", busy: hasActiveMcpExecutions(), lastActivity }), 20);
process.on("message", (message: { type: string }) => {
  if (message.type === "shutdown") process.exit(0);
  if (message.type === "prepare-sleep") process.send?.({ type: hasActiveMcpExecutions() ? "sleep-rejected" : "sleep-accepted" });
});
process.on("disconnect", () => process.exit(0));
