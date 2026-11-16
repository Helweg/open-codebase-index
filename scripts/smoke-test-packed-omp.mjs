// Copied into the standalone consumer so TypeBox and extension imports resolve
// from the installed tarball, never from the source checkout's dependencies.
import assert from "node:assert/strict";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";

const installedRoot = realpathSync(process.argv[2]);
const installed = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"));
const requiredToolNames = [
  "codebase_context", "codebase_search", "codebase_peek", "index_codebase", "index_status",
];
assert.ok(Array.isArray(installed.omp?.extensions) && installed.omp.extensions.length > 0,
  "Packed package must declare omp extension entrypoints");

function collect(extension, schema) {
  const tools = new Map();
  const hooks = new Map();
  extension({
    registerTool(tool) {
      assert.equal(typeof tool.name, "string");
      assert.ok(!tools.has(tool.name), `Duplicate omp tool: ${tool.name}`);
      assert.equal(typeof tool.label, "string");
      assert.equal(typeof tool.description, "string");
      assert.equal(typeof tool.execute, "function", `Missing execute handler: ${tool.name}`);
      assert.equal(tool.parameters?.type, "object", `Invalid parameter schema: ${tool.name}`);
      tools.set(tool.name, tool);
    },
    on(event, handler) {
      assert.equal(typeof handler, "function");
      const handlers = hooks.get(event) ?? [];
      handlers.push(handler);
      hooks.set(event, handlers);
    },
    ...(schema ? { typebox: { Type: schema } } : {}),
  });
  for (const name of requiredToolNames) {
    assert.ok(tools.has(name), `Missing packed omp tool: ${name}`);
  }
  return { tools, hooks };
}

function checkSchemas(tools) {
  // Validate the JSON-serializable schema the host consumes, not TypeBox metadata.
  const schemas = new Map([...tools].map(([name, tool]) => [name, JSON.parse(JSON.stringify(tool.parameters))]));
  for (const name of ["codebase_search", "codebase_peek"]) {
    const schema = schemas.get(name);
    assert.equal(Value.Check(schema, {
      query: "PackedFixture", limit: 3, chunkType: "element",
      blameAuthor: "Fixture Author", blameSha: "abc123",
    }), true, `${name} rejects supported retrieval filters`);
    for (const invalid of [
      {}, { query: 42 }, { query: "fixture", limit: "3" },
      { query: "fixture", chunkType: "not-a-chunk-type" },
      { query: "fixture", blameAuthor: 42 }, { query: "fixture", blameSha: 42 },
    ]) {
      assert.equal(Value.Check(schema, invalid), false, `${name} accepts invalid parameters: ${JSON.stringify(invalid)}`);
    }
  }
  const indexing = schemas.get("index_codebase");
  assert.equal(Value.Check(indexing, {}), true, "Indexing options must remain optional");
  assert.equal(Value.Check(indexing, { force: false, estimateOnly: true }), true);
  assert.equal(Value.Check(indexing, { force: "false" }), false);
  return schemas;
}

const extensions = [];
for (const entrypoint of installed.omp.extensions) {
  assert.ok(typeof entrypoint === "string" && entrypoint.startsWith("./"), "Invalid omp manifest entrypoint");
  const extensionPath = realpathSync(path.resolve(installedRoot, entrypoint));
  assert.ok(extensionPath.startsWith(`${installedRoot}${path.sep}`), "omp extension escapes the installed package");
  assert.ok(lstatSync(extensionPath).isFile(), "omp extension is not a file");
  const { default: extension } = await import(pathToFileURL(extensionPath).href);
  assert.equal(typeof extension, "function", "Packed omp extension must export a factory");

  const fallback = collect(extension);
  checkSchemas(fallback.tools);
  const injected = collect(extension, Type);
  checkSchemas(injected.tools);
  extensions.push({
    entrypoint, tools: [...injected.tools.keys()], hooks: [...injected.hooks.keys()],
    schemaBuilders: ["package-fallback", "injected-typebox-compatible"],
    schemaValidation: "valid-and-invalid-retrieval-and-indexing-parameters",
  });
}
console.log(JSON.stringify({
  coverage: "installed-extension-api-registration-and-schema-validation",
  actualOmpSession: false,
  boundary: "Direct manifest import with a collecting ExtensionAPI; no omp application, model, lifecycle execution, or tool execution",
  extensions,
}));
