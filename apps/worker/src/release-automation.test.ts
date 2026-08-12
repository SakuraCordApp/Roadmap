import { readFile } from "node:fs/promises";
import path from "node:path";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import roadmapConfig from "../../../roadmap.config.js";
import type { Env } from "./env.js";
import { RELEASE_AUTOMATION_RETIRED_MESSAGE } from "./job-recovery.js";
import { acceptGithubReleaseWebhook, processPendingReleaseJobs } from "./release-automation.js";

describe("retired release automation", () => {
  let miniflare: Miniflare;
  let env: Env;

  beforeEach(async () => {
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
      "0005_report_job_recovery.sql",
      "0006_streamline_roadmap_items.sql",
      "0007_recover_automation_jobs.sql",
      "0008_version_roadmap.sql",
      "0009_recover_ai_report_jobs.sql",
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
    };
  });

  afterEach(async () => miniflare.dispose());

  it("acknowledges every signed release without enqueueing it", async () => {
    for (const releaseBody of [undefined, "## Changes", "<!-- sakuracord-release-action:v1 -->"]) {
      const body = JSON.stringify({
        action: "published",
        release: {
          id: 10,
          tag_name: "v1.2.0",
          name: "SakuraCord 1.2",
          ...(releaseBody === undefined ? {} : { body: releaseBody }),
          html_url: "https://github.com/SakuraCordApp/SakuraCord/releases/tag/v1.2.0",
          target_commitish: "main",
          published_at: "2026-07-24T12:00:00Z",
          draft: false,
        },
        repository: { full_name: "SakuraCordApp/SakuraCord" },
      });

      await expect(
        acceptGithubReleaseWebhook(await signedWebhook(body), env, roadmapConfig),
      ).resolves.toEqual({ accepted: false, reason: "github_actions_owned" });
    }
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM release_jobs").first(),
    ).resolves.toMatchObject({ count: 0 });
  });

  it("terminally retires legacy unfinished jobs without publishing anything", async () => {
    await env.DB.prepare(
      `INSERT INTO release_jobs(
        repository,release_id,tag_name,release_name,release_url,target_commitish,
        published_at,payload_json,status,attempts,last_error
      ) VALUES(
        'SakuraCordApp/SakuraCord',10,'v1.2.0','SakuraCord 1.2',
        'https://github.com/SakuraCordApp/SakuraCord/releases/tag/v1.2.0','main',
        '2026-07-24T12:00:00Z','{}','failed',9,'Discord rejected the message.'
      )`,
    ).run();

    await expect(processPendingReleaseJobs(env, roadmapConfig, 1)).resolves.toEqual({
      processed: 0,
      failed: 0,
    });
    await expect(
      env.DB.prepare(
        "SELECT status,attempts,locked_at,completed_at,last_error FROM release_jobs WHERE release_id=10",
      ).first(),
    ).resolves.toMatchObject({
      status: "complete",
      attempts: 10,
      locked_at: null,
      last_error: RELEASE_AUTOMATION_RETIRED_MESSAGE,
    });
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
