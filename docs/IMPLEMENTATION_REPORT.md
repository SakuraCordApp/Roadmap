# Implementation report

Date: 2026-07-24

## Outcome

This repository is a standalone, reusable roadmap-management platform. The
canonical roadmap is stored in the instance database; normal roadmap mutations
perform transactional SQL operations and never modify or commit either this
repository or the separately configured application repository.

SakuraCord is supplied as the default typed configuration and initial import.
Forks replace the safe instance configuration, branding, taxonomy, Discord
mapping, deployment names, and application-repository path without changing
the core engine.

## Architecture decisions

- Cloudflare D1 is the canonical provider. Compare-and-swap revisions, audit
  history, synchronization-job creation, and linked-thread updates share one
  prepared-statement batch transaction.
- The public web application, Discord projection, forum state, CLI, and MCP
  tools all read or mutate the same API and database.
- Discord forum posts are treated as threads. Reconciliation covers active and
  paginated archived threads, messages, attachments, reactions, and tags.
- The simplified Discord roadmap hashes only visible feature names and public
  section metadata. Detail-only changes do not cause message edits.
- The free-tier Cloudflare provider schedules REST reconciliation every minute
  because an outbound Gateway WebSocket keeps a Durable Object active and the
  account's existing Gateway workload already consumes its daily duration
  allowance. The portable Node Gateway remains available for real-time
  delivery.
- The MCP server implements the stable protocol directly over newline-delimited
  stdio and stateless HTTP. Local application-repository inspection uses
  argument-safe, read-only child processes and is opt-in.
- Setup reads its ignored checkpoint journal on every run, caches only
  non-secret answers, skips completed steps, and resumes from the first failed
  operation. Release infrastructure and browser authorization have independent
  checkpoints, so OAuth retry does not repeat webhook, secret, deployment, or
  Discord-role work. Provider calls are also idempotent where their APIs allow
  it.
- Release automation uses signed GitHub webhooks and D1 jobs rather than
  committing an application-repository workflow. ChatGPT OAuth credentials are
  encrypted at rest; destination checkpoints prevent duplicate GitHub or
  Discord publication.

## Implemented surfaces

- `packages/core`: strict schemas, typed configuration, lifecycle and completion
  gates, stable IDs, evidence-backed progress, optimistic concurrency, diffs,
  storage/provider ports, and Discord projections.
- `migrations`: canonical items, history, synchronization state, Discord
  submissions/messages/reactions/events, replay nonces, tokens, subscriptions,
  rate limits, and setup/schema metadata.
- `apps/worker`: public and maintainer API, D1 adapter, static public interface,
  authentication/authorization, CORS, rate limiting, replay defenses, Discord
  interactions, synchronization/reconciliation, cron jobs, and remote MCP.
- `SakuraCordApp/DiscordBot`: independent free-tier Cloudflare scheduled
  reconciliation and Node-compatible real-time Gateway providers.
- `apps/web`: configurable, responsive, keyboard-accessible roadmap overview,
  filters/search, direct item routes, and safe external links. The public
  surface shows only change, priority, kind, and status.
- `packages/mcp`: all fifteen requested roadmap tools and opt-in, read-only
  source-repository inspection tools.
- `plugins/roadmap-management`: valid Codex plugin, MCP configuration, and a
  revision-safe roadmap-management skill.
- `packages/cli`: setup, doctor, deploy, migrate, Discord configuration and
  verification, release webhook/OAuth setup, MCP/Codex installation,
  import/export, reconcile, and upgrade commands.
- `docs`: setup, configuration, API, Discord, Gateway, MCP/Codex, security,
  operations, backups/recovery, upgrades, development, and contribution
  guidance.

## Verification performed

- `npm run check`
  - Prettier check passed.
  - ESLint passed.
  - TypeScript project-reference checking passed.
  - 19 Vitest files and 55 tests passed.
  - Core, MCP, web, Worker, and CLI production builds passed.
  - Wrangler Worker deployment dry-run passed with D1, assets,
    environment-variable, and cron configuration.
- A fresh migration was executed through Wrangler against an isolated local D1:
  14 migration commands completed successfully.
- A local Worker served `/healthz`, public configuration, item listing, and the
  production web application.
- A new SakuraCord instance starts with an empty roadmap; no example entries are
  inserted.
- A live local partial update preserved every omitted field, incremented the
  revision, returned a diff, and recorded history.
- Reusing a stale revision returned HTTP 409; an unknown patch field returned
  HTTP 422.
- CLI setup dry-run and doctor completed successfully without external writes.
- Provider-boundary orchestration tests verify that one-shot setup deploys a
  signature-capable Worker before Discord endpoint registration, stores
  Discord secrets first, redeploys IDs/tag mappings, performs a create/delete
  permission test, publishes, reconciles, and confirms the Cloudflare
  synchronization provider is healthy.
- Resume regression coverage verifies that a run interrupted after Cloudflare
  skips project prompts, D1 creation, migrations, secret writes, and the first
  deployment before continuing with Discord.
- Repeated initial imports use content-derived durable idempotency keys, and
  repeated Codex installation accepts an already-installed plugin.
- Signed GitHub webhook tests cover replay rejection, complete paginated commit
  input, GitHub release patching, Discord mention allowlisting, stable nonces,
  and persisted destination checkpoints.
- OAuth tests prove PKCE verifiers and ChatGPT access/refresh tokens are not
  stored as plaintext D1 values. Discord interaction tests prove Subscribe
  adds/removes the configured updates role without a shadow subscriber table.
- The protocol-native MCP smoke test discovered all 15 required tools.
- Both the repository plugin validator and the Codex plugin-creator validator
  accepted the plugin.
- `npm audit --audit-level=moderate` reported zero vulnerabilities.
- A repository-wide populated-token scan passed; local smoke-test credentials
  were kept in ignored `.dev.vars` and removed after verification.

## Deployment

No Cloudflare, Discord, domain, or Codex installation resource was created or
modified. Live deployment requires explicit operator authorization and valid
provider credentials.

The supported production sequence is:

1. Run `npm install` and `npm run build --workspace @roadmap/cli`.
2. Review `npm run roadmap -- setup --dry-run`.
3. Run `npm run roadmap -- setup` and follow the verified provider steps.
4. Run `npm run roadmap -- doctor --api-url <public-url>`.
5. Start the selected Gateway provider and run
   `npm run roadmap -- reconcile`.

## Remaining external verification

The source implementation and local provider boundaries are complete, but the
following cannot be truthfully certified without an authorized real instance:

- a live Cloudflare account, D1 database, custom route, secret store, and
  deployed health check;
- a real Discord application, privileged `MESSAGE_CONTENT` approval, guild
  permissions, forum tags, archived-thread access, reactions, moderated
  controls, Components V2 message edits, and sustained Gateway reconnects;
- a live remote Codex installation and authenticated mutation through the
  deployed MCP endpoint; and
- production backup restoration into a second Cloudflare account.

For large Discord bots, sharding and Discord session-start coordination remain
deployment-specific extensions. The Cloudflare provider uses scheduled
reconciliation; the Node provider is
the documented fallback.
