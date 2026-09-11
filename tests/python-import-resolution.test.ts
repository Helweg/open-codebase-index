import type { LocalModuleData } from "../src/indexer/local-module-resolution.js";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { LocalModuleCallResolver } from "../src/indexer/local-module-resolution.js";
import { Database, extractCalls, hashContent, parseFiles } from "../src/native/index.js";

function moduleData(filePath: string, content: string): LocalModuleData {
  return { content, symbols: parseFiles([{ path: filePath, content }])[0].symbols.map((symbol) => ({
    ...symbol, filePath, id: `${filePath}:${symbol.name}:${symbol.startLine}`,
  })) };
}

async function resolve(content: string, additional: Record<string, string> = {}, importer = "payments/reports.py", name = "format_payment") {
  const files = {
    "payments/__init__.py": "",
    "payments/formatting.py": "def format_payment(payment):\n    return f\"{payment['id']}:{payment['amount']}\"\n",
    "payments/duplicate.py": "def format_payment(payment):\n    return payment\n",
    ...additional,
    [importer]: content,
  };
  const modules = new Map(Object.entries(files).map(([filePath, source]) => [filePath, moduleData(filePath, source)]));
  const resolver = new LocalModuleCallResolver({ filePaths: [...modules.keys()], loadModule: async (filePath) => modules.get(filePath) });
  const site = extractCalls(content, "python").find((call) => call.calleeName === name && call.callType === "Call");
  expect(site).toBeDefined();
  return resolver.resolveCallTarget(importer, content, site!);
}

const basic = "from .formatting import format_payment\n\ndef render_report(payment):\n    return format_payment(payment)\n";

describe("conservative Python relative imports", () => {
  it("resolves the explicit target despite duplicate names in other modules", async () => {
    await expect(resolve(basic)).resolves.toMatchObject({ filePath: "payments/formatting.py", name: "format_payment" });
  });

  it("resolves aliases, parent-relative imports, and package initializers", async () => {
    await expect(resolve(basic.replaceAll("import format_payment", "import format_payment as fmt").replace("return format_payment", "return fmt"), {}, "payments/reports.py", "fmt"))
      .resolves.toMatchObject({ filePath: "payments/formatting.py", name: "format_payment" });
    await expect(resolve(basic.replace(".formatting", "..formatting"), { "payments/views/__init__.py": "" }, "payments/views/reports.py"))
      .resolves.toMatchObject({ filePath: "payments/formatting.py" });
    await expect(resolve(basic.replace(".formatting", ".helpers"), { "payments/helpers/__init__.py": "def format_payment(payment):\n    return payment\n" }))
      .resolves.toMatchObject({ filePath: "payments/helpers/__init__.py" });
  });

  it("ignores comments and multiline quoted fake imports and handles UTF-8 call coordinates", async () => {
    await expect(resolve('"""\nfrom .duplicate import format_payment\n"""\n# from .duplicate import format_payment\n' + basic.replace("return format_payment", 'é = 1; return format_payment')))
      .resolves.toMatchObject({ filePath: "payments/formatting.py" });
  });

  it("does not climb above the project package or resolve outside source paths", async () => {
    await expect(resolve(basic.replace(".formatting", "...formatting"), {
      "__init__.py": "", "formatting.py": "def format_payment(payment):\n    return payment\n",
    })).resolves.toBeUndefined();
    await expect(resolve(basic, {}, "../payments/reports.py")).resolves.toBeUndefined();
    await expect(resolve(basic, {}, "/payments/reports.py")).resolves.toBeUndefined();
  });

  it.each([
    ["duplicate imports", "from .duplicate import format_payment\n" + basic],
    ["parameter shadowing", basic.replace("render_report(payment)", "render_report(payment, format_payment)")],
    ["local rebinding", basic.replace("    return", "    format_payment = other\n    return")],
    ["module rebinding", basic + "format_payment = other\n"],
    ["NFKC module rebinding", basic + "ｆormat_payment = other\n"],
    ["NFKC parameter shadowing", basic.replace("render_report(payment)", "render_report(payment, ｆormat_payment)")],
    ["comprehension binding", basic.replace("return format_payment(payment)", "return [format_payment(payment) for format_payment in callbacks]")],
    ["lambda binding", basic.replace("return format_payment(payment)", "return (lambda format_payment: format_payment(payment))(other)")],
    ["conditional import", basic.replace("from .formatting", "if enabled:\n    from .formatting")],
    ["star import", "from .duplicate import *\n" + basic],
    ["dynamic binding", basic + "globals().update(replacements)\n"],
    ["vars binding", basic + 'vars()["format_payment"] = other\n'],
    ["f-string binding", basic + "value = f'{(format_payment := other)}'\n"],
    ["nested-quote f-string binding", basic + 'value = f"{str("ignored") + (format_payment := other)}"\n'],
    ["nested-quote f-string fake closing brace", basic + 'value = f"{str(\'}\', "ignored") + (format_payment := other)}"\n'],
    ["absolute import", basic.replace(".formatting", "payments.formatting")],
    ["missing module", basic.replace(".formatting", ".missing")],
    ["outside package", basic.replace(".formatting", "...formatting")],
    ["quoted import only", '"""from .formatting import format_payment"""\n' + basic.split("\n").slice(1).join("\n")],
  ])("abstains on %s", async (_label, source) => {
    await expect(resolve(source)).resolves.toBeUndefined();
  });

  it.each([
    ["module/package ambiguity", { "payments/formatting/__init__.py": "def format_payment(payment):\n    return payment\n" }],
    ["duplicate definitions", { "payments/formatting.py": "def format_payment(payment):\n    return payment\ndef format_payment(payment):\n    return payment\n" }],
    ["nested definition", { "payments/formatting.py": "def outer():\n    def format_payment(payment):\n        return payment\n" }],
    ["rebound export", { "payments/formatting.py": "def format_payment(payment):\n    return payment\nformat_payment = other\n" }],
    ["vars rebound export", { "payments/formatting.py": 'def format_payment(payment):\n    return payment\nvars()["format_payment"] = other\n' }],
    ["decorated export", { "payments/formatting.py": "@replace\ndef format_payment(payment):\n    return payment\n" }],
  ])("abstains on target %s", async (_label, files) => {
    await expect(resolve(basic, files)).resolves.toBeUndefined();
  });

  it("requires every intermediate component to be an unambiguous package", async () => {
    const nested = basic.replace(".formatting", ".helpers.formatting");
    const target = { "payments/helpers/formatting.py": "def format_payment(payment):\n    return payment\n" };
    await expect(resolve(nested, target)).resolves.toBeUndefined();
    await expect(resolve(nested, { ...target, "payments/helpers.py": "value = 1\n" })).resolves.toBeUndefined();
    await expect(resolve(nested, { ...target, "payments/helpers/__init__.py": "" })).resolves.toMatchObject({ filePath: "payments/helpers/formatting.py" });
    await expect(resolve(nested, { ...target, "payments/helpers/__init__.py": "", "payments/helpers.py": "value = 1\n" })).resolves.toBeUndefined();
  });
});

describe("Python import graph indexing lifecycle", () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(["structural", "hybrid"] as const)("keeps explicit targets current across edits, target rename/delete, migration and restart (%s)", async (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "python-import-graph-"));
    directories.push(root);
    const write = (relativePath: string, content: string): void => {
      const filePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    };
    write("payments/__init__.py", "");
    write("payments/formatting.py", "def format_payment(payment):\n    return str(payment)\n");
    write("payments/audit.py", "def record_audit(value):\n    return value\n");
    write("payments/duplicate.py", "def format_payment(payment):\n    return payment\n");
    write("payments/reports.py", basic);
    const config = parseConfig({
      embeddingProvider: "custom", customProvider: { baseUrl: "http://localhost:11434/v1", model: "mock-model", dimensions: 8 },
      indexing: { mode, watchFiles: false, autoIndex: false, requireProjectMarker: false },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      return new Response(JSON.stringify({ data: inputs.map(() => ({ embedding: Array(8).fill(0.125) })), usage: { total_tokens: inputs.length } }), { status: 200 });
    });
    let indexer = new Indexer(root, config, "opencode");
    const edges = async () => {
      const symbols = await indexer.getSymbolsForBranch();
      const caller = symbols.find((symbol) => symbol.name === "render_report")!;
      return Promise.all((await indexer.getCallees(caller.id)).map(async (edge) => ({
        name: edge.targetName, resolved: edge.isResolved,
        target: symbols.find((symbol) => symbol.id === edge.toSymbolId)?.filePath.replaceAll("\\", "/").split("/payments/").at(-1),
      })));
    };
    const restart = async () => {
      await indexer.close();
      indexer = new Indexer(root, config, "opencode");
    };
    try {
      await indexer.index();
      expect(await edges()).toEqual([{ name: "format_payment", resolved: true, target: "formatting.py" }]);
      write("payments/reports.py", "from .formatting import format_payment\nfrom .audit import record_audit\n\ndef render_report(payment):\n    rendered = format_payment(payment)\n    record_audit(rendered)\n    return rendered\n");
      await indexer.index();
      const expected = [
        { name: "format_payment", resolved: true, target: "formatting.py" },
        { name: "record_audit", resolved: true, target: "audit.py" },
      ];
      expect(await edges()).toEqual(expected);
      await restart();
      expect(await edges()).toEqual(expected);
      fs.renameSync(path.join(root, "payments/audit.py"), path.join(root, "payments/audit_new.py"));
      await indexer.index();
      expect(await edges()).toContainEqual({ name: "record_audit", resolved: false, target: undefined });
      fs.renameSync(path.join(root, "payments/audit_new.py"), path.join(root, "payments/audit.py"));
      await indexer.index();
      expect(await edges()).toEqual(expected);
      write("payments/formatting/__init__.py", "def format_payment(payment):\n    return payment\n");
      await indexer.index();
      expect(await edges()).toContainEqual({ name: "format_payment", resolved: false, target: undefined });
      fs.unlinkSync(path.join(root, "payments/formatting/__init__.py"));
      await indexer.index();
      expect(await edges()).toEqual(expected);
      write("payments/audit.py", "def renamed_audit(value):\n    return value\n");
      await indexer.index();
      expect(await edges()).toContainEqual({ name: "record_audit", resolved: false, target: undefined });
      write("payments/audit.py", "def record_audit(value):\n    return value\n");
      await indexer.index();
      expect(await edges()).toEqual(expected);
      fs.unlinkSync(path.join(root, "payments/audit.py"));
      await restart();
      await indexer.index();
      expect(await edges()).toContainEqual({ name: "record_audit", resolved: false, target: undefined });
      write("payments/audit.py", "def record_audit(value):\n    return value\n");
      await indexer.index();
      await indexer.close();
      const db = new Database(path.join(root, ".opencode/index", ...(mode === "structural" ? ["structural"] : []), "codebase.db"));
      try {
        db.setMetadata(`index.callGraphResolutionVersion.${hashContent("default").slice(0, 24)}`, "9");
        const caller = db.getSymbolsByName("render_report")[0];
        const persistedEdges = db.getCallees(caller.id, "default");
        expect(persistedEdges).toHaveLength(2);
        for (const edge of persistedEdges) db.upsertCallEdge({ ...edge, toSymbolId: undefined, isResolved: false });
      } finally { db.close(); }
      indexer = new Indexer(root, config, "opencode");
      expect((await edges()).every((edge) => !edge.resolved)).toBe(true);
      await indexer.index();
      expect(await edges()).toEqual(expected);
      await restart();
      expect(await edges()).toEqual(expected);
    } finally { await indexer.close(); }
  });
});
