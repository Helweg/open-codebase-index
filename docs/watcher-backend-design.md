# Low-descriptor watcher design

**Status:** proposal for issue #268. This document does not change the production watcher.

## Evidence

The baseline command, `npm run benchmark:watcher`, creates a deterministic tree and measures the current `FileWatcher` against the real filesystem.

On macOS with Node v26.6.0, the Chokidar backend used an additional 2,001 descriptors for 2,000 TypeScript files in 253 directories. Startup took 274.6 ms wall time and 693.9 ms CPU. Add, change, and unlink were all delivered, and the descriptors were released after `stop()`.

The same fixture with Node's recursive `fs.watch` added no descriptors. Its notifications were not semantic: creation, content replacement, and deletion each arrived as `rename`. Therefore a backend must not treat native `eventType` as `add`, `change`, or `unlink`.

## Compatibility contract

The public `FileWatcher` contract remains unchanged:

- `start(handler)` delivers debounced `FileChange[]` with `add`, `change`, or `unlink`.
- `waitUntilReady()` resolves only once event coverage and the initial snapshot are coherent.
- `stop()` prevents stale events and closes every underlying watcher.
- Include, exclude, gitignore, restricted-path, config-file, external-config, and linked-worktree behavior remains identical.
- The MCP, OpenCode, Pi, Codex, Claude, and Jcode lifecycle paths continue to own one watcher and await its shutdown.

The new internal boundary should deliberately be weaker:

```ts
interface WatcherBackend {
  start(onInvalidate: (path: string | null) => void): Promise<void>;
  stop(): Promise<void>;
}
```

`path` is a hint, not a fact. `null` means the backend could not identify a path. Backends never claim an event is an add, change, or unlink.

## Reconciliation model

A reconciler owns a filtered snapshot:

```ts
Map<absolutePath, { size: number; mtimeMs: number }>
```

It uses the existing file eligibility rules rather than duplicating glob, ignore, or restricted-directory policy.

1. Build snapshot A.
2. Start the backend.
3. Build snapshot B and emit the difference from A. This closes the startup race between the first scan and backend activation.
4. For a path hint, debounce and rescan that file or subtree. Compare the scoped result with the stored snapshot.
5. For a missing path hint, debounce and reconcile the full snapshot.
6. Emit `add` for new entries, `change` for fingerprints that differ, and `unlink` for previous entries no longer present.
7. Replace only the reconciled portion of the stored snapshot after a successful scan.

A directory hint requires a recursive scoped scan. A removed directory requires deleting all known snapshot entries under its normalized prefix. A config file outside the project remains an explicitly watched target and is reconciled as a single path.

This makes reconciliation authoritative. Native notifications only decide when and where to look.

## Backend selection

At startup, attempt the recursive native backend only after a runtime capability check. A platform name is not sufficient because Node and filesystem support vary.

| Capability | Backend | Correctness mechanism |
|---|---|---|
| Recursive `fs.watch` can be created | Native recursive backend | Snapshot reconciliation |
| Recursive setup unavailable or fails | Existing Chokidar backend | Existing normalized events, plus the same reconciliation boundary when introduced |
| Runtime watcher error after startup | Explicit recovery path | Close the failed backend, re-establish coverage, reconcile before declaring ready |

Polling is recovery-only. It must not be silently selected as the normal low-descriptor path.

## Required acceptance checks

Before the native backend can become the default:

1. The benchmark must show a non-linear descriptor improvement on a 2,000-file fixture.
2. Repeated real-filesystem tests must deterministically report add, content change, unlink, directory creation/removal, ignored paths, root files, and dotfiles.
3. Config refresh tests must cover project config, explicit external config, inherited worktree config, create, delete, and recreate.
4. A synthetic backend test must cover null filenames, duplicate hints, stale callbacks after stop, and the startup scan race.
5. The MCP built-CLI signal and shutdown smoke test must pass.
6. Native and fallback implementations must pass the same contract suite. Platform-specific results must be recorded instead of inferred.

## Implementation sequence

1. Extract eligibility and snapshot-diff logic with direct unit tests.
2. Add an internal invalidation backend interface while keeping Chokidar as the active backend.
3. Add a native recursive backend behind an opt-in test switch.
4. Run the contract suite and descriptor benchmark across available target platforms.
5. Enable native recursive watching only where the capability and correctness gates pass.
