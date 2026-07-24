# AI release automation

## Outcome

Publishing a GitHub Release (directly or from a saved draft) triggers a signed
repository webhook. The roadmap
Worker:

1. records the release as an idempotent D1 job;
2. finds the previous published release;
3. paginates every commit in `previousTag...currentTag` (or all reachable
   commits for a first release);
4. generates a factual GitHub description and concise Discord copy;
5. patches the existing GitHub Release;
6. posts one Discord announcement that pings the configured updates role; and
7. records destination checkpoints and the Discord message ID.

This does not create a workflow or roadmap-data commit in the application
repository.

The roadmap Worker does not decide when to release, create a Git tag, build the
application, or upload release artifacts. CI or a maintainer must publish the
GitHub Release first; the webhook then generates and delivers its copy.

## Configure

The full `roadmap setup` wizard can configure this step. It asks for:

- GitHub repository in `owner/name` form;
- fine-grained GitHub token;
- Discord updates role and announcement channel;
- shared AI model and reasoning effort; and
- one browser-based ChatGPT authorization.

The GitHub token needs only:

- selected repository access;
- `Contents: write` to update Release descriptions; and
- `Webhooks: write` to create or repair the webhook.

For a standalone or resumed configuration:

```sh
npm run build --workspace @roadmap/cli
npm run roadmap -- releases configure \
  --repository SakuraCordApp/SakuraCord \
  --updates-role-id 1528177363995590795 \
  --channel-id 1528180213912047806
```

The CLI stores the GitHub token, webhook secret, and a generated 256-bit
encryption key through Wrangler secret storage. It applies migrations, deploys,
creates or updates the release-only webhook, opens the ChatGPT login page, and
checks the deployed status endpoint after the account is connected. The
registered Codex OAuth callback is `http://localhost:1455/auth/callback`, so
the CLI temporarily listens on that loopback port, validates OAuth state, and
forwards the short-lived code to the authenticated Worker completion endpoint.
This does not run Codex CLI, and the local listener closes immediately after
success or failure.

To reconnect or inspect status:

```sh
npm run roadmap -- releases connect-ai
npm run roadmap -- releases status
```

No Codex CLI process runs in GitHub Actions or Cloudflare. No OpenAI Platform
API key is used. Requests use the connected ChatGPT account through the
community-maintained `@openai-oauth/core` Codex transport, so this integration
is unofficial and may break if the private upstream changes.

## Discord behavior

The persistent roadmap message's Subscribe button toggles
`discord.updatesRoleId`. The announcement visibly contains only that role
mention, and `allowed_mentions.roles` contains only the same ID. AI output
cannot add user, role, `@here`, or `@everyone` pings.

The bot requires `MANAGE_ROLES`, its highest role must be above the updates
role, and it needs `MENTION_EVERYONE` unless the updates role is mentionable.

## Failure and recovery

Jobs retry with bounded exponential backoff. Generation, GitHub update, and
Discord publication are checkpointed separately. Use:

```sh
npm run roadmap -- releases status
curl -X POST \
  -H "Authorization: Bearer $ROADMAP_TOKEN" \
  -H "Idempotency-Key: manual-release-retry-001" \
  https://roadmap.example.com/api/v1/releases/process
```

Common recovery:

- `AI_OAUTH_REQUIRED`: run `roadmap releases connect-ai`.
- `Invalid authorize request`: deploy the latest Worker and rerun
  `roadmap releases connect-ai`; older versions incorrectly used the public
  roadmap URL as the callback.
- Local port 1455 unavailable: close any other active Codex sign-in flow or
  process using that port, then retry.
- `GITHUB_API_ERROR`: repair/rotate the fine-grained token and rerun
  `roadmap releases configure`.
- `RELEASE_COMMIT_LIMIT_EXCEEDED`: raise `releases.maxCommits` after reviewing
  prompt-size and cost implications.
- Discord 403: move the bot role above the updates role and verify
  `MANAGE_ROLES`, `MENTION_EVERYONE`, and channel send permissions.

Disconnecting deletes the encrypted session:

```sh
curl -X DELETE \
  -H "Authorization: Bearer $ROADMAP_TOKEN" \
  -H "Idempotency-Key: disconnect-release-ai-001" \
  https://roadmap.example.com/api/v1/ai/oauth/session
```

Rotate `ROADMAP_OAUTH_ENCRYPTION_KEY` only together with a reconnect. Replacing
the key alone intentionally makes the old ciphertext unreadable.

## Upstream and API references

- <https://github.com/EvanZhouDev/openai-oauth>
- <https://docs.github.com/en/webhooks/webhook-events-and-payloads#release>
- <https://docs.github.com/en/rest/commits/commits#compare-two-commits>
- <https://docs.github.com/en/rest/releases/releases#update-a-release>
- <https://docs.github.com/en/rest/repos/webhooks#create-a-repository-webhook>
- <https://docs.discord.com/developers/resources/guild#add-guild-member-role>
- <https://docs.discord.com/developers/resources/message#allowed-mentions-object>
