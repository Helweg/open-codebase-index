import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const targetPath = process.env.TEST_BM25_TARGET_PATH;
const readyPath = process.env.TEST_BM25_READY_PATH;
const releasePath = process.env.TEST_BM25_RELEASE_PATH;

if (targetPath && readyPath && releasePath) {
  const originalRenameSync = fs.renameSync;
  const normalizedTargetPath = path.resolve(targetPath);
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

  fs.renameSync = (source, destination) => {
    const normalizedSource = path.resolve(String(source));
    const normalizedDestination = path.resolve(String(destination));
    const isBm25Publication = normalizedDestination === normalizedTargetPath
      && normalizedSource.startsWith(`${normalizedTargetPath}.tmp.`);

    if (isBm25Publication) {
      fs.writeFileSync(readyPath, JSON.stringify({ source: normalizedSource, destination: normalizedDestination }));
      const startedAt = Date.now();
      while (!fs.existsSync(releasePath)) {
        if (Date.now() - startedAt > 10000) {
          throw new Error(`Timed out waiting for BM25 publication release at ${releasePath}`);
        }
        Atomics.wait(waitBuffer, 0, 0, 10);
      }
    }

    return originalRenameSync(source, destination);
  };

  // Met à jour les imports ESM nommés de node:fs utilisés par le code produit.
  syncBuiltinESMExports();
}
