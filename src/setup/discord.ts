import { AREAS, DISCORD, STATUSES, statusLabel, type IssueKind, type StatusId } from "../config";
import { getState, setState } from "../db/store";
import { guidePost } from "../discord/cards";
import { isDiscordStatus } from "../discord/rest";
import { TAG_STATE_KEY, discordClient, type ForumTagMap } from "../discord/threads";
import { webhookStateKey } from "../sync/comments";
import type { Env } from "../env";

const PERMISSIONS = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  ADD_REACTIONS: 1n << 6n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
  MANAGE_THREADS: 1n << 34n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  ADMINISTRATOR: 1n << 3n,
} as const;

export async function checkBotPermissions(env: Env) {
  const discord = discordClient(env);
  const me = await discord.get<{ id: string }>("/users/@me");
  const member = await discord.get<{ roles: string[] }>(
    `/guilds/${DISCORD.guildId}/members/${me.id}`,
  );
  const roles = await discord.get<Array<{ id: string; permissions: string }>>(
    `/guilds/${DISCORD.guildId}/roles`,
  );
  let granted = 0n;
  for (const role of roles) {
    if (role.id === DISCORD.guildId || member.roles.includes(role.id))
      granted |= BigInt(role.permissions);
  }
  const admin = (granted & PERMISSIONS.ADMINISTRATOR) !== 0n;
  const missing = Object.entries(PERMISSIONS)
    .filter(([name, bit]) => name !== "ADMINISTRATOR" && !admin && (granted & bit) === 0n)
    .map(([name]) => name);
  return { botId: me.id, administrator: admin, missing };
}

export async function ensureEmojis(
  env: Env,
  payloads: Record<string, string>,
  replace: string[] = [],
): Promise<Record<string, string>> {
  const discord = discordClient(env);
  const existing = await discord.get<Array<{ id: string; name: string }>>(
    `/guilds/${DISCORD.guildId}/emojis`,
  );
  const ids: Record<string, string> = {};
  for (const emoji of existing) ids[emoji.name] = emoji.id;
  for (const [name, image] of Object.entries(payloads)) {
    if (ids[name] && !replace.includes(name)) continue;
    if (ids[name]) await discord.delete(`/guilds/${DISCORD.guildId}/emojis/${ids[name]}`);
    const created = await discord.post<{ id: string }>(
      `/guilds/${DISCORD.guildId}/emojis`,
      { name, image },
      { reason: "SakuraCord report tag icon" },
    );
    ids[name] = created.id;
  }
  return ids;
}

export const statusEmojiName = (status: StatusId) => `sc_${status}`;

function forumStatuses(kind: IssueKind) {
  return STATUSES.filter(
    (status) => !(kind === "feature" && status.bugOnly) && status.id !== "done",
  );
}

/** Replace both forums' tags with the hub taxonomy: bot-owned statuses plus areas. */
export async function configureForums(env: Env, emojiIds: Record<string, string>) {
  const discord = discordClient(env);
  const map: ForumTagMap = {};
  const forums: Array<[string, IssueKind]> = [
    [DISCORD.bugForumId, "bug"],
    [DISCORD.featureForumId, "feature"],
  ];
  for (const [forumId, kind] of forums) {
    const channel = await discord.get<{ available_tags: Array<{ id: string; name: string }> }>(
      `/channels/${forumId}`,
    );
    const byName = new Map(channel.available_tags.map((tag) => [tag.name.toLowerCase(), tag.id]));
    const statusTags = forumStatuses(kind).map((status) => {
      const name = statusLabel(status.id, kind);
      const emojiId = emojiIds[statusEmojiName(status.id)];
      return {
        key: status.id,
        tag: {
          ...(byName.get(name.toLowerCase()) ? { id: byName.get(name.toLowerCase()) } : {}),
          name,
          moderated: true,
          ...(emojiId ? { emoji_id: emojiId } : { emoji_name: status.emoji }),
        },
      };
    });
    const areaTags = AREAS.map((area) => ({
      key: area.id,
      tag: {
        ...(byName.get(area.label.toLowerCase())
          ? { id: byName.get(area.label.toLowerCase()) }
          : {}),
        name: area.label,
        moderated: true,
        emoji_name: area.emoji,
      },
    }));
    const bug = kind === "bug";
    const updated = await discord.patch<{ available_tags: Array<{ id: string; name: string }> }>(
      `/channels/${forumId}`,
      {
        available_tags: [...statusTags, ...areaTags].map((entry) => entry.tag),
        topic: bug
          ? "Report SakuraCord bugs with /bug or the button in the pinned post. Each report is tracked as a GitHub issue and on sakuracord.app/tracker. Press 👍 Me too on existing reports instead of posting duplicates."
          : "Suggest SakuraCord features with /suggest or the button in the pinned post. Each suggestion is tracked as a GitHub issue and on sakuracord.app/tracker. Vote with 👍 Me too.",
        flags: 0,
        default_reaction_emoji: null,
        default_sort_order: 0,
      },
      { reason: "SakuraCord issue hub taxonomy" },
    );
    const idByName = new Map(updated.available_tags.map((tag) => [tag.name, tag.id]));
    map[forumId] = {
      status: Object.fromEntries(
        statusTags.map((entry) => [entry.key, idByName.get(entry.tag.name)!]),
      ) as ForumTagMap[string]["status"],
      area: Object.fromEntries(areaTags.map((entry) => [entry.key, idByName.get(entry.tag.name)!])),
    };
    // Closed-as-completed issues without a release use the Shipped tag.
    map[forumId]!.status.done = map[forumId]!.status.shipped;
  }
  await setState(env.DB, TAG_STATE_KEY, JSON.stringify(map));
  return map;
}

/** Only the bot creates forum posts; everyone can still reply inside them. */
export async function lockForumPosting(env: Env, botId: string) {
  const discord = discordClient(env);
  const results: string[] = [];
  for (const forumId of [DISCORD.bugForumId, DISCORD.featureForumId]) {
    const channel = await discord.get<{
      permission_overwrites: Array<{ id: string; type: number; allow: string; deny: string }>;
    }>(`/channels/${forumId}`);
    const everyone = channel.permission_overwrites.find(
      (overwrite) => overwrite.id === DISCORD.guildId,
    );
    const allow =
      (BigInt(everyone?.allow ?? "0") & ~PERMISSIONS.SEND_MESSAGES) |
      PERMISSIONS.SEND_MESSAGES_IN_THREADS;
    const deny =
      (BigInt(everyone?.deny ?? "0") | PERMISSIONS.SEND_MESSAGES) &
      ~PERMISSIONS.SEND_MESSAGES_IN_THREADS;
    await discord.put(
      `/channels/${forumId}/permissions/${DISCORD.guildId}`,
      { type: 0, allow: allow.toString(), deny: deny.toString() },
      { reason: "Reports are filed through /bug and /suggest" },
    );
    const bot = channel.permission_overwrites.find((overwrite) => overwrite.id === botId);
    const botAllow =
      BigInt(bot?.allow ?? "0") |
      PERMISSIONS.VIEW_CHANNEL |
      PERMISSIONS.SEND_MESSAGES |
      PERMISSIONS.SEND_MESSAGES_IN_THREADS |
      PERMISSIONS.MANAGE_THREADS |
      PERMISSIONS.ATTACH_FILES |
      PERMISSIONS.EMBED_LINKS |
      PERMISSIONS.READ_MESSAGE_HISTORY |
      PERMISSIONS.ADD_REACTIONS;
    await discord.put(
      `/channels/${forumId}/permissions/${botId}`,
      { type: 1, allow: botAllow.toString(), deny: "0" },
      { reason: "SakuraCord bot files forum posts" },
    );
    results.push(forumId);
  }
  return results;
}

export async function ensureGuidePosts(env: Env) {
  const discord = discordClient(env);
  const posts: Record<string, string> = {};
  for (const [forumId, kind] of [
    [DISCORD.bugForumId, "bug"],
    [DISCORD.featureForumId, "feature"],
  ] as Array<[string, IssueKind]>) {
    const key = `discord:guide:${forumId}`;
    const existing = await getState(env.DB, key);
    const message = guidePost(kind, env.WEBSITE_URL);
    if (existing) {
      try {
        await discord.patch(`/channels/${existing}`, { archived: false, locked: true });
        await discord.patch(`/channels/${existing}/messages/${existing}`, message);
        posts[kind] = existing;
        continue;
      } catch (error) {
        if (!isDiscordStatus(error, 404)) throw error;
      }
    }
    const active = await discord.get<{
      threads: Array<{ id: string; parent_id: string; flags?: number }>;
    }>(`/guilds/${DISCORD.guildId}/threads/active`);
    for (const thread of active.threads.filter(
      (t) => t.parent_id === forumId && ((t.flags ?? 0) & 2) !== 0,
    )) {
      await discord.patch(`/channels/${thread.id}`, { flags: 0 }).catch(() => undefined);
    }
    const created = await discord.post<{ id: string }>(`/channels/${forumId}/threads`, {
      name: kind === "bug" ? "📌 How to report a bug" : "📌 How to suggest a feature",
      auto_archive_duration: 10080,
      message,
    });
    await discord.patch(`/channels/${created.id}`, { flags: 2, locked: true });
    await setState(env.DB, key, created.id);
    posts[kind] = created.id;
  }
  return posts;
}

/** One webhook per forum lets GitHub and website comments appear under their authors' names. */
export async function ensureWebhooks(env: Env) {
  const discord = discordClient(env);
  const result: Record<string, string> = {};
  for (const forumId of [DISCORD.bugForumId, DISCORD.featureForumId]) {
    const hooks = await discord.get<
      Array<{ id: string; token?: string; name: string; application_id?: string | null }>
    >(`/channels/${forumId}/webhooks`);
    let hook = hooks.find(
      (value) =>
        value.name === "SakuraCord Sync" &&
        value.token &&
        value.application_id === env.DISCORD_APPLICATION_ID,
    );
    hook ??= await discord.post<{ id: string; token: string; name: string }>(
      `/channels/${forumId}/webhooks`,
      { name: "SakuraCord Sync" },
      { reason: "Comment sync" },
    );
    await setState(
      env.DB,
      webhookStateKey(forumId),
      JSON.stringify({ id: hook.id, token: hook.token }),
    );
    result[forumId] = hook.id;
  }
  return result;
}

export async function registerCommands(env: Env) {
  const commands = [
    { name: "bug", type: 1, description: "Report a bug in SakuraCord" },
    { name: "suggest", type: 1, description: "Suggest a feature for SakuraCord" },
    { name: "roadmap", type: 1, description: "Open the SakuraCord roadmap and tracker" },
  ];
  return discordClient(env).put(
    `/applications/${env.DISCORD_APPLICATION_ID}/guilds/${DISCORD.guildId}/commands`,
    commands,
  );
}

export async function ensureInteractionEndpoint(env: Env) {
  const discord = discordClient(env);
  const url = `${env.HUB_URL}/interactions/discord`;
  const app = await discord.get<{ interactions_endpoint_url?: string | null }>("/applications/@me");
  if (app.interactions_endpoint_url !== url) {
    await discord.patch("/applications/@me", { interactions_endpoint_url: url });
  }
  return url;
}

export async function setupDiscord(
  env: Env,
  input: { emojis?: Record<string, string>; replaceEmojis?: string[] } = {},
) {
  const permissions = await checkBotPermissions(env);
  const emojiIds = await ensureEmojis(env, input.emojis ?? {}, input.replaceEmojis ?? []);
  const tags = await configureForums(env, emojiIds);
  const locked = await lockForumPosting(env, permissions.botId);
  const guides = await ensureGuidePosts(env);
  const webhooks = await ensureWebhooks(env);
  const commands = await registerCommands(env);
  const endpoint = await ensureInteractionEndpoint(env);
  return { permissions, tags, locked, guides, webhooks, commands, endpoint };
}
