import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

// Only the default-root-build acceptance scenario owns this diagnostic.
export const CAPTURE_LIMITS = {
  events: 512,
  eventBytes: 2048,
  entries: 256,
  snapshotBytes: 16 * 1024 * 1024,
  totalBytes: 18 * 1024 * 1024,
} as const;

const ANCHORED_PHASES: Record<string, true> = {
  scenario: true, "ready-start": true, "ready-end": true, write: true,
  "callback-start": true, "callback-end": true, "callback-error": true,
  "index-start": true, "index-end": true, "index-error": true, failure: true,
  cleanup: true, warning: true, backend: true,
  "backend-ready": true, raw: true, "backend-event": true, "backend-error": true,
};
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

type Event = { ms: number; phase: string; detail: string };
type Root = { label: "project" | "index"; directory: string; identity: fs.Stats };
type Entry = { path: string; bytes?: number; missing?: string };

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function checkedDirectory(directory: string): fs.Stats {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || fs.realpathSync(directory) !== path.join(fs.realpathSync(path.dirname(directory)), path.basename(directory))) {
    throw new Error("MISSING: unsafe directory boundary");
  }
  return stat;
}

export class DefaultRootBuildFailureCapture {
  private readonly started = performance.now();
  private readonly roots: Root[] = [];
  private readonly events: Event[] = [];
  private nextEvent = 0;
  private readonly anchors: Record<string, { first: Event; last: Event }> = {};
  private dropped = 0;
  private totalEvents = 0;
  private readonly phaseCounts: Record<string, number> = {};
  private detailByteCuts = 0;
  private failed = false;
  private readonly missing: string[] = [];

  constructor(projectDir: string, indexRoot: string, private readonly backend: string) {
    for (const [label, directory, prefix] of [
      ["project", projectDir, "ocbi-include-excluded-project-"],
      ["index", indexRoot, "ocbi-include-excluded-index-"],
    ] as const) {
      try {
        const identity = checkedDirectory(directory);
        if (fs.realpathSync(path.dirname(directory)) !== fs.realpathSync(os.tmpdir())
          || !path.basename(directory).startsWith(prefix)
          || (process.getuid && identity.uid !== process.getuid())) {
          throw new Error("MISSING: not an owned scenario fixture root");
        }
        this.roots.push({ label, directory, identity });
      } catch (error) {
        this.missing.push(`${label}: ${this.text(error)}`);
      }
    }
    this.record("scenario", { backend, host: "jcode", platform: process.platform,
      arch: process.arch, osRelease: os.release(), node: process.version, versions: process.versions,
      gaps: { filtering: "MISSING", queued: "MISSING", flush: "MISSING",
        nativeNotifications: "MISSING: no public passive emitter",
        chokidarReplacement: "MISSING: listeners cover only the captured emitter" } });
  }

  private text(value: unknown): string {
    let text = inspect(value, { depth: 3, maxArrayLength: 20, maxStringLength: 1024,
      customInspect: false, getters: false, breakLength: Infinity });
    for (const root of this.roots) text = text.replaceAll(root.directory, `<${root.label}>`);
    text = text.replaceAll(REPO_ROOT.replace(/[\\/]$/, ""), "<checkout>")
      .replaceAll(os.homedir(), "<home>")
      .replaceAll(os.tmpdir(), "<tmp>");
    // Raw backend errors may name unrelated absolute paths. Never retain those names.
    text = text.replace(/(?<![\w>])(?:[A-Za-z]:[\\/]|\/)[^\s'"<>),\]}]+/g, "<external-path>");
    const bytes = Buffer.from(text);
    if (bytes.length > 1500) this.detailByteCuts += 1;
    return bytes.subarray(0, 1500).toString("utf8");
  }

  record(phase: string, detail?: unknown): void {
    // Diagnostics must not change callback/query error propagation, even for unusual values.
    try {
      this.totalEvents += 1;
      this.phaseCounts[phase] = (this.phaseCounts[phase] ?? 0) + 1;
      const event = { ms: performance.now() - this.started, phase: phase.slice(0, 64), detail: this.text(detail) };
      while (Buffer.byteLength(JSON.stringify(event)) > CAPTURE_LIMITS.eventBytes) {
        event.detail = event.detail.slice(0, Math.floor(event.detail.length / 2));
        this.detailByteCuts += 1;
      }
      if (this.events.length === CAPTURE_LIMITS.events) this.dropped += 1;
      this.events[this.nextEvent] = event;
      this.nextEvent = (this.nextEvent + 1) % CAPTURE_LIMITS.events;
      if (Object.hasOwn(ANCHORED_PHASES, phase)) {
        const anchor = this.anchors[phase];
        this.anchors[phase] = { first: anchor?.first ?? event, last: event };
      }
    } catch {
      this.dropped += 1;
    }
  }

  fail(error: unknown): void {
    this.failed = true;
    this.record("failure", error);
  }

  private assertRoot(root: Root): void {
    if (!sameIdentity(root.identity, checkedDirectory(root.directory))) {
      throw new Error("MISSING: fixture root identity changed");
    }
  }

  private nativeObservation(): unknown {
    let suffix = "";
    if (process.platform === "linux") suffix = "-gnu";
    if (process.platform === "win32") suffix = "-msvc";
    const filename = `codebase-index-native.${process.platform}-${process.arch}${suffix}.node`;
    const nativePath = path.join(REPO_ROOT, "native", filename);
    // Observe only the ordinary cache; do not require, import, or reload the addon.
    const cached = createRequire(import.meta.url).cache[nativePath];
    if (!cached) return { cache: "MISSING", executedBytes: "MISSING" };
    const observation = { cache: { filename: `native/${filename}`, loaded: cached.loaded },
      executedBytes: "MISSING: cache identity and current disk bytes do not prove executed bytes" };
    try {
      const before = fs.lstatSync(nativePath);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64 * 1024 * 1024) {
        throw new Error("unsafe native disk file");
      }
      const fd = fs.openSync(nativePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!sameIdentity(before, fs.fstatSync(fd))) throw new Error("native disk identity changed");
        const hash = crypto.createHash("sha256");
        const buffer = Buffer.alloc(64 * 1024);
        let remaining = before.size;
        while (remaining > 0) {
          const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
          if (!count) throw new Error("native disk read incomplete");
          hash.update(buffer.subarray(0, count));
          remaining -= count;
        }
        const after = fs.fstatSync(fd);
        if (!sameIdentity(before, after) || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          throw new Error("native disk changed during hash");
        }
        return { ...observation, currentDiskOnlySha256: hash.digest("hex") };
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      return { ...observation, currentDiskOnlySha256: this.text(error) };
    }
  }

  // Called only after watcher stop, handler tails, and indexer close have settled.
  // The caller still owns unconditional fixture deletion and the original test outcome.
  retainFailure(options: {
    testFailed: boolean; watchersStopped: boolean; indexClosed: boolean;
  }): { directory?: string; missing?: string } {
    if (!this.failed && !options.testFailed) return {};
    try {
      const requestedBase = process.env.CI && process.env.RUNNER_TEMP ? process.env.RUNNER_TEMP : os.tmpdir();
      checkedDirectory(requestedBase);
      const base = fs.realpathSync(requestedBase);
      const parent = path.join(base, "ocbi-watcher-failures");
      try {
        fs.mkdirSync(parent, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const parentStat = checkedDirectory(parent);
      if ((process.getuid && parentStat.uid !== process.getuid()) || (parentStat.mode & 0o077) !== 0) {
        throw new Error("MISSING: artifact parent is not private/owned");
      }
      const directory = fs.mkdtempSync(path.join(parent, `${this.backend}-`));
      fs.chmodSync(directory, 0o700);
      if (!sameIdentity(parentStat, checkedDirectory(parent))) throw new Error("MISSING: artifact parent changed");
      checkedDirectory(directory);
      const entries: Entry[] = [];
      let bytes = 0;
      let visited = 0;
      const copy = (root: Root, relative: string): void => {
        if (visited >= CAPTURE_LIMITS.entries) return;
        visited += 1;
        const source = path.join(root.directory, relative);
        const destination = path.join(directory, root.label, relative);
        const name = path.join(root.label, relative).replaceAll("\\", "/");
        try {
          this.assertRoot(root);
          if (fs.realpathSync(path.dirname(source)) !== path.join(fs.realpathSync(root.directory), path.dirname(relative))) {
            throw new Error("MISSING: parent path escaped/replaced");
          }
          const before = fs.lstatSync(source);
          if (before.isSymbolicLink()) throw new Error("MISSING: symlink refused");
          if (before.isDirectory()) {
            const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
              if (!sameIdentity(before, fs.fstatSync(fd))) throw new Error("MISSING: directory identity changed");
              fs.mkdirSync(destination, { mode: 0o700 });
              const dir = fs.opendirSync(source);
              try {
                let child: fs.Dirent | null;
                while (visited < CAPTURE_LIMITS.entries && (child = dir.readSync())) {
                  copy(root, path.join(relative, child.name));
                }
              } finally {
                dir.closeSync();
              }
            } finally {
              fs.closeSync(fd);
            }
          } else {
            if (!before.isFile() || before.nlink !== 1) throw new Error("MISSING: special/hardlinked file refused");
            if (before.size > CAPTURE_LIMITS.snapshotBytes - bytes) throw new Error("MISSING: snapshot byte cap");
            const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
              const opened = fs.fstatSync(fd);
              if (!sameIdentity(before, opened) || opened.nlink !== 1 || opened.size !== before.size) {
                throw new Error("MISSING: opened file identity/size changed");
              }
              this.assertRoot(root);
              const data = Buffer.alloc(before.size);
              let offset = 0;
              while (offset < data.length) {
                const count = fs.readSync(fd, data, offset, data.length - offset, null);
                if (!count) throw new Error("MISSING: incomplete fixture read");
                offset += count;
              }
              const after = fs.fstatSync(fd);
              if (!sameIdentity(opened, after) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
                throw new Error("MISSING: fixture changed during capture");
              }
              bytes += data.length; // Reserve even if a write partially fails.
              fs.writeFileSync(destination, data, { flag: "wx", mode: 0o600 });
              entries.push({ path: name.slice(0, 512), bytes: data.length });
            } finally {
              fs.closeSync(fd);
            }
          }
        } catch (error) {
          entries.push({ path: this.text(name), missing: this.text(error) });
        }
      };
      for (const root of this.roots) {
        if (root.label === "index" && (!options.watchersStopped || !options.indexClosed)) {
          this.missing.push("index: MISSING: watcher stop or indexer close did not succeed; quiescence unverified; database snapshot refused");
          continue;
        }
        try {
          this.assertRoot(root);
          const fd = fs.openSync(root.directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try {
            if (!sameIdentity(root.identity, fs.fstatSync(fd))) throw new Error("MISSING: opened root changed");
            fs.mkdirSync(path.join(directory, root.label), { mode: 0o700 });
            const dir = fs.opendirSync(root.directory);
            try {
              let child: fs.Dirent | null;
              while (visited < CAPTURE_LIMITS.entries && (child = dir.readSync())) copy(root, child.name);
            } finally {
              dir.closeSync();
            }
          } finally {
            fs.closeSync(fd);
          }
        } catch (error) {
          this.missing.push(`${root.label}: ${this.text(error)}`);
        }
      }
      const events = this.events.length === CAPTURE_LIMITS.events
        ? [...this.events.slice(this.nextEvent), ...this.events.slice(0, this.nextEvent)]
        : this.events;
      let metadata = JSON.stringify({ schema: 1, backend: this.backend, host: "jcode", limits: CAPTURE_LIMITS,
        runtime: { node: process.version, versions: process.versions, platform: process.platform,
          arch: process.arch, osRelease: os.release(), pid: process.pid },
        elapsedMs: performance.now() - this.started, droppedEvents: this.dropped, detailByteCuts: this.detailByteCuts,
        totalEvents: this.totalEvents, phaseCounts: this.phaseCounts, events, anchors: this.anchors,
        missing: [...this.missing, "filtering: MISSING", "queued: MISSING", "flush: MISSING",
          "native notifications: MISSING", "replacement Chokidar emitter coverage: MISSING",
          "snapshot portability: POSIX mode/directory-FD guards; Windows coverage MISSING"],
        native: this.nativeObservation(), snapshot: { bytes, visited, entryCapReached: visited >= CAPTURE_LIMITS.entries,
          watchersStopped: options.watchersStopped, indexClosed: options.indexClosed, entries },
        privacy: "Raw fixture index bytes may embed fixture paths; diagnostic text is redacted. Not an adversarial race-proof copier.",
      }, null, 2);
      if (Buffer.byteLength(metadata) + bytes > CAPTURE_LIMITS.totalBytes) {
        metadata = JSON.stringify({ missing: "MISSING: shared metadata byte cap", limits: CAPTURE_LIMITS,
          snapshotBytes: bytes, visited, droppedEvents: this.dropped, detailByteCuts: this.detailByteCuts,
          totalEvents: this.totalEvents, phaseCounts: this.phaseCounts,
          watchersStopped: options.watchersStopped, indexClosed: options.indexClosed, anchors: this.anchors });
      }
      fs.writeFileSync(path.join(directory, "capture.json"), metadata, { flag: "wx", mode: 0o600 });
      return { directory };
    } catch (error) {
      return { missing: this.text(error) };
    }
  }
}
