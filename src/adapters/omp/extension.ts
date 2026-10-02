import { Type } from "typebox";

import {
  CODEBASE_INDEX_GUIDANCE,
  ensureCodebaseIndexSession,
  registerCodebaseIndexTools,
  type CodebaseIndexExtensionAPI,
  type ExtensionSchemaBuilder,
} from "../shared/extension-core.js";

/**
 * omp (oh-my-pi) implements the pi extension contract, so this wrapper registers
 * the shared core and pi-compatible `.codebase-index/` storage. omp exposes its
 * TypeBox-style builder as the namespace `pi.typebox` (`{ Type, default }`);
 * prefer `pi.typebox.Type` so parameter schemas come from the host, falling back
 * to this package's builder when the host exposes none.
 */
export type OmpExtensionAPI = CodebaseIndexExtensionAPI & {
  typebox?: { Type?: ExtensionSchemaBuilder };
  on(
    event: "before_agent_start",
    handler: (event: { systemPrompt: string[] }, ctx: { cwd: string }) => Promise<{ systemPrompt: string[] }>,
  ): void;
};

export default function codebaseIndexOmpExtension(pi: OmpExtensionAPI): void {
  registerCodebaseIndexTools(pi, pi.typebox?.Type ?? Type);
  pi.on("before_agent_start", async (event, ctx) => {
    await ensureCodebaseIndexSession(ctx.cwd);
    return { systemPrompt: [...event.systemPrompt, CODEBASE_INDEX_GUIDANCE] };
  });
}
