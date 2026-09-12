# Workspace status

`cbi workspace status` gives a bounded, read-only readiness view across explicitly named Git repositories.

```bash
cbi workspace status \
  --repo api=../services/api \
  --repo web="../apps/web client" \
  --host jcode
```

Use `--json` for machine-readable output. The command accepts 1 to 20 repeated `--repo NAME=PATH` values. Names must be non-empty and unique. Paths are resolved relative to the current directory, may contain spaces or `=`, and duplicate canonical roots are rejected.

Each result includes the requested name, resolved root, actual Git checkout branch and HEAD, indexed runtime branch, persisted all-branch chunk count, active-branch chunk count, indexing mode, active branch readiness, compatibility, and an explicit branch mismatch marker. `ready` means the index is readable, mode-compatible, and has usable active-branch coverage. It does not mean the current HEAD or source bytes were compared with the index. `actualHead` is the checkout HEAD, `indexedBranch` is the reader catalog branch rather than an indexed commit, and `freshness` is always `not_checked`. A repository that is missing, unreadable, unindexed, incompatible, branch-mismatched, or otherwise not ready does not hide healthy repository results. Structural indexes are evaluated from their persisted chunks without requiring an embedding provider or vector count. The command prints all results and exits nonzero when any repository is unavailable or not ready.

This command does not register repositories, create or refresh indexes, start watchers, install providers, infer cross-repository edges, or promise index freshness. SQLite status reads use a bounded temporary snapshot outside the repository, including any live WAL, while vector and keyword artifacts remain read from their original locations. If the database or WAL changes during snapshotting, or either artifact is unreadable, that repository is reported unavailable rather than potentially ready from stale state. Temporary snapshots are closed and removed after each repository. Run `cbi index --project PATH --host MODE` separately when an index needs to be created or refreshed.
