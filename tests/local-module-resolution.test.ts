import { describe, expect, it } from "vitest";

import { LocalModuleCallResolver, type LocalModuleData } from "../src/indexer/local-module-resolution.js";
import type { CallSiteData, SymbolData } from "../src/native/index.js";

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
    language: filePath.endsWith(".js") ? "javascript" : "typescript",
  };
}

function callSite(calleeName: string, line = 2, column = 2, callType: CallSiteData["callType"] = "Call"): CallSiteData {
  return { calleeName, line, column, callType, confidence: "Direct" };
}

function resolver(modules: Record<string, LocalModuleData>): LocalModuleCallResolver {
  return new LocalModuleCallResolver({
    filePaths: Object.keys(modules),
    loadModule: async (filePath) => modules[filePath],
  });
}

describe("LocalModuleCallResolver", () => {
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
});
