import { describe, expect, it, vi } from "vitest";
import roadmapConfig from "../../../../roadmap.config.js";
import type { RoadmapItem } from "@roadmap/core";
import {
  applyRoadmapTags,
  desiredForumTags,
  ensureForumTaxonomy,
  ensureRoadmapTimelineEmojis,
} from "./forums.js";
import type { DiscordRestClient } from "./rest.js";

describe("Discord forum taxonomy", () => {
  it("unifies both forums with user-selectable classification/priority and moderated status tags", async () => {
    const forums = new Map(
      [roadmapConfig.discord.featureRequestsForumId!, roadmapConfig.discord.bugReportsForumId!].map(
        (id) => [
          id,
          {
            id,
            name: `Forum ${id}`,
            available_tags: [
              {
                id: `${id}-inbox`,
                name: "Inbox",
                moderated: false,
                emoji_id: null,
                emoji_name: null,
              },
              {
                id: `${id}-fixed`,
                name: "Fixed",
                moderated: false,
                emoji_id: null,
                emoji_name: "✅",
              },
            ],
          },
        ],
      ),
    );
    const rest = {
      get: vi.fn(async (path: string) => {
        if (path.includes("/emojis")) return [];
        return structuredClone(forums.get(path.split("/").at(-1)!)!);
      }),
      post: vi.fn(async (_path: string, body: { name: string }) => ({
        id: `emoji-${body.name}`,
        name: body.name,
      })),
      patch: vi.fn(async (path: string, body: { available_tags: any[] }) => {
        const id = path.split("/").at(-1)!;
        const current = forums.get(id)!;
        const updated = {
          ...current,
          available_tags: body.available_tags.map((tag) => ({
            ...tag,
            id: tag.id ?? `${id}-${tag.name.toLocaleLowerCase().replaceAll(" ", "-")}`,
          })),
        };
        forums.set(id, updated);
        return structuredClone(updated);
      }),
    } as unknown as DiscordRestClient;
    const icons = Object.fromEntries(
      desiredForumTags(roadmapConfig).map((tag) => [tag.key, "data:image/png;base64,dGVzdA=="]),
    );

    const result = await ensureForumTaxonomy(rest, roadmapConfig, icons);

    expect(result).toHaveLength(2);
    for (const forum of result) {
      expect(forum.tags).toHaveLength(12);
      expect(forum.tags.map((tag) => tag.name)).not.toContain("Fixed");
      expect(forum.tags.filter((tag) => tag.moderated).map((tag) => tag.name)).toEqual([
        "Planned",
        "In Progress",
        "Polishing",
        "Declined",
        "Duplicate",
        "Done",
      ]);
      expect(forum.tags.filter((tag) => !tag.moderated).map((tag) => tag.name)).toEqual([
        "Visual",
        "Functionality",
        "Critical",
        "High",
        "Medium",
        "Low",
      ]);
      expect(forum.tags.every((tag) => Boolean(tag.emojiId))).toBe(true);
      expect(forum.tags.map((tag) => tag.name)).not.toContain("Inbox");
    }
    expect((rest.post as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(12);
  });

  it("replaces managed tags with the canonical classification, priority, and status", async () => {
    const tags = desiredForumTags(roadmapConfig).map((tag) => ({
      id: `tag-${tag.key}`,
      name: tag.name,
      moderated: tag.moderated,
      emoji_id: `emoji-${tag.key}`,
      emoji_name: null,
    }));
    const rest = {
      get: vi.fn(async () => ({ id: "forum", name: "Forum", available_tags: tags })),
    } as unknown as DiscordRestClient;
    const item = {
      labels: ["visual"],
      priority: "high",
      status: "in_progress",
    } as RoadmapItem;

    const applied = await applyRoadmapTags(
      rest,
      roadmapConfig,
      {
        id: "thread",
        parent_id: "forum",
        applied_tags: ["unrelated", "tag-low", "tag-planned"],
      },
      item,
    );

    expect(applied).toEqual(["unrelated", "tag-visual", "tag-high", "tag-in_progress"]);
  });

  it("recreates only explicitly replaced custom emoji images", async () => {
    const desired = desiredForumTags(roadmapConfig);
    const forums = new Map(
      [roadmapConfig.discord.featureRequestsForumId!, roadmapConfig.discord.bugReportsForumId!].map(
        (id) => [
          id,
          {
            id,
            name: `Forum ${id}`,
            available_tags: desired.map((tag) => ({
              id: `${id}-${tag.key}`,
              name: tag.name,
              moderated: tag.moderated,
              emoji_id: `old-${tag.key}`,
              emoji_name: null,
            })),
          },
        ],
      ),
    );
    const rest = {
      get: vi.fn(async (path: string) => {
        if (path.includes("/emojis")) {
          return desired.map((tag) => ({
            id: `old-${tag.key}`,
            name: `sakura_tag_${tag.key}`,
          }));
        }
        return structuredClone(forums.get(path.split("/").at(-1)!)!);
      }),
      delete: vi.fn(async () => undefined),
      post: vi.fn(async (_path: string, body: { name: string }) => ({
        id: `new-${body.name}`,
        name: body.name,
      })),
      patch: vi.fn(async (path: string, body: { available_tags: any[] }) => ({
        ...forums.get(path.split("/").at(-1)!)!,
        available_tags: body.available_tags,
      })),
    } as unknown as DiscordRestClient;

    const result = await ensureForumTaxonomy(
      rest,
      roadmapConfig,
      { high: "data:image/png;base64,dGVzdA==" },
      ["high"],
    );

    expect(rest.delete).toHaveBeenCalledOnce();
    expect(rest.delete).toHaveBeenCalledWith(
      `/guilds/${roadmapConfig.discord.guildId}/emojis/old-high`,
    );
    expect(rest.post).toHaveBeenCalledOnce();
    expect(result[0]?.tags.find((tag) => tag.name === "High")?.emojiId).toBe("new-sakura_tag_high");
    expect(result[0]?.tags.find((tag) => tag.name === "Low")?.emojiId).toBe("old-low");
  });

  it("creates and selectively replaces the website-matched roadmap timeline emojis", async () => {
    const rest = {
      get: vi.fn(async () => [
        { id: "old-line", name: "sakura_roadmap_line" },
        { id: "old-dot", name: "sakura_roadmap_dot" },
      ]),
      delete: vi.fn(async () => undefined),
      post: vi.fn(async (_path: string, body: { name: string }) => ({
        id: `new-${body.name}`,
        name: body.name,
      })),
    } as unknown as DiscordRestClient;

    const result = await ensureRoadmapTimelineEmojis(
      rest,
      roadmapConfig,
      { line: "data:image/png;base64,bGluZQ==", dot: "data:image/png;base64,ZG90" },
      new Set(["dot"]),
    );

    expect(rest.delete).toHaveBeenCalledWith(
      `/guilds/${roadmapConfig.discord.guildId}/emojis/old-dot`,
    );
    expect(rest.post).toHaveBeenCalledOnce();
    expect(result).toEqual([
      { key: "line", id: "old-line", name: "sakura_roadmap_line" },
      { key: "dot", id: "new-sakura_roadmap_dot", name: "sakura_roadmap_dot" },
    ]);
  });
});
