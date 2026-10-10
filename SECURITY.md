# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.36.x  | :white_check_mark: |
| < 0.36.0 | :x:               |

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
- Stores vector indices locally in your project directory
- Sends code chunks to embedding APIs (OpenAI, Google, Ollama, or a custom OpenAI-compatible endpoint)
- Does not transmit data to any other third parties

### Data Privacy

- All index data is stored locally
- Code is only sent to your configured embedding provider
- No telemetry or analytics are collected

## Dependency Override Policy

Track override decisions in [#379](https://github.com/Helweg/open-codebase-index/issues/379). An override must act on a real, non-shrinkwrapped dependency edge, identify its security purpose and patched floor, and avoid forcing unrelated or future-major edges to an older release.

- Prefer same-major, version-qualified selectors and patched caret ranges over global exact pins. Check ordinary, optional, and peer dependency ranges after resolution.
- Before calling an override inert, resolve two disposable lock-only trees from the same manifest with no existing lock, with and without that override. Compare every package path and version; report explicit added, removed, and version-changed lists. All three lists must be empty.
- For active changes, record those resolution deltas and run `npm audit --json` including development dependencies, a fresh `npm ci`, affected real CLI/build paths, and the repository validation gate. Preserve security coverage rather than accepting a newly introduced finding.
- Root overrides govern repository installs, not the transitive dependencies of a published package installed by a consumer. Check both packed identities with `npm_config_engine_strict=true` on the supported Node.js floor, 22.13.0.

### Retained Security Floors

| Selector | Replacement range | Security purpose |
| --- | --- | --- |
| `hono@>=4.0.0 <4.13.7` | `^4.13.7` | [GHSA-hxh3-vqpv-xpqv](https://github.com/advisories/GHSA-hxh3-vqpv-xpqv) |
| `ip-address@>=10.0.0 <10.7.1` | `^10.7.1` | [GHSA-j6r3-76f7-8jcv](https://github.com/advisories/GHSA-j6r3-76f7-8jcv) and [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw) |
| `postcss@>=8.0.0 <8.5.26` | `^8.5.26` | Retain the sourceMappingURL map-file-disclosure floor from commit `5b0cf22`, including earlier PostCSS fixes |
| `vite@>=8.0.0 <8.0.16` | `^8.0.16` | [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) and [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) |

The development-only `tsup@^8.1.0` override replaces its `esbuild` edge with `^0.28.1`. Current `tsup@8.5.1` declares `^0.27.0`, whose fresh resolution is vulnerable `0.27.7`: [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr), a low-severity Windows development-server file-read issue fixed in `0.28.1`. This is an intentional, scoped parent-range exception, not a claim that every declared range is satisfied. The native CLI/YAML, bundler, built CLI, full suite, and both minimum-runtime packed identities were exercised on macOS ARM64; this does not establish Windows or Linux runtime coverage. Remove the exception when tsup supports a patched esbuild range; do not restore a global pin that downgrades chord's exact `0.28.2` edge.

### Removed Overrides and Resolved Pi Exception

Fresh two-way resolution proved `@eslint/config-array`, `brace-expansion`, `fast-uri`, `qs`, and `body-parser` inert at the October 2026 review. Their patched versions remain resolved without overrides. The active `@hono/node-server` and `express-rate-limit` exact pins were removed after individually audited, parent-compatible fresh resolutions; the existing lock retains their patched versions. Removing `js-yaml` restores `@napi-rs/cli`'s declared `^5.0.0` dependency instead of forcing 4.x.

The Pi shrinkwrap exception is already resolved by [#404](https://github.com/Helweg/open-codebase-index/pull/404): `@earendil-works/pi-coding-agent@1.0.1` no longer publishes the shrinkwrap and declares patched `brace-expansion@5.0.12`. Its development dependency and host API type contracts remain intact. There is no remaining Pi shrinkwrap blocker in the current tree.
