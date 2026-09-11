# Optional SCIP TypeScript enrichment

OCBI can optionally use a compiler-generated [SCIP](https://github.com/scip-code/scip) index to resolve some call-graph targets that remain unresolved after normal JavaScript and TypeScript analysis.

This feature is an experimental, import-only pilot. It is disabled by default. OCBI remains responsible for symbols, call sites, call types, source ranges, and excerpts. SCIP may only change an existing unresolved edge into a resolved edge targeting one unique existing local OCBI symbol.

## Requirements

You must provide both:

1. an existing `index.scip` generated for the current checkout; and
2. an explicit path or executable name for an installed `scip` decoder CLI that supports `scip print --json`.

OCBI does not install either tool, run a package manager, invoke `npx`, download tools, access a remote service, or generate SCIP automatically.

The pilot has been verified with:

- `@sourcegraph/scip-typescript` 0.4.0
- `scip` CLI 0.10.0

Other generator or decoder versions may use unsupported encodings or JSON shapes and can be rejected conservatively.

## Generate the artifact

Install the official tools separately from OCBI and outside OCBI's production dependencies. From the repository root, run the official generator directly:

```bash
/path/to/scip-typescript index --output index.scip
```

For a JavaScript project without a `tsconfig.json`, the generator also supports its explicit inferred configuration mode:

```bash
/path/to/scip-typescript index --infer-tsconfig --output index.scip
```

Workspace selection and generator arguments are your responsibility. Consult the [scip-typescript documentation](https://github.com/sourcegraph/scip-typescript) for supported Yarn, pnpm, and project configuration modes.

Confirm that the decoder can read the artifact:

```bash
/path/to/scip print --json index.scip >/dev/null
```

Do not add generated decoder JSON to the OCBI configuration. OCBI invokes the decoder locally with a fixed argument list and bounded output.

## Configure OCBI

Add the following to the host-specific OCBI configuration described in [Configuration](configuration.md):

```json
{
  "indexing": {
    "scipTypeScript": {
      "enabled": true,
      "indexFile": "index.scip",
      "decoderCommand": "/path/to/scip",
      "timeoutMs": 30000,
      "maxOutputBytes": 67108864,
      "requireFreshIndex": true
    }
  }
}
```

`indexFile` is resolved relative to the materialized project root. It must resolve to a regular file beneath that root. Symlink escapes and mismatched SCIP project roots are rejected.

| Option | Default | Bounds and behavior |
|---|---:|---|
| `enabled` | `false` | Enables import-only enrichment |
| `indexFile` | `index.scip` | Project-relative path to an existing artifact |
| `decoderCommand` | `scip` | Explicit decoder executable, without additional arguments |
| `timeoutMs` | `30000` | Clamped to 1,000 through 300,000 ms |
| `maxOutputBytes` | `67108864` | Clamped to 1 MiB through 256 MiB; bounds decoded JSON, SCIP input, and accepted source reads |
| `requireFreshIndex` | `true` | Rejects an artifact older than relevant source or project configuration inputs |

Run normal indexing after generating the artifact or changing this configuration:

```bash
cbi index --project /path/to/repository
```

## Supported pilot scope

The pilot considers TypeScript, TSX, JavaScript, JSX, and their supported module variants. An edge is enriched only when all required evidence is unique and compatible:

- OCBI already extracted the edge and its enclosing source symbol;
- the edge is currently unresolved;
- one SCIP reference overlaps the existing callee location;
- one project-local SCIP definition maps to one existing OCBI declaration by canonical path, exact declaration-name span, and compatible target kind; and
- the target belongs to the active branch catalog.

The importer does not create edges from general SCIP references. Reads, writes, type references, documentation references, and other non-call occurrences do not become calls. Existing resolved OCBI targets are never replaced, even if SCIP disagrees.

## Freshness limitations

With `requireFreshIndex: true`, OCBI compares the artifact modification time with relevant JavaScript and TypeScript sources plus `tsconfig*`, `jsconfig*`, package manifests, workspace manifests, and common npm, Yarn, pnpm, and Bun lockfiles. The manifest scan is bounded.

This timestamp check is conservative, not cryptographic proof that `index.scip` represents the current checkout. Timestamps can be preserved or manipulated, and a generator can produce incomplete output. Regenerate the artifact after changing source, compiler configuration, dependencies, workspace layout, branch, or checkout.

OCBI fingerprints the actual artifact bytes and checks that the file does not change while it is decoded. A changed, missing, stale, oversized, or inconsistent artifact is not imported.

## Failure and disable behavior

SCIP enrichment must not make ordinary indexing fail. OCBI falls back to its normal graph when:

- the feature is disabled;
- the artifact is missing, stale, unreadable, oversized, malformed, or outside the project root;
- the decoder is missing, exits unsuccessfully, times out, or is cancelled;
- JSON paths, ranges, encodings, or project metadata are unsupported; or
- a reference or definition is absent, external, incompatible, or ambiguous.

Transitions from usable SCIP data to disabled, stale, missing, rejected, or failed states refresh JavaScript and TypeScript graph edges. Previously enriched targets are removed and rewritten using ordinary OCBI resolution. SCIP-enabled graph identities are branch-isolated so one checkout cannot overwrite another checkout's enriched target.

The decoder is executed with `execFile`, no shell, no stdin, fixed arguments, a timeout, and bounded output. OCBI never runs the generator during file watching or automatic indexing.

## Current acceptance limitations

The pilot has passed focused safety tests and a real generated artifact demonstrated a correct new method resolution, restart persistence, stale and decoder-failure clearing, one-file batch order independence, and normal Git branch isolation.

This does not establish general accuracy or performance superiority. In the current real acceptance fixture, one of two previously unresolved calls was resolved and the other remained unresolved. The pilot has not yet met the planned expansion gate across two realistic repositories, including hand-labeled precision, resolution gain, import p95, memory, and source-citation regression checks.

Keep the feature disabled unless you can generate and maintain a trusted local artifact. Treat unresolved results as conservative abstention, not proof that no relationship exists.

For design history and known risks, see [Optional local SCIP TypeScript enrichment feasibility](scip-typescript-enrichment-feasibility.md).
