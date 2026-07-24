import { afterEach, describe, expect, it, vi } from "vitest";
import roadmapConfig from "../../../../roadmap.config.js";
import type { RoadmapEngine, RoadmapItem } from "@roadmap/core";
import type { Env } from "../env.js";
import { desiredForumTags } from "./forums.js";
import { componentsV2RoadmapBody, DiscordSyncService } from "./sync.js";

describe("Discord roadmap completion synchronization", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each([
    ["bug_report", "Bug fixed", "has been fixed"],
    ["feature_request", "Feature implemented", "has been implemented"],
  ] as const)(
    "posts the %s completion notice before locking and archiving",
    async (kind, heading, text) => {
      const requests: Array<{ method: string; path: string; body: any }> = [];
      const tags = desiredForumTags(roadmapConfig).map((tag) => ({
        id: `tag-${tag.key}`,
        name: tag.name,
        moderated: tag.moderated,
        emoji_id: `emoji-${tag.key}`,
        emoji_name: null,
      }));
      globalThis.fetch = vi.fn(async (input, init) => {
        const url = new URL(String(input));
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method: init?.method ?? "GET", path: url.pathname, body });
        if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/channels/thread")) {
          return Response.json({
            id: "thread",
            parent_id: "forum",
            applied_tags: ["tag-planned"],
            thread_metadata: { archived: false, locked: false },
          });
        }
        if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/channels/forum")) {
          return Response.json({ id: "forum", name: "Reports", available_tags: tags });
        }
        return Response.json({ id: "ok" });
      }) as typeof fetch;
      const state = new Map<string, string>();
      const db = {
        prepare(sql: string) {
          let values: unknown[] = [];
          return {
            bind(...input: unknown[]) {
              values = input;
              return this;
            },
            async first() {
              if (sql.includes("SELECT value FROM discord_state")) {
                const value = state.get(String(values[0]));
                return value ? { value } : null;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO discord_state")) {
                state.set(String(values[0]), String(values[1]));
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      } as unknown as D1Database;
      const item = {
        id: "SAK-01K00000000000000000000000",
        title: "Native media viewer",
        status: "done",
        priority: "high",
        labels: ["visual"],
        linkedDiscordThreads: [
          {
            threadId: "thread",
            forumId: "forum",
            guildId: "guild",
            kind,
            url: "https://discord.com/channels/guild/thread",
            title: "Native media viewer",
            linkedAt: "2026-07-24T00:00:00.000Z",
          },
        ],
      } as RoadmapItem;
      const engine = { get: vi.fn(async () => item) } as unknown as RoadmapEngine;
      const env = {
        DB: db,
        DISCORD_BOT_TOKEN: "discord-bot-token-for-tests",
      } as Env;

      await new DiscordSyncService(env, roadmapConfig, engine).syncItem(item.id);

      const mutations = requests.filter((request) => request.method !== "GET");
      expect(mutations.map((request) => request.method)).toEqual(["PATCH", "POST", "PATCH"]);
      expect(mutations[0]?.body).toMatchObject({
        archived: false,
        locked: false,
        applied_tags: ["tag-visual", "tag-high", "tag-done"],
      });
      expect(mutations[1]?.body.content).toContain(heading);
      expect(mutations[1]?.body.content).toContain(text);
      expect(mutations[2]?.body).toEqual({ archived: true, locked: true });
      expect(state.get("thread_status:thread")).toBe("done");
    },
  );
});

describe("Discord Components V2 roadmap layout", () => {
  it("uses one colored container per lifecycle step with status and priority emoji", () => {
    const sections = roadmapConfig.publicSections.map((section) => ({
      id: section.id,
      label: section.label,
      items:
        section.id === "planned"
          ? [
              {
                id: "SCR-01K00000000000000000000000",
                title: "Native screen sharing",
                priority: "high",
                area: "communication",
                linkedThreadUrls: [],
              },
            ]
          : [],
    }));
    const projection = {
      groups: [
        { id: "feature", label: "New Features", sections },
        {
          id: "bug",
          label: "Bug Tracking",
          sections: roadmapConfig.publicSections.map((section) => ({
            id: section.id,
            label: section.label,
            items: [],
          })),
        },
      ],
      generatedAt: "2026-07-24T00:00:00.000Z",
      hashInput: "{}",
      hash: "hash",
    };
    const emojiIds = new Map([
      ["planned", "emoji-planned"],
      ["in_progress", "emoji-progress"],
      ["polishing", "emoji-polishing"],
      ["done", "emoji-done"],
      ["high", "emoji-high"],
    ]);

    const body = componentsV2RoadmapBody(projection, roadmapConfig, emojiIds) as {
      flags: number;
      components: Array<{ type: number; accent_color?: number; components?: any[] }>;
    };

    expect(body.flags).toBe(1 << 15);
    expect(body.components).toHaveLength(roadmapConfig.publicSections.length + 2);
    expect(body.components.filter((component) => component.type === 17)).toHaveLength(5);
    expect(body.components.at(-1)?.type).toBe(1);
    const planned = body.components[1]!;
    expect(planned.accent_color).toBe(Number.parseInt("#60A5FA".slice(1), 16));
    expect(planned.components?.[0]?.content).toContain(
      "<:sakura_tag_planned:emoji-planned> Planned",
    );
    expect(planned.components?.[0]?.content).toContain(
      "<:sakura_tag_high:emoji-high> **Native screen sharing**",
    );
    expect(planned.components?.[0]?.content).toContain("💡 New Features");
    expect(planned.components?.[0]?.content).toContain("🪲 Bug Tracking");
    expect(JSON.stringify(body)).not.toContain("/items/");
    expect(countComponents(body.components)).toBeLessThanOrEqual(40);
  });
});

function countComponents(components: Array<{ components?: any[] }>): number {
  return components.reduce(
    (count, component) =>
      count + 1 + (component.components ? countComponents(component.components) : 0),
    0,
  );
}
