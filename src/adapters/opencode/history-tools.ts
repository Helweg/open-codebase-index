import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { runRepositoryHistoryClear, runRepositoryHistorySearch, runRepositoryHistoryStatus, runRepositoryHistorySync } from "../../tools/history-operations.js";

const z = tool.schema;
const repository = z.string().optional().describe("Configured GitHub.com owner/repo (not a URL)");
export const repository_history_sync: ToolDefinition = tool({
  description: "Manually sync explicitly enabled GitHub.com PR/issue history, including discussions. Read-only, local private lexical storage; no embeddings. Full reconciliation is resumable and may use many API requests.",
  args: { repository, since: z.string().optional().describe("Initial created-at window only; ISO date, omitted/config absent means all history") },
  async execute(args, context) { return JSON.stringify(await runRepositoryHistorySync(args, context?.worktree ?? process.cwd(), "opencode", { signal: context?.abort }), null, 2); },
});
export const repository_history_search: ToolDefinition = tool({
  description: "Search LOCAL cached untrusted historical GitHub issue/PR evidence, not code results or authoritative current behavior. Exact source URLs/excerpts/state/timestamps/commit provenance. No network, embeddings or rerank requests.",
  args: { query: z.string(), repository, kind: z.enum(["issue", "pull_request"]).optional(), state: z.enum(["open", "closed", "merged", "draft"]).optional(), author: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  async execute(args, context) { return JSON.stringify(await runRepositoryHistorySearch(args, context?.worktree ?? process.cwd(), "opencode", { signal: context?.abort }), null, 2); },
});
export const repository_history_status: ToolDefinition = tool({
  description: "Show local history enablement, cached freshness, counts, and last sync error. No code index/provider required; cached permissions are not real-time.", args: { repository },
  async execute(args, context) { return JSON.stringify(await runRepositoryHistoryStatus(args, context?.worktree ?? process.cwd(), "opencode"), null, 2); },
});
export const repository_history_clear: ToolDefinition = tool({
  description: "Clear ONLY this source's local history and unfinished fetch staging, even if disabled. No code-index changes, credentials changes or GitHub writes.", args: { repository },
  async execute(args, context) { return JSON.stringify(await runRepositoryHistoryClear(args, context?.worktree ?? process.cwd(), "opencode"), null, 2); },
});
