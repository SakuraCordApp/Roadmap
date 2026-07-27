# Setup and deployment

## Guided setup

The Roadmap and DiscordBot repositories are independent clones. For a
Cloudflare synchronization installation, deploy
[`SakuraCordApp/DiscordBot`](https://github.com/SakuraCordApp/DiscordBot) first
with a Roadmap maintainer `ROADMAP_TOKEN`. No sibling directory, workspace
link, or unpublished package is required.

Build the CLI, inspect the plan, then apply:

```sh
npm install
npm run build --workspace @roadmap/cli
npm run roadmap -- setup --dry-run
npm run roadmap -- setup
```

The wizard:

1. collects project identity, public URL, application repository, branding,
   taxonomy IDs and colors, Gateway provider, MCP mode, and initial data;
2. validates typed configuration;
3. verifies Wrangler authentication;
4. discovers or creates the named D1 database idempotently;
5. applies migrations;
6. stores the bootstrap secret with Wrangler;
7. builds, deploys, and waits for `/healthz`;
8. validates Discord and maps/creates bootstrap status tags;
9. stores the Discord verification key before registering the interaction
   endpoint and guild command;
10. redeploys the Discord IDs and tag mappings, then repeats the health check;
11. verifies active and archived thread reads and creates/deletes a permission
    test message;
12. configures the selected AI model and reasoning effort, stores the OAuth
    encryption key, opens ChatGPT authorization, and verifies the encrypted
    session for automatic report analysis;
13. optionally configures a signed GitHub Release webhook and its fine-grained
    token, reusing the same AI connection;
14. writes and tests MCP configuration;
15. optionally installs the Codex plugin;
16. validates and imports initial data;
17. generates rounded PNG emoji from the configured brand, priority, and
    lifecycle colors and applies the unified taxonomy to both forums;
18. publishes the persistent simplified roadmap message and reconciles both
    forums; and
19. starts and verifies the independently deployed DiscordBot scheduled
    reconciliation when the Cloudflare provider is selected.

Progress is journaled in ignored `.roadmap/setup-state.json`, and non-secret
wizard answers are cached in ignored `.roadmap/setup-answers.json`. Rerunning
`roadmap setup` resumes automatically: it prints completed checkpoints, skips
them, and continues at the first unfinished or failed step. It does not ask for
project or Discord IDs again. Secrets are never cached locally, so a resumed
step may ask for the Discord bot token or saved maintainer token when it needs
one. AI infrastructure, ChatGPT authorization, release infrastructure, forum
emoji, and publication are separate checkpoints. An interrupted authorization
resumes without recreating the release webhook. Use `roadmap setup --repair` to
deliberately regenerate managed emoji and re-verify external resources.

Provider operations remain idempotent as a second defense: existing D1
resources are discovered, migrations are idempotent, Discord commands use bulk
overwrite, tag creation preserves existing tags, and API imports use unique
mutation keys.

Before a full run, the operator must create the Discord application and bot,
enable `MESSAGE_CONTENT`, invite the bot, and have the two forum channels,
roadmap channel, and maintainer role available. These Developer Portal and guild
ownership steps cannot be performed by a bot that does not exist or has not
been invited yet.

## CI/non-interactive setup

Review a dry run first. The apply run requires `--yes`.

```sh
npm run roadmap -- setup \
  --non-interactive --yes \
  --project-name "My Project" \
  --slug my-project \
  --description "Public engineering roadmap" \
  --application-repository /workspace/my-project \
  --public-url https://roadmap.example.com \
  --id-prefix MPR \
  --gateway-provider cloudflare \
  --mcp-mode remote \
  --initial-data empty \
  --skip-discord
```

Set secrets in the CI secret store:

- `ROADMAP_ADMIN_TOKEN` (optional; generated if absent)
- Discord values when Discord setup is enabled

For a fully non-interactive Discord run, set `DISCORD_BOT_TOKEN` and pass:

```text
--discord-application-id
--discord-public-key
--discord-guild-id
--discord-feature-forum-id
--discord-bug-forum-id
--discord-roadmap-channel-id
--discord-updates-role-id
--discord-maintainer-role-ids
```

AI release automation also requires `GITHUB_RELEASE_TOKEN` with repository
`Contents: write` and `Webhooks: write`, plus `--github-repository owner/name`.
The first ChatGPT connection is deliberately interactive. A later
non-interactive setup can verify and reuse the encrypted connected session.
Pass `--skip-releases` when release automation is intentionally out of scope.
Pass `--skip-ai` only when automatic Discord report analysis is also
intentionally disabled.

When the Wrangler login can access multiple Cloudflare accounts, the
interactive wizard asks which account should own the Worker and D1 database
and persists its public account ID in `wrangler.jsonc`. For non-interactive
setup, pass `--cloudflare-account-id <id>` or set
`CLOUDFLARE_ACCOUNT_ID`. The selected account must be one returned by
`npx wrangler whoami --json`.

On macOS, setup saves the maintainer token to
`dev.<project-slug>.roadmap-maintainer` in Keychain and reuses it for resumed
post-deployment steps. On other platforms it prints the token once for secure
capture. The Gateway-ingest secret is always printed once because it may be
needed by a separate Gateway host. Never redirect setup output into a tracked
artifact.

Before registering Discord's interaction URL, setup compares the supplied
public key with Discord's authenticated application record and waits until the
deployed Worker returns the expected signed-ingress rejection for an unsigned
probe. This prevents Cloudflare secret-propagation races from producing an
unverifiable Discord endpoint.

## Manual Cloudflare flow

```sh
npx wrangler login
npx wrangler d1 create my-project-roadmap
# Put the returned database_id in wrangler.jsonc.
npx wrangler d1 migrations apply my-project-roadmap --remote
npx wrangler secret put ROADMAP_ADMIN_TOKEN
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put GITHUB_RELEASE_TOKEN
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put ROADMAP_OAUTH_ENCRYPTION_KEY
npm run check
npx wrangler deploy
curl -fsS https://roadmap.example.com/healthz
```

For the Cloudflare synchronization provider, deploy the separate DiscordBot after
storing its matching secrets:

```sh
git clone https://github.com/SakuraCordApp/DiscordBot.git
cd DiscordBot
npm install
npx wrangler secret put ROADMAP_TOKEN
npm run deploy
```

Configure a custom domain with normal Cloudflare Worker route/custom-domain
controls, set `ROADMAP_PUBLIC_URL`, and add the exact origin to
`ROADMAP_ALLOWED_ORIGINS`. The CLI fails rather than claiming success when the
custom domain health check does not resolve. During initial DNS propagation,
the CLI retries through public DNS when the operator's local resolver still
has a negative cache entry; certificate and HTTP health validation still use
the configured hostname.

## Continuous deployment

The production Worker is connected to `SakuraCordApp/Roadmap` through
Cloudflare Workers Builds. Pushes to `main` run `npm run check` and then
`npx wrangler deploy`. Runtime secrets remain in Cloudflare rather than GitHub.
DiscordBot has its own independent Workers Builds connection and deploy gate.

## Deployment boundary

Repository build and local validation require no credentials. Deployment,
resource creation, secret writes, Discord registration, and write tests happen
only when a developer explicitly runs the corresponding command.
