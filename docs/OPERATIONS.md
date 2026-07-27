# Operations, backup, and recovery

## Routine checks

```sh
roadmap doctor --api-url "$ROADMAP_API_URL"
roadmap discord verify
roadmap reconcile --api-url "$ROADMAP_API_URL"
roadmap releases status --api-url "$ROADMAP_API_URL"
```

Monitor `/api/v1/sync/status` for pending, processing, or failed jobs. Failed
jobs retain a redacted error and exponential retry time. Reconciliation is safe
to rerun.

The protected Discord report endpoints expose and drain the separate
attachment-analysis queue:

```sh
curl -X POST "$ROADMAP_API_URL/api/v1/discord/reports/status" \
  -H "Authorization: Bearer $ROADMAP_TOKEN"
curl -X POST "$ROADMAP_API_URL/api/v1/discord/reports/process" \
  -H "Authorization: Bearer $ROADMAP_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"limit":2}'
```

The minute cron retries report analysis before processing ordinary Discord
synchronization jobs.

## Backup

D1 is canonical. Back it up before migrations and on a regular schedule:

```sh
npx wrangler d1 export sakuracord-roadmap --remote \
  --output backups/roadmap-$(date +%Y%m%d).sql
```

Backups can contain public roadmap data plus maintainer token hashes, Discord
user IDs/reactions, encrypted ChatGPT OAuth credentials, release webhook
payloads, generated announcements, and operational metadata. Store them
encrypted outside the repository with access controls and retention limits.

Export shareable public data separately:

```sh
roadmap export --api-url "$ROADMAP_API_URL" --safe-config \
  --file roadmap-public-export.json
```

This export does not include secrets, token hashes, replay nonces, rate limits,
or operational event payloads.

## Restore

1. Stop DiscordBot or set the provider to `disabled`.
2. Deploy a maintenance response or prevent maintainer writes.
3. Create a new D1 database.
4. import the trusted SQL backup with Wrangler;
5. update the D1 binding ID;
6. deploy and verify `/healthz`;
7. run `roadmap reconcile`;
8. resume the selected Gateway provider; and
9. compare item/history counts and failed jobs.

Prefer restoring into a new D1 database and switching the binding over
overwriting the only production copy.

## Token rotation

Cloudflare/CLI:

```sh
npx wrangler secret put ROADMAP_ADMIN_TOKEN
npx wrangler secret put GITHUB_RELEASE_TOKEN
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

Rotate the Discord bot token in the Developer Portal, then update both
Cloudflare Workers before redeploying them.

Do not rotate `ROADMAP_OAUTH_ENCRYPTION_KEY` independently. Disconnect the AI
session, replace the key, then run `roadmap releases connect-ai` so no
undecryptable credential remains. Re-running `roadmap releases configure`
performs that replacement and reconnect flow.

## Drift recovery

If Discord and the website disagree:

1. read the canonical item and history;
2. inspect `/api/v1/sync/status`;
3. fix credentials/permissions or channel/tag configuration;
4. run `roadmap reconcile`;
5. force one projection publish if necessary; and
6. verify the existing roadmap message was edited rather than duplicated.

Never repair drift by editing canonical status independently in Discord.
