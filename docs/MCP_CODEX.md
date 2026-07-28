# MCP and Codex

## Codex plugin

The plugin root is `plugins/roadmap-management` and contains:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `skills/roadmap-management/SKILL.md`

Validate it:

```sh
node scripts/validate-plugin.mjs plugins/roadmap-management
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/roadmap-management
```

Install through the CLI:

```sh
npm run roadmap -- mcp install \
  --api-url https://roadmap.example.com \
  --repository /absolute/path/to/application \
  --test
npm run roadmap -- codex install
```

Start a new Codex task after installation so the skill and tools are loaded.

The plugin configuration never embeds `ROADMAP_TOKEN`. Provide it to the Codex
launching environment, OS secret manager, or remote MCP bearer configuration.

## MCP transports

Local stdio:

```sh
ROADMAP_API_URL=https://roadmap.example.com \
ROADMAP_TOKEN=... \
ROADMAP_APP_REPOSITORY=/absolute/read-only/path \
node packages/mcp/dist/index.js
```

Remote Streamable HTTP:

```text
https://roadmap.example.com/mcp
Authorization: Bearer <maintainer token>
```

The server implements stable MCP 2025-11-25 initialization, deterministic
`tools/list`, `tools/call`, newline-delimited stdio, and stateless Streamable
HTTP JSON responses. `GET /mcp` returns 405 because no unsolicited server
notifications are emitted.

## Tools

- `roadmap_list`
- `roadmap_get`
- `roadmap_search`
- `roadmap_create`
- `roadmap_update`
- `roadmap_transition`
- `roadmap_link_discord_thread`
- `roadmap_add_acceptance_criterion`
- `roadmap_generate_discord_view`
- `roadmap_validate`
- `roadmap_sync_status`
- `roadmap_reconcile`
- `roadmap_history`

Local mode adds:

- `roadmap_inspect_repository`
- `roadmap_repository_changes`

Repository tools invoke `rg` and `git log` with argument arrays. They do not
invoke a shell, accept a replacement path from tool arguments, or write any
files. Remote mode does not expose local repository inspection.

## Safe mutation behavior

The skill requires Codex to read the current item revision before every write,
use the exact `expectedRevision`, and surface conflicts. Completion overrides
require an explicit reason and remain visible in audit history.

All tool mutations call the same authenticated HTTP API as the CLI and Discord
controls. MCP has no database bypass.
