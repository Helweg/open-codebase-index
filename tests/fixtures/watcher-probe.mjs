import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const eventsPath = process.env.TEST_WATCHER_EVENTS_PATH;
const projectRoot = process.env.TEST_PROJECT_ROOT;
const readyPath = process.env.TEST_WATCHER_READY_PATH;
const startReleaseDirectory = process.env.TEST_WATCHER_START_RELEASE_DIRECTORY;
const heldPath = process.env.TEST_WATCHER_HELD_PATH;
const originalWatch = fs.watch;

if (eventsPath && projectRoot) {
  const canonicalProjectRoot = path.resolve(projectRoot);
  fs.watch = function watchWithProbe(target, ...args) {
    const targetPath = Buffer.isBuffer(target) ? target.toString() : String(target);
    if (path.resolve(targetPath).startsWith(canonicalProjectRoot)) {
      fs.appendFileSync(eventsPath, `${process.pid}\n`, "utf-8");
    }
    return originalWatch.call(this, target, ...args);
  };
  syncBuiltinESMExports();
}

if ((readyPath || startReleaseDirectory) && projectRoot) {
  const { FileWatcher } = await import("../../src/watcher/file-watcher.ts");
  const pendingStarts = new WeakMap();
  if (startReleaseDirectory) {
    const start = FileWatcher.prototype.start;
    FileWatcher.prototype.start = function startWithGate(...args) {
      if (heldPath) fs.appendFileSync(heldPath, `${process.pid}\n`, "utf-8");
      const pending = new Promise((resolve) => {
        const releasePath = path.join(startReleaseDirectory, String(process.pid));
        const check = () => {
          if (!fs.existsSync(releasePath)) {
            setTimeout(check, 10);
            return;
          }
          start.apply(this, args);
          resolve();
        };
        check();
      });
      pendingStarts.set(this, pending);
    };
  }
  const waitUntilReady = FileWatcher.prototype.waitUntilReady;
  FileWatcher.prototype.waitUntilReady = async function waitWithReadyProbe() {
    await pendingStarts.get(this);
    await waitUntilReady.call(this);
    if (readyPath && path.resolve(this.projectRoot) === path.resolve(projectRoot)) {
      fs.appendFileSync(readyPath, `${process.pid}\n`, "utf-8");
    }
  };
}
