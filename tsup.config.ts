import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/pi-extension.ts"],
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: false,
  bundle: true,
  noExternal: [
    "@opencode-ai/plugin",
    "chokidar",
    "ignore",
    "p-queue",
    "p-retry",
    "unicode-case-folding",
  ],
  external: [
    "@modelcontextprotocol/sdk",
    "zod",
    "@earendil-works/pi-coding-agent",
    "typebox",
    /^node:/,
    "fs",
    "fs/promises",
    "path",
    "os",
    "crypto",
    "stream",
    "events",
    "util",
    "buffer",
    "child_process",
    "assert",
    "net",
    "tls",
    "http",
    "https",
    "url",
  ],
  esbuildOptions(options, context) {
    if (context.format === "esm") {
      options.banner = {
        js: [
          "// opencode-codebase-index - Semantic codebase search for OpenCode",
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        ].join("\n"),
      };
    } else {
      options.banner = {
        js: "// opencode-codebase-index - Semantic codebase search for OpenCode",
      };
    }
    if (context.format === "cjs") {
      options.logOverride = {
        "empty-import-meta": "silent",
      };
    }
  },
});
