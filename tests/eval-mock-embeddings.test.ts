import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ChunkMetadata } from "../src/native/types.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, expect, it } from "vitest";

import { VectorStore } from "../src/native/vector-store.js";

let server: ChildProcessByStdio<null, Readable, Readable>;
let tempDir: string;
let endpoint: string;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-mock-embeddings-"));
  server = spawn(process.execPath, [path.resolve("scripts/eval-mock-embeddings-server.mjs")], {
    env: { ...process.env, EVAL_EMBED_PORT: "0", EVAL_EMBED_DIMS: "16" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  server.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  await once(server, "spawn");
  const lines = createInterface({ input: server.stdout });
  for await (const line of lines) {
    const match = line.match(/listening on (http:\/\/127\.0\.0\.1:\d+\/v1\/embeddings)/u);
    if (match) {
      endpoint = match[1];
      lines.close();
      return;
    }
  }
  throw new Error(`Mock embedding server exited (${server.exitCode}): ${errors}`);
});

afterAll(async () => {
  try {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it("keeps repeated inputs stable without collapsing hash-collision inputs through F16 search", async () => {
  // These distinct strings collided under the former 31-based mock hash.
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: ["Aa", "BB", "Aa"] }),
  });
  expect(response.status).toBe(200);
  const payload = await response.json() as { data: { embedding: number[] }[] };
  const [first, second, repeated] = payload.data.map((row) => row.embedding);
  expect(first).toHaveLength(16);
  expect(repeated).toEqual(first);

  const store = new VectorStore(path.join(tempDir, "vectors"), 16);
  const metadata: ChunkMetadata = {
    filePath: "fixture.ts",
    startLine: 1,
    endLine: 1,
    language: "typescript",
    chunkType: "function",
    hash: "fixture",
  };
  store.addBatch([
    { id: "first", vector: first, metadata },
    { id: "second", vector: second, metadata },
  ]);
  const results = store.search(first, 2);
  expect(results.map((row) => row.id)).toEqual(["first", "second"]);
  expect(results[0].score).toBeGreaterThan(0.99);
  expect(results[1].score).toBeLessThan(0.95);
});
