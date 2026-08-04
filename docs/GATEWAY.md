# Discord synchronization

SakuraCord uses Cloudflare scheduled discovery rather than a persistent Discord
Gateway process. The Roadmap Worker reads latency-sensitive active forum posts
first, writes durable D1 report jobs, and publishes those thread IDs to a
dedicated Cloudflare Queue. A queue consumer runs report analysis independently
from archived-thread repair work.

Roadmap reads the configured feature-request and bug-report forums through
Discord REST, stores changed threads and messages in D1, re-runs report analysis
when user-authored content changes, and reconciles roadmap status tags. The
authenticated `POST /api/v1/reconcile` endpoint remains available as a
compatibility and manual trigger, and also starts analysis after discovery.

The independently deployed DiscordBot does not trigger reconciliation. This
prevents duplicate minute crawls from competing for Discord and Worker limits.
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
