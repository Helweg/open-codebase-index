import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Status = "expected-capture-missing" | "retained" | "capture-retention-failed";

// Separate from the snapshot destination so a refused/failed capture can still be reported.
export class FailureCaptureStatus {
  private readonly id = crypto.randomUUID();
  private expected = false;

  constructor(private readonly backend: string) {}

  report(status: Status, directory?: string): void {
    if (status === "expected-capture-missing" && this.expected) return;
    this.expected = true;
    const record = { schema: 1, backend: this.backend, status,
      ...(directory ? { capture: path.basename(directory) } : {}) };
    const line = `[watcher failure capture] ${JSON.stringify(record)}\n`;
    // Reporting is secondary: never replace the scenario's original failure.
    try { process.stderr.write(line); } catch { /* Best effort when stderr is closed. */ }
    try {
      const base = process.env.CI && process.env.RUNNER_TEMP ? process.env.RUNNER_TEMP : os.tmpdir();
      const parent = path.join(base, "ocbi-watcher-capture-status");
      fs.mkdirSync(parent, { mode: 0o700, recursive: true });
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe status directory");
      const temporary = path.join(parent, `${this.id}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, path.join(parent, `${this.id}.json`));
    } catch {
      // The Actions summary is an independent durable fallback if RUNNER_TEMP cannot be written.
      try {
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
          `\nWatcher capture status storage failed; see test log.\n\n\`\`\`json\n${JSON.stringify({ ...record, statusWrite: "failed" })}\n\`\`\`\n`);
      } catch { /* The original failure and stderr remain primary. */ }
    }
  }
}
