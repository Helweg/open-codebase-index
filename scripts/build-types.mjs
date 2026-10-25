import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import * as path from "node:path";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const externalPackages = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
const builtins = new Set(builtinModules);
// Keep the exact upstream plugin's type ABI without installing its vulnerable Zod runtime.
const data = JSON.parse(readFileSync(path.join(import.meta.dirname, "opencode-zod-4.1.8-declarations.json"), "utf8"));
const assetRoot = path.join(root, "dist", "opencode-zod-4.1.8");
for (const file of data.files) {
  const target = path.resolve(assetRoot, file.path);
  if (!target.startsWith(`${assetRoot}${path.sep}`) || !(file.path.endsWith(".d.cts") || file.path === "LICENSE")) {
    throw new Error("Invalid OpenCode declaration asset");
  }
  if (createHash("sha256").update(file.contents).digest("hex") !== file.sha256) {
    throw new Error(`OpenCode declaration data hash mismatch: ${file.path}`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, file.contents, { mode: 0o644 });
}
const legacyEntry = path.join(assetRoot, data.entry);
const pluginToolTypes = path.join(root, "node_modules", "@opencode-ai", "plugin", "dist", "tool.d.ts");
function isPluginToolDeclaration(importer) {
  return !!importer && path.resolve(importer) === pluginToolTypes;
}
const bundle = await rollup({
  input: path.join(root, "src/index.ts"),
  external(name, importer) {
    if (name === "zod" && isPluginToolDeclaration(importer)) return false;
    return name.startsWith("node:") || builtins.has(name)
      || externalPackages.some((dependency) => name === dependency || name.startsWith(`${dependency}/`));
  },
  plugins: [{
    name: "opencode-declaration-abi",
    resolveId(name, importer) {
      if (name !== "zod" || !isPluginToolDeclaration(importer)) return null;
      return { id: legacyEntry, external: true };
    },
  }, dts({
    tsconfig: path.join(root, "tsconfig.json"),
    includeExternal: ["@opencode-ai/plugin"],
  })],
  onwarn(warning, warn) {
    if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
    warn(warning);
  },
});
try {
  for (const name of ["index.d.ts", "index.d.cts"]) {
    await bundle.write({
      file: path.join(root, "dist", name),
      format: "es",
      paths: { [legacyEntry]: "./opencode-zod-4.1.8/index.cjs" },
    });
  }
} finally {
  await bundle.close();
}
console.log("DTS Built dist/index.d.ts and dist/index.d.cts with declaration-only OpenCode ABI assets");
