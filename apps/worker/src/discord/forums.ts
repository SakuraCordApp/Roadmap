import { RoadmapError, type RoadmapConfig, type RoadmapItem } from "@roadmap/core";
import type { DiscordRestClient } from "./rest.js";

export type TagIconPayloads = Record<string, string>;

interface DiscordForumTag {
  id: string;
  name: string;
  moderated: boolean;
  emoji_id: string | null;
  emoji_name: string | null;
}

interface DiscordForum {
  id: string;
  name: string;
  available_tags: DiscordForumTag[];
}

interface DiscordEmoji {
  id: string;
  name: string;
}

interface DesiredTag {
  key: string;
  name: string;
  moderated: boolean;
}

export interface ForumTaxonomyResult {
  forumId: string;
  forumName: string;
  tags: Array<{
    id: string;
    name: string;
    moderated: boolean;
    emojiId: string | null;
  }>;
}

const CLASSIFICATION_TAGS: DesiredTag[] = [
  { key: "visual", name: "Visual", moderated: false },
  { key: "functionality", name: "Functionality", moderated: false },
];

export function desiredForumTags(config: RoadmapConfig): DesiredTag[] {
  const priorities = config.priorities.map((priority) => ({
    key: priority.id,
    name: priority.label,
    moderated: false,
  }));
  const lifecycle = config.lifecycle.map((state) => ({
    key: state.id,
    name: state.label,
    moderated: true,
  }));
  return [...CLASSIFICATION_TAGS, ...priorities, ...lifecycle];
}

export async function ensureForumTaxonomy(
  rest: DiscordRestClient,
  config: RoadmapConfig,
  iconPayloads: TagIconPayloads = {},
  replaceIconKeys: string[] = [],
): Promise<ForumTaxonomyResult[]> {
  const guildId = config.discord.guildId;
  if (!guildId)
    throw new RoadmapError("DISCORD_GUILD_MISSING", "Discord guild is not configured.", 503);
  const desired = desiredForumTags(config);
  if (desired.length > 20) {
    throw new RoadmapError(
      "DISCORD_FORUM_TAG_LIMIT",
      `Discord forums support at most 20 tags; this configuration requires ${desired.length}.`,
      422,
    );
  }
  const emojiIds = await ensureTagEmojis(
    rest,
    guildId,
    desired,
    iconPayloads,
    new Set(replaceIconKeys),
  );
  const forumIds = [config.discord.featureRequestsForumId, config.discord.bugReportsForumId].filter(
    (value): value is string => Boolean(value),
  );
  const results: ForumTaxonomyResult[] = [];
  for (const forumId of forumIds) {
    const current = await rest.get<DiscordForum>(`/channels/${forumId}`);
    const currentByName = new Map(
      (current.available_tags ?? []).map((tag) => [tag.name.toLocaleLowerCase(), tag]),
    );
    const availableTags = desired.map((tag) => {
      const existing = currentByName.get(tag.name.toLocaleLowerCase());
      return {
        ...(existing?.id ? { id: existing.id } : {}),
        name: tag.name,
        moderated: tag.moderated,
        emoji_id: emojiIds.get(tag.key) ?? existing?.emoji_id ?? null,
        emoji_name: null,
      };
    });
    const updated = await rest.patch<DiscordForum>(
      `/channels/${forumId}`,
      { available_tags: availableTags, require_tag: true },
      "Unify SakuraCord roadmap forum taxonomy",
    );
    results.push({
      forumId,
      forumName: updated.name,
      tags: updated.available_tags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        moderated: tag.moderated,
        emojiId: tag.emoji_id,
      })),
    });
  }
  return results;
}

export async function applyRoadmapTags(
  rest: DiscordRestClient,
  config: RoadmapConfig,
  thread: { id: string; parent_id: string; applied_tags?: string[] },
  item: RoadmapItem,
): Promise<string[]> {
  const forum = await rest.get<DiscordForum>(`/channels/${thread.parent_id}`);
  const desired = desiredForumTags(config);
  const managedNames = new Set(desired.map((tag) => tag.name.toLocaleLowerCase()));
  const managedIds = new Set(
    forum.available_tags
      .filter((tag) => managedNames.has(tag.name.toLocaleLowerCase()))
      .map((tag) => tag.id),
  );
  const tagByName = new Map(
    forum.available_tags.map((tag) => [tag.name.toLocaleLowerCase(), tag.id]),
  );
  const classification = item.labels.includes("visual") ? "visual" : "functionality";
  const lifecycleLabel =
    config.lifecycle.find((state) => state.id === item.status)?.label ?? item.status;
  const priorityLabel =
    config.priorities.find((priority) => priority.id === item.priority)?.label ?? item.priority;
  const selectedNames = [
    classification === "visual" ? "Visual" : "Functionality",
    priorityLabel,
    lifecycleLabel,
  ];
  const selected = selectedNames
    .map((name) => tagByName.get(name.toLocaleLowerCase()))
    .filter((value): value is string => Boolean(value));
  const retained = (thread.applied_tags ?? []).filter((tag) => !managedIds.has(tag));
  return [...new Set([...retained, ...selected])].slice(0, 5);
}

export async function resolveAppliedTagNames(
  rest: DiscordRestClient,
  thread: { parent_id: string; applied_tags?: string[] },
): Promise<string[]> {
  const forum = await rest.get<DiscordForum>(`/channels/${thread.parent_id}`);
  const selected = new Set(thread.applied_tags ?? []);
  return forum.available_tags.filter((tag) => selected.has(tag.id)).map((tag) => tag.name);
}

async function ensureTagEmojis(
  rest: DiscordRestClient,
  guildId: string,
  desired: DesiredTag[],
  iconPayloads: TagIconPayloads,
  replaceIconKeys: Set<string>,
): Promise<Map<string, string>> {
  const existing = await rest.get<DiscordEmoji[]>(`/guilds/${guildId}/emojis`);
  const byName = new Map(existing.map((emoji) => [emoji.name, emoji]));
  const result = new Map<string, string>();
  for (const tag of desired) {
    const emojiName = `sakura_tag_${tag.key}`;
    let emoji = byName.get(emojiName);
    if (emoji && replaceIconKeys.has(tag.key) && iconPayloads[tag.key]) {
      await rest.delete(`/guilds/${guildId}/emojis/${emoji.id}`);
      byName.delete(emojiName);
      emoji = undefined;
    }
    if (!emoji && iconPayloads[tag.key]) {
      emoji = await rest.post<DiscordEmoji>(
        `/guilds/${guildId}/emojis`,
        { name: emojiName, image: iconPayloads[tag.key] },
        `Create ${tag.name} roadmap tag icon`,
      );
      byName.set(emojiName, emoji);
    }
    if (emoji) result.set(tag.key, emoji.id);
  }
  return result;
}
