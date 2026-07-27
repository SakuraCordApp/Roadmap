import { readFile } from "node:fs/promises";
import path from "node:path";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import roadmapConfig from "../../../roadmap.config.js";
import type { Env } from "./env.js";

const aiHarness = vi.hoisted(() => ({
  calls: [] as unknown[],
}));

vi.mock("./ai-oauth.js", () => ({
  generateStructuredReleaseCopy: vi.fn(async (...args: unknown[]) => {
    aiHarness.calls.push(args);
    return {
      githubDescription:
        "## What changed\n\n- Added polished release automation.\n\n**Full Changelog:** [v1.1.0...v1.2.0](https://github.com/SakuraCordApp/SakuraCord/compare/v1.1.0...v1.2.0)",
      discordTitle: "SakuraCord v1.2.0 is here",
      discordAnnouncement: "**Highlights**\n- Polished release automation.",
    };
  }),
}));

import { acceptGithubReleaseWebhook, processPendingReleaseJobs } from "./release-automation.js";

describe("release automation", () => {
  let miniflare: Miniflare;
  let env: Env;
  let originalFetch: typeof fetch;
  const githubRequests: Array<{ url: URL; method: string; body?: any }> = [];
  const discordRequests: Array<{ url: URL; method: string; body?: any }> = [];

  beforeEach(async () => {
    aiHarness.calls.length = 0;
    githubRequests.length = 0;
    discordRequests.length = 0;
    miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["DB"],
    });
    const db = (await miniflare.getD1Database("DB")) as unknown as D1Database;
    for (const name of [
      "0001_initial.sql",
      "0002_release_automation.sql",
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
    env = {
      DB: db,
      ASSETS: {} as Fetcher,
      GITHUB_WEBHOOK_SECRET: "github-webhook-secret-for-tests",
      GITHUB_RELEASE_TOKEN: "github-token-for-tests",
      DISCORD_BOT_TOKEN: "discord-token-for-tests",
    };
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.origin === "https://api.github.com") {
        githubRequests.push({ url, method, body });
        if (url.pathname.endsWith("/releases") && method === "GET") {
          return Response.json([
            {
              id: 10,
              tag_name: "v1.2.0",
              draft: false,
              published_at: "2026-07-24T12:00:00Z",
            },
            {
              id: 9,
              tag_name: "v1.1.0",
              draft: false,
              published_at: "2026-07-10T12:00:00Z",
            },
          ]);
        }
        if (url.pathname.includes("/compare/") && method === "GET") {
          return Response.json({
            total_commits: 2,
            commits: [
              commit("a".repeat(40), "Add release automation"),
              commit("b".repeat(40), "Polish announcement copy"),
            ],
          });
        }
        if (url.pathname.endsWith("/releases/10") && method === "PATCH") {
          return Response.json({ id: 10, body: body?.body });
        }
      }
      if (url.origin === "https://discord.com") {
        discordRequests.push({ url, method, body });
        if (method === "POST") return Response.json({ id: "99999999999999999" });
      }
      return new Response("unexpected request", { status: 500 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await miniflare.dispose();
  });

  it("accepts a signed release once, summarizes every compared commit, and publishes both destinations", async () => {
    const body = JSON.stringify({
      action: "published",
      release: {
        id: 10,
        tag_name: "v1.2.0",
        name: "SakuraCord 1.2",
        html_url: "https://github.com/SakuraCordApp/SakuraCord/releases/tag/v1.2.0",
        target_commitish: "main",
        published_at: "2026-07-24T12:00:00Z",
        draft: false,
      },
      repository: { full_name: "SakuraCordApp/SakuraCord" },
    });
    const request = await signedWebhook(body);
    const accepted = await acceptGithubReleaseWebhook(request, env, roadmapConfig);
    expect(accepted).toMatchObject({ accepted: true, jobId: 1 });

    const duplicate = await acceptGithubReleaseWebhook(
      await signedWebhook(body),
      env,
      roadmapConfig,
    );
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true });

    await expect(processPendingReleaseJobs(env, roadmapConfig, 1)).resolves.toEqual({
      processed: 1,
      failed: 0,
    });
    const aiInput = aiHarness.calls[0]?.[2] as { commits: unknown[]; previousTag: string };
    expect(aiInput.commits).toHaveLength(2);
    expect(aiInput.previousTag).toBe("v1.1.0");

    const releasePatch = githubRequests.find(
      ({ url, method }) => url.pathname.endsWith("/releases/10") && method === "PATCH",
    );
    expect(releasePatch?.body.body).toContain("## What changed");
    expect(releasePatch?.body.body).toContain("SakuraCordApp/SakuraCord/compare/v1.1.0...v1.2.0");
    expect(releasePatch?.body.body.match(/\*\*Full Changelog:\*\*/g)).toHaveLength(1);

    expect(discordRequests).toHaveLength(1);
    expect(discordRequests[0]?.body).toMatchObject({
      content: `<@&${roadmapConfig.discord.updatesRoleId}>`,
      allowed_mentions: {
        parse: [],
        roles: [roadmapConfig.discord.updatesRoleId],
        replied_user: false,
      },
      enforce_nonce: true,
    });
    const stored = await env.DB.prepare(
      "SELECT status,github_updated_at,discord_message_id FROM release_jobs WHERE release_id=10",
    ).first<{
      status: string;
      github_updated_at: string | null;
      discord_message_id: string | null;
    }>();
    expect(stored?.status).toBe("complete");
    expect(stored?.github_updated_at).toBeTruthy();
    expect(stored?.discord_message_id).toBe("99999999999999999");
  });

  async function signedWebhook(body: string): Promise<Request> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const hex = [...new Uint8Array(signature)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return new Request("https://roadmap.sakuracord.app/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "release",
        "X-GitHub-Delivery": "11111111-2222-3333-4444-555555555555",
        "X-Hub-Signature-256": `sha256=${hex}`,
      },
      body,
    });
  }
});

function commit(sha: string, message: string) {
  return {
    sha,
    html_url: `https://github.com/SakuraCordApp/SakuraCord/commit/${sha}`,
    commit: {
      message,
      author: { name: "SakuraCord Maintainer", date: "2026-07-24T10:00:00Z" },
      committer: { name: "SakuraCord Maintainer", date: "2026-07-24T10:00:00Z" },
    },
  };
}
