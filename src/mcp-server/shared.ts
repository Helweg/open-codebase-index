import type { HostMode } from "../config/host.js";

export const MAX_CONTENT_LINES = 30;

export function truncateContent(content: string): string {
  const lines = content.split("\n");
  if (lines.length <= MAX_CONTENT_LINES) return content;
  return (
    lines.slice(0, MAX_CONTENT_LINES).join("\n") +
    `\n// ... (${lines.length - MAX_CONTENT_LINES} more lines)`
  );
}

export interface McpServerRuntime {
  projectRoot: string;
  host: HostMode;
}
