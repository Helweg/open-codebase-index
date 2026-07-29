# Installation and host setup

`opencode-codebase-index` requires Node.js 20 or newer. The published package includes the MCP server dependencies and native binaries for supported platforms.

## OpenCode

Install the package:

```bash
npm install opencode-codebase-index
```

Add it to `opencode.json`:

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
        "opencode-codebase-index@latest",
        "opencode-codebase-index-mcp",
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
pi install npm:opencode-codebase-index
```

For local development:

```bash
pi install ./path/to/opencode-codebase-index
```

The package provides native tools and the `codebase-search` skill. Pi uses `.codebase-index/` project storage.

## Codex

Add the marketplace and install the plugin:

```text
codex plugin marketplace add Helweg/opencode-codebase-index
codex plugin add codebase-index@helweg-plugins
```

Restart or open a new thread in the target workspace. The plugin bundles MCP configuration, session guidance, and the `codebase-search` skill.

For local plugin development from this checkout:

```bash
npm run build:ts
npm run dev:link-mcp
```

Codex uses `.codebase-index/` project storage.

## Claude Code

From Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add Helweg/opencode-codebase-index
/plugin install codebase-index@helweg-plugins
```

Restart or open a new session in the target workspace. The plugin includes MCP configuration and the `codebase-search` skill.

Claude uses:

- project config: `.claude/codebase-index.json`
- project index: `.claude/index/`
- global config: `~/.claude/codebase-index.json`
- global index: `~/.claude/global-index/`

## Generic MCP clients

Run the published MCP server with `npx`:

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
        "opencode-codebase-index",
        "opencode-codebase-index-mcp",
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
opencode-codebase-index-mcp --project /path/to/repo
opencode-codebase-index-mcp --config /path/to/config.json
opencode-codebase-index-mcp --host jcode
```

Use `--host` when you want the corresponding host's configuration and storage paths. Without it, the CLI uses OpenCode-compatible behavior.

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
