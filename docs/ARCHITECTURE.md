# Architecture

## Boundaries

This repository is the complete reusable platform. It does not place roadmap
files, data, or commits in the configured application repository. The
application repository is an optional read-only evidence source for local MCP
tools.

`packages/core` owns schemas, configuration validation, lifecycle validation,
projections, diffs, and storage interfaces. It has no Cloudflare, Discord,
React, Codex, or CLI dependency.

`apps/worker` owns the D1 storage adapter, HTTP API, authentication, rate
limiting, Discord interactions, REST synchronization, and scheduled jobs.

`apps/web` is a public React client. It reads the same API that external clients
use and contains no mutation credentials.

The Roadmap Worker owns scheduled forum reconciliation and Discord's HTTP
interactions endpoint, so report intake has one self-contained runtime and no
always-on Node gateway is required. The separate
[`SakuraCordApp/DiscordBot`](https://github.com/SakuraCordApp/DiscordBot)
repository owns GitHub-to-Discord notifications without triggering forum
reconciliation. Both repositories build and deploy without a local sibling
checkout.

`packages/mcp` exposes the roadmap API through MCP. Local repository inspection
is explicitly read-only and is absent from remote Worker mode.

`packages/cli` coordinates setup and providers. It prints plans, keeps a local
resumption journal under ignored `.roadmap/`, and verifies each external step.

## Release automation

GitHub `release.published` webhooks are HMAC-verified and inserted into D1 with
a unique repository/release key. The request returns immediately. The Worker
attempts processing in `waitUntil`, while the minute cron is the durable retry
path.

The processor resolves the previous published tag, paginates the GitHub compare
API so every commit is included, and sends bounded commit metadata to the
ChatGPT OAuth transport. Structured output is validated before it can leave the
Worker. Destination checkpoints are persisted independently: a retry does not
regenerate text or repeat a successful GitHub patch. Discord uses a stable
nonce with `enforce_nonce` so an ambiguous network retry cannot duplicate the
announcement.

## Canonical mutation

1. The caller authenticates and supplies an `Idempotency-Key`.
2. Zod validates structure and configured enum membership.
3. The caller supplies `expectedRevision`.
4. D1 executes one `UPDATE ... WHERE revision = ?`.
5. An `AFTER UPDATE` trigger records actor, before/after JSON, override reason,
   mutation ID, and revision.
6. The same trigger inserts item and projection synchronization jobs.
7. The API returns a machine-readable before/after diff.

The trigger is part of the same SQLite statement. A stale compare-and-swap
cannot produce history or synchronization work. The audit table has a unique
mutation ID, so a replay returns the original result.

## Completion gate

Lifecycle states are configurable. A state with `completionGate: true` normally
requires at least one acceptance criterion and every criterion satisfied. A
bypass requires a non-empty override reason stored in history.

## Synchronization

Synchronization work is at-least-once and idempotent:

- job keys are durable and unique;
- forum reports have a stable D1 job record and a dedicated Cloudflare Queue;
- each minute discovers newest active reports before archived repair work, and
  a one-message queue consumer keeps analysis off the reconciliation path;
- structured report analysis is schema-validated before canonical creation and
  is limited to fields supported by report text and attachments; repo-dependent
  planning fields are not part of the canonical model;
- Discord interaction jobs are persisted before deferred acknowledgement and
  reclaimed after stale leases;
- interaction IDs are replay-protected;
- per-thread status replies are keyed by thread and status;
- the visible Discord projection has a SHA-256 hash;
- reconciliation reads active and paginated archived threads and repairs
  changes missed during an earlier polling window.

Partial Discord failures leave the canonical mutation complete and the job
failed with bounded retry metadata. A later job or `roadmap reconcile` repairs
the projection; Discord never becomes an independent source of roadmap state.

## Storage portability

`RoadmapStorage` is the core boundary. D1 is the included adapter and relies on
SQLite JSON functions and triggers. Another SQL-compatible provider must
preserve:

- compare-and-swap revisions;
- atomic history and sync-job creation;
- unique mutation IDs;
- durable event and replay keys; and
- ordered, bounded history queries.
