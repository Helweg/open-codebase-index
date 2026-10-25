import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function checkedDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || fs.realpathSync(directory) !== path.join(fs.realpathSync(path.dirname(directory)), path.basename(directory))) {
    throw new Error("Unsafe diagnostic directory");
  }
}

export function inspectWatcherCaptures(base) {
  const statusDirectory = path.join(base, "ocbi-watcher-capture-status");
  let names;
  try {
    checkedDirectory(base);
    checkedDirectory(statusDirectory);
    names = fs.readdirSync(statusDirectory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    return [{ status: "capture-status-unavailable" }];
  }
  return names.filter((name) => name.endsWith(".json") && name !== "report.json").slice(0, 32).map((name) => {
    try {
      const file = path.join(statusDirectory, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw new Error("Invalid status file");
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (record?.schema !== 1 || !["auto", "native", "chokidar"].includes(record.backend)
        || !["expected-capture-missing", "capture-retention-failed", "retained"].includes(record.status)) {
        throw new Error("Invalid status record");
      }
      const backend = record.backend;
      if (record.status !== "retained") return { backend, status: record.status };
      if (typeof record.capture !== "string" || !/^[a-zA-Z0-9-]+$/.test(record.capture)) {
        throw new Error("Invalid capture identity");
      }
      try {
        const parent = path.join(base, "ocbi-watcher-failures");
        checkedDirectory(parent);
        const directory = path.join(parent, record.capture);
        checkedDirectory(directory);
        const captureStat = fs.lstatSync(path.join(directory, "capture.json"));
        if (captureStat.isFile() && !captureStat.isSymbolicLink() && captureStat.size > 0) {
          return { backend, status: "retained", capture: record.capture };
        }
      } catch {
        // Only a valid retained record establishes an expected usable bundle.
      }
      return { backend, status: "expected-capture-missing" };
    } catch {
      return { status: "capture-status-unavailable" };
    }
  });
}

export function reportWatcherCaptures(base, summary) {
  const records = inspectWatcherCaptures(base);
  const status = records.length === 0 ? "no-records-unknown" : "reported";
  const report = { schema: 1, status, records };
  const text = records.length === 0
    ? "Watcher captures: no durable status records; covered-failure expectation unknown. No capture obligation inferred.\n"
    : `Watcher failure captures:\n${records.map((record) => `- ${record.backend ?? "unknown"}: ${record.status}`).join("\n")}\n`;
  console.log(text);
  // Independent of the report destination, including a refused or unwritable directory.
  if (summary) fs.appendFileSync(summary,
    `\n### Watcher capture diagnostics\n\n${text}\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n`);
  const directory = path.join(base, "ocbi-watcher-capture-status");
  try {
    checkedDirectory(base);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    checkedDirectory(directory);
    const temporary = path.join(directory, `${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, "report.json"));
  } catch {
    console.error("Watcher capture status report could not be retained; see job summary and test log.");
  }
  return records;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  reportWatcherCaptures(process.env.RUNNER_TEMP, process.env.GITHUB_STEP_SUMMARY);
}
