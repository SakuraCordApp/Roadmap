import { readFile } from "node:fs/promises";
import path from "node:path";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import roadmapConfig from "../../../roadmap.config.js";
import type { Env } from "./env.js";
import { bytesToBase64Url } from "./crypto-store.js";

const oauthHarness = vi.hoisted(() => ({
  requests: [] as unknown[],
  oauthRequestOptions: [] as Array<{ redirectUri: string }>,
}));

vi.mock("@openai-oauth/core", () => ({
  createOpenAIOAuthRequest: vi.fn(async (options: { redirectUri: string }) => {
    oauthHarness.oauthRequestOptions.push(options);
    return {
      authorizationUrl:
        "https://auth.openai.com/oauth/authorize?state=oauth-state&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
      state: "oauth-state",
      codeVerifier: "oauth-code-verifier",
      codeChallenge: "challenge",
      redirectUri: options.redirectUri,
    };
  }),
  exchangeOpenAIOAuthCode: vi.fn(async () => ({
    accessToken: "access-token-secret",
    refreshToken: "refresh-token-secret",
    idToken: "id-token-secret",
    accountId: "account-secret",
    expiresIn: 3_600,
    raw: {},
  })),
  refreshOpenAIOAuthTokens: vi.fn(),
  createOpenAIOAuthTransport: vi.fn(() => ({
    request: vi.fn(async (_path: string, init: RequestInit) => {
      oauthHarness.requests.push(JSON.parse(String(init.body)));
      return Response.json({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  githubDescription: "## Changes\n\n- Added subscriptions.",
                  discordTitle: "Release @everyone",
                  discordAnnouncement: "Hello <@12345678901234567> and @here",
                }),
              },
            ],
          },
        ],
      });
    }),
  })),
}));

import {
  aiOAuthStatus,
  beginAiOAuth,
  finishAiOAuth,
  generateStructuredReleaseCopy,
} from "./ai-oauth.js";

describe("encrypted ChatGPT OAuth", () => {
  let miniflare: Miniflare;
  let env: Env;

  beforeEach(async () => {
    oauthHarness.requests.length = 0;
    oauthHarness.oauthRequestOptions.length = 0;
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
    const key = new Uint8Array(32);
    key.fill(7);
    env = {
      DB: db,
      ASSETS: {} as Fetcher,
      ROADMAP_OAUTH_ENCRYPTION_KEY: bytesToBase64Url(key),
    };
  });

  afterEach(async () => miniflare.dispose());

  it("stores the PKCE verifier and refreshable session encrypted, then validates generated output", async () => {
    const started = await beginAiOAuth(env);
    expect(started.authorizationUrl).toContain("auth.openai.com");
    expect(oauthHarness.oauthRequestOptions).toEqual([
      { redirectUri: "http://localhost:1455/auth/callback" },
    ]);
    const pending = await env.DB.prepare("SELECT encrypted_verifier FROM ai_oauth_requests").first<{
      encrypted_verifier: string;
    }>();
    expect(pending?.encrypted_verifier).not.toContain("oauth-code-verifier");

    await finishAiOAuth(env, "authorization-code", "oauth-state");
    const stored = await env.DB.prepare(
      "SELECT encrypted_session FROM ai_oauth_session WHERE id='primary'",
    ).first<{ encrypted_session: string }>();
    expect(stored?.encrypted_session).not.toContain("access-token-secret");
    expect(stored?.encrypted_session).not.toContain("refresh-token-secret");
    await expect(aiOAuthStatus(env)).resolves.toMatchObject({ connected: true });

    const generated = await generateStructuredReleaseCopy(env, roadmapConfig, {
      tagName: "v1.2.0",
      releaseName: "SakuraCord 1.2",
      releaseUrl: "https://github.com/SakuraCordApp/SakuraCord/releases/tag/v1.2.0",
      previousTag: "v1.1.0",
      commits: [
        {
          sha: "a".repeat(40),
          message: "Add update subscriptions",
          author: "Maintainer",
          committedAt: "2026-07-24T12:00:00Z",
          url: `https://github.com/SakuraCordApp/SakuraCord/commit/${"a".repeat(40)}`,
        },
      ],
    });
    expect(generated.githubDescription).toContain("Added subscriptions");
    expect(generated.discordTitle).toContain("@\u200beveryone");
    expect(generated.discordAnnouncement).toContain("[mention removed]");
    expect(generated.discordAnnouncement).toContain("@\u200bhere");
    expect(oauthHarness.requests).toHaveLength(1);
    expect(oauthHarness.requests[0]).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "medium" },
    });
    const releasePrompt = JSON.parse(
      (
        oauthHarness.requests[0] as {
          input: Array<{ content: Array<{ text: string }> }>;
        }
      ).input[0]!.content[0]!.text,
    ) as { requirements: { github: string } };
    expect(releasePrompt.requirements.github).toContain(
      "Do not include a Full Changelog section or link",
    );

    const replacementKey = new Uint8Array(32);
    replacementKey.fill(9);
    env.ROADMAP_OAUTH_ENCRYPTION_KEY = bytesToBase64Url(replacementKey);
    await expect(aiOAuthStatus(env)).resolves.toEqual({ connected: false });
  });

  it("requeues unfinished report and release jobs after a successful reconnect", async () => {
    const started = await beginAiOAuth(env);
    expect(started.authorizationUrl).toContain("auth.openai.com");
    await env.DB.prepare(
      `INSERT INTO discord_submissions(
        thread_id,forum_id,guild_id,kind,title,created_at,updated_at
      ) VALUES('thread','forum','guild','bug_report','Broken preview',datetime('now'),datetime('now'))`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO discord_report_jobs(thread_id,status,attempts,last_error)
       VALUES('thread','failed',10,'Report analysis exceeded its retry budget.')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO release_jobs(
        repository,release_id,tag_name,release_name,release_url,target_commitish,
        published_at,payload_json,status,attempts,last_error
      ) VALUES(
        'SakuraCordApp/SakuraCord',10,'v1.2.0','SakuraCord 1.2',
        'https://github.com/SakuraCordApp/SakuraCord/releases/tag/v1.2.0','main',
        '2026-07-24T12:00:00Z','{}','failed',10,'ChatGPT authorization was rejected.'
      )`,
    ).run();

    await finishAiOAuth(env, "authorization-code", "oauth-state");

    await expect(
      env.DB.prepare(
        "SELECT status,attempts,locked_at,last_error FROM discord_report_jobs WHERE thread_id='thread'",
      ).first(),
    ).resolves.toEqual({ status: "pending", attempts: 0, locked_at: null, last_error: null });
    await expect(
      env.DB.prepare(
        "SELECT status,attempts,locked_at,last_error FROM release_jobs WHERE release_id=10",
      ).first(),
    ).resolves.toEqual({ status: "pending", attempts: 0, locked_at: null, last_error: null });
  });
});
