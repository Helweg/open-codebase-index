# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.38.x  | :white_check_mark: |
| 0.37.x  | :white_check_mark: |
| < 0.37.0 | :x:               |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue
2. Use GitHub's private vulnerability reporting for this repository:
   - https://github.com/Helweg/open-codebase-index/security/advisories/new
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Any suggested fixes (optional)

We will acknowledge receipt within 48 hours and provide a detailed response within 7 days.

## Security Considerations

This plugin:
- Stores code indexes and opted-in history caches locally in your project directory
- Sends code chunks to configured embedding and reranking providers only when those features are enabled
- Uses existing `gh` authentication for explicitly opted-in manual history sync against the selected GitHub.com or GitHub Enterprise server

### Data Privacy

- Code indexes and opted-in history caches are stored locally
- Embedding and optional reranking requests use your configured providers
- History search runs locally without embedding or reranking requests; cached permissions are offline observations, not real-time access checks
- No telemetry or analytics are collected

## Dependency Override Policy

Track override decisions in [#379](https://github.com/Helweg/open-codebase-index/issues/379). An override must act on a real, non-shrinkwrapped dependency edge, identify its security purpose and patched floor, and avoid forcing unrelated or future-major edges to an older release.

- Prefer same-major, version-qualified selectors and patched caret ranges over global exact pins. Check ordinary, optional, and peer dependency ranges after resolution.
- Preserve existing `os`, `cpu`, and `libc` selectors on unchanged optional packages when refreshing lockfiles. Package-path/version equality alone does not prove platform-selection equivalence.
- Before calling an override inert, resolve two disposable lock-only trees from the same manifest with no existing lock, with and without that override. Compare every package path and version; report explicit added, removed, and version-changed lists. All three lists must be empty.
- For active changes, record those resolution deltas and run `npm audit --json` including development dependencies, a fresh `npm ci`, affected real CLI/build paths, and the repository validation gate. Preserve security coverage rather than accepting a newly introduced finding.
- Root overrides govern repository installs, not the transitive dependencies of a published package installed by a consumer. Check both packed identities with `npm_config_engine_strict=true` on the supported Node.js floor, 22.22.0.

### Retained Security Floors

| Selector | Replacement range | Security purpose |
| --- | --- | --- |
| `hono@>=4.0.0 <4.13.11` | `^4.13.11` | [GHSA-hxh3-vqpv-xpqv](https://github.com/advisories/GHSA-hxh3-vqpv-xpqv) and [GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7) |
| `ip-address@>=10.0.0 <10.7.4` | `^10.7.4` | [GHSA-j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv), [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw), and [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5) |
| `postcss@>=8.0.0 <8.5.26` | `^8.5.26` | Retain the sourceMappingURL map-file-disclosure floor from commit `5b0cf22`, including earlier PostCSS fixes |
| `vite@>=8.0.0 <8.0.16` | `^8.0.16` | [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) and [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) |
| `@earendil-works/pi-coding-agent@^1.3.0` → `undici@>=8.0.0 <8.12.2` | `^8.12.2` | Development-only [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c); replaces the parent's exact vulnerable edge without changing the published runtime floor |
| `@opencode-ai/plugin@1.3.13` → `zod@<4.6.6` | `^4.6.7` | Development-only [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5); aligns the build SDK with the safe direct Zod |

### 0.38.1 Consumer Dependency Closure

The OpenCode helper was already bundled into ESM and CommonJS output and used the
safe direct Zod. Its unnecessary production `@opencode-ai/plugin` dependency
nevertheless installed an additional vulnerable exact Zod copy. Keep the original
helper and `tool.schema` contract, declare direct Zod `^4.6.7`, and keep the exact
plugin `1.3.13` only for building and type interoperability. Bundle its public
declarations, but retain safe, dependency-free `@opencode-ai/sdk@1.3.13` as a
declared public type dependency: its protected client members must share upstream
identity rather than becoming incompatible copies in bundled declarations.

The plugin's pre-existing Zod `4.1.8` **type ABI**, including its version-branded
schema types, is retained only as original declaration data with its MIT notice.
The build materializes that graph under `dist/opencode-zod-4.1.8` and redirects
only the plugin tool declaration's Zod import to a relative private type entry.
No legacy JavaScript is bundled, installed as a production dependency, or run.
Runtime/configuration Zod remains `>=4.6.7`; neither private members nor type
brands are erased or rewritten to make SDK interoperability pass.

Packed acceptance checks both identities without consumer overrides or an
explicitly installed OpenCode plugin, with complete strict ESM/CommonJS
declaration checking. The necessary safe SDK is installed automatically from the
declared dependency. Separate explicit, unmodified plugin/Zod fixtures retain
actual upstream `Plugin` assignability and the same non-`any` and negative
callback checks. Those comparison fixtures do not describe our production
dependency graph.

The existing Express range admits body-parser `2.4.0`, addressing
[GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828).
The existing AJV range admits fast-uri `3.1.9`, addressing
[GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg),
[GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h),
[GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr), and
[GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp).
These runtime resolutions do not need new root overrides. The scoped development
overrides above do not govern downstream installs. Undici's existing development
Node.js `22.19.0` was the development minimum and `22.13.0` the published
minimum at that review. Chokidar 6 now requires Node.js `22.22.0` for both
source installs and published package use.

### Removed Overrides and Resolved Pi Exception

Fresh two-way resolution proved `@eslint/config-array`, `brace-expansion`, `fast-uri`, `qs`, and `body-parser` inert at the October 2026 review. Their patched versions remain resolved without overrides. The active `@hono/node-server` and `express-rate-limit` exact pins were removed after individually audited, parent-compatible fresh resolutions; the existing lock retains their patched versions. Removing `js-yaml` restores `@napi-rs/cli`'s declared `^5.0.0` dependency instead of forcing 4.x.

The October 2026 tsup cleanup separately proved the old development-only `tsup@^8.1.0` → `esbuild@^0.28.1` override inert using two fresh, lockfile-free resolutions: added `[]`, removed `[]`, version-changed `[]`. Both resolve `tsup@9.0.0`, whose declared `esbuild@^0.28.2` already exceeds the `0.28.1` floor for [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr). Ordinary, optional, and peer dependency edges remain valid; unchanged optional packages retain selector values and presence. Both fresh trees and the retained checked-in lock audit clean, including development dependencies. The checked-in lockfile is unchanged: this is inert configuration cleanup, not new security remediation or a bundler upgrade. Do not restore a global esbuild pin that downgrades chord's exact `0.28.2` edge. The published Node.js floor remains `22.13.0`; local runtime qualification covers macOS ARM64 only, not Windows or Linux.

The Pi shrinkwrap exception is already resolved by [#404](https://github.com/Helweg/open-codebase-index/pull/404): `@earendil-works/pi-coding-agent@1.0.1` no longer publishes the shrinkwrap and declares patched `brace-expansion@5.0.12`. Its development dependency and host API type contracts remain intact. There is no remaining Pi shrinkwrap blocker in the current tree.
