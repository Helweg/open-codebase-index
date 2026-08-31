# Installation and host setup

`open-codebase-index` requires Node.js 20 or newer and is the preferred package identity. `opencode-codebase-index` remains a supported legacy package alias, and `open-codebase-index-mcp` is the preferred binary alias.

The published package includes the MCP server dependencies and native binaries for supported platforms.

## OpenCode

Install the package:

```bash
npm install open-codebase-index
```

Legacy install:

```bash
npm install opencode-codebase-index
```

Add it to `opencode.json`:

```json
{
  "plugin": ["open-codebase-index"]
}
```

Legacy OpenCode alias:

```json
{
  "plugin": ["opencode-codebase-index"]
}
```

Open the repository, run `/status`, and then run `/index`.

OpenCode uses:

- project config: `.opencode/codebase-index.json`
- project index: `.opencode/index/`
- global config: `~/.config/opencode/codebase-index.json`
- global index: `~/.opencode/global-index/`

## Jcode

Jcode starts non-shared MCP servers in each session's working directory. Configure the server once in `~/.jcode/mcp.json`:

```json
{
  "servers": {
    "codebase-index": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "open-codebase-index@latest",
        "open-codebase-index-mcp",
        "--host",
        "jcode"
      ],
      "env": {},
      "shared": false
    }
  }
}
```

Do not add a fixed `--project` argument. Jcode supplies the active session directory as the process working directory. `shared: false` prevents indexer state from being shared across repositories.

Restart Jcode after changing the MCP configuration. Jcode uses `.codebase-index/` project storage and can fall back to existing OpenCode state when appropriate.

## Pi

Install the Pi package:

```bash
pi install npm:open-codebase-index
```

For local development:

```bash
pi install ./path/to/open-codebase-index
```

The package provides native tools and the `codebase-search` skill. Pi uses `.codebase-index/` project storage.

## Codex

Add the marketplace and install the plugin:

```text
codex plugin marketplace add Helweg/open-codebase-index
codex plugin add codebase-index@helweg-plugins
```

Restart or open a new thread in the target workspace. The plugin bundles MCP configuration, session guidance, and the `codebase-search` skill.

If Codex reports `Transport closed`, inspect `index_status` from a new thread or client session. Server-side cancellation and durable diagnostics cannot make a client reuse a stdio transport that it has already closed.

For local plugin development from this checkout:

```bash
npm run build:ts
npm run dev:link-mcp
```

Codex uses `.codebase-index/` project storage.

## Claude Code

From Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add Helweg/open-codebase-index
/plugin install codebase-index@helweg-plugins
```

Restart or open a new session in the target workspace. The plugin includes MCP configuration and the `codebase-search` skill.

Claude uses:

- project config: `.claude/codebase-index.json`
- project index: `.claude/index/`
- global config: `~/.claude/codebase-index.json`
- global index: `~/.claude/global-index/`

## Human CLI

The concise `cbi` command is for terminal use. It shares `open-codebase-index` index and retrieval operations, while `open-codebase-index-mcp` remains the MCP-server binary.

```bash
# Inspect readiness, then create or refresh the index
cbi status --project /path/to/repo --host jcode
cbi index --project /path/to/repo --host jcode

# Search and inspect code from the terminal
cbi search "retry recovery" --project /path/to/repo --limit 5
cbi definition Indexer --project /path/to/repo
cbi graph callers Indexer --project /path/to/repo
```

Use `cbi index --dry-run` for a parse-only embedding-token total, `--estimate-only` for an estimate, and `cbi --help` for command usage.

## Generic MCP clients

Run the published MCP server with `npx`:

```bash
npx -y --package open-codebase-index open-codebase-index-mcp --project /path/to/repo
```

Legacy command:

```bash
npx -y --package opencode-codebase-index opencode-codebase-index-mcp --project /path/to/repo
```

Example MCP configuration:

```json
{
  "mcpServers": {
    "codebase-index": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "open-codebase-index",
        "open-codebase-index-mcp",
        "--project",
        "/path/to/repo"
      ]
    }
  }
}
```

### CLI options

```text
--project <path>  Repository to index. Defaults to the current directory.
--config <path>   Explicit configuration file.
--host <mode>     opencode, codex, claude, pi, or jcode.
```

Examples:

```bash
open-codebase-index-mcp --project /path/to/repo
open-codebase-index-mcp --config /path/to/config.json
open-codebase-index-mcp --host jcode
```

Use `--host` when you want the corresponding host's configuration and storage paths. Without it, the CLI uses OpenCode-compatible behavior.

The same binary also accepts a dedicated indexing mode:

```bash
open-codebase-index-mcp index --project /path/to/repo --estimate-only
open-codebase-index-mcp index --project /path/to/repo --force
open-codebase-index-mcp index --project /path/to/repo --config /path/to/config.json --host jcode
opencode-codebase-index-mcp index --project /path/to/repo --estimate-only
```

When using `index`:

- `--estimate-only` prints the estimate directly and exits.
- `--dry-run` parses the file set and reports the exact embedding token total (files, source chunks, tokens) without indexing; read-only, no embedding requests.
- `--force` bypasses stale-index checks.
- `--verbose` includes detailed final index statistics.
- `--config` loads and parses that file, then initializes the runtime from it before indexing.

Progress and diagnostics for `index` are written to `stderr`; the final formatted result is written to `stdout`.

## Local source checkout

```bash
npm ci
npm run build:ts
npm run dev:link-mcp
```

If native code changed, run:

```bash
npm run build:native
```

## First use

For every host:

1. Open the repository you want to index.
2. Run `index_status` or `/status`.
3. Run `index_codebase` or `/index` if the index is missing or stale.
4. Start with `codebase_context` for repository questions.

Provider setup and storage configuration are covered in [Configuration](configuration.md). Tool selection is covered in [Tools and commands](tools.md).
