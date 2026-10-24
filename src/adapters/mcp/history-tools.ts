import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HostMode } from "../../config/host.js";
import { HistoryError } from "../../history/config.js";
import { runRepositoryHistoryClear, runRepositoryHistorySearch, runRepositoryHistoryStatus, runRepositoryHistorySync } from "../../tools/history-operations.js";
import { TOOL_NAME } from "../../tools/tool-names.js";

export function registerMcpHistoryTools(server: McpServer, projectRoot: string, host: HostMode): void {
  const repository = z.string().optional().describe("Configured [HOST/]OWNER/REPO; HOST defaults to github.com; required when multiple sources are configured");
  const respond = async (operation: () => Promise<unknown>) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await operation(), null, 2) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof HistoryError ? error.message : "HISTORY_ERROR: local history operation failed" }] }; }
  };
  server.tool(TOOL_NAME.REPOSITORY_HISTORY_SYNC, "Manually sync an explicitly enabled GitHub.com or GitHub Enterprise issue/PR source. Read-only; local private lexical history, no embeddings. Full reconciliation may use many requests; interrupted fetches resume next manual sync.", {
    repository, since: z.string().optional().describe("Initial created-at window (ISO date); no bound when omitted/config absent"),
  }, (args, extra) => respond(() => runRepositoryHistorySync(args, projectRoot, host, { signal: extra.signal })));
  server.tool(TOOL_NAME.REPOSITORY_HISTORY_SEARCH, "Search LOCAL cached untrusted historical issue/PR evidence, separate from current code. Returns exact source citations/state/timestamps/commit provenance. No network, embeddings, or reranking; current code is authoritative.", {
    query: z.string(), repository, kind: z.enum(["issue", "pull_request"]).optional(), state: z.enum(["open", "closed", "merged", "draft"]).optional(), author: z.string().optional(), limit: z.number().int().min(1).max(100).optional(),
  }, (args, extra) => respond(() => runRepositoryHistorySearch(args, projectRoot, host, { signal: extra.signal })));
  server.tool(TOOL_NAME.REPOSITORY_HISTORY_STATUS, "Show local history opt-in, cached freshness, counts and last sync error without activating a code index/provider. Offline cache does not imply real-time GitHub permissions.", { repository },
    (args) => respond(() => runRepositoryHistoryStatus(args, projectRoot, host)));
  server.tool(TOOL_NAME.REPOSITORY_HISTORY_CLEAR, "Clear ONLY local history and unfinished fetch staging for a source, even if disabled. Does not change code indexes, credentials, or GitHub.", { repository },
    (args) => respond(() => runRepositoryHistoryClear(args, projectRoot, host)));
}
