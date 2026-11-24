import * as path from "node:path";

export function packedSdkFixtures(artifactRoot, packageName, hostSdkVersion) {
  // The nested fixture must not track our production SDK pin: it can match the host's pin.
  return [
    { expectedLayout: "deduplicated", sdkVersion: hostSdkVersion },
    { expectedLayout: "nested", sdkVersion: "1.19.5" },
  ].map((fixture) => ({
    ...fixture,
    installRoot: path.join(artifactRoot, `sdk-interop-${packageName}-${fixture.expectedLayout}`),
  }));
}
