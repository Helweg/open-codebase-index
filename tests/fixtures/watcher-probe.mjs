import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const eventsPath = process.env.TEST_WATCHER_EVENTS_PATH;
const projectRoot = process.env.TEST_PROJECT_ROOT;
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
