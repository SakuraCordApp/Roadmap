# API

All responses are JSON. Errors use:

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "Expected revision 3, found 4.",
    "details": {}
  }
}
```

## Public read API

### `GET /healthz`

Returns service and schema health.

### `GET /api/v1/config`

Returns public branding, taxonomy, lifecycle, and section configuration. Auth,
Discord operational configuration, and deployment internals are omitted.

### `GET /api/v1/items`

Query parameters:

- `status`, `area`, `type`, `priority`, `difficulty`: comma-separated IDs
- `search`: case-insensitive title/description search
- `completedSince`: ISO-8601 timestamp
- `limit`: 1–250
- `cursor`: opaque timestamp returned as `nextCursor`

Response:

```json
{ "data": [], "nextCursor": "2026-07-24T00:00:00.000Z" }
```

### `GET /api/v1/items/:id`

Returns the complete public roadmap document.

### `GET /api/v1/history`

Optional `itemId`, `since`, and `limit` parameters. Returns ordered mutation
history with revision, action, actor identity, before/after documents, and
override reason.

### `GET /api/v1/items/:id/history`

Item-specific history.

### `POST /api/v1/validate`

Validates a complete item without mutating.

### `GET /api/v1/discord/projection`

Returns the feature-name-only projection and visible SHA-256 hash. It does not
publish.

### `GET /api/v1/sync/status`

Returns job counts, Gateway provider/status, and last reconciliation time.

## Maintainer authentication

Mutation endpoints require:

```text
Authorization: Bearer <maintainer token>
Idempotency-Key: <8–200 character unique operation ID>
Content-Type: application/json
```

Cookies are rejected. Browser requests must have an allowed `Origin`.

Every mutation response contains:

```json
{
  "data": {
    "before": {},
    "after": {},
    "diff": [{ "path": "status", "before": "planned", "after": "in_progress" }],
    "replayed": false
  }
}
```

### `POST /api/v1/items`

Creates a canonical item at revision 1.

### `PATCH /api/v1/items/:id`

Body:

```json
{ "expectedRevision": 3, "patch": { "priority": "high" } }
```

Status is rejected here; use the transition endpoint.

### `POST /api/v1/items/:id/transition`

```json
{
  "expectedRevision": 3,
  "to": "done",
  "overrideReason": "Optional explicit completion-gate bypass reason"
}
```

### Evidence and link endpoints

- `POST /api/v1/items/:id/link-discord`
- `POST /api/v1/items/:id/research`
- `POST /api/v1/items/:id/acceptance-criteria`
- `POST /api/v1/items/:id/verifications`

Each body includes `expectedRevision`.

### Operational mutations

- `POST /api/v1/reconcile`
- `POST /api/v1/discord/publish`
- `POST /api/v1/discord/forums/configure`
- `POST /api/v1/discord/reports/status`
- `POST /api/v1/discord/reports/process`
- `POST /api/v1/sync/process`
- `POST /api/v1/discord/gateway/start`
- `POST /api/v1/discord/gateway/stop`
- `POST /api/v1/discord/gateway/status`
- `POST /api/v1/ai/oauth/start`
- `POST /api/v1/ai/oauth/complete`
- `GET /api/v1/ai/oauth/status`
- `DELETE /api/v1/ai/oauth/session`
- `GET /api/v1/releases/status`
- `POST /api/v1/releases/process`

`/api/internal/discord/events` is not a maintainer endpoint. DiscordBot
signs its raw body, timestamp, and nonce with `ROADMAP_GATEWAY_INGEST_SECRET`.

`roadmap releases connect-ai` listens temporarily on
`http://localhost:1455/auth/callback`, the callback registered for the Codex
OAuth client. It validates the random OAuth state and sends the code and state
to authenticated `POST /api/v1/ai/oauth/complete`. The Worker then claims the
expiring, single-use state and performs the PKCE exchange. Authorization codes,
PKCE verifiers, and tokens are never written to project files.

`POST /webhooks/github` is not a maintainer endpoint. It accepts only GitHub
`release` deliveries whose raw body passes `X-Hub-Signature-256`, delivery ID
has not been replayed, and repository matches typed configuration.

## MCP endpoint

`POST /mcp` implements stateless Streamable HTTP JSON responses for the stable
MCP 2025-11-25 lifecycle and tools capability. `GET /mcp` returns 405 because
the server does not emit unsolicited notifications.
