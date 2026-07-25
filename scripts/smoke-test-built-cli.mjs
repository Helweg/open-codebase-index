import { spawn } from "node:child_process";

const cliPath = process.argv[2] ?? "dist/cli.js";
const child = spawn(process.execPath, [cliPath, "--host", "jcode"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.stdin.end();

const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal, survived: false }));

  setTimeout(() => {
    child.kill();
    resolve({ code: null, signal: "SIGTERM", survived: true });
  }, 2_000).unref();
});

if (!result.survived && result.code !== 0) {
  throw new Error(`Built ESM CLI failed with exit code ${result.code}:\n${stderr}`);
}
