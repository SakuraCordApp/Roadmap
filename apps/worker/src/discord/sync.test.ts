import { readFile } from "node:fs/promises";
import path from "node:path";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import roadmapConfig from "../../../../roadmap.config.js";
import type { RoadmapEngine, RoadmapItem } from "@roadmap/core";
import type { Env } from "../env.js";
import { desiredForumTags } from "./forums.js";
import {
  attachmentContentFingerprint,
  combineUserReportText,
  componentsV2RoadmapBody,
  componentsV2RoadmapEditBody,
  discordReportSourceRevision,
  DiscordSyncService,
  isReportEvidenceMessage,
  isUserAuthoredDiscordMessage,
  reportCreatedContent,
} from "./sync.js";

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
      state.set("thread_status:thread", "in_progress");
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
    expect(body.components.filter((component) => component.type === 17)).toHaveLength(
      roadmapConfig.publicSections.length + 1,
    );
    expect(body.components.at(-1)?.type).toBe(1);
    const planned =
      body.components[
        roadmapConfig.publicSections.findIndex((section) => section.id === "planned") + 1
      ]!;
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

    const editBody = componentsV2RoadmapEditBody(projection, roadmapConfig, emojiIds) as Record<
      string,
      unknown
    >;
    expect(editBody).toMatchObject({
      flags: 1 << 15,
      content: null,
      embeds: [],
      attachments: [],
      sticker_ids: [],
      poll: null,
    });
  });
});

describe("Discord report copy and context", () => {
  it("ignores refreshed Discord CDN signatures when comparing attachments", () => {
    const first = [
      {
        id: "attachment",
        filename: "screenshot.png",
        size: 2_350,
        content_type: "image/png",
        width: 80,
        height: 78,
        url: "https://cdn.discordapp.com/attachments/thread/attachment/screenshot.png?ex=one&hm=aaa",
        proxy_url:
          "https://media.discordapp.net/attachments/thread/attachment/screenshot.png?ex=one&hm=aaa",
      },
    ];
    const refreshed = [
      {
        ...first[0],
        url: "https://cdn.discordapp.com/attachments/thread/attachment/screenshot.png?ex=two&hm=bbb",
        proxy_url:
          "https://media.discordapp.net/attachments/thread/attachment/screenshot.png?ex=two&hm=bbb",
      },
    ];

    expect(attachmentContentFingerprint(refreshed)).toBe(attachmentContentFingerprint(first));
    expect(attachmentContentFingerprint([{ ...refreshed[0], size: 2_351 }])).not.toBe(
      attachmentContentFingerprint(first),
    );
  });

  it("uses reporter follow-ups as evidence while excluding bot messages", () => {
    expect(
      combineUserReportText(
        [
          {
            id: "bot-response",
            content: "I still need more information.",
            timestamp: "2026-07-25T10:02:00.000Z",
            author: { id: "roadmap-bot" },
          },
          {
            id: "follow-up",
            content: "<@roadmap-bot> It happens in the main chat after loading older messages.",
            timestamp: "2026-07-25T10:03:00.000Z",
            author: { id: "reporter" },
            mentions: [{ id: "roadmap-bot" }],
          },
          {
            id: "unrelated-chatter",
            content: "Anyone playing later?",
            timestamp: "2026-07-25T10:04:00.000Z",
            author: { id: "someone-else" },
          },
          {
            id: "starter",
            content: "Scrolling lags.",
            timestamp: "2026-07-25T10:01:00.000Z",
            author: {},
          },
        ],
        "starter",
        "fallback",
        "roadmap-bot",
      ),
    ).toBe(
      [
        "Initial report:\nScrolling lags.",
        "Bot-mentioned follow-up evidence (message ID: follow-up):\n<@roadmap-bot> It happens in the main chat after loading older messages.",
      ].join("\n\n"),
    );
  });

  it("keeps bot notifications and managed tags out of source identity", async () => {
    const userMessages = [
      {
        id: "starter",
        content: "Highlight mentions in yellow.",
        timestamp: "2026-07-27T01:30:33.164Z",
        author: { id: "reporter" },
      },
    ];
    const botNotification = {
      id: "created-notice",
      content: "**Roadmap report created — SCR-01TEST**",
      timestamp: "2026-07-27T10:19:03.868Z",
      author: { id: "roadmap-bot" },
      application_id: "roadmap-application",
    };
    const initialContent = combineUserReportText(
      userMessages,
      "starter",
      "fallback",
      "roadmap-bot",
    );
    const afterProjectionContent = combineUserReportText(
      [...userMessages, botNotification],
      "starter",
      "fallback",
      "roadmap-bot",
    );

    expect(afterProjectionContent).toBe(initialContent);
    expect(isUserAuthoredDiscordMessage(botNotification, "roadmap-bot")).toBe(false);
    const initialRevision = await discordReportSourceRevision({
      kind: "feature_request",
      title: "Mention highlights",
      content: initialContent,
      attachments: [],
    });
    const afterProjectionRevision = await discordReportSourceRevision({
      kind: "feature_request",
      title: "Mention highlights",
      content: afterProjectionContent,
      attachments: [],
    });
    expect(afterProjectionRevision).toBe(initialRevision);

    const withUserFollowUp = combineUserReportText(
      [
        ...userMessages,
        {
          id: "follow-up",
          content: "<@roadmap-bot> Ephemeral messages should be blue.",
          timestamp: "2026-07-27T10:20:03.868Z",
          author: { id: "reporter" },
          mentions: [{ id: "roadmap-bot" }],
        },
      ],
      "starter",
      "fallback",
      "roadmap-bot",
    );
    await expect(
      discordReportSourceRevision({
        kind: "feature_request",
        title: "Mention highlights",
        content: withUserFollowUp,
        attachments: [],
      }),
    ).resolves.not.toBe(initialRevision);
  });

  it("accepts follow-up evidence only when the user mentions the bot", () => {
    const unmentioned = {
      id: "chatter",
      content: "This is unrelated conversation.",
      author: { id: "member" },
      attachments: [{ id: "unrelated-file" }],
    };
    const mentioned = {
      ...unmentioned,
      id: "evidence",
      content: "<@roadmap-bot> this log reproduces the issue",
      mentions: [{ id: "roadmap-bot" }],
      attachments: [{ id: "relevant-log" }],
    };

    expect(isReportEvidenceMessage(unmentioned, "starter", "roadmap-bot")).toBe(false);
    expect(isReportEvidenceMessage(mentioned, "starter", "roadmap-bot")).toBe(true);
    expect(
      isReportEvidenceMessage({ ...unmentioned, id: "starter" }, "starter", "roadmap-bot"),
    ).toBe(true);
    expect(
      isReportEvidenceMessage(
        { ...mentioned, author: { id: "roadmap-bot", bot: true } },
        "starter",
        "roadmap-bot",
      ),
    ).toBe(false);
  });

  it("confirms creation without asking the reporter for more details", () => {
    const content = reportCreatedContent(
      "SCR-01K00000000000000000000001",
      {
        title: "Scrolling stalls in long channels",
        classification: "functionality",
      },
      "Medium",
    );

    expect(content).toContain("Roadmap report created");
    expect(content).toContain("Scrolling stalls in long channels");
    expect(content).toContain("Status: **Planned**");
    expect(content).not.toMatch(/still need|missing information|follow.?up/i);
  });
});

describe("Discord scheduled reconciliation", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("bootstraps an already-discovered unlinked report exactly once", async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["DB"],
    });
    try {
      const db = (await miniflare.getD1Database("DB")) as unknown as D1Database;
      for (const name of [
        "0001_initial.sql",
        "0003_report_automation.sql",
        "0004_reliable_jobs.sql",
      ]) {
        const migration = await readFile(path.resolve("migrations", name), "utf8");
        for (const statement of migration
          .split(/;\n\n/)
          .map((value) => value.trim())
          .filter(Boolean)) {
          await db.prepare(statement).run();
        }
      }

      const threadId = "1530406149856428172";
      const guildId = roadmapConfig.discord.guildId!;
      const bugForumId = roadmapConfig.discord.bugReportsForumId!;
      const featureForumId = roadmapConfig.discord.featureRequestsForumId!;
      const createdAt = "2026-07-25T02:47:39.697Z";
      await db
        .prepare(
          `INSERT INTO discord_submissions(
             thread_id,forum_id,guild_id,kind,title,author_id,starter_message_id,
             archived,locked,applied_tags_json,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          threadId,
          bugForumId,
          guildId,
          "bug_report",
          "Message rendering",
          "reporter",
          threadId,
          0,
          0,
          "[]",
          createdAt,
          createdAt,
        )
        .run();

      const requests: Array<{ method: string; path: string }> = [];
      const reportContent = "Messages overlap after loading history.";
      let followUpContent = "Unrelated conversation.";
      let followUpMentions: Array<{ id: string }> = [];
      globalThis.fetch = vi.fn(async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        requests.push({ method, path: url.pathname });
        if (url.pathname.endsWith(`/guilds/${guildId}/threads/active`)) {
          return Response.json({
            threads: [
              {
                id: threadId,
                guild_id: guildId,
                parent_id: bugForumId,
                name: "Message rendering",
                owner_id: "reporter",
                applied_tags: [],
                thread_metadata: {
                  archived: false,
                  locked: false,
                  create_timestamp: createdAt,
                  archive_timestamp: createdAt,
                },
              },
            ],
          });
        }
        if (
          url.pathname.endsWith(`/channels/${featureForumId}/threads/archived/public`) ||
          url.pathname.endsWith(`/channels/${bugForumId}/threads/archived/public`)
        ) {
          return Response.json({ threads: [], has_more: false });
        }
        if (url.pathname.endsWith(`/channels/${threadId}/messages`)) {
          return Response.json([
            {
              id: threadId,
              channel_id: threadId,
              content: reportContent,
              timestamp: createdAt,
              author: { id: "reporter" },
              attachments: [],
            },
            {
              id: "follow-up",
              channel_id: threadId,
              content: followUpContent,
              timestamp: "2026-07-25T03:00:00.000Z",
              author: { id: "reporter" },
              mentions: followUpMentions,
              attachments: [],
            },
          ]);
        }
        return Response.json({ id: "ok" });
      }) as typeof fetch;

      const env = {
        DB: db,
        DISCORD_BOT_TOKEN: "discord-bot-token-for-tests",
      } as Env;
      const engine = {} as RoadmapEngine;
      const sync = new DiscordSyncService(env, roadmapConfig, engine);

      await expect(sync.reconcile()).resolves.toMatchObject({ threads: 1, errors: [] });
      await expect(sync.reconcile()).resolves.toMatchObject({ threads: 1, errors: [] });

      const job = await db
        .prepare(
          "SELECT status,count(*) AS count FROM discord_report_jobs WHERE thread_id=? GROUP BY status",
        )
        .bind(threadId)
        .first<{ status: string; count: number }>();
      expect(job).toEqual({ status: "pending", count: 1 });
      await db
        .prepare(
          "UPDATE discord_report_jobs SET status='processing',locked_at=datetime('now') WHERE thread_id=?",
        )
        .bind(threadId)
        .run();
      await expect(sync.reconcile()).resolves.toMatchObject({ threads: 1, errors: [] });
      expect(
        await db
          .prepare("SELECT status,rerun_requested FROM discord_report_jobs WHERE thread_id=?")
          .bind(threadId)
          .first<{ status: string; rerun_requested: number }>(),
      ).toEqual({ status: "processing", rerun_requested: 0 });
      expect(
        await db
          .prepare("SELECT content FROM discord_submissions WHERE thread_id=?")
          .bind(threadId)
          .first<{ content: string }>(),
      ).toEqual({ content: "Messages overlap after loading history." });

      await db
        .prepare(
          `UPDATE discord_report_jobs
           SET status='complete',locked_at=NULL,completed_at=datetime('now')
           WHERE thread_id=?`,
        )
        .bind(threadId)
        .run();
      await db
        .prepare("UPDATE discord_state SET value=? WHERE key=?")
        .bind(
          JSON.stringify({
            lastMessageId: null,
            checkedAt: "2026-07-25T00:00:00.000Z",
          }),
          `thread_messages:${threadId}`,
        )
        .run();
      followUpContent = "Still unrelated conversation.";
      await expect(sync.reconcile()).resolves.toMatchObject({ threads: 1, errors: [] });
      expect(
        await db
          .prepare("SELECT status FROM discord_report_jobs WHERE thread_id=?")
          .bind(threadId)
          .first<{ status: string }>(),
      ).toEqual({ status: "complete" });

      await db
        .prepare("UPDATE discord_state SET value=? WHERE key=?")
        .bind(
          JSON.stringify({
            lastMessageId: null,
            checkedAt: "2026-07-25T00:00:00.000Z",
          }),
          `thread_messages:${threadId}`,
        )
        .run();
      followUpContent = "<@ok> This additional detail is relevant.";
      followUpMentions = [{ id: "ok" }];
      await expect(sync.reconcile()).resolves.toMatchObject({ threads: 1, errors: [] });
      expect(
        await db
          .prepare("SELECT status FROM discord_report_jobs WHERE thread_id=?")
          .bind(threadId)
          .first<{ status: string }>(),
      ).toEqual({ status: "pending" });
      expect(
        await db
          .prepare("SELECT content FROM discord_submissions WHERE thread_id=?")
          .bind(threadId)
          .first<{ content: string }>(),
      ).toEqual({ content: reportContent });

      expect(
        requests.filter(
          (request) =>
            request.method === "POST" && request.path.endsWith(`/channels/${threadId}/messages`),
        ),
      ).toHaveLength(0);
      expect(
        requests.filter(
          (request) => request.method === "PATCH" && request.path.endsWith(`/channels/${threadId}`),
        ),
      ).toHaveLength(0);
    } finally {
      await miniflare.dispose();
    }
  });
});

function countComponents(components: Array<{ components?: any[] }>): number {
  return components.reduce(
    (count, component) =>
      count + 1 + (component.components ? countComponents(component.components) : 0),
    0,
  );
}
