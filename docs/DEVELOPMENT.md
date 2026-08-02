# Development and testing

## Install and run

```sh
npm ci
npx wrangler d1 migrations apply sakuracord-roadmap --local
npm run build --workspace @roadmap/web
npm run dev
```

Run the web Vite server separately for HMR:

```sh
npm run dev:web
```

It proxies `/api` to the local Worker.

## Complete gate

```sh
npm run check
```

The gate includes:

- Prettier check
- ESLint
- TypeScript project references
- Vitest unit/security/integration suites
- D1 migration/trigger execution in Miniflare
- Cloudflare Worker dry-run bundle
- Vite production build
- DiscordBot contract compatibility (in its independent repository)
- MCP build
- CLI build

External services are mocked only at their HTTP boundaries. A real Discord write
test is separate:

```sh
DISCORD_BOT_TOKEN=... roadmap discord verify --write-test
```

Cloudflare deployment verification is separate:

```sh
roadmap deploy --api-url https://roadmap.example.com
```

## Test areas

Core tests cover configurable schemas, streamlined item validation, transition
gates, stale revisions, and visible Discord hashing.

D1 tests run the real migration, triggers, audit history, synchronization jobs,
idempotency replay, and compare-and-swap conflict behavior.

API tests cover public reads, authenticated mutations, origin rejection,
required idempotency keys, history, diffs, and replay.

Security tests use real Ed25519 and HMAC signatures and verify tamper/staleness
rejection.

MCP tests negotiate the stable protocol, list every required tool, validate
arguments, and return structured API results.

## Adding a storage provider

Implement `RoadmapStorage` and pass the same core engine suite. The provider
must atomically couple the canonical change with audit history and sync-job
creation. A repository adapter that commits files is intentionally invalid.

## Discord synchronization development

Keep scheduled forum reconciliation and all forum business logic in Roadmap.
[`SakuraCordApp/DiscordBot`](https://github.com/SakuraCordApp/DiscordBot) may
invoke the authenticated reconciliation endpoint as a compatibility trigger,
but routine intake must not depend on that separate deployment.
