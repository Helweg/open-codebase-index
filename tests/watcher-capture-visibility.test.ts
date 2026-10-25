import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { inspectWatcherCaptures, reportWatcherCaptures } from "../scripts/report-watcher-captures.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocbi-capture-visibility-"));
  roots.push(root);
  return root;
}

// A real failing subprocess exercises the helper without making the suite fail or sharing env/mocks.
function failScenario(base: string, mode: string) {
  const helper = new URL("./watcher/default-root-build-failure-capture.ts", import.meta.url).href;
  const script = `
    import * as fs from 'node:fs';
    import * as os from 'node:os';
    import * as path from 'node:path';
    import { DefaultRootBuildFailureCapture } from ${JSON.stringify(helper)};
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ocbi-include-excluded-project-'));
    const index = fs.mkdtempSync(path.join(os.tmpdir(), 'ocbi-include-excluded-index-'));
    let capture;
    try {
      if (${JSON.stringify(mode)} !== 'unrelated') {
        fs.writeFileSync(path.join(project, 'synthetic.ts'), 'export const synthetic = true;');
        capture = new DefaultRootBuildFailureCapture(project, index, 'chokidar');
        capture.fail(new Error('controlled-original-test-failure'));
      }
      throw new Error('controlled-original-test-failure');
    } finally {
      try {
        if (${JSON.stringify(mode)} !== 'missing') capture?.retainFailure({
          testFailed: true, watchersStopped: false, indexClosed: false });
      } finally {
        fs.rmSync(project, { recursive: true, force: true });
        fs.rmSync(index, { recursive: true, force: true });
      }
    }
  `;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, CI: "true", RUNNER_TEMP: base, GITHUB_STEP_SUMMARY: path.join(base, "summary.md") },
    encoding: "utf8", timeout: 30_000,
  });
}

function summaryRecords(base: string) {
  return fs.readFileSync(path.join(base, "summary.md"), "utf8").split("\n")
    .filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
}

describe("failure-only watcher capture visibility", () => {
  it.each([
    ["retained", "retained"],
    ["write-failure", "capture-retention-failed"],
    ["missing", "expected-capture-missing"],
    ["unrelated", undefined],
  ])("preserves original failure and reports %s", (mode, expected) => {
    const base = fixture();
    if (mode === "write-failure") fs.writeFileSync(path.join(base, "ocbi-watcher-failures"), "blocked");
    const result = failScenario(base, mode);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("controlled-original-test-failure");
    const records = reportWatcherCaptures(base, path.join(base, "summary.md"));
    expect(records.map((record) => record.status)).toEqual(expected ? [expected] : []);
    expect(JSON.parse(fs.readFileSync(path.join(base, "ocbi-watcher-capture-status", "report.json"), "utf8")).records)
      .toEqual(records);
    if (expected === "retained") {
      const directory = path.join(base, "ocbi-watcher-failures", records[0].capture!);
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, "capture.json"), "utf8"));
      expect(metadata.phaseCounts.failure).toBe(1);
      expect(metadata.anchors.failure.first.detail).toContain("controlled-original-test-failure");
      expect(metadata.snapshot.watchersStopped).toBe(false);
      expect(metadata.snapshot.indexClosed).toBe(false);
      expect(fs.existsSync(path.join(directory, "index"))).toBe(false);
      fs.unlinkSync(path.join(directory, "capture.json"));
      expect(inspectWatcherCaptures(base)[0].status).toBe("expected-capture-missing");
    }
  });

  it("keeps a durable summary fallback when the status directory cannot be written", () => {
    const base = fixture();
    fs.writeFileSync(path.join(base, "ocbi-watcher-capture-status"), "blocked");
    const result = failScenario(base, "retained");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("controlled-original-test-failure");
    const fallback = summaryRecords(base);
    expect(fallback.map((record) => record.status)).toEqual(["expected-capture-missing", "retained"]);
    expect(fallback.map((record) => record.statusWrite)).toEqual(["failed", "failed"]);
    expect(reportWatcherCaptures(base, path.join(base, "summary.md"))[0].status).toBe("expected-capture-missing");
    expect(summaryRecords(base).at(-1).records).toEqual([{ status: "expected-capture-missing" }]);
    expect(inspectWatcherCaptures(base)[0].status).toBe("expected-capture-missing");
  });

  it("does not infer a clean capture exemption from absent durable records", () => {
    const base = fixture();
    expect(reportWatcherCaptures(base, path.join(base, "summary.md"))).toEqual([]);
    const report = JSON.parse(fs.readFileSync(path.join(base, "ocbi-watcher-capture-status", "report.json"), "utf8"));
    expect(report.status).toBe("no-records-unknown");
    expect(report.records).toEqual([]);
  });

  it("refuses a symlinked status directory without reading or writing outside it", () => {
    const base = fixture();
    const outside = fixture();
    const sentinel = path.join(outside, "report.json");
    fs.writeFileSync(sentinel, "outside-sentinel");
    fs.symlinkSync(outside, path.join(base, "ocbi-watcher-capture-status"), "dir");
    expect(reportWatcherCaptures(base, path.join(base, "summary.md"))).toEqual([{ status: "expected-capture-missing" }]);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("outside-sentinel");
    expect(fs.readdirSync(outside)).toEqual(["report.json"]);
    expect(summaryRecords(base).at(-1).records).toEqual([{ status: "expected-capture-missing" }]);
  });

  it.each(["parent", "bundle"])("refuses a symlinked capture %s", (boundary) => {
    const base = fixture();
    const outside = fixture();
    fs.writeFileSync(path.join(outside, "capture.json"), "outside-sentinel");
    const statuses = path.join(base, "ocbi-watcher-capture-status");
    fs.mkdirSync(statuses, { mode: 0o700 });
    fs.writeFileSync(path.join(statuses, "failure.json"), JSON.stringify({
      backend: "chokidar", status: "retained", capture: "chokidar-synthetic",
    }));
    const parent = path.join(base, "ocbi-watcher-failures");
    if (boundary === "parent") {
      fs.mkdirSync(path.join(outside, "chokidar-synthetic"));
      fs.writeFileSync(path.join(outside, "chokidar-synthetic", "capture.json"), "outside-sentinel");
      fs.symlinkSync(outside, parent, "dir");
    } else {
      fs.mkdirSync(parent);
      fs.symlinkSync(outside, path.join(parent, "chokidar-synthetic"), "dir");
    }
    expect(inspectWatcherCaptures(base)[0].status).toBe("expected-capture-missing");
    expect(fs.readFileSync(path.join(outside, "capture.json"), "utf8")).toBe("outside-sentinel");
  });
});
