import { describe, expect, it } from "vitest";

import {
  LocalModuleCallResolver,
  TsConfigPathAliasCache,
  getLocalWorkspacePackageManifestPaths,
  getTsConfigModuleResolutionConfigDependencyPaths,
  getTsConfigModuleResolutionConfigPaths,
  getLocalWorkspacePackages,
  parseLocalWorkspacePackage,
  parseTsConfigForModuleResolution,
  resolveTsConfigForModuleResolution,
  type LocalModuleData,
} from "../src/indexer/local-module-resolution.js";
import { extractCalls, parseFiles, type CallSiteData, type SymbolData } from "../src/native/index.js";

describe("local workspace package manifest discovery", () => {
  const importerPaths = [
    "apps/web/src/main.ts",
    "packages/shared/src/index.ts",
    "packages/private/src/index.ts",
  ];

  it("uses only root package.json workspace array or object patterns when declared", () => {
    expect(getLocalWorkspacePackageManifestPaths(importerPaths, (manifestPath) =>
      manifestPath === "package.json"
        ? JSON.stringify({ workspaces: ["packages/shared", "apps/*"] })
        : undefined
    )).toEqual([
      "apps/web/package.json",
      "package.json",
      "packages/shared/package.json",
    ]);

    expect(getLocalWorkspacePackageManifestPaths(importerPaths, (manifestPath) =>
      manifestPath === "package.json"
        ? JSON.stringify({ workspaces: { packages: ["packages/*", "!packages/private"] } })
        : undefined
    )).toEqual([
      "package.json",
      "packages/shared/package.json",
    ]);
  });

  it("rejects outside and node_modules paths without scanning beyond known importers", () => {
    const paths = getLocalWorkspacePackageManifestPaths([
      "../outside/src/index.ts",
      "/absolute/src/index.ts",
      "C:\\outside\\src\\index.ts",
      "node_modules/external/src/index.ts",
      "packages/safe/src/index.ts",
    ], (manifestPath) => manifestPath === "package.json"
      ? JSON.stringify({
        workspaces: ["../outside/*", "/absolute/*", "C:\\outside\\*", "node_modules/*", "packages/*"],
      })
      : undefined);

    expect(paths).toEqual(["package.json", "packages/safe/package.json"]);
  });

  it("supports only bounded segment globs and applies exclusions across array and object forms", () => {
    const paths = getLocalWorkspacePackageManifestPaths([
      "apps/web/src/main.ts",
      "packages/deep/nested/src/index.ts",
      "packages/private/src/index.ts",
    ], (manifestPath) => manifestPath === "package.json"
      ? JSON.stringify({
        workspaces: {
          packages: ["apps/w?b", "packages/**/nested", "packages/private", "!packages/private"],
        },
      })
      : undefined);

    expect(paths).toEqual([
      "apps/web/package.json",
      "package.json",
      "packages/deep/nested/package.json",
    ]);
  });

  it("fails closed for malformed manifests or unsupported workspace glob syntax", () => {
    const discover = (rootManifestText: string): readonly string[] =>
      getLocalWorkspacePackageManifestPaths(importerPaths, (manifestPath) =>
        manifestPath === "package.json" ? rootManifestText : undefined
      );

    expect(discover("{")).toEqual(["package.json"]);
    expect(discover(JSON.stringify({ workspaces: ["packages/*", "!packages/{private,secret}"] })))
      .toEqual(["package.json"]);
    expect(discover(JSON.stringify({ workspaces: ["packages/*", "packages/**/../private"] })))
      .toEqual(["package.json"]);
    expect(discover(JSON.stringify({ workspaces: ["packages/*", 42] })))
      .toEqual(["package.json"]);
    expect(discover(JSON.stringify({
      workspaces: ["packages/*", ...Array.from({ length: 256 }, (_, index) => `other/${index}`)],
    }))).toEqual(["package.json"]);
  });

  it("loads only root and source-ancestor manifests selected by the root declaration", () => {
    const loadedPaths: string[] = [];
    const manifests: Record<string, string> = {
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/shared/package.json": JSON.stringify({ name: "@scope/shared" }),
      "tools/unrelated/package.json": JSON.stringify({ name: "unrelated" }),
    };

    getLocalWorkspacePackages(["packages/shared/src/index.ts"], (manifestPath) => {
      loadedPaths.push(manifestPath);
      return manifests[manifestPath];
    });

    expect(new Set(loadedPaths)).toEqual(new Set([
      "package.json",
      "packages/shared/package.json",
    ]));
    expect(loadedPaths).not.toContain("tools/unrelated/package.json");
  });
});

function symbol(id: string, filePath: string, name: string, kind = "function_declaration"): SymbolData {
  return {
    id,
    filePath,
    name,
    kind,
    startLine: 1,
    startCol: 0,
    endLine: 3,
    endCol: 0,
    language: filePath.endsWith(".go")
      ? "go"
      : filePath.endsWith(".js") ? "javascript" : "typescript",
  };
}

function callSite(calleeName: string, line = 2, column = 2, callType: CallSiteData["callType"] = "Call"): CallSiteData {
  return { calleeName, line, column, callType, confidence: "Direct" };
}

function goModule(filePath: string, content: string): LocalModuleData {
  const parsed = parseFiles([{ path: filePath, content }])[0];
  return {
    content,
    symbols: parsed.symbols.map((parsedSymbol, index) => ({
      ...parsedSymbol,
      id: `go_${index}_${parsedSymbol.name}`,
      filePath,
    })),
  };
}

function goCall(content: string, calleeName: string, occurrence = 0): CallSiteData {
  const sites = extractCalls(content, "go").filter((site) => site.calleeName === calleeName);
  const site = sites[occurrence];
  if (!site) throw new Error(`Missing Go call ${calleeName} at occurrence ${occurrence}`);
  return site;
}

function resolver(
  modules: Record<string, LocalModuleData>,
  workspaceManifestTexts: Record<string, string> = {},
): LocalModuleCallResolver {
  return new LocalModuleCallResolver({
    filePaths: Object.keys(modules),
    loadModule: async (filePath) => modules[filePath],
    workspacePackages: getLocalWorkspacePackages(
      Object.keys(modules),
      (manifestPath) => workspaceManifestTexts[manifestPath],
    ),
  });
}

describe("LocalModuleCallResolver", () => {
  it("resolves only direct unshadowed Go function calls in the same directory and package", async () => {
    const caller = [
      "package worker",
      "",
      "func Run(Shared func()) {",
      "  Shared()",
      "}",
      "",
      "func Direct() {",
      "  Target()",
      '  _ = "é"; other.Target()',
      "}",
    ].join("\n");
    const target = "package worker\n\nfunc Target() {}\nfunc Shared() {}\n";
    const targetSymbol = goModule("worker/target.go", target).symbols.find((entry) => entry.name === "Target");
    const instance = resolver({
      "worker/caller.go": goModule("worker/caller.go", caller),
      "worker/target.go": goModule("worker/target.go", target),
      "worker/other-package.go": goModule("worker/other-package.go", "package other\n\nfunc Target() {}\n"),
      "other/decoy.go": goModule("other/decoy.go", "package worker\n\nfunc Target() {}\n"),
    });

    await expect(instance.resolveCallTarget("worker/caller.go", caller, goCall(caller, "Target", 0)))
      .resolves.toEqual(targetSymbol);
    await expect(instance.resolveCallTarget("worker/caller.go", caller, goCall(caller, "Target", 1)))
      .resolves.toBeUndefined();
    await expect(instance.resolveCallTarget("worker/caller.go", caller, goCall(caller, "Shared")))
      .resolves.toBeUndefined();
  });

  it("abstains for Go short declarations, reserved init calls, build constraints, and test-only targets", async () => {
    const caller = [
      "package worker",
      "",
      "func Run() {",
      "  Shadowed := func() {}",
      "  Shadowed()",
      "  init()",
      "  Tagged()",
      "  Platform()",
      "  TestOnly()",
      "  CgoOnly()",
      "  HiddenOnly()",
      "  UppercaseOnly()",
      "}",
    ].join("\n");
    const modules = {
      "worker/caller.go": goModule("worker/caller.go", caller),
      "worker/shadowed.go": goModule("worker/shadowed.go", "package worker\n\nfunc Shadowed() {}\n"),
      "worker/init.go": goModule("worker/init.go", "package worker\n\nfunc init() {}\n"),
      "worker/tagged.go": goModule(
        "worker/tagged.go",
        "//go:build custom\n\npackage worker\n\nfunc Tagged() {}\n",
      ),
      "worker/platform_linux.go": goModule(
        "worker/platform_linux.go",
        "package worker\n\nfunc Platform() {}\n",
      ),
      "worker/helpers_test.go": goModule(
        "worker/helpers_test.go",
        "package worker\n\nfunc TestOnly() {}\n",
      ),
      "worker/cgo.go": goModule(
        "worker/cgo.go",
        'package worker\n\nimport "C"\n\nfunc CgoOnly() {}\n',
      ),
      "worker/_hidden.go": goModule(
        "worker/_hidden.go",
        "package worker\n\nfunc HiddenOnly() {}\n",
      ),
      "worker/uppercase.GO": goModule(
        "worker/uppercase.GO",
        "package worker\n\nfunc UppercaseOnly() {}\n",
      ),
    };
    const instance = resolver(modules);

    for (const name of [
      "Shadowed",
      "init",
      "Tagged",
      "Platform",
      "TestOnly",
      "CgoOnly",
      "HiddenOnly",
      "UppercaseOnly",
    ]) {
      await expect(instance.resolveCallTarget("worker/caller.go", caller, goCall(caller, name)))
        .resolves.toBeUndefined();
    }
  });

  it("abstains for explicit Go local declarations and build-constrained importers", async () => {
    const caller = [
      "package worker",
      "",
      "func Explicit() {",
      "  var (",
      "    ignored int",
      "    Bound = func() {}",
      "  )",
      "  Bound()",
      "}",
      "",
      "func LocalType() {",
      "  type Converted func()",
      "  Converted()",
      "}",
    ].join("\n");
    const platformCaller = "package worker\n\nfunc PlatformRun() { Production() }\n";
    const taggedCaller = "// +build custom\n\npackage worker\n\nfunc TaggedRun() { Production() }\n";
    const production = goModule("worker/production.go", "package worker\n\nfunc Production() {}\n");
    const instance = resolver({
      "worker/caller.go": goModule("worker/caller.go", caller),
      "worker/bound.go": goModule("worker/bound.go", "package worker\n\nfunc Bound() {}\nfunc Converted() {}\n"),
      "worker/caller_linux.go": goModule("worker/caller_linux.go", platformCaller),
      "worker/tagged-caller.go": goModule("worker/tagged-caller.go", taggedCaller),
      "worker/production.go": production,
    });

    await expect(instance.resolveCallTarget("worker/caller.go", caller, goCall(caller, "Bound")))
      .resolves.toBeUndefined();
    await expect(instance.resolveCallTarget("worker/caller.go", caller, goCall(caller, "Converted")))
      .resolves.toBeUndefined();
    await expect(instance.resolveCallTarget(
      "worker/caller_linux.go",
      platformCaller,
      goCall(platformCaller, "Production"),
    )).resolves.toBeUndefined();
    await expect(instance.resolveCallTarget(
      "worker/tagged-caller.go",
      taggedCaller,
      goCall(taggedCaller, "Production"),
    )).resolves.toBeUndefined();
  });

  it("allows same-package Go tests to call eligible production and test helpers", async () => {
    const caller = "package worker\n\nfunc TestRun() { Production(); TestHelper() }\n";
    const production = goModule("worker/production.go", "package worker\n\nfunc Production() {}\n");
    const helper = goModule("worker/helper_test.go", "package worker\n\nfunc TestHelper() {}\n");
    const instance = resolver({
      "worker/caller_test.go": goModule("worker/caller_test.go", caller),
      "worker/production.go": production,
      "worker/helper_test.go": helper,
    });

    await expect(instance.resolveCallTarget("worker/caller_test.go", caller, goCall(caller, "Production")))
      .resolves.toEqual(production.symbols.find((entry) => entry.name === "Production"));
    await expect(instance.resolveCallTarget("worker/caller_test.go", caller, goCall(caller, "TestHelper")))
      .resolves.toEqual(helper.symbols.find((entry) => entry.name === "TestHelper"));
  });
  it("resolves declared project-local workspace package roots and exact exports", async () => {
    const main = [
      'import { rootTarget } from "@scope/shared";',
      'import { featureTarget } from "@scope/shared/feature";',
      "export function run() { rootTarget(); featureTarget(); }",
    ].join("\n");
    const rootTarget = symbol("root", "packages/shared/src/index.ts", "rootTarget");
    const featureTarget = symbol("feature", "packages/shared/src/feature.ts", "featureTarget");
    const instance = resolver({
      "apps/web/src/main.ts": { content: main, symbols: [symbol("run", "apps/web/src/main.ts", "run")] },
      "packages/shared/src/index.ts": { content: "export function rootTarget() {}", symbols: [rootTarget] },
      "packages/shared/src/feature.ts": { content: "export function featureTarget() {}", symbols: [featureTarget] },
    }, {
      "packages/shared/package.json": JSON.stringify({
        name: "@scope/shared",
        exports: { ".": "./src/index.ts", "./feature": "./src/feature.ts" },
      }),
    });

    await expect(instance.resolveCallTarget("apps/web/src/main.ts", main, callSite("rootTarget", 3, 24)))
      .resolves.toEqual(rootTarget);
    await expect(instance.resolveCallTarget("apps/web/src/main.ts", main, callSite("featureTarget", 3, 38)))
      .resolves.toEqual(featureTarget);
  });

  it("applies Node-style static ESM workspace export conditions conservatively", async () => {
    const main = [
      'import { defaultFirstTarget } from "@scope/conditions/default-first";',
      'import { nodeFirstTarget } from "@scope/conditions/node-first";',
      'import { nestedFallbackTarget } from "@scope/conditions/nested-fallback";',
      'import { inactiveBranchTarget } from "@scope/conditions/inactive-branches";',
      'import { blockedTarget } from "@scope/conditions/blocked";',
      'import { unsafeTarget } from "@scope/conditions/unsafe";',
      'import { arrayTarget } from "@scope/conditions/array";',
      'import { mixedTarget } from "@scope/conditions/mixed";',
      'import { invalidConditionTarget } from "@scope/conditions/invalid-condition";',
      'import { legacyTarget } from "@scope/legacy-blocked";',
      "export function run() {",
      "  defaultFirstTarget();",
      "  nodeFirstTarget();",
      "  nestedFallbackTarget();",
      "  inactiveBranchTarget();",
      "  blockedTarget();",
      "  unsafeTarget();",
      "  arrayTarget();",
      "  mixedTarget();",
      "  invalidConditionTarget();",
      "  legacyTarget();",
      "}",
    ].join("\n");
    const defaultFirstTarget = symbol("default", "packages/conditions/src/default.ts", "defaultFirstTarget");
    const nodeFirstTarget = symbol("node", "packages/conditions/src/node.ts", "nodeFirstTarget");
    const nestedFallbackTarget = symbol(
      "nested-fallback",
      "packages/conditions/src/nested-fallback.ts",
      "nestedFallbackTarget",
    );
    const inactiveBranchTarget = symbol(
      "inactive-branches",
      "packages/conditions/src/inactive-branches.ts",
      "inactiveBranchTarget",
    );
    const instance = resolver({
      "apps/web/src/main.ts": { content: main, symbols: [symbol("run", "apps/web/src/main.ts", "run")] },
      "packages/conditions/src/default.ts": {
        content: "export function defaultFirstTarget() {}",
        symbols: [defaultFirstTarget],
      },
      "packages/conditions/src/import.ts": {
        content: "export function defaultFirstTarget() {}",
        symbols: [symbol("import", "packages/conditions/src/import.ts", "defaultFirstTarget")],
      },
      "packages/conditions/src/node.ts": {
        content: "export function nodeFirstTarget() {}",
        symbols: [nodeFirstTarget],
      },
      "packages/conditions/src/node-import.ts": {
        content: "export function nodeFirstTarget() {}",
        symbols: [symbol("node-import", "packages/conditions/src/node-import.ts", "nodeFirstTarget")],
      },
      "packages/conditions/src/nested-fallback.ts": {
        content: "export function nestedFallbackTarget() {}",
        symbols: [nestedFallbackTarget],
      },
      "packages/conditions/src/inactive-branches.ts": {
        content: "export function inactiveBranchTarget() {}",
        symbols: [inactiveBranchTarget],
      },
      "packages/conditions/src/blocked-fallback.ts": {
        content: "export function blockedTarget() {}",
        symbols: [symbol("blocked", "packages/conditions/src/blocked-fallback.ts", "blockedTarget")],
      },
      "packages/conditions/src/unsafe-fallback.ts": {
        content: "export function unsafeTarget() {}",
        symbols: [symbol("unsafe", "packages/conditions/src/unsafe-fallback.ts", "unsafeTarget")],
      },
      "packages/conditions/src/array-fallback.ts": {
        content: "export function arrayTarget() {}",
        symbols: [symbol("array", "packages/conditions/src/array-fallback.ts", "arrayTarget")],
      },
      "packages/conditions/src/mixed-fallback.ts": {
        content: "export function mixedTarget() {}",
        symbols: [symbol("mixed", "packages/conditions/src/mixed-fallback.ts", "mixedTarget")],
      },
      "packages/conditions/src/invalid-condition-fallback.ts": {
        content: "export function invalidConditionTarget() {}",
        symbols: [symbol(
          "invalid-condition",
          "packages/conditions/src/invalid-condition-fallback.ts",
          "invalidConditionTarget",
        )],
      },
      "packages/legacy/src/main.ts": {
        content: "export function legacyTarget() {}",
        symbols: [symbol("legacy", "packages/legacy/src/main.ts", "legacyTarget")],
      },
    }, {
      "packages/conditions/package.json": JSON.stringify({
        name: "@scope/conditions",
        exports: {
          "./default-first": {
            default: "./src/default.ts",
            import: "./src/import.ts",
          },
          "./node-first": {
            node: "./src/node.ts",
            import: "./src/node-import.ts",
          },
          "./nested-fallback": {
            node: { require: "./src/missing-cjs.ts" },
            default: "./src/nested-fallback.ts",
          },
          "./inactive-branches": {
            types: "./src/missing-types.ts",
            require: "./src/missing-cjs.ts",
            browser: "./src/missing-browser.ts",
            import: "./src/inactive-branches.ts",
          },
          "./blocked": { node: null, default: "./src/blocked-fallback.ts" },
          "./unsafe": { node: "./../outside.ts", default: "./src/unsafe-fallback.ts" },
          "./array": { node: ["./src/missing-array.ts"], default: "./src/array-fallback.ts" },
          "./mixed": {
            node: { ".": "./src/missing-root.ts", import: "./src/missing-import.ts" },
            default: "./src/mixed-fallback.ts",
          },
          "./invalid-condition": {
            "10": "./src/missing-numeric.ts",
            default: "./src/invalid-condition-fallback.ts",
          },
        },
      }),
      "packages/legacy/package.json": JSON.stringify({
        name: "@scope/legacy-blocked",
        exports: null,
        module: "./src/main.ts",
        main: "./src/main.ts",
      }),
    });

    await expect(instance.resolveCallTarget("apps/web/src/main.ts", main, callSite("defaultFirstTarget", 12, 2)))
      .resolves.toEqual(defaultFirstTarget);
    await expect(instance.resolveCallTarget("apps/web/src/main.ts", main, callSite("nodeFirstTarget", 13, 2)))
      .resolves.toEqual(nodeFirstTarget);
    await expect(instance.resolveCallTarget("apps/web/src/main.ts", main, callSite("nestedFallbackTarget", 14, 2)))
      .resolves.toEqual(nestedFallbackTarget);
    await expect(instance.resolveCallTarget("apps/web/src/main.ts", main, callSite("inactiveBranchTarget", 15, 2)))
      .resolves.toEqual(inactiveBranchTarget);
    for (const [calleeName, line] of [
      ["blockedTarget", 16],
      ["unsafeTarget", 17],
      ["arrayTarget", 18],
      ["mixedTarget", 19],
      ["invalidConditionTarget", 20],
      ["legacyTarget", 21],
    ] as const) {
      await expect(instance.resolveCallTarget("apps/web/src/main.ts", main, callSite(calleeName, line, 2)))
        .resolves.toBeUndefined();
    }
  });

  it("does not bypass null or subpath-only exports with legacy root entry fields", async () => {
    const main = [
      'import { nullRootTarget } from "null-root-package";',
      'import { restrictedRootTarget } from "restricted-root-package";',
      "export function run() { nullRootTarget(); restrictedRootTarget(); }",
    ].join("\n");
    const instance = resolver({
      "apps/web/src/main.ts": { content: main, symbols: [symbol("run", "apps/web/src/main.ts", "run")] },
      "packages/null-root/src/index.ts": {
        content: "export function nullRootTarget() {}",
        symbols: [symbol("null-root", "packages/null-root/src/index.ts", "nullRootTarget")],
      },
      "packages/restricted-root/src/index.ts": {
        content: "export function restrictedRootTarget() {}",
        symbols: [symbol("restricted-root", "packages/restricted-root/src/index.ts", "restrictedRootTarget")],
      },
    }, {
      "packages/null-root/package.json": JSON.stringify({
        name: "null-root-package",
        exports: null,
        main: "./src/index.ts",
      }),
      "packages/restricted-root/package.json": JSON.stringify({
        name: "restricted-root-package",
        exports: { "./feature": "./src/index.ts" },
        main: "./src/index.ts",
      }),
    });

    await expect(instance.resolveCallTarget("apps/web/src/main.ts", main, callSite("nullRootTarget", 3, 24)))
      .resolves.toBeUndefined();
    await expect(instance.resolveCallTarget("apps/web/src/main.ts", main, callSite("restrictedRootTarget", 3, 42)))
      .resolves.toBeUndefined();
  });

  it("uses Node-compatible wildcard specificity with exact exports taking precedence", async () => {
    const main = [
      'import { generalTarget } from "@scope/shared/features/general";',
      'import { specificTarget } from "@scope/shared/features/internal/suffix-long";',
      'import { exactTarget } from "@scope/shared/features/internal/exact";',
      "export function run() {",
      "  generalTarget();",
      "  specificTarget();",
      "  exactTarget();",
      "}",
    ].join("\n");
    const generalTarget = symbol("general", "packages/shared/src/general/general.ts", "generalTarget");
    const specificTarget = symbol("specific", "packages/shared/src/by-prefix/suffix-long.ts", "specificTarget");
    const exactTarget = symbol("exact", "packages/shared/src/exact.ts", "exactTarget");
    const instance = resolver({
      "apps/web/src/main.ts": { content: main, symbols: [symbol("run", "apps/web/src/main.ts", "run")] },
      "packages/shared/src/general/general.ts": {
        content: "export function generalTarget() {}",
        symbols: [generalTarget],
      },
      "packages/shared/src/by-trailer/internal.ts": {
        content: "export function specificTarget() {}",
        symbols: [symbol("trailer-specific", "packages/shared/src/by-trailer/internal.ts", "specificTarget")],
      },
      "packages/shared/src/by-prefix/suffix-long.ts": {
        content: "export function specificTarget() {}",
        symbols: [specificTarget],
      },
      "packages/shared/src/general/internal/exact.ts": {
        content: "export function exactTarget() {}",
        symbols: [symbol("general-exact", "packages/shared/src/general/internal/exact.ts", "exactTarget")],
      },
      "packages/shared/src/internal/exact.ts": {
        content: "export function exactTarget() {}",
        symbols: [symbol("specific-exact", "packages/shared/src/internal/exact.ts", "exactTarget")],
      },
      "packages/shared/src/exact.ts": { content: "export function exactTarget() {}", symbols: [exactTarget] },
    }, {
      "packages/shared/package.json": JSON.stringify({
        name: "@scope/shared",
        exports: {
          "./features/internal/exact": "./src/exact.ts",
          "./features/*": "./src/general/*.ts",
          "./features/*/suffix-long": "./src/by-trailer/*.ts",
          "./features/internal/*": "./src/by-prefix/*.ts",
        },
      }),
    });

    await expect(instance.resolveCallTarget("apps/web/src/main.ts", main, callSite("generalTarget", 5, 2)))
      .resolves.toEqual(generalTarget);
    await expect(instance.resolveCallTarget("apps/web/src/main.ts", main, callSite("specificTarget", 6, 2)))
      .resolves.toEqual(specificTarget);
    await expect(instance.resolveCallTarget("apps/web/src/main.ts", main, callSite("exactTarget", 7, 2)))
      .resolves.toEqual(exactTarget);
  });

  it("bounds wildcard export maps and fails closed when the limit is exceeded", () => {
    const exports = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`./feature-${index}/*`, `./src/feature-${index}/*.ts`]),
    );
    exports["."] = "./src/index.ts";

    const workspacePackage = parseLocalWorkspacePackage(
      "packages/shared/package.json",
      JSON.stringify({ name: "shared-package", exports }),
    );

    expect(workspacePackage?.entryPoints.get(".")).toEqual(["packages/shared/src/index.ts"]);
    expect(workspacePackage?.exportPatterns).toEqual([]);
  });

  it("blocks broader fallbacks and rejects malformed, external, and ambiguous wildcard mappings", async () => {
    const main = [
      'import { unsafeKeyTarget } from "shared-package/../outside";',
      'import { noStarTarget } from "shared-package/no-star/value";',
      'import { multiStarTarget } from "shared-package/multi/value";',
      'import { escapingTarget } from "shared-package/escape/outside";',
      'import { traversalTarget } from "shared-package/capture/../outside";',
      'import { encodedTraversalTarget } from "shared-package/capture/%2e%2e/outside";',
      'import { encodedTarget } from "shared-package/encoded/value";',
      'import { nodeModulesTarget } from "shared-package/modules/value";',
      'import { exactNullTarget } from "shared-package/exact-null";',
      'import { exactUnsafeTarget } from "shared-package/exact-unsafe";',
      'import { exactMixedTarget } from "shared-package/exact-mixed";',
      'import { patternNullTarget } from "shared-package/private/value";',
      'import { trailingSlashTarget } from "shared-package/";',
      'import { conditionalTarget } from "shared-package/conditional/value";',
      'import { ambiguousTarget } from "duplicate-package/features/value";',
      'import { invalidNameTarget } from "invalid/name/value";',
      "export function run() {",
      "  unsafeKeyTarget(); noStarTarget(); multiStarTarget(); escapingTarget();",
      "  traversalTarget(); encodedTraversalTarget(); encodedTarget(); nodeModulesTarget();",
      "  exactNullTarget(); exactUnsafeTarget(); exactMixedTarget(); patternNullTarget(); trailingSlashTarget();",
      "  conditionalTarget(); ambiguousTarget(); invalidNameTarget();",
      "}",
    ].join("\n");
    const conditionalTarget = symbol("conditional", "packages/shared/src/value.ts", "conditionalTarget");
    const instance = resolver({
      "apps/web/main.ts": { content: main, symbols: [symbol("run", "apps/web/main.ts", "run")] },
      "packages/shared/src/outside.ts": {
        content: [
          "export function unsafeKeyTarget() {}",
          "export function traversalTarget() {}",
          "export function encodedTraversalTarget() {}",
        ].join("\n"),
        symbols: [
          symbol("unsafe-key", "packages/shared/src/outside.ts", "unsafeKeyTarget"),
          symbol("traversal", "packages/shared/src/outside.ts", "traversalTarget"),
          symbol("encoded-traversal", "packages/shared/src/outside.ts", "encodedTraversalTarget"),
        ],
      },
      "packages/shared/src/%2e%2e/outside.ts": {
        content: "export function encodedTraversalTarget() {}",
        symbols: [
          symbol("encoded-traversal-literal", "packages/shared/src/%2e%2e/outside.ts", "encodedTraversalTarget"),
        ],
      },
      "packages/shared/src/%2e%2e/value.ts": {
        content: "export function encodedTarget() {}",
        symbols: [symbol("encoded-literal", "packages/shared/src/%2e%2e/value.ts", "encodedTarget")],
      },
      "packages/shared/src/node_modules/value.ts": {
        content: "export function nodeModulesTarget() {}",
        symbols: [symbol("node-modules", "packages/shared/src/node_modules/value.ts", "nodeModulesTarget")],
      },
      "packages/shared/src/fixed.ts": {
        content: "export function noStarTarget() {}",
        symbols: [symbol("no-star", "packages/shared/src/fixed.ts", "noStarTarget")],
      },
      "packages/shared/src/value/value.ts": {
        content: "export function multiStarTarget() {}",
        symbols: [symbol("multi-star", "packages/shared/src/value/value.ts", "multiStarTarget")],
      },
      "packages/outside.ts": {
        content: "export function escapingTarget() {}\nexport function encodedTarget() {}",
        symbols: [
          symbol("escaping", "packages/outside.ts", "escapingTarget"),
          symbol("encoded", "packages/outside.ts", "encodedTarget"),
        ],
      },
      "packages/shared/src/exact-null.ts": {
        content: "export function exactNullTarget() {}",
        symbols: [symbol("exact-null", "packages/shared/src/exact-null.ts", "exactNullTarget")],
      },
      "packages/shared/src/exact-unsafe.ts": {
        content: "export function exactUnsafeTarget() {}",
        symbols: [symbol("exact-unsafe", "packages/shared/src/exact-unsafe.ts", "exactUnsafeTarget")],
      },
      "packages/shared/src/exact-mixed.ts": {
        content: "export function exactMixedTarget() {}",
        symbols: [symbol("exact-mixed", "packages/shared/src/exact-mixed.ts", "exactMixedTarget")],
      },
      "packages/shared/src/private/value.ts": {
        content: "export function patternNullTarget() {}",
        symbols: [symbol("pattern-null", "packages/shared/src/private/value.ts", "patternNullTarget")],
      },
      "packages/shared/src/.ts": {
        content: "export function trailingSlashTarget() {}",
        symbols: [symbol("trailing-slash", "packages/shared/src/.ts", "trailingSlashTarget")],
      },
      "packages/shared/src/value.ts": {
        content: "export function conditionalTarget() {}",
        symbols: [conditionalTarget],
      },
      "packages/a/src/value.ts": {
        content: "export function ambiguousTarget() {}",
        symbols: [symbol("ambiguous-a", "packages/a/src/value.ts", "ambiguousTarget")],
      },
      "packages/b/src/value.ts": {
        content: "export function ambiguousTarget() {}",
        symbols: [symbol("ambiguous-b", "packages/b/src/value.ts", "ambiguousTarget")],
      },
      "packages/invalid/src/value.ts": {
        content: "export function invalidNameTarget() {}",
        symbols: [symbol("invalid-name", "packages/invalid/src/value.ts", "invalidNameTarget")],
      },
    }, {
      "packages/shared/package.json": JSON.stringify({
        name: "shared-package",
        exports: {
          "./../*": "./src/*.ts",
          "./no-star/*": "./src/fixed.ts",
          "./multi/*": "./src/*/*.ts",
          "./escape/*": "./../*.ts",
          "./capture/*": "./src/*.ts",
          "./encoded/*": "./src/%2e%2e/*.ts",
          "./modules/*": "./src/node_modules/*.ts",
          "./exact-null": null,
          "./exact-unsafe": "./../exact-unsafe.ts",
          "./exact-mixed": { types: "./src/exact-mixed.ts", import: "external-package" },
          "./private/*": null,
          "./*": "./src/*.ts",
          "./conditional/*": { import: "./src/*.ts", default: "./src/fixed.ts" },
        },
      }),
      "packages/a/package.json": JSON.stringify({
        name: "duplicate-package",
        exports: { "./features/*": "./src/*.ts" },
      }),
      "packages/b/package.json": JSON.stringify({
        name: "duplicate-package",
        exports: { "./features/*": "./src/*.ts" },
      }),
      "packages/invalid/package.json": JSON.stringify({
        name: "invalid/name",
        exports: { "./*": "./src/*.ts" },
      }),
    });

    for (const name of [
      "unsafeKeyTarget",
      "noStarTarget",
      "multiStarTarget",
      "escapingTarget",
      "traversalTarget",
      "encodedTraversalTarget",
      "encodedTarget",
      "nodeModulesTarget",
      "exactNullTarget",
      "exactUnsafeTarget",
      "exactMixedTarget",
      "patternNullTarget",
      "trailingSlashTarget",
      "ambiguousTarget",
      "invalidNameTarget",
    ]) {
      await expect(instance.resolveCallTarget("apps/web/main.ts", main, callSite(name, 20, 2)))
        .resolves.toBeUndefined();
    }
    await expect(instance.resolveCallTarget("apps/web/main.ts", main, callSite("conditionalTarget", 20, 2)))
      .resolves.toEqual(conditionalTarget);
  });

  it("rejects unsafe workspace package manifest paths and names", () => {
    const manifest = JSON.stringify({ name: "safe-package", exports: { "./*": "./src/*.ts" } });

    expect(parseLocalWorkspacePackage("../packages/shared/package.json", manifest)).toBeUndefined();
    expect(parseLocalWorkspacePackage("node_modules/shared/package.json", manifest)).toBeUndefined();
    expect(parseLocalWorkspacePackage("C:/packages/shared/package.json", manifest)).toBeUndefined();
    expect(parseLocalWorkspacePackage(
      "packages/shared/package.json",
      JSON.stringify({ name: "node:fs", exports: { "./*": "./src/*.ts" } }),
    )).toBeUndefined();
  });

  it("uses safe package-relative subpaths without exports and abstains for external or ambiguous packages", async () => {
    const main = [
      'import { nestedTarget } from "shared-package/nested";',
      'import { externalTarget } from "external-package";',
      'import { duplicateTarget } from "duplicate-package";',
      "export function run() { nestedTarget(); externalTarget(); duplicateTarget(); }",
    ].join("\n");
    const nestedTarget = symbol("nested", "packages/shared/nested.ts", "nestedTarget");
    const instance = resolver({
      "apps/web/main.ts": { content: main, symbols: [symbol("run", "apps/web/main.ts", "run")] },
      "packages/shared/nested.ts": { content: "export function nestedTarget() {}", symbols: [nestedTarget] },
      "packages/a/index.ts": { content: "export function duplicateTarget() {}", symbols: [] },
      "packages/b/index.ts": { content: "export function duplicateTarget() {}", symbols: [] },
    }, {
      "packages/shared/package.json": JSON.stringify({ name: "shared-package" }),
      "packages/a/package.json": JSON.stringify({ name: "duplicate-package", main: "./index.ts" }),
      "packages/b/package.json": JSON.stringify({ name: "duplicate-package", main: "./index.ts" }),
    });

    await expect(instance.resolveCallTarget("apps/web/main.ts", main, callSite("nestedTarget", 4, 24)))
      .resolves.toEqual(nestedTarget);
    await expect(instance.resolveCallTarget("apps/web/main.ts", main, callSite("externalTarget", 4, 40)))
      .resolves.toBeUndefined();
    await expect(instance.resolveCallTarget("apps/web/main.ts", main, callSite("duplicateTarget", 4, 58)))
      .resolves.toBeUndefined();
  });

  it("resolves direct, aliased, default, and namespace imports", async () => {
    const main = [
      'import defaultTarget, { directTarget as localAlias } from "./target.js";',
      'import * as targetApi from "./target.js";',
      "export function run() {",
      "  localAlias();",
      "  defaultTarget();",
      "  targetApi.directTarget();",
      "}",
    ].join("\n");
    const directTarget = symbol("direct", "src/target.ts", "directTarget");
    const defaultTarget = symbol("default", "src/target.ts", "defaultImplementation");
    const instance = resolver({
      "src/main.ts": { content: main, symbols: [symbol("run", "src/main.ts", "run")] },
      "src/target.ts": {
        content: [
          "export function directTarget() { return 1; }",
          "export default function defaultImplementation() { return 2; }",
        ].join("\n"),
        symbols: [directTarget, defaultTarget],
      },
    });

    await expect(instance.resolveCallTarget("src/main.ts", main, callSite("localAlias", 4, 2)))
      .resolves.toEqual(directTarget);
    await expect(instance.resolveCallTarget("src/main.ts", main, callSite("defaultTarget", 5, 2)))
      .resolves.toEqual(defaultTarget);
    await expect(instance.resolveCallTarget("src/main.ts", main, callSite("directTarget", 6, 12, "MethodCall")))
      .resolves.toEqual(directTarget);
  });

  it("follows named aliases and export-star re-export chains", async () => {
    const main = [
      'import { publicTarget as localTarget, starTarget } from "./barrel.js";',
      "export function run() {",
      "  localTarget();",
      "  starTarget();",
      "}",
    ].join("\n");
    const original = symbol("original", "src/original.ts", "originalTarget");
    const star = symbol("star", "src/star.ts", "starTarget");
    const instance = resolver({
      "src/main.ts": { content: main, symbols: [symbol("run", "src/main.ts", "run")] },
      "src/barrel.ts": {
        content: [
          'export { originalTarget as publicTarget } from "./original.js";',
          'export * from "./nested.js";',
        ].join("\n"),
        symbols: [],
      },
      "src/nested.ts": { content: 'export * from "./star.js";', symbols: [] },
      "src/original.ts": {
        content: "export function originalTarget() { return 1; }",
        symbols: [original],
      },
      "src/star.ts": { content: "export function starTarget() { return 2; }", symbols: [star] },
    });

    await expect(instance.resolveCallTarget("src/main.ts", main, callSite("localTarget", 3, 2)))
      .resolves.toEqual(original);
    await expect(instance.resolveCallTarget("src/main.ts", main, callSite("starTarget", 4, 2)))
      .resolves.toEqual(star);
  });

  it("uses the relative module path to disambiguate duplicate symbol names", async () => {
    const main = [
      'import { duplicateTarget } from "./a.js";',
      "export function run() { duplicateTarget(); }",
    ].join("\n");
    const targetA = symbol("a", "src/a.ts", "duplicateTarget");
    const targetB = symbol("b", "src/b.ts", "duplicateTarget");
    const instance = resolver({
      "src/main.ts": { content: main, symbols: [symbol("run", "src/main.ts", "run")] },
      "src/a.ts": { content: "export function duplicateTarget() {}", symbols: [targetA] },
      "src/b.ts": { content: "export function duplicateTarget() {}", symbols: [targetB] },
    });

    await expect(instance.resolveCallTarget("src/main.ts", main, callSite("duplicateTarget", 2, 24)))
      .resolves.toEqual(targetA);
  });

  it("does not mistake an ordinary member call for a named import", async () => {
    const main = [
      'import { directTarget as localAlias } from "./target.js";',
      "export function run(holder: { localAlias(): void }) { holder.localAlias(); }",
    ].join("\n");
    const instance = resolver({
      "src/main.ts": { content: main, symbols: [symbol("run", "src/main.ts", "run")] },
      "src/target.ts": {
        content: "export function directTarget() {}",
        symbols: [symbol("target", "src/target.ts", "directTarget")],
      },
    });

    await expect(instance.resolveCallTarget("src/main.ts", main, callSite("localAlias", 2, 61, "MethodCall")))
      .resolves.toBeUndefined();
  });

  it("abstains for ambiguous star exports and ambiguous extensionless modules", async () => {
    const main = [
      'import { ambiguousTarget } from "./barrel.js";',
      'import { extensionlessTarget } from "./extensionless";',
      "export function run() { ambiguousTarget(); extensionlessTarget(); }",
    ].join("\n");
    const instance = resolver({
      "src/main.ts": { content: main, symbols: [symbol("run", "src/main.ts", "run")] },
      "src/barrel.ts": {
        content: 'export * from "./a.js";\nexport * from "./b.js";',
        symbols: [],
      },
      "src/a.ts": {
        content: "export function ambiguousTarget() {}",
        symbols: [symbol("a", "src/a.ts", "ambiguousTarget")],
      },
      "src/b.ts": {
        content: "export function ambiguousTarget() {}",
        symbols: [symbol("b", "src/b.ts", "ambiguousTarget")],
      },
      "src/extensionless.ts": {
        content: "export function extensionlessTarget() {}",
        symbols: [symbol("ts", "src/extensionless.ts", "extensionlessTarget")],
      },
      "src/extensionless.js": {
        content: "export function extensionlessTarget() {}",
        symbols: [symbol("js", "src/extensionless.js", "extensionlessTarget")],
      },
    });

    await expect(instance.resolveCallTarget("src/main.ts", main, callSite("ambiguousTarget", 3, 24)))
      .resolves.toBeUndefined();
    await expect(instance.resolveCallTarget("src/main.ts", main, callSite("extensionlessTarget", 3, 43)))
      .resolves.toBeUndefined();
  });

  it("abstains for missing, external, type-only, and cyclic exports", async () => {
    const main = [
      'import { missingTarget } from "./missing.js";',
      'import { externalTarget } from "external-package";',
      'import type { TypeOnlyTarget } from "./types.js";',
      'import { cyclicTarget } from "./cycle-a.js";',
      "export function run() { missingTarget(); externalTarget(); TypeOnlyTarget(); cyclicTarget(); }",
    ].join("\n");
    const instance = resolver({
      "src/main.ts": { content: main, symbols: [symbol("run", "src/main.ts", "run")] },
      "src/types.ts": {
        content: "export function TypeOnlyTarget() {}",
        symbols: [symbol("type", "src/types.ts", "TypeOnlyTarget")],
      },
      "src/cycle-a.ts": { content: 'export * from "./cycle-b.js";', symbols: [] },
      "src/cycle-b.ts": { content: 'export * from "./cycle-a.js";', symbols: [] },
    });

    for (const name of ["missingTarget", "externalTarget", "TypeOnlyTarget", "cyclicTarget"]) {
      await expect(instance.resolveCallTarget("src/main.ts", main, callSite(name, 5, 24)))
        .resolves.toBeUndefined();
    }
  });

  it("selects a constructor-compatible symbol and returns deterministic repeated results", async () => {
    const main = [
      'import { Service } from "./service.js";',
      "export function run() { return new Service(); }",
    ].join("\n");
    const interfaceSymbol = symbol("interface", "src/service.ts", "Service", "interface_declaration");
    const classSymbol = symbol("class", "src/service.ts", "Service", "class_declaration");
    const instance = resolver({
      "src/main.ts": { content: main, symbols: [symbol("run", "src/main.ts", "run")] },
      "src/service.ts": {
        content: "export interface Service {}\nexport class Service {}",
        symbols: [interfaceSymbol, classSymbol],
      },
    });
    const site = callSite("Service", 2, 35, "Constructor");

    const first = await instance.resolveCallTarget("src/main.ts", main, site);
    const second = await instance.resolveCallTarget("src/main.ts", main, site);
    expect(first).toEqual(classSymbol);
    expect(second).toEqual(first);
  });

  it("parses TypeScript module-resolution config and supports path aliases", () => {
    const parsed = parseTsConfigForModuleResolution(JSON.stringify({
      compilerOptions: {
        baseUrl: "./src",
        paths: {
          "@/*": ["./*/index"],
        },
      },
    }));

    expect(parsed).toEqual({
      baseUrl: "src",
      aliases: [{ pattern: "@/*", targets: ["*/index"] }],
    });
  });

  it("supports common JSONC tsconfig syntax", () => {
    const parsed = parseTsConfigForModuleResolution([
      '{',
      '  // compilerOptions',
      '  "compilerOptions": {',
      '    "baseUrl": "./src",',
      '    "paths": {',
      '      "@/*": ["./*/index"],',
      '      "@foo/*": ["./foo/*"],',
      '    },',
      '  },',
      '}',
    ].join("\n"));

    expect(parsed).toEqual({
      baseUrl: "src",
      aliases: [
        { pattern: "@/*", targets: ["*/index"] },
        { pattern: "@foo/*", targets: ["foo/*"] },
      ],
    });
  });

  it("resolves aliases inherited through a local tsconfig extends chain", async () => {
    const configs = new Map([
      ["tsconfig.json", JSON.stringify({ extends: "./config/base" })],
      ["config/base.json", JSON.stringify({
        compilerOptions: {
          baseUrl: "../src",
          paths: { "@core/*": ["core/*"] },
        },
      })],
    ]);
    const aliases = resolveTsConfigForModuleResolution("tsconfig.json", (configPath) => configs.get(configPath));
    expect(aliases).toEqual({
      baseUrl: "src",
      aliases: [{ pattern: "@core/*", targets: ["core/*"], baseUrl: "src" }],
    });
    expect(getTsConfigModuleResolutionConfigPaths("tsconfig.json", (configPath) => configs.get(configPath)))
      .toEqual(["config/base.json", "tsconfig.json"]);

    const main = [
      'import { inheritedTarget } from "@core/target";',
      "export function run() { return inheritedTarget(); }",
    ].join("\n");
    const inheritedTarget = symbol("inherited", "src/core/target.ts", "inheritedTarget");
    const instance = new LocalModuleCallResolver({
      filePaths: ["src/main.ts", "src/core/target.ts"],
      loadModule: async (filePath) => ({
        "src/main.ts": { content: main, symbols: [symbol("run", "src/main.ts", "run")] },
        "src/core/target.ts": { content: "export function inheritedTarget() {}", symbols: [inheritedTarget] },
      })[filePath],
      tsConfigPathAliases: aliases,
    });

    await expect(instance.resolveCallTarget("src/main.ts", main, callSite("inheritedTarget", 2, 31)))
      .resolves.toEqual(inheritedTarget);
  });

  it("retains missing local extends targets as watcher dependencies", () => {
    const configs = new Map([
      ["packages/app/tsconfig.json", JSON.stringify({ extends: "../config/base" })],
    ]);

    expect(getTsConfigModuleResolutionConfigDependencyPaths(
      "packages/app/tsconfig.json",
      (configPath) => configs.get(configPath),
    )).toEqual(["packages/app/tsconfig.json", "packages/config/base.json"]);
  });

  it("uses the nearest importer config and caches config reads and extends resolution", async () => {
    const configs = new Map([
      ["tsconfig.json", JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@scope/*": ["src/root/*"] } },
      })],
      ["packages/app/tsconfig.json", JSON.stringify({ extends: "../config/base" })],
      ["packages/app/jsconfig.json", JSON.stringify({
        compilerOptions: { baseUrl: "../..", paths: { "@scope/*": ["src/wrong/*"] } },
      })],
      ["packages/config/base.json", JSON.stringify({
        compilerOptions: { baseUrl: "../..", paths: { "@scope/*": ["packages/app/src/nested/*"] } },
      })],
      ["packages/js-only/jsconfig.json", JSON.stringify({
        compilerOptions: { baseUrl: "../..", paths: { "@scope/*": ["packages/js-only/src/nested/*"] } },
      })],
    ]);
    const loadCounts = new Map<string, number>();
    const aliasCache = new TsConfigPathAliasCache((configPath) => {
      loadCounts.set(configPath, (loadCounts.get(configPath) ?? 0) + 1);
      return configs.get(configPath);
    });
    const importerContent = 'import { aliasTarget } from "@scope/target";\nexport function run() { aliasTarget(); }';
    const rootTarget = symbol("root", "src/root/target.ts", "aliasTarget");
    const appTarget = symbol("app", "packages/app/src/nested/target.ts", "aliasTarget");
    const jsTarget = symbol("js", "packages/js-only/src/nested/target.ts", "aliasTarget");
    const modules: Record<string, LocalModuleData> = {
      "src/main.ts": { content: importerContent, symbols: [symbol("root-run", "src/main.ts", "run")] },
      "src/root/target.ts": { content: "export function aliasTarget() {}", symbols: [rootTarget] },
      "packages/app/src/main.ts": {
        content: importerContent,
        symbols: [symbol("app-run", "packages/app/src/main.ts", "run")],
      },
      "packages/app/src/nested/target.ts": {
        content: "export function aliasTarget() {}",
        symbols: [appTarget],
      },
      "packages/js-only/src/main.js": {
        content: importerContent,
        symbols: [symbol("js-run", "packages/js-only/src/main.js", "run")],
      },
      "packages/js-only/src/nested/target.ts": {
        content: "export function aliasTarget() {}",
        symbols: [jsTarget],
      },
    };
    const instance = new LocalModuleCallResolver({
      filePaths: Object.keys(modules),
      loadModule: async (filePath) => modules[filePath],
      pathAliasesForImporter: (filePath) => aliasCache.getPathAliasesForImporter(filePath),
    });
    const site = callSite("aliasTarget", 2, 24);

    await expect(instance.resolveCallTarget("src/main.ts", importerContent, site)).resolves.toEqual(rootTarget);
    await expect(instance.resolveCallTarget("packages/app/src/main.ts", importerContent, site)).resolves.toEqual(appTarget);
    await expect(instance.resolveCallTarget("packages/js-only/src/main.js", importerContent, site)).resolves.toEqual(jsTarget);
    await expect(instance.resolveCallTarget("packages/app/src/main.ts", importerContent, site)).resolves.toEqual(appTarget);

    const configState = aliasCache.getConfigState([
      "src/main.ts",
      "packages/app/src/main.ts",
      "packages/js-only/src/main.js",
    ]);
    expect(configState).toContainEqual(["packages/app/tsconfig.json", configs.get("packages/app/tsconfig.json")]);
    expect(configState).toContainEqual(["packages/config/base.json", configs.get("packages/config/base.json")]);
    expect(configState).toContainEqual(["packages/js-only/tsconfig.json", null]);
    expect(configState).not.toContainEqual(["packages/app/jsconfig.json", configs.get("packages/app/jsconfig.json")]);
    expect([...loadCounts.values()].every((count) => count === 1)).toBe(true);
  });

  it("rejects cyclic, package-based, and project-escaping tsconfig extends paths", () => {
    const cyclicConfigs = new Map([
      ["tsconfig.json", JSON.stringify({ extends: "./config/base" })],
      ["config/base.json", JSON.stringify({ extends: "../tsconfig" })],
    ]);
    expect(resolveTsConfigForModuleResolution("tsconfig.json", (configPath) => cyclicConfigs.get(configPath)))
      .toBeUndefined();
    expect(resolveTsConfigForModuleResolution("tsconfig.json", () => JSON.stringify({ extends: "@company/tsconfig" })))
      .toBeUndefined();
    expect(resolveTsConfigForModuleResolution("tsconfig.json", () => JSON.stringify({ extends: "../outside" })))
      .toBeUndefined();
  });

  it("abstains when tsconfig does not define paths", () => {
    const parsed = parseTsConfigForModuleResolution(JSON.stringify({
      compilerOptions: {
        baseUrl: "./src",
      },
    }));

    expect(parsed).toBeUndefined();
  });

  it("ignores invalid module-resolution config with unsupported structures", () => {
    expect(parseTsConfigForModuleResolution("{}")).toBeUndefined();
    expect(parseTsConfigForModuleResolution("not-json")).toBeUndefined();
    expect(parseTsConfigForModuleResolution(JSON.stringify({ compilerOptions: { paths: { "bad*path*here": ["./x"] } } })))
      .toBeUndefined();
  });
});
