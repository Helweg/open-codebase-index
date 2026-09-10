import { runIdleSupervisor } from "../../../src/adapters/mcp/idle-supervisor.js";
await runIdleSupervisor(new URL("./worker.cjs", import.meta.url), process.argv.slice(2), 100);
