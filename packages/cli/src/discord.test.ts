import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ContextModule from "./context.js";

const harness = vi.hoisted(() => ({
  events: [] as string[],
  failedSecret: null as string | null,
}));

vi.mock("./context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ContextModule>();
  return {
    ...actual,
    output: vi.fn(),
    run: vi.fn(
      async (
        _context: unknown,
        command: string,
        args: string[],
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
        const secretName =
          command === "npx" && args[0] === "wrangler" && args[1] === "secret"
            ? args.at(-1)
            : undefined;
        if (secretName) harness.events.push(`secret:${secretName}`);
        const failed = secretName === harness.failedSecret;
        return {
          exitCode: failed ? 1 : 0,
          stdout: "",
          stderr: failed ? "simulated secret failure" : "",
        };
      },
    ),
  };
});

import { botInviteUrl, configureDiscord, verifyDiscord } from "./discord.js";

const applicationId = "11111111111111111";
const guildId = "22222222222222222";
const featureForumId = "33333333333333333";
const bugForumId = "44444444444444444";
const roadmapChannelId = "55555555555555555";
const releaseAnnouncementChannelId = "55555555555555556";
const maintainerRoleId = "66666666666666666";
const updatesRoleId = "88888888888888888";
const botRoleId = "99999999999999998";
const requiredTags = [
  "Inbox",
  "Planned",
  "In Progress",
  "Polishing",
  "Done",
  "Declined",
  "Duplicate",
].map((name, index) => ({
  id: `7777777777777777${index}`,
  name,
  moderated: true,
}));

let temporaryRoot = "";
let originalFetch: typeof fetch;

beforeEach(async () => {
  harness.events.length = 0;
  harness.failedSecret = null;
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "roadmap-discord-test-"));
  await writeFile(path.join(temporaryRoot, "roadmap.instance.json"), "{}\n");
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    harness.events.push(`discord:${method}:${url.pathname}`);
    if (url.pathname === "/api/v10/users/@me") {
      return Response.json({ id: applicationId, username: "RoadmapBot" });
    }
    if (url.pathname === "/api/v10/oauth2/applications/@me") {
      return Response.json({ id: applicationId, verify_key: "a".repeat(64) });
    }
    if (url.pathname === `/api/v10/guilds/${guildId}`) {
      return Response.json({ id: guildId, name: "SakuraCord" });
    }
    if (url.pathname === `/api/v10/guilds/${guildId}/roles`) {
      return Response.json([
        {
          id: guildId,
          name: "@everyone",
          position: 0,
          permissions: "0",
          managed: false,
          mentionable: false,
        },
        {
          id: updatesRoleId,
          name: "Updates",
          position: 1,
          permissions: "0",
          managed: false,
          mentionable: false,
        },
        {
          id: botRoleId,
          name: "RoadmapBot",
          position: 10,
          permissions: ((1n << 28n) | (1n << 17n)).toString(),
          managed: true,
          mentionable: false,
        },
      ]);
    }
    if (url.pathname === `/api/v10/guilds/${guildId}/members/${applicationId}`) {
      return Response.json({ roles: [botRoleId] });
    }
    if (url.pathname === `/api/v10/channels/${featureForumId}`) {
      return Response.json({
        id: featureForumId,
        type: 15,
        name: "feature-requests",
        available_tags: requiredTags,
      });
    }
    if (url.pathname === `/api/v10/channels/${bugForumId}`) {
      return Response.json({
        id: bugForumId,
        type: 15,
        name: "bug-reports",
        available_tags: requiredTags,
      });
    }
    if (url.pathname === `/api/v10/channels/${roadmapChannelId}`) {
      return Response.json({ id: roadmapChannelId, type: 0, name: "roadmap" });
    }
    if (url.pathname === `/api/v10/channels/${releaseAnnouncementChannelId}`) {
      return Response.json({
        id: releaseAnnouncementChannelId,
        type: 0,
        name: "releases",
      });
    }
    if (url.pathname === `/api/v10/guilds/${guildId}/threads/active`) {
      return Response.json({ threads: [], members: [] });
    }
    if (
      url.pathname === `/api/v10/channels/${featureForumId}/threads/archived/public` ||
      url.pathname === `/api/v10/channels/${bugForumId}/threads/archived/public`
    ) {
      return Response.json({ threads: [], members: [], has_more: false });
    }
    if (url.pathname === `/api/v10/channels/${roadmapChannelId}/messages` && method === "POST") {
      return Response.json({ id: "99999999999999999" });
    }
    if (
      url.pathname === `/api/v10/channels/${roadmapChannelId}/messages/99999999999999999` &&
      method === "DELETE"
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      url.pathname === `/api/v10/channels/${releaseAnnouncementChannelId}/messages` &&
      method === "POST"
    ) {
      return Response.json({ id: "99999999999999997" });
    }
    if (
      url.pathname ===
        `/api/v10/channels/${releaseAnnouncementChannelId}/messages/99999999999999997` &&
      method === "DELETE"
    ) {
      return new Response(null, { status: 204 });
    }
    if (
      url.pathname === "/api/v10/applications/@me" ||
      url.pathname === `/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
    ) {
      return Response.json({});
    }
    if (url.origin === "https://roadmap.example.com" && url.pathname === "/interactions/discord") {
      harness.events.push("worker:interaction-secret-ready");
      return Response.json(
        { error: { code: "INVALID_SIGNATURE", message: "Missing Discord signature headers." } },
        { status: 401 },
      );
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("Discord setup ordering", () => {
  it("generates a guild-install URL with temporary tag-creation permission", () => {
    const url = new URL(botInviteUrl(applicationId, true));
    expect(url.origin).toBe("https://discord.com");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe(applicationId);
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    expect(url.searchParams.get("permissions")).toBe("295547636816");
    expect(url.searchParams.get("integration_type")).toBe("0");
  });

  it("stores every Worker secret before Discord verifies the interaction endpoint", async () => {
    const configured = await configureDiscord(
      { root: temporaryRoot, json: false, verbose: false },
      {
        botToken: "test-discord-token-with-safe-length",
        applicationId,
        publicKey: "a".repeat(64),
        guildId,
        featureForumId,
        bugForumId,
        roadmapChannelId,
        releaseAnnouncementChannelId,
        updatesRoleId,
        maintainerRoleIds: maintainerRoleId,
        publicUrl: "https://roadmap.example.com",
        storeSecret: true,
        createMissingTags: true,
        nonInteractive: true,
        onAnswers: async () => {
          harness.events.push("setup-answers:saved");
        },
      },
    );

    const endpointIndex = harness.events.indexOf("discord:PATCH:/api/v10/applications/@me");
    expect(endpointIndex).toBeGreaterThan(0);
    expect(harness.events.indexOf("setup-answers:saved")).toBeLessThan(
      harness.events.indexOf("discord:GET:/api/v10/users/@me"),
    );
    for (const name of ["DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID", "DISCORD_PUBLIC_KEY"]) {
      expect(harness.events.indexOf(`secret:${name}`)).toBeLessThan(endpointIndex);
    }
    expect(harness.events.indexOf("worker:interaction-secret-ready")).toBeLessThan(endpointIndex);
    expect(configured.applicationId).toBe(applicationId);
    const instance = JSON.parse(
      await readFile(path.join(temporaryRoot, "roadmap.instance.json"), "utf8"),
    );
    expect(instance.discord.roadmapChannelId).toBe(roadmapChannelId);
    expect(instance.discord.releaseAnnouncementChannelId).toBe(releaseAnnouncementChannelId);
    expect(configured.releaseAnnouncementChannelId).toBe(releaseAnnouncementChannelId);
    expect(instance.discord.maintainerRoleIds).toEqual([maintainerRoleId]);
  });

  it("does not register an unverifiable endpoint when secret storage fails", async () => {
    harness.failedSecret = "DISCORD_PUBLIC_KEY";
    await expect(
      configureDiscord(
        { root: temporaryRoot, json: false, verbose: false },
        {
          botToken: "test-discord-token-with-safe-length",
          applicationId,
          publicKey: "a".repeat(64),
          guildId,
          featureForumId,
          bugForumId,
          roadmapChannelId,
          releaseAnnouncementChannelId,
          updatesRoleId,
          maintainerRoleIds: maintainerRoleId,
          publicUrl: "https://roadmap.example.com",
          storeSecret: true,
          createMissingTags: true,
          nonInteractive: true,
        },
      ),
    ).rejects.toThrow("Failed to store DISCORD_PUBLIC_KEY");
    expect(harness.events).not.toContain("discord:PATCH:/api/v10/applications/@me");
  });

  it("rejects a public key that does not belong to the bot application", async () => {
    await expect(
      configureDiscord(
        { root: temporaryRoot, json: false, verbose: false },
        {
          botToken: "test-discord-token-with-safe-length",
          applicationId,
          publicKey: "b".repeat(64),
          guildId,
          featureForumId,
          bugForumId,
          roadmapChannelId,
          releaseAnnouncementChannelId,
          updatesRoleId,
          maintainerRoleIds: maintainerRoleId,
          publicUrl: "https://roadmap.example.com",
          storeSecret: true,
          createMissingTags: true,
          nonInteractive: true,
        },
      ),
    ).rejects.toThrow("public key does not match");
    expect(harness.events.some((event) => event.startsWith("secret:"))).toBe(false);
    expect(harness.events).not.toContain("discord:PATCH:/api/v10/applications/@me");
  });

  it("uses Discord's accepted minimum page size while verifying archived forum access", async () => {
    await verifyDiscord(
      { root: temporaryRoot, json: false, verbose: false },
      {
        botToken: "test-discord-token-with-safe-length",
        applicationId,
        guildId,
        featureForumId,
        bugForumId,
        roadmapChannelId,
        releaseAnnouncementChannelId,
        updatesRoleId,
        createMissingTags: true,
        writeTest: true,
      },
    );

    expect(harness.events).toContain(
      `discord:GET:/api/v10/channels/${featureForumId}/threads/archived/public`,
    );
    const archivedRequests = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.endsWith("/threads/archived/public"));
    expect(archivedRequests).toHaveLength(2);
    expect(archivedRequests.every((url) => url.searchParams.get("limit") === "2")).toBe(true);
    expect(harness.events).toContain(
      `discord:POST:/api/v10/channels/${releaseAnnouncementChannelId}/messages`,
    );
    expect(harness.events).toContain(
      `discord:DELETE:/api/v10/channels/${releaseAnnouncementChannelId}/messages/99999999999999997`,
    );
  });
});
