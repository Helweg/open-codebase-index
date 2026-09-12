const readline = require("node:readline");
const fs = require("node:fs");
if (process.argv.includes("--owner-file")) {
  const ownerFile = process.argv[process.argv.indexOf("--owner-file") + 1];
  if (fs.existsSync(ownerFile)) {
    let alive = true;
    try { process.kill(Number(fs.readFileSync(ownerFile, "utf8")), 0); }
    catch (error) {
      if (error.code !== "ESRCH") throw error;
      alive = false;
    }
    if (alive) throw new Error("Replacement started before the old worker exited.");
  }
  fs.writeFileSync(ownerFile, String(process.pid));
}
const input = readline.createInterface({ input: process.stdin });
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let active = 0;
let rejected = false;
let ready = false;
let lastActivity = Date.now();
const activity = setInterval(() => process.send({ type: "activity", busy: active > 0, lastActivity }), 20);
process.on("disconnect", () => process.exit(0));
process.on("message", (message) => {
  if (message.type === "shutdown") {
    if (process.argv.includes("--stall-sleep")) return;
    process.exit(0);
  }
  if (message.type === "prepare-sleep") {
    if (process.argv.includes("--stall-sleep")) {
      console.error("fixture preparing sleep");
      return;
    }
    if (process.argv.includes("--reject-sleep") && !rejected) {
      rejected = true;
      console.error("fixture preparing sleep");
      setTimeout(() => process.send({ type: "sleep-rejected" }), 100);
      return;
    }
    process.send({ type: active ? "sleep-rejected" : "sleep-accepted" });
  }
});
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (process.argv.includes("--startup-failure")) process.exit(1);
    if (process.argv.includes("--slow-start")) {
      setTimeout(() => write({ id: message.id, result: {} }), 150);
      return;
    }
    write({ id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } });
    return;
  }
  if (message.method === "notifications/initialized") {
    ready = true;
    if (process.argv.includes("--stall-input")) input.pause();
    return;
  }
  if (message.method === "notifications/cancelled") {
    write({ method: "notifications/progress", params: { progressToken: "cancelled", progress: 1 } }); return;
  }
  if (message.id !== undefined && !message.method) {
    if (message.id === "stale1" || message.id === "stale2") {
      write({ method: "notifications/progress", params: { progressToken: "stale-replayed", progress: 1 } });
      return;
    }
    if (message.id === 1 || message.id === "1") {
      write({ method: "notifications/progress", params: { progressToken: `${typeof message.id}:${message.id}`, progress: 1 } });
      return;
    }
    write({ method: "notifications/progress", params: { progressToken: "reverse-reply", progress: 1 } }); return;
  }
  if (!message.method || message.id === undefined) return;
  if (!ready) { write({ id: message.id, error: { code: -32603, message: "Not initialized" } }); return; }
  if (message.params?.name === "index_status" && process.argv.includes("--always-crash")) process.exit(1);
  if (message.params?.name === "stale-reverse") {
    write({ id: "stale1", method: "roots/list" });
    write({ id: "stale2", method: "roots/list" });
    input.pause();
    setTimeout(() => process.exit(1), 150);
    return;
  }
  if (message.params?.name === "crash") process.exit(1);
  if (message.params?.name === "index_status" && process.argv.includes("--crash-once")) {
    const marker = process.argv[process.argv.indexOf("--crash-once") + 1];
    if (!fs.existsSync(marker)) { fs.writeFileSync(marker, "crashed"); process.exit(1); }
  }
  if (message.params?.name === "distinct-reverse") {
    write({ id: 1, method: "roots/list" });
    write({ id: "1", method: "roots/list" });
  }
  if (message.params?.name === "reverse") write({ id: "reverse", method: "roots/list" });
  active++;
  write({ method: "notifications/progress", params: { progressToken: message.params?._meta?.progressToken ?? "fixture", progress: 0 } });
  setTimeout(() => {
    active--;
    lastActivity = Date.now();
    write({ id: message.id, result: { pid: process.pid, ...(message.params?.name === "large" ? { payload: "x".repeat(256 * 1024) } : {}) } });
  }, message.params?.name === "slow" ? 350 : 0);
});
input.on("close", () => { clearInterval(activity); process.exit(0); });
