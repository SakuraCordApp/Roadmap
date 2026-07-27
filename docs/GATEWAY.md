# Discord synchronization

SakuraCord uses Cloudflare scheduled reconciliation rather than a persistent
Discord Gateway process. The independently deployed DiscordBot Worker calls the
authenticated `POST /api/v1/reconcile` endpoint every minute.

Roadmap then reads the configured feature-request and bug-report forums through
Discord REST, stores changed threads and messages in D1, re-runs report analysis
when user-authored content changes, and reconciles roadmap status tags.

## Required DiscordBot configuration

Set the deployed Roadmap URL in DiscordBot's `wrangler.jsonc`, then store a
Roadmap maintainer token only in Cloudflare:

```sh
npx wrangler secret put ROADMAP_TOKEN
npx wrangler deploy
```

There is no Node runtime, raw Gateway event ingress, shared Gateway secret, or
public bot-control endpoint.

## Operations

Maintainers can trigger the same reconciliation immediately:

```sh
npm run roadmap -- reconcile
```

`POST /api/v1/discord/gateway/start` remains as a compatibility alias for an
immediate Cloudflare reconciliation. `status` reports the scheduled polling
mode, and `stop` reports that cron-managed reconciliation cannot be stopped
through the API.
