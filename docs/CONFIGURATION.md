# Configuration

## Files

`roadmap.config.ts` contains reusable SakuraCord defaults and validates the final
configuration with `defineRoadmapConfig`.

`roadmap.instance.json` is the fork/instance override. It is safe to commit when
it contains only public identifiers and branding. Objects merge recursively;
arrays replace defaults. Never place tokens, private keys, or passwords there.

The setup wizard writes only `roadmap.instance.json`, `wrangler.jsonc` resource
IDs, and the plugin transport file. Secrets go to Wrangler secret storage or the
launching process environment.

## Project

```json
{
  "project": {
    "name": "My Project",
    "slug": "my-project",
    "idPrefix": "MPR",
    "description": "Public project description",
    "publicUrl": "https://roadmap.example.com",
    "applicationRepository": "/absolute/read-only/local/path",
    "documentationUrl": "https://docs.example.com",
    "contributionUrl": "https://github.com/example/project"
  }
}
```

The stable ID prefix is followed by a ULID. It must not change after records
exist.

## Branding

`branding` supports logo/icon URLs, primary/accent/background colors, and a font
stack. The web app exposes the values as CSS variables and remains functional
without external images.

## Taxonomy

Areas, item types, and priorities contain:

```json
{ "id": "platform", "label": "Platform", "color": "#94A3B8" }
```

IDs are lower-case snake case and are stored in every item. Remove or rename an
ID only with a data migration.

Lifecycle states add:

```json
{
  "id": "done",
  "label": "Done",
  "color": "#34D399",
  "terminal": true,
  "publicSection": true,
  "completionGate": true,
  "transitionsTo": ["in_progress", "polishing"]
}
```

`completionGate` is the configurable acceptance-criteria gate; the engine does
not require a state to be named `done`.

`publicSections` controls public/Discord grouping. A section can include one or
more statuses and an optional `recentlyCompletedDays`.

Guided setup asks for lifecycle and priority colors alongside their IDs.
Non-interactive setup uses `--lifecycle-colors` and `--priority-colors`; each
list must contain one six-digit hex color per corresponding ID. These colors
also drive the generated Discord tag emoji.

## Discord

Guild/channel/message IDs are public operational identifiers and may be
committed. Bot tokens and application secrets may not.

Forum tag mappings support separate IDs per forum:

```json
{
  "discord": {
    "statusTagMappings": {
      "FEATURE_FORUM_ID:planned": "FEATURE_PLANNED_TAG_ID",
      "BUG_FORUM_ID:planned": "BUG_PLANNED_TAG_ID"
    }
  }
}
```

An unprefixed status key is a fallback for instances that share one mapping.

`updatesRoleId` is the role toggled by Subscribe and pinged by release
announcements. `roadmapChannelId` and `releaseAnnouncementChannelId` are
independent typed settings. The setup CLI asks for both explicitly and verifies
send/delete access in both. The Worker retains a roadmap-channel fallback only
for backwards compatibility with older instance files.

## AI and releases

```json
{
  "releases": {
    "enabled": true,
    "githubRepository": "example/project",
    "aiModel": "gpt-5.6-sol",
    "reasoningEffort": "medium",
    "maxCommits": 2000
  }
}
```

The model settings are shared by automatic Discord report analysis and optional
release writing. They are configurable in guided setup even when release
automation is disabled. The model must be available to the connected
ChatGPT/Codex-plan account.
`reasoningEffort` is sent to both Discord report analysis and release writing;
supported values are `none`, `low`, `medium`, `high`, `xhigh`, and `max`.
`maxCommits` is a safety limit, not a sampling limit: a larger release fails
explicitly instead of silently omitting commits.

## Environment and secrets

Public runtime values:

- `ROADMAP_PUBLIC_URL`
- `ROADMAP_ALLOWED_ORIGINS` (comma-separated)
- `ROADMAP_GATEWAY_PROVIDER` (`cloudflare` or `disabled`)

Secrets:

- `ROADMAP_ADMIN_TOKEN`
- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`
- `GITHUB_RELEASE_TOKEN`
- `GITHUB_WEBHOOK_SECRET`
- `ROADMAP_OAUTH_ENCRYPTION_KEY`
- `ROADMAP_TOKEN` for local CLI/MCP clients

Use `.dev.vars` locally and `wrangler secret put NAME` remotely. The CLI passes
secret values on stdin and redacts diagnostics.
