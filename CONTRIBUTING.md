# Contributing to open-codebase-index

Thank you for your interest in contributing! This document provides guidelines and information for contributors.

## Quick Contribution Checklist

Use this when you just want the shortest path to a good PR:

1. Create a branch
2. Implement + add/update tests
3. Run: `npm run build && npm run typecheck && npm run lint && npm run test:run`
4. Add at least one release category label
5. Open PR with summary + testing notes

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Project Structure](#project-structure)
- [Release Labels and Notes](#release-labels-and-notes)

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/open-codebase-index.git
   cd open-codebase-index
   ```
3. **Install dependencies**:
   ```bash
   npm ci
   ```
4. **Build the project**:
   ```bash
   npm run build
   ```

## Development Setup

### Prerequisites

- Node.js 22.19 or newer for development (required by the Pi development dependencies). Node.js 24 LTS is recommended. The published package supports Node.js 22.13 or newer.
- Rust toolchain (for native module)
- npm

### Building

```bash
# Build everything (TypeScript + Rust)
npm run build

# Build only TypeScript
npm run build:ts

# Build only Rust native module
npm run build:native
```

### Testing

```bash
# Run all tests
npm run test:run

# Run tests in watch mode
npm run test

# Run Rust tests
cd native && cargo test
```

The default-root-build watcher rejection scenarios in
`tests/include-excluded-paths-indexing.test.ts` retain diagnostics **only on
failure**, after stopping watchers, settling handler tails, and closing indexers,
before deleting their temporary fixtures. Successful runs retain nothing.

Look for `[watcher failure capture]` in stderr. Locally the printed private
directory is under `<os.tmpdir()>/ocbi-watcher-failures/`; CI uses
`${RUNNER_TEMP}/ocbi-watcher-failures/` and uploads it on job failure as
`watcher-failures-node-<version>-<run>-<attempt>` for 14 days.
`capture.json` contains monotonic observations, first/last phase anchors,
suppressed warnings, dropped-event and explicit detail-byte-cut counts,
bounded numeric index statistics, runtime/backend information, and a snapshot
inventory. Only genuine notifications from the initially available
Chokidar emitter are observed; replacement/native notifications and internal
filtering, queueing, and flushing are marked `MISSING`, not inferred.

Limits per scenario: 512 tail events of at most 2 KiB each, fixed first/last
phase anchors, 256 visited fixture entries, 16 MiB of combined source/index
snapshots, and 18 MiB total including metadata. Caps, refused paths, capture
errors, and unavailable evidence are reported as `MISSING`. Symlinks,
hardlinks, special files, and replaced fixture roots are refused. Index
snapshots require both all watcher stops and all indexer closes to succeed,
after handler tails settle; otherwise only safe source fixtures are retained.
These quiescence checks do not prove database consistency. POSIX mode and
directory-FD guards may refuse Windows snapshots as `MISSING`; Windows
snapshot coverage has not been verified. These checks are not an adversarial
filesystem-race guarantee.

Diagnostic text redacts absolute private paths, but **raw fixture index files
can contain temporary paths**. Inspect artifacts privately; do not commit them
or publish raw contents. A native cache observation and current-disk digest do
not prove the bytes originally executed. A passing run is a non-reproduction,
not evidence that a historical watcher failure is fixed.

### Linting

```bash
# Run ESLint
npm run lint

# Run Clippy (Rust)
cd native && cargo clippy
```

## Making Changes

1. **Create a feature branch**:
   ```bash
   git checkout -b feature/my-feature
   ```

2. **Make your changes** and add tests if applicable

3. **Run checks** before committing:
   ```bash
   npm run build && npm run typecheck && npm run lint && npm run test:run
   ```

4. **Commit with a descriptive message**:
   ```bash
   git commit -m "feat: add my feature"
   ```
   
   We follow [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` - New feature
   - `fix:` - Bug fix
   - `docs:` - Documentation changes
   - `perf:` - Performance improvement
   - `refactor:` - Code refactoring
   - `test:` - Adding/updating tests
   - `chore:` - Maintenance tasks

5. **Push and open a pull request**:
    ```bash
    git push origin feature/my-feature
    ```

### Adding a new language?

If you're contributing parser or call-graph support for a new language, use [`docs/adding-language-support.md`](./docs/adding-language-support.md). It explains the difference between file discovery, semantic parsing, and call-graph support, and lists every code path you may need to update.

## Pull Request Guidelines

- Keep PRs focused and atomic
- Include tests for new functionality
- Update documentation if needed
- Ensure CI passes before requesting review
- Add at least one release category label (`feature`, `bug`, `performance`, `documentation`, `dependencies`, `refactor`, `test`, or `chore`)

## Project Structure

```
src/                  # TypeScript source
  ├── indexer/        # Index orchestration, ranking, batching, locks, and impact analysis
  ├── embeddings/     # Embedding providers
  ├── tools/          # Tool contracts, operations, context routing, and formatting
  ├── git/            # Branch detection, ref resolution, and temporary materialization
  ├── native/         # Focused TypeScript wrappers around Rust bindings
  └── config/         # Configuration schema

native/src/           # Rust native module
  ├── bindings/       # NAPI class facades
  ├── db/             # Focused SQLite persistence domains
  ├── parser.rs       # Tree-sitter parsing and parser policy
  ├── call_extractor.rs # Language-aware call extraction
  ├── store.rs        # Vector storage and publication
  └── inverted_index.rs # BM25 search

tests/                # Unit tests
```

## Release Labels and Notes

This repository enforces release labels in CI (`Release Label Check`).

- Every PR must include at least one release category label (`feature`, `bug`, `performance`, `documentation`, `dependencies`, `refactor`, `test`, `chore`, or `skip-changelog`).
- Use `semver:major`, `semver:minor`, or `semver:patch` when the change should explicitly drive the release bump.
- Use `skip-changelog` only for intentionally excluded changes.

## Questions?

Open an issue for any questions or concerns. We're happy to help!
