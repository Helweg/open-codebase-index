import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const names = ["opencode-codebase-index", "open-codebase-index"];
const gate = path.resolve("scripts/publish-validated-packages.mjs");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const hostPlugin = JSON.parse(readFileSync("package-lock.json", "utf8"))
  .packages["node_modules/@opencode-ai/plugin"];
const hostSdkVersion = hostPlugin.dependencies["@opencode-ai/sdk"];

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), "publish-validation-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function typeResult(installRoot: string, name: string) {
  return {
    compiler: "5.9.3",
    options: { strict: true, skipLibCheck: false },
    consumers: [
      { extension: "mts", resolvedDeclaration: path.join(installRoot, "node_modules", name, "dist", "index.d.ts"), diagnostics: 0 },
      { extension: "cts", resolvedDeclaration: path.join(installRoot, "node_modules", name, "dist", "index.d.cts"), diagnostics: 0 },
    ],
  };
}

function receipt() {
  const packages = names.map((name) => {
    // Check-only verifies the recorded bytes and does not need a real npm archive.
    const bytes = Buffer.from(`Archive bytes for ${name}`);
    const tarball = path.join(scratch, `${name}.tgz`);
    writeFileSync(tarball, bytes);
    const sdkInteropTypes = [
      { hostSdkLayout: "deduplicated", sdkVersion: hostSdkVersion },
      { hostSdkLayout: "nested", sdkVersion: "1.19.5" },
    ].map((fixture) => ({
      ...fixture,
      sdkInterop: true,
      pluginVersion: hostPlugin.version,
      ...typeResult(path.join(scratch, `sdk-interop-${name}-${fixture.hostSdkLayout}`), name),
    }));
    return {
      name, version, tarball,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      validation: { runtime: true, types: typeResult(path.join(scratch, `install-${name}`), name), sdkInteropTypes },
    };
  });
  return { schemaVersion: 1, version, packages };
}

function checkOnly(proof: ReturnType<typeof receipt>) {
  const filename = path.join(scratch, "validated-packages.json");
  writeFileSync(filename, JSON.stringify(proof));
  return spawnSync(process.execPath, [gate, filename, "--check-only"], {
    cwd: scratch,
    env: { ...process.env, PATH: scratch, npm_config_offline: "true" },
    encoding: "utf8",
  });
}

it("accepts a complete receipt for both identities without publishing", () => {
  const result = checkOnly(receipt());
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Verified both validated tarballs");
});

describe.each(names)("publication proof for %s", (name) => {
  it.each(["deduplicated", "nested"])("rejects missing %s evidence", (layout) => {
    const proof = receipt();
    const { validation } = proof.packages.find((entry) => entry.name === name)!;
    validation.sdkInteropTypes = validation.sdkInteropTypes.filter((row) => row.hostSdkLayout !== layout);
    const result = checkOnly(proof);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${name}: publication requires both deduplicated and nested`);
  });

  it("rejects a deduplicated result relabeled as nested", () => {
    const proof = receipt();
    const { sdkInteropTypes } = proof.packages.find((entry) => entry.name === name)!.validation;
    sdkInteropTypes[1] = { ...sdkInteropTypes[0], hostSdkLayout: "nested" };
    const result = checkOnly(proof);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${name}: unexpected root SDK version for nested`);
  });

  it.each(["mts", "cts"])("rejects a mislabeled %s path even with the right nested pin", (extension) => {
    const proof = receipt();
    const [deduplicated, nested] = proof.packages.find((entry) => entry.name === name)!.validation.sdkInteropTypes;
    nested.consumers = nested.consumers.map((consumer) => consumer.extension === extension
      ? deduplicated.consumers.find((row) => row.extension === extension)!
      : consumer);
    const result = checkOnly(proof);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${name}: unexpected ${extension} declaration path for nested`);
  });

  it("rejects SDK type proof copied from the other identity", () => {
    const proof = receipt();
    const { validation } = proof.packages.find((entry) => entry.name === name)!;
    const other = proof.packages.find((entry) => entry.name !== name)!;
    validation.sdkInteropTypes = other.validation.sdkInteropTypes;
    const result = checkOnly(proof);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${name}: unexpected mts declaration path for deduplicated`);
  });
});
