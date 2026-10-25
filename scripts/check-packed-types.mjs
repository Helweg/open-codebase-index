import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export function checkPackedTypes(installRoot, packageName, { sdkInterop = false } = {}) {
  const require = createRequire(path.join(installRoot, "package.json"));
  const ts = require("typescript");
  assert.equal(ts.version, "5.9.3");
  const options = {
    strict: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: false,
    types: ["node"],
    typeRoots: [path.join(installRoot, "node_modules", "@types")],
  };
  const checks = `
    type IsAny<T> = 0 extends (1 & T) ? true : false;
    type NotAny<T extends false> = T;
    type Typed = [
      NotAny<IsAny<typeof plugin>>,
      NotAny<IsAny<typeof plugin.id>>,
      NotAny<IsAny<typeof plugin.setup>>,
      NotAny<IsAny<Parameters<typeof plugin.setup>[0]>>,
      NotAny<IsAny<typeof plugin.server>>,
      NotAny<IsAny<Parameters<typeof plugin.server>[0]>>
    ];
    const typed: Typed = [false, false, false, false, false, false];
    const id: string = plugin.id;
    declare const context: Parameters<typeof plugin.setup>[0];
    const directory: string = context.location.directory;
    const setup: Promise<void | (() => void | Promise<void>)> = plugin.setup(context);
    declare const input: Parameters<typeof plugin.server>[0];
    const serverDirectory: string = input.directory;
    const serverWorktree: string = input.worktree;
    ${sdkInterop ? 'const server: import("@opencode-ai/plugin").Plugin = plugin.server;' : ""}
    const hooks = plugin.server(input);
    hooks.then((value) => {
      value["tool.execute.before"]?.({ tool: "example", sessionID: "s", callID: "c" }, { args: {} });
      // @ts-expect-error v1 SDK callback requires a string session ID
      value["tool.execute.before"]?.({ tool: "example", sessionID: 1, callID: "c" }, { args: {} });
    });
    // @ts-expect-error root id is not numeric
    const numeric: number = plugin.id;
    // @ts-expect-error setup requires the actual host context
    plugin.setup({ location: "invalid" });
    // @ts-expect-error v1 server requires its SDK-backed host input
    plugin.server({ directory: 1 });
    // @ts-expect-error no fabricated root API
    plugin.nonexistent();
    void [typed, id, directory, setup, serverDirectory, serverWorktree, hooks, numeric${sdkInterop ? ", server" : ""}];
  `;
  const results = [];
  for (const [extension, prelude, mode, declaration] of [
    ["mts", `import plugin from ${JSON.stringify(packageName)};`, ts.ModuleKind.ESNext, "index.d.ts"],
    ["cts", `import packageModule = require(${JSON.stringify(packageName)});\nconst plugin = packageModule.default;`, ts.ModuleKind.CommonJS, "index.d.cts"],
  ]) {
    const consumerPath = path.join(installRoot, `consumer.${extension}`);
    writeFileSync(consumerPath, `${prelude}\n${checks}`, { flag: "wx", mode: 0o600 });
    const resolved = ts.resolveModuleName(packageName, consumerPath, options, ts.sys, undefined, undefined, mode).resolvedModule;
    const expected = realpathSync(path.join(installRoot, "node_modules", packageName, "dist", declaration));
    assert.ok(resolved, `No package resolution for ${extension}`);
    assert.equal(realpathSync(resolved.resolvedFileName), expected);
    const program = ts.createProgram([consumerPath], options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => installRoot,
      getCanonicalFileName: (file) => file,
      getNewLine: () => "\n",
    }));
    const files = program.getSourceFiles().map((source) => realpathSync(source.fileName));
    for (const file of files) {
      assert.ok(file.startsWith(`${realpathSync(installRoot)}${path.sep}`), `Consumer type closure escaped its install: ${file}`);
    }
    if (!sdkInterop) {
      assert.ok(!files.some((file) => file.includes(`${path.sep}node_modules${path.sep}@opencode-ai${path.sep}plugin${path.sep}`)),
        "Standalone types must not load an undeclared OpenCode plugin");
    }
    assert.ok(files.includes(expected), `Compiler did not load ${declaration}`);
    results.push({ extension, resolvedDeclaration: expected, files, diagnostics: 0 });
  }
  return { compiler: ts.version, node: process.version, options, sdkInterop, consumers: results };
}
