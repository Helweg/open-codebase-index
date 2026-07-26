export type HostMode = "opencode" | "codex" | "claude" | "pi" | "jcode";

export const HOST_MODES: ReadonlyArray<HostMode> = ["opencode", "codex", "claude", "pi", "jcode"];

export function isSupportedHostMode(value: string): value is HostMode {
  return (HOST_MODES as ReadonlyArray<string>).includes(value);
}

export function parseHostMode(value: string | undefined): HostMode {
  const normalized = (value ?? "").toLowerCase();

  if (isSupportedHostMode(normalized)) {
    return normalized;
  }

  throw new Error(`Invalid host mode: ${value ?? "(none)"}. Allowed values: ${HOST_MODES.join(", ")}.`);
}
