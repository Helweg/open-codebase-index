import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractApiUsages } from "../src/native/index.js";
import { buildApiImpactEvidence } from "../src/tools/api-impact.js";

const temporaryRoots: string[] = [];

async function tempProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-impact-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("API usage extraction", () => {
  it("uses AST facts and rejects comments, strings, dynamic paths, imported handlers, protocol-relative URLs, and shadowed fetch", () => {
    const source = `
      import express from "express";
      import { importedHandler } from "./other.js";
      const app = express();
      const local = (_req, res) => res.sendStatus(204);
      const dynamic = "/dynamic";
      // app.get('/comment', local)
      const sample = "app.get('/string', local)";
      app.delete('/items/one', local);
      app.get(dynamic, local);
      app.post('/imported', importedHandler);
      fetch('/items/one', { method: 'DELETE' });
      fetch('//cdn.example/item');
      fetch(\`/items/\${id}\`);
    `;
    const result = extractApiUsages(source, "typescript");
    expect(result.routes.map((route) => `${route.method} ${route.path}`)).toEqual(["DELETE /items/one"]);
    expect(result.fetches.map((fetch) => `${fetch.method} ${fetch.path}`)).toEqual(["DELETE /items/one"]);

    const shadowed = extractApiUsages("function run(fetch) { fetch('/items/one'); }", "javascript");
    expect(shadowed.fetches).toEqual([]);
  });
});

describe("bounded API impact evidence", () => {
  it("matches exact relative consumers in indexed scope and labels tests as candidates", async () => {
    const root = await tempProject();
    await writeFile(path.join(root, "src/routes.ts"), `
      import express from "express";
      const app = express();
      export function createUser(_req, res) { res.sendStatus(201); }
      app.post('/users', createUser);
    `);
    await writeFile(path.join(root, "src/client.ts"), "void fetch('/users', { method: 'POST' });");
    await writeFile(path.join(root, "tests/routes.test.ts"), "it('creates', async () => { await fetch('/users', { method: 'POST' }); });");
    await writeFile(path.join(root, "src/excluded.ts"), "export function hidden() { return fetch('/users', { method: 'POST' }); }");

    const evidence = await buildApiImpactEvidence(root, {
      symbol: "createUser",
      filePath: "src/routes.ts",
      startLine: 4,
    }, ["src/routes.ts", "src/client.ts", "tests/routes.test.ts"]);

    expect(evidence.text).toContain("POST /users at src/routes.ts:5");
    expect(evidence.text).toContain("src/client.ts:1 [exact_relative_fetch_match]");
    expect(evidence.text).toContain("tests/routes.test.ts:1 [exact_relative_fetch_match, candidate_test_file]");
    expect(evidence.text).not.toContain("excluded.ts");
    expect(evidence.text).toContain("never resolved call edges");
    expect(evidence.text).toContain("not proven runtime coverage");
    expect(evidence.consumerCount).toBe(2);
    expect(evidence.candidateTestCount).toBe(1);
  });

  it("reports duplicate method/path registrations as ambiguous", async () => {
    const root = await tempProject();
    await writeFile(path.join(root, "src/routes.js"), `
      const express = require('express');
      const app = express();
      function first(_req, res) { res.send('first'); }
      function second(_req, res) { res.send('second'); }
      app.get('/same', first);
      app.get('/same', second);
    `);
    const evidence = await buildApiImpactEvidence(root, {
      symbol: "first",
      filePath: "src/routes.js",
      startLine: 4,
    }, ["src/routes.js"]);
    expect(evidence.text).toContain("ambiguous_duplicate_signature");
  });
});
