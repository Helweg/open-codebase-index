# Configuration

Configuration is optional. Defaults are applied when fields are omitted.

## Configuration locations

| Host | Project config | Project index | Global config | Global index |
|---|---|---|---|---|
| OpenCode | `.opencode/codebase-index.json` | `.opencode/index/` | `~/.config/opencode/codebase-index.json` | `~/.opencode/global-index/` |
| Claude | `.claude/codebase-index.json` | `.claude/index/` | `~/.claude/codebase-index.json` | `~/.claude/global-index/` |
| Codex, Pi, Jcode | `.codebase-index/config.json` | `.codebase-index/index/` | `~/.config/codebase-index/config.json` | `~/.codebase-index/global-index/` |

Non-OpenCode hosts can fall back to existing OpenCode configuration or index state when a host-specific location does not exist.

Linked worktrees without their own host-specific project config inherit both the config and project index from the main checkout. Project-owned paths are stored relative to the project root, while branch catalogs and branch-scoped runtime state keep each checkout's contents separate. Adding a project config inside a worktree creates a local config and index boundary instead.

Because inheriting worktrees operate on the same project index, clearing or force-rebuilding it from one checkout affects the main checkout and every other inheriting worktree. Legacy project indexes that contain absolute stored paths must be rebuilt once with `index_codebase` and `force: true`. Global indexes continue to use canonical absolute paths.

Git project indexes store file-change and retry state in `file-hashes.<branch-hash>.json` and `failed-batches.<branch-hash>.json`. Non-Git project indexes and global indexes keep the unnamespaced `file-hashes.json` and `failed-batches.json` filenames.

## Minimal example

```json
{
  "embeddingProvider": "auto",
  "scope": "project"
}
```

## Embedding providers

Supported values:

- `auto`
- `ollama`
- `openai`
- `google`
- `custom`

Automatic detection order:

1. Ollama
2. OpenAI
3. Google

### Ollama

```bash
ollama pull nomic-embed-text
```

```json
{
  "embeddingProvider": "ollama"
}
```

### OpenAI and Google

Set the provider and corresponding environment credentials:

```json
{
  "embeddingProvider": "openai"
}
```

```bash
export OPENAI_API_KEY=...
```

For Google, use `embeddingProvider: "google"` and configure the Google API credentials expected by your environment.

`github-copilot` is no longer supported for embeddings because GitHub Models retired its inference API. Migrate to OpenAI, Google, Ollama, or a custom OpenAI-compatible endpoint, then force-rebuild the index.

### Google models

`gemini-embedding-2` is available with Google's recommended code-retrieval query and document formatting. The default remains `gemini-embedding-001` until retrieval benchmarking supports changing it.

### Custom OpenAI-compatible endpoint

```json
{
  "embeddingProvider": "custom",
  "customProvider": {
    "baseUrl": "http://localhost:11434/v1",
    "model": "nomic-embed-text",
    "dimensions": 768,
    "maxTokens": 8192,
    "timeoutMs": 30000,
    "concurrency": 3,
    "requestIntervalMs": 0
  }
}
```

The `/embeddings` path is appended to `baseUrl`. `apiKey` and `maxBatchSize` are optional.

Changing provider, model, dimensions, or embedding strategy can make an existing index incompatible. Check `index_status` and rebuild with `force: true` only when required.

## Scope

```json
{
  "scope": "project"
}
```

- `project`: store the index with the repository.
- `global`: use the host-specific global index path.

## Indexing defaults

| Option | Default | Purpose |
|---|---:|---|
| `autoIndex` | `false` | Run first-use automatic indexing for retrieval tools |
| `autoIndexWaitMs` | `10000` | Maximum first-use wait time |
| `autoIndexMaxRetries` | `5` | Transient lock retries |
| `autoIndexRetryDelayMs` | `100` | Initial retry delay |
| `watchFiles` | `true` | Watch files and branches for incremental updates |
| `pauseBackgroundIndexingOnBattery` | `false` | On macOS, defer automatic background indexing on battery |
| `maxFileSize` | `1048576` | Maximum file size in bytes |
| `maxChunksPerFile` | `100` | Maximum semantic chunks per file |
| `semanticOnly` | `false` | Skip generic blocks and keep semantic chunks |
| `retries` | `3` | Embedding retry attempts |
| `retryDelayMs` | `1000` | Initial embedding retry delay |
| `autoGc` | `true` | Enable automatic orphan cleanup |
| `gcIntervalDays` | `7` | Cleanup interval |
| `gcOrphanThreshold` | `100` | Orphan threshold for cleanup |
| `requireProjectMarker` | `true` | Require `.git`, `package.json`, or another project marker before watching |
| `maxDepth` | `5` | Directory traversal depth; `-1` is unlimited |
| `maxFilesPerDirectory` | `100` | Per-directory file cap |
| `fallbackToTextOnMaxChunks` | `true` | Fall back to line chunks when the semantic cap is reached |
| `gitBlame.enabled` | `false` | Store git blame metadata for filtering |

Example:

```json
{
  "indexing": {
    "autoIndex": false,
    "watchFiles": true,
    "maxFileSize": 1048576,
    "maxChunksPerFile": 100,
    "requireProjectMarker": true,
    "gitBlame": {
      "enabled": false
    }
  }
}
```

## Search defaults

| Option | Default | Purpose |
|---|---:|---|
| `maxResults` | `20` | Default result limit |
| `minScore` | `0.1` | Minimum accepted score |
| `includeContext` | `true` | Read source context for full results |
| `hybridWeight` | `0.5` | Keyword weight for weighted fusion |
| `fusionStrategy` | `rrf` | `rrf` or `weighted` |
| `rrfK` | `60` | Reciprocal-rank fusion constant |
| `rerankTopN` | `20` | Deterministic reranking pool |
| `contextLines` | `0` | Extra source lines around results |
| `routingHints` | `true` | Inject host routing guidance |
| `routingGraphHandoffHints` | `false` | Include graph handoff guidance |
| `routingHintRole` | `system` | `system` or `developer` |
| `communityBoost` | `0` | Opt-in multiplicative boost (`0` to `1`) for candidates in an exact query symbol's call-graph community |

`communityBoost` is experimental and disabled by default. It activates only when the query contains one unambiguous exact symbol already present in the active branch catalog. Existing branch, directory, file-type, chunk-type, blame, and score filters run first, so community context can reorder only candidates that already passed normal search scope. Missing or ambiguous symbols and unavailable graph data fall back to the existing ranking.

## Include and exclude patterns

```json
{
  "include": ["**/*.ts", "**/*.tsx"],
  "additionalInclude": ["scripts/**/*.mjs"],
  "exclude": ["**/generated/**"]
}
```

- `include` replaces the default include patterns.
- `additionalInclude` extends the defaults.
- `exclude` replaces the default exclude patterns.
- `.gitignore` is also respected.

## Knowledge bases

Index additional directories alongside the project:

```json
{
  "knowledgeBases": [
    "../shared-docs",
    "/absolute/path/to/reference-source"
  ]
}
```

Paths can be absolute or relative to the project root. OpenCode and Pi also expose host-native tools for adding, listing, and removing knowledge bases.

## External reranking

Reranking is disabled unless configured.

```json
{
  "reranker": {
    "enabled": true,
    "provider": "cohere",
    "model": "rerank-v3.5",
    "apiKey": "...",
    "topN": 20,
    "timeoutMs": 10000
  }
}
```

Providers:

- `cohere`, default base URL `https://api.cohere.ai/v1`
- `jina`, default base URL `https://api.jina.ai/v1`
- `custom`, requires `baseUrl`

When reranking is enabled, `topN` defaults to `15` and `timeoutMs` defaults to `10000`. Directory, file-type, chunk-type, branch, and blame filters are applied before candidates are sent to the reranker.

## Debug and metrics

```json
{
  "debug": {
    "enabled": true,
    "logLevel": "info",
    "metrics": true
  },
  "effectivenessMetrics": {
    "enabled": false
  }
}
```

Debug defaults:

- logging disabled
- log level `info`
- search, embedding, cache, GC, and branch categories enabled when logging is active
- operational metrics enabled when debug logging is active

`effectivenessMetrics.enabled` separately opts into privacy-safe, process-lifetime repository-tool aggregate counters.

## Complete representative example

```json
{
  "embeddingProvider": "auto",
  "scope": "project",
  "indexing": {
    "autoIndex": false,
    "watchFiles": true,
    "pauseBackgroundIndexingOnBattery": false,
    "maxFileSize": 1048576,
    "maxChunksPerFile": 100,
    "semanticOnly": false,
    "requireProjectMarker": true,
    "maxDepth": 5,
    "maxFilesPerDirectory": 100,
    "fallbackToTextOnMaxChunks": true,
    "gitBlame": {
      "enabled": false
    }
  },
  "search": {
    "maxResults": 20,
    "minScore": 0.1,
    "includeContext": true,
    "hybridWeight": 0.5,
    "fusionStrategy": "rrf",
    "rrfK": 60,
    "rerankTopN": 20,
    "contextLines": 0,
    "communityBoost": 0
  },
  "knowledgeBases": [],
  "debug": {
    "enabled": false,
    "logLevel": "info",
    "metrics": true
  },
  "effectivenessMetrics": {
    "enabled": false
  }
}
```

For recovery steps, see [Troubleshooting](../TROUBLESHOOTING.md). For internals, see [Architecture](../ARCHITECTURE.md).
