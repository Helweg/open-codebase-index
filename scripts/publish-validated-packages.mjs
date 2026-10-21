import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const [manifestArg, checkOnly] = process.argv.slice(2);
assert.ok(manifestArg && (checkOnly === undefined || checkOnly === "--check-only"),
  "Usage: node scripts/publish-validated-packages.mjs <validation-manifest> [--check-only]");
const manifestPath = path.resolve(manifestArg);
const artifactRoot = realpathSync(path.dirname(manifestPath));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const expectedVersion = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version;
const catalog = JSON.parse(readFileSync(path.join(repositoryRoot, "src", "identity-catalog.json"), "utf8"));
const expectedNames = [catalog.product.current.packageName, catalog.product.future.packageName].sort();
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.version, expectedVersion);
assert.deepEqual(manifest.packages.map((entry) => entry.name).sort(), expectedNames);

function verifyArchive(entry) {
  assert.equal(entry.version, expectedVersion);
  assert.ok(lstatSync(entry.tarball).isFile(), "Validated tarball must be a regular file");
  assert.ok(realpathSync(entry.tarball).startsWith(`${artifactRoot}${path.sep}`), "Tarball escaped validation directory");
  const integrity = `sha512-${createHash("sha512").update(readFileSync(entry.tarball)).digest("base64")}`;
  assert.equal(integrity, entry.integrity, `Validated tarball changed: ${entry.name}`);
  assert.equal(entry.validation.runtime, true);
  assert.equal(entry.validation.types.compiler, "5.9.3");
  assert.equal(entry.validation.types.options.strict, true);
  assert.equal(entry.validation.types.options.skipLibCheck, false);
  assert.deepEqual(entry.validation.types.consumers.map((consumer) => consumer.extension).sort(), ["cts", "mts"]);
  assert.ok(entry.validation.types.consumers.every((consumer) => consumer.diagnostics === 0));
}

// Validate BOTH identities before any registry request or publication.
for (const entry of manifest.packages) verifyArchive(entry);
if (checkOnly === "--check-only") {
  console.log(`Verified both validated tarballs for ${expectedVersion}; no registry operations`);
} else {
  const pending = [];
  for (const entry of manifest.packages) {
    const started = new Date().toISOString();
    const lookupArgs = ["view", `${entry.name}@${entry.version}`, "--json", "--prefer-online"];
    const lookup = spawnSync("npm", lookupArgs, { encoding: "utf8" });
    writeFileSync(path.join(artifactRoot, `registry-view-${entry.name}.json`), JSON.stringify({
      command: "npm", args: lookupArgs, started, finished: new Date().toISOString(), pid: lookup.pid, status: lookup.status,
      signal: lookup.signal, error: lookup.error?.message, stdout: lookup.stdout, stderr: lookup.stderr,
    }, null, 2), { flag: "wx", mode: 0o600 });
    if (lookup.status === 0) {
      const existing = JSON.parse(lookup.stdout);
      assert.equal(existing.name, entry.name);
      assert.equal(existing.version, entry.version);
      assert.equal(existing.dist?.integrity, entry.integrity, `Existing immutable package integrity differs: ${entry.name}`);
      console.log(`Skipping immutable existing ${entry.name}@${entry.version}`);
      continue;
    }
    assert.equal(JSON.parse(lookup.stdout).error?.code, "E404", `Registry lookup failed: ${lookup.stderr}`);
    pending.push(entry);
  }
  // A later identity's lookup failure must not follow an earlier publication.
  for (const entry of pending) {
    verifyArchive(entry);
    const args = ["publish", entry.tarball, "--ignore-scripts", "--access", "public"];
    const published = spawnSync("npm", args, { encoding: "utf8" });
    writeFileSync(path.join(artifactRoot, `publish-${entry.name}.json`), JSON.stringify({
      command: "npm", args, pid: published.pid, status: published.status, signal: published.signal,
      error: published.error?.message, stdout: published.stdout, stderr: published.stderr,
    }, null, 2), { flag: "wx", mode: 0o600 });
    process.stdout.write(published.stdout ?? "");
    process.stderr.write(published.stderr ?? "");
    assert.equal(published.status, 0, `Publishing validated ${entry.name} failed`);
  }
}
