# Migration plan: `open-codebase-index`

This document describes how to evolve the project from `opencode-codebase-index` to the host-neutral name `open-codebase-index` without breaking existing installations or losing indexes.

It is a plan, not an active rename. Repository renames, npm publication, tags, releases, storage migrations, and removal of compatibility aliases require separate approval.

## Why the rename is now feasible

The runtime is no longer structured as one OpenCode-specific implementation with other hosts attached later:

- OpenCode integration lives under `src/adapters/opencode/`.
- MCP integration and the executable MCP CLI live under `src/adapters/mcp/`.
- Pi integration lives under `src/adapters/pi/`.
- Shared indexing, search, configuration, watcher, evaluation, and native code require an explicit host context where host-specific paths or behavior matter.
- Canonical portable tool names are shared while each host retains its own schemas, registration order, and output contracts.

The remaining OpenCode references fall into two categories:

1. **Compatibility contracts** that must remain stable during migration, such as the current npm package, binary, OpenCode config paths, legacy fallback paths, and plugin manifests.
2. **Product identity** that can move to the new name, such as repository branding, documentation headings, server display names, package descriptions, and new installation examples.

Do not replace both categories in one release.

## Compatibility promises

A safe migration should preserve these promises for at least one minor release after the new package becomes generally available:

- Existing `opencode-codebase-index` npm installations continue to work.
- The `opencode-codebase-index-mcp` binary remains available as an alias.
- Existing OpenCode, Codex, Claude, Pi, and Jcode configuration continues to load.
- Existing project and global indexes remain readable in place.
- Current tool names, request schemas, result formats, and host-specific aliases do not change.
- The native binary filename and persistence formats do not change merely for branding.
- Users receive an actionable deprecation message before any legacy package or binary is retired.

## Identity inventory

The rename touches several independently versioned identities. Treat each as a separate migration surface.

| Surface | Current identity | Proposed identity | Initial compatibility action |
|---|---|---|---|
| GitHub repository | `Helweg/opencode-codebase-index` | `Helweg/open-codebase-index` | Rename only after docs and automation accept both URLs; rely on GitHub redirect temporarily |
| npm package | `opencode-codebase-index` | `open-codebase-index` | Publish a new package; keep the old package as a compatibility wrapper or deprecation bridge |
| MCP binary | `opencode-codebase-index-mcp` | `open-codebase-index-mcp` | Ship both bin names from the new package during the transition |
| MCP server name | `opencode-codebase-index` | `open-codebase-index` | Change only after client snapshots and integration tests accept the new display identity |
| Native crate/package | `codebase-index-native` | unchanged initially | Do not rename in the first phase; it is internal and affects artifacts, loaders, and release matrices |
| OpenCode plugin entry | `opencode-codebase-index` | compatibility dependent | Keep supported while the old npm package exists |
| Claude plugin metadata | current package/repository identity | new identity | Update in the new package release while retaining compatible command invocation |
| Codex package metadata | current package/repository identity | new identity | Update with package aliases and manifest tests |
| Pi package entry | current package identity | new identity | Preserve the same extension and tool behavior |
| Project storage | `.opencode/`, `.codebase-index/`, `.claude/` | unchanged | These are host compatibility paths, not product branding |
| Global storage | host-specific current paths | unchanged | Never move user data solely because the product name changed |
| Tool names | `codebase_*`, `index_*`, `call_graph*`, `pr_impact` | unchanged | They are already host-neutral public contracts |

## Recommended release sequence

### Phase 0: prepare compatibility infrastructure

Complete before publishing the new name:

1. Add constants for product name, package names, binary names, repository URL, and server display identity where literals are currently duplicated.
2. Add tests that inventory both binary aliases and all host manifests.
3. Make release workflows accept an explicit npm package name instead of assuming the repository name.
4. Verify native artifact discovery is independent of the top-level npm package name.
5. Verify documentation, issue templates, badges, and release automation can use the future repository URL.

**Exit criteria:** no behavior change, all current installs remain identical, and the release pipeline can build either top-level package identity from an explicit setting.

### Phase 1: publish the new package as a compatibility-equivalent release

1. Create `open-codebase-index` with the same versioned implementation and supported platforms.
2. Export both binaries:
   - `open-codebase-index-mcp`
   - `opencode-codebase-index-mcp`
3. Preserve existing host config and index paths.
4. Preserve all tool contracts and plugin behavior.
5. Update new installation examples to prefer `open-codebase-index`.
6. Keep `opencode-codebase-index` fully functional and point its documentation to the new package.

The old package can initially remain a synchronized publication of the same code. A thin wrapper is preferable only after package-manager, plugin-loader, CommonJS, ESM, and native-binary behavior has been proven for that arrangement.

**Exit criteria:** clean installs of both package names pass the same host, MCP, ESM/CJS, native-load, and tool-conformance tests on every supported platform.

### Phase 2: rename the GitHub repository and public branding

1. Rename the repository to `open-codebase-index`.
2. Update package repository, homepage, bugs, funding, badges, clone commands, and contribution links.
3. Update GitHub Actions references, release workflows, marketplace metadata, and external installation snippets.
4. Keep explicit tests for old GitHub URLs only where compatibility documentation intentionally mentions the redirect.
5. Announce that storage locations and tool names are intentionally unchanged.

### Phase 2 readiness checklist

- [x] Publish and CI use the workflow repository URL override from `GITHUB_REPOSITORY` so metadata stages follow the active host URL.
- [x] Add targeted identity test coverage for:
  - checked-in defaults remain unchanged without overrides,
  - explicit override updates package, Claude, and Codex staged metadata.
- [x] Ensure invalid or unknown repository URLs fail fast with clear errors.
- [x] Keep checked-in links on the live repository until the rename is approved. The release workflow is already rename-safe because it derives staged metadata from `GITHUB_REPOSITORY`.
- [ ] Rename the GitHub repository only after explicit maintainer approval.
- [ ] Immediately after the rename, update checked-in public links and verify redirects, provenance, and marketplace installation.

Intentional pre-rename references to `Helweg/opencode-codebase-index` are classified as follows:

| Location | Why it remains | When to update |
|---|---|---|
| `package.json`, `src/identity-catalog.json` current identity, and checked-in host manifests | Describe the currently live repository and legacy compatibility identity | Immediately after the GitHub rename; retain the catalog's current identity as the documented compatibility value |
| `README.md`, `SECURITY.md`, `TROUBLESHOOTING.md`, and `docs/installation.md` | Must resolve before the new repository URL exists | In the rename commit or immediately after the rename |
| Historical `CHANGELOG.md` comparison links | Release history currently resolves through the live repository | After the rename, relying on GitHub redirects for old external links |
| This migration document | Explicitly documents both old and future identities | Keep both identities for historical and operational context |

Phase 2 rename changes require explicit maintainer approval and are not to be executed during this repository-rename preparation pass.

**Exit criteria:** fresh clones, pull requests, release automation, package provenance, source links, and documentation links resolve through the new repository identity.

### Phase 3: deprecate legacy entrypoints

After at least one minor release and observed adoption:

1. Mark the old npm package as deprecated with an exact replacement command.
2. Keep publishing security or critical compatibility fixes during the announced window.
3. Emit a concise warning only from legacy package or binary entrypoints. Do not add warnings to users already on the new package.
4. Measure remaining legacy package downloads and support requests.
5. Publish a retirement date before removing any alias.

**Exit criteria:** the documented support window has elapsed, migration telemetry and issue volume are acceptable, and removal has explicit maintainer approval.

### Phase 4: optional internal cleanup

Internal identities such as `codebase-index-native`, native artifact filenames, cache metadata keys, or historical fallback constants should be renamed only if they create ongoing maintenance cost.

Such changes need their own compatibility design because they affect:

- prebuilt native artifact names and dynamic loading,
- GitHub release matrices and npm optional packages,
- persisted metadata and migration keys,
- downstream build scripts,
- cache reuse across upgrades.

The default decision should be to leave these stable.

## Storage and configuration policy

Do not rename directories such as `.opencode`, `.codebase-index`, `.claude`, or their global equivalents as part of product branding.

Those paths identify host integration and existing user state. Moving them would create duplicated indexes, expensive re-embedding, confusing precedence, and rollback risk.

If a future neutral storage root is desired, implement it separately with all of the following:

1. Read old and new locations with deterministic precedence.
2. Never copy or delete data automatically during a read-only command.
3. Use an explicit migration command with a dry-run report.
4. Detect cross-device moves, partial copies, locks, and concurrent indexers.
5. Preserve a rollback path until the new index is opened and validated successfully.
6. Test linked worktrees, global scope, every host mode, and interrupted migration recovery.

No neutral storage migration is required for the public rename.

## Package and binary compatibility design

During the transition, the new `package.json` should expose both binary names to the same built CLI:

```json
{
  "bin": {
    "open-codebase-index-mcp": "dist/cli.js",
    "opencode-codebase-index-mcp": "dist/cli.js"
  }
}
```

Keep `src/cli.ts` and `dist/cli.*` as stable executable facades. The MCP implementation remains under `src/adapters/mcp/`.

Before publishing, test:

- direct npm execution of both binary names,
- global and local installs,
- symlink entrypoint detection,
- ESM and CommonJS loading,
- all supported native platforms,
- explicit `--host` routing,
- shutdown and watcher cleanup,
- eval and visualization subcommands.

## Plugin and host migration

### OpenCode

Keep the old plugin package valid throughout the compatibility window. Document the new package as preferred only after OpenCode has been tested with both names and upgrade behavior is understood.

Do not rename `.opencode/codebase-index.json` or `.opencode/index/`.

### MCP clients, Codex, Claude, and Jcode

Update generated examples and manifests to invoke `open-codebase-index-mcp`, while accepting the old binary alias. Preserve `--host` values and host-specific config paths.

### Pi

Update package installation instructions while preserving the existing extension entrypoint, portable tool names, and Pi-only knowledge-base aliases.

## Validation matrix

Every migration phase should pass this matrix before release:

### Source and contract checks

- TypeScript typecheck and lint.
- Rust formatting and unit tests.
- Exact OpenCode, MCP, and Pi tool inventory tests.
- Request schema, null handling, defaults, and output conformance tests.
- Repository-wide search for unintended stale product identities.
- Diff check confirming storage paths and tool names did not change.

### Build and package checks

- Full TypeScript and native builds.
- Built CLI smoke tests for ESM and CommonJS.
- `npm pack --dry-run` and inspection of included files.
- Clean installation from the produced tarball under both package names.
- Both binary aliases execute the same artifact.
- Native module loads on macOS ARM64/x64, Linux x64/ARM64, and Windows x64.

### Host checks

- OpenCode plugin registration and lifecycle.
- MCP stdio startup, prompts, tools, shutdown, and indexing locks.
- Pi registration and conformance.
- Codex, Claude, and Jcode manifest/package tests.
- Host-specific config and index path tests.
- Existing-index upgrade without re-embedding.

### Release checks

- Package provenance points to the renamed repository.
- GitHub release artifacts match package metadata.
- Old and new documentation URLs resolve.
- Rollback installation instructions are tested.
- No tag or package is published until all platform jobs pass.

## Rollback plan

Each phase must be independently reversible.

- **New package problem:** deprecate the affected new version, point users back to the still-supported old package, and publish a fixed version. Existing indexes remain in place.
- **Binary alias problem:** restore both bin entries in a patch release. Do not require users to move config or data.
- **Repository rename problem:** use GitHub redirects temporarily, restore documentation links, and avoid changing package provenance again until automation is fixed.
- **Manifest problem:** republish corrected host metadata without changing tool contracts.
- **Native artifact problem:** retain the stable `codebase-index-native` identity and republish platform artifacts before changing any internal name.

A rollback must not delete caches, indexes, configs, tags, releases, or the legacy npm package.

## Work that should remain separate

Do not combine the public rename with:

- tool renaming or schema normalization,
- storage-path migration,
- native binary renaming,
- persistence-format changes,
- embedding model changes,
- removal of host-specific aliases,
- a major Indexer or parser refactor.

Separating these changes keeps regressions attributable and makes rollback practical.

## Maintainer approval gates

Require explicit approval before each of these actions:

- reserving or publishing the `open-codebase-index` npm package,
- renaming the GitHub repository,
- changing package provenance or release credentials,
- deprecating the old npm package,
- removing the old binary alias,
- changing any user storage path,
- renaming native artifacts,
- tagging or publishing a release.

Until those approvals are given, the correct endpoint is a fully validated migration plan and compatibility-ready code, not an executed rename.
