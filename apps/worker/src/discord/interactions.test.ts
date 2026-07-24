import { readFile } from "node:fs/promises";
import path from "node:path";
import { Miniflare } from "miniflare";
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import roadmapConfig from "../../../../roadmap.config.js";
import type { RoadmapEngine } from "@roadmap/core";
import type { Env } from "../env.js";
import { handleDiscordInteraction } from "./interactions.js";

describe("Discord update subscriptions", () => {
  let miniflare: Miniflare;
  let env: Env;
  let originalFetch: typeof fetch;
  const keyPair = nacl.sign.keyPair();
  const requests: Array<{ method: string; pathname: string }> = [];

  beforeEach(async () => {
    requests.length = 0;
    miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["DB"],
    });
    const db = (await miniflare.getD1Database("DB")) as unknown as D1Database;
    const migration = await readFile(path.resolve("migrations/0001_initial.sql"), "utf8");
    for (const statement of migration
      .split(/;\n\n/)
      .map((value) => value.trim())
      .filter(Boolean)) {
      await db.prepare(statement).run();
    }
    env = {
      DB: db,
      ASSETS: {} as Fetcher,
      DISCORD_BOT_TOKEN: "discord-bot-token-for-tests",
      DISCORD_PUBLIC_KEY: toHex(keyPair.publicKey),
    };
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method ?? "GET", pathname: url.pathname });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await miniflare.dispose();
  });

  it("adds and removes the configured Discord role instead of maintaining shadow subscription state", async () => {
    const added = await interact("interaction-add", []);
    expect(added.status).toBe(200);
    expect((await added.json<any>()).data.content).toContain("now receive");
    expect(requests[0]).toEqual({
      method: "PUT",
      pathname: `/api/v10/guilds/${roadmapConfig.discord.guildId}/members/77777777777777777/roles/${roadmapConfig.discord.updatesRoleId}`,
    });

    const removed = await interact("interaction-remove", [roadmapConfig.discord.updatesRoleId!]);
    expect((await removed.json<any>()).data.content).toContain("no longer");
    expect(requests[1]).toEqual({
      method: "DELETE",
      pathname: `/api/v10/guilds/${roadmapConfig.discord.guildId}/members/77777777777777777/roles/${roadmapConfig.discord.updatesRoleId}`,
    });

    const shadowRows = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM discord_subscriptions",
    ).first<{ count: number }>();
    expect(shadowRows?.count).toBe(0);
  });

  async function interact(id: string, roles: string[]): Promise<Response> {
    const body = JSON.stringify({
      id,
      application_id: "11111111111111111",
      type: 3,
      token: "interaction-token",
      guild_id: roadmapConfig.discord.guildId,
      channel_id: roadmapConfig.discord.roadmapChannelId,
      member: {
        user: { id: "77777777777777777", username: "Subscriber" },
        roles,
      },
      data: { custom_id: "roadmap:subscribe", component_type: 2 },
    });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = nacl.sign.detached(
      new TextEncoder().encode(timestamp + body),
      keyPair.secretKey,
    );
    return handleDiscordInteraction(
      new Request("https://roadmap.sakuracord.app/interactions/discord", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-Ed25519": toHex(signature),
          "X-Signature-Timestamp": timestamp,
        },
        body,
      }),
      env,
      roadmapConfig,
      {} as RoadmapEngine,
    );
  }
});

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
