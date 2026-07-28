# Discord integration

## Bot setup

Create a Discord application and bot in the Developer Portal. Enable:

- `GUILDS`
- `GUILD_MESSAGES`
- `GUILD_MESSAGE_REACTIONS`
- privileged `MESSAGE_CONTENT`

Message content controls the `content`, `embeds`, `attachments`, `components`,
and poll fields in message objects. Verified/high-reach applications may require
Discord review for the privileged intent.

The generated invite requests:

- View Channels
- Add Reactions
- Send Messages
- Read Message History
- Use Application Commands
- Manage Threads
- Send Messages in Threads
- Manage Expressions
- Manage Roles
- Mention Everyone

`MANAGE_CHANNELS` is needed only when the setup CLI creates missing forum tags.
Moderated tags and locked-thread reopening require `MANAGE_THREADS`.
Custom tag emoji provisioning requires `MANAGE_GUILD_EXPRESSIONS`.
`MANAGE_ROLES` lets the Subscribe button add/remove the configured updates
role. The bot's highest role must be above that role. `MENTION_EVERYONE` lets
the bot notify that role without making the role globally mentionable.

```sh
DISCORD_BOT_TOKEN=... npm run roadmap -- discord configure
DISCORD_BOT_TOKEN=... npm run roadmap -- discord verify
```

`discord configure` explicitly asks for and validates the bot/application
match, guild, two forum channels, roadmap text channel, release-announcement
text channel, updates role, available tags, interaction endpoint, and guild
slash command before writing public IDs. The roadmap and release channels may
be the same, but they are separate settings and must both be supplied.
`--store-secret` uses Wrangler secret storage before Discord verifies the
interaction endpoint. `--create-missing-tags` creates moderated status tags
without deleting existing tags.

For automation, pass `--roadmap-channel-id` and
`--release-announcement-channel-id`. The main setup command exposes the
equivalent `--discord-roadmap-channel-id` and
`--discord-release-channel-id` flags.

The full setup wizard generates the rounded emoji PNGs from the configured
brand, priority, and lifecycle colors, uploads the guild emoji, and applies the
unified taxonomy to both forums before publishing the roadmap message. A repair
run regenerates and replaces the managed emoji:

```sh
npm run roadmap -- setup --repair
```

`npm run discord:configure-forums` remains available as a focused operational
repair command for an already deployed instance.

On macOS, setup stores and reuses the maintainer credential through the
`dev.<project-slug>.roadmap-maintainer` Keychain service, so repair and resumed
setup do not require pasting it again.

`discord verify --write-test` creates and immediately deletes a test message in
both configured text channels (once when they are the same). The standalone
verify command never runs that write without the flag. The full `roadmap setup`
plan explicitly includes the same test and asks for confirmation before any
external changes.

## Forum model

Discord `GUILD_FORUM` channels contain `PUBLIC_THREAD` posts. The thread ID is
also the starter message ID for a forum post. The platform stores:

- submission title, kind, author, content, attachments, and tags;
- every reply and edit;
- reaction users and emoji keys;
- review state and linked roadmap item;
- archived and locked state; and
- parsed bug metadata.

Bug metadata recognizes common headings for application version, OS version,
hardware, reproduction steps, expected behavior, actual behavior, and
diagnostics. Raw untrusted text remains plain data and is length-bounded.

Both forums use one taxonomy:

- members choose `Visual` or `Functionality` plus `Critical`, `High`, `Medium`,
  or `Low`;
- the bot owns the moderated `Planned`, `In Progress`, `Polishing`, `Done`,
  `Declined`, and `Duplicate` tags; and
- every tag uses a custom guild emoji generated from the rounded SVG sources
  under `assets/discord-tag-icons`.

`Critical` is reserved for app-breaking crashes, data loss, unusable
authentication, or loss of the core app. Major daily-usability features and
failures use `High`; bounded work normally uses `Medium` or `Low`.

New threads enter an internal pending-analysis queue. A durable analysis job
reads the starter text and supported image/file attachments through the
connected ChatGPT session. From that evidence alone it normalizes the title and
description, classifies the report, selects a report-supported priority and
area, and writes observable acceptance criteria. It does not infer difficulty,
confidence, repository components, an implementation approach, technical
risks, or research plans because those fields are not part of the canonical
model. The job creates one canonical bug or feature item in `planned` and links
it back to the forum post. Files remain Discord-hosted references; they are not
copied into canonical roadmap storage.

Ordinary thread conversation is not roadmap evidence and does not trigger
reanalysis. To incorporate a relevant follow-up comment or file, mention the
SakuraCord bot in that message. The starter message is always evidence; after
creation, only changes to user-authored messages or attachments that mention
the bot can update the item. Bot, application, webhook, and ordinary unmentioned
messages are ignored. Mentioned material that is unrelated to the initial
report is explicitly excluded from the analysis.

Canonical lifecycle changes automatically replace the bot-managed status tag.
When an item reaches Done, the bot posts either “Bug fixed” or “Feature
implemented”, then locks and archives the thread. Declined and Duplicate are
also terminal and lock/archive their threads.

## Simplified roadmap

The public Discord message contains only stable ID, feature title, lifecycle
section, optional area, and public detail link. Default SakuraCord sections are
Planned, In Progress, Polishing, and Recently Done.

Components V2 use one Container with Text Displays, Separators, a public-roadmap
link, and a subscription button. The message has `IS_COMPONENTS_V2` (`1 << 15`);
traditional content is not mixed into it.

The Subscribe button does not maintain a second subscriber database. It
directly adds or removes `discord.updatesRoleId` on the member and responds
ephemerally. That same role is the only allowed mention in generated release
announcements.

The projection is sorted and SHA-256 hashed. If visible data did not change, the
bot does not call Discord. It edits the stored message ID and only creates a new
message when none exists or the configured one no longer exists.

## Rate limits and failure handling

The REST client honors Discord 429 `retry_after`, retries bounded 5xx failures
with exponential backoff, and returns actionable response details. User text is
escaped, `allowed_mentions.parse` is empty, and no endpoint logs bot
authorization.

Forum status replies are keyed by thread and lifecycle state, so reaction-only
or research-only roadmap revisions cannot create duplicate status replies.

Primary Discord references:

- <https://docs.discord.com/developers/resources/channel>
- <https://docs.discord.com/developers/topics/threads>
- <https://docs.discord.com/developers/events/gateway>
- <https://docs.discord.com/developers/resources/message>
- <https://docs.discord.com/developers/interactions/receiving-and-responding>
- <https://docs.discord.com/developers/components/reference>
