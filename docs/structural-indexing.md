# Provider-free structural indexing

Set `indexing.mode` explicitly to use local parsing, definitions, call graphs and BM25 keyword retrieval without initializing an embedding provider:

```json
{
  "indexing": {
    "mode": "structural"
  }
}
```

The default remains `hybrid`, which uses semantic vectors as well as structural evidence. Configure this in the normal host-specific project configuration. No provider credentials are needed for structural mode.

## Workflow

```bash
cbi index --project /path/to/repository --host jcode
cbi status --project /path/to/repository --host jcode
cbi definition parseConfig --project /path/to/repository --host jcode
cbi graph callers parseConfig --project /path/to/repository --host jcode
cbi search 'configuration validation' --project /path/to/repository --host jcode
```

In structural mode, search is keyword-based, not semantic similarity. Definitions and graph operations use the indexed structural catalog. Retrieval quality for paraphrases can differ substantially from hybrid mode. `find_similar` and embedding-cost estimation are unsupported rather than simulated with dummy vectors. MCP reports unsupported operations as non-retryable `UNSUPPORTED_OPERATION` errors.

## Storage and safety

Structural artifacts live in a `structural/` child of the normal resolved index directory. Existing hybrid artifacts are not moved, overwritten or converted. Switching modes selects the corresponding index, so a first structural index must be built even when a hybrid index already exists.

Structural mode persists source chunks, symbols and graph edges in SQLite and publishes a BM25 keyword index. It does not create semantic vectors or embedding records. Status distinguishes stored chunks across branches from active-branch coverage and reports no embedding provider. A compatible mode alone does not prove that current source bytes were indexed.

Generation checks detect interrupted SQLite/keyword publication. A damaged or incomplete keyword index should block readiness and require normal indexing to recover. Recovery uses persisted branch-referenced source text where available. Older structural artifacts without recoverable source text may require an explicit force rebuild. Force and deletion checks should always use an isolated test project before operating on valuable indexes.

## Scope

This is a local retrieval mode, not a replacement for compiler analysis or a guarantee that every dynamic call is resolved. Optional SCIP enrichment has its own configuration and external artifact requirements. Named workspace status reports repository coverage independently and does not infer cross-repository edges.

See [implementation validation](reliable-change-context-validation.md) for observed checks and outstanding integration gates. This document describes the implementation under review, not release approval or a performance superiority claim.
