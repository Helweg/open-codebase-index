import { watch, type WatchEventType } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

interface RecursiveWatchCapability {
  code?: string;
  deliversEvents?: boolean;
  events?: Array<{ eventType: WatchEventType; filename: string | null }>;
  platform: NodeJS.Platform;
  supported: boolean;
}

function getErrorCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return undefined;
}

describe("recursive native watcher capability", () => {
  let projectRoot: string | undefined;
  let watcher: ReturnType<typeof watch> | undefined;

  afterEach(() => {
    watcher?.close();
    if (projectRoot) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("records whether the current Node runtime supports recursive fs.watch", async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "recursive-watch-capability-"));
    const events: Array<{ eventType: WatchEventType; filename: string | null }> = [];

    try {
      watcher = watch(projectRoot, { recursive: true }, (eventType, filename) => {
        events.push({
          eventType,
          filename: filename === null ? null : filename.toString(),
        });
      });
    } catch (error) {
      const code = getErrorCode(error);
      const capability: RecursiveWatchCapability = {
        code,
        platform: process.platform,
        supported: false,
      };
      console.log(`[watcher-capability] ${JSON.stringify(capability)}`);
      return;
    }

    fs.writeFileSync(path.join(projectRoot, "observed.ts"), "export const value = 1;\n");
    let deliversEvents = true;
    try {
      await vi.waitFor(() => {
        expect(events).not.toHaveLength(0);
      }, { timeout: 2_000, interval: 25 });
    } catch {
      deliversEvents = false;
    }

    const capability: RecursiveWatchCapability = {
      deliversEvents,
      events,
      platform: process.platform,
      supported: true,
    };
    console.log(`[watcher-capability] ${JSON.stringify(capability)}`);
  });
});
