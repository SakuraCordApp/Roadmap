# Security

## Secret separation

Tracked files contain source, migrations, public IDs, safe branding, and
examples. `.env`, `.env.*`, `.dev.vars`, local databases, setup state, logs, and
local MCP overrides are ignored.

Production secrets use Wrangler secret storage. CLI diagnostics redact bearer,
bot, and long hexadecimal values. Token prompts use hidden input. Tokens are
passed to Wrangler on stdin.

Release automation stores `GITHUB_RELEASE_TOKEN`, `GITHUB_WEBHOOK_SECRET`, and
`ROADMAP_OAUTH_ENCRYPTION_KEY` as Worker secrets. ChatGPT access and refresh
tokens are AES-256-GCM encrypted in D1 with purpose-bound additional
authenticated data. The encryption key is never stored in D1. OAuth PKCE
verifiers use the same protection, expire after ten minutes, and are
single-use.

## Authentication and authorization

- Public endpoints are read-only.
- Mutation endpoints accept bearer tokens only and reject cookies.
- Bootstrap auth uses `ROADMAP_ADMIN_TOKEN`.
- Additional maintainer tokens are stored as SHA-256 hashes with expiry and
  revocation columns.
- Discord controls require a configured maintainer role.
- Every mutation stores actor ID, display identity, actor kind, mutation ID,
  override reason, and before/after documents.

## Request security

- Discord interaction bodies use Ed25519 verification over timestamp plus raw
  body.
- Interaction timestamps older than five minutes are rejected.
- Interaction IDs are replay-protected in D1.
- GitHub webhook bodies use `X-Hub-Signature-256` HMAC verification and
  delivery IDs are replay-protected for 30 days.
- DiscordBot ingress uses HMAC-SHA256 over timestamp, nonce, and raw body.
- Gateway timestamps and nonces are replay-protected.
- Mutation requests require durable idempotency keys.
- Public and mutation rate windows are D1-backed.
- CORS uses an exact configured allowlist and never enables credentials.
- CSRF is not applicable to bearer-only APIs; cookie-bearing mutation requests
  are rejected as defense in depth.
- Security headers are added by Hono middleware.

## Untrusted Discord content

Content is stored as bounded plain text. NUL bytes are removed. Discord output
escapes markdown control characters, breaks `@` mentions, and always sends empty
`allowed_mentions.parse`. Component custom IDs contain only controlled action,
thread ID, and status values.

Attachments are metadata/Discord URLs; the Worker does not proxy arbitrary
bytes. Diagnostics remain public only when maintainers intentionally preserve
them in public submission/roadmap data. Forum guidance should tell users to
remove credentials, account databases, and private logs.

## Database and migrations

Migrations enable foreign keys, validate JSON with `json_valid`, constrain
states/counters, and use additive versioned files. Audit and synchronization
triggers are part of the canonical write.

Before a production migration:

1. export a D1 backup;
2. run the migration against a fresh local database;
3. run the complete test/build gate;
4. apply remotely; and
5. verify `/healthz`, schema metadata, and `roadmap doctor`.

## Threat considerations

- A stolen maintainer token can mutate public roadmap data. Revoke/rotate it and
  inspect audit history.
- A stolen bot token can operate within granted Discord permissions. Rotate it
  in the Developer Portal and Wrangler, then reconcile.
- A compromised DiscordBot deployment has the bot token and ingest secret. Keep it
  patched, single-purpose, and unable to access D1 credentials.
- Local repository inspection exposes source text to the local MCP client. It
  is disabled in remote mode and only configured by absolute local path.
- ChatGPT/Codex-plan OAuth is implemented with the unofficial
  `@openai-oauth/core` transport. Credentials have account-level sensitivity.
  Operators must review its license and risk, restrict Worker administration,
  and disconnect/rotate immediately after a suspected compromise.
- Commit messages are untrusted prompt data. The release prompt explicitly
  rejects embedded instructions, bounds every message, validates structured
  output, and strips Discord mentions before publishing.

`npm audit --audit-level=moderate` is part of the release evidence. Do not
silence dependency advisories without documenting reachability and mitigation.
