import { readFile } from "node:fs/promises";
import path from "node:path";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "./env.js";
import { createApp } from "./app.js";
import { bytesToBase64Url } from "./crypto-store.js";

describe("public and maintainer API", () => {
  let miniflare: Miniflare;
  let env: Env;
  const app = createApp();
  const executionContext = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

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
      ASSETS: { fetch: async () => new Response("asset") } as Fetcher,
      ROADMAP_ADMIN_TOKEN: "test-maintainer-token-which-is-long-enough",
      ROADMAP_ALLOWED_ORIGINS: "https://roadmap.sakuracord.app",
      ROADMAP_GATEWAY_PROVIDER: "disabled",
      ROADMAP_OAUTH_ENCRYPTION_KEY: bytesToBase64Url(new Uint8Array(32).fill(7)),
    };
  });

  afterEach(async () => miniflare.dispose());

  it("creates, replays, lists, updates, conflicts, and exposes audit history", async () => {
    const createBody = {
      title: "Full polls support",
      description: "Implement native polls end to end.",
      type: "feature",
      area: "chat",
      status: "planned",
      priority: "critical",
    };
    const created = await call("/api/v1/items", {
      method: "POST",
      headers: mutationHeaders("api-create-polls"),
      body: JSON.stringify(createBody),
    });
    expect(created.status).toBe(201);
    const createdPayload = await created.json<any>();
    const id = createdPayload.data.after.id as string;
    expect(createdPayload.data.diff.length).toBeGreaterThan(0);

    const replay = await call("/api/v1/items", {
      method: "POST",
      headers: mutationHeaders("api-create-polls"),
      body: JSON.stringify(createBody),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json<any>()).data.replayed).toBe(true);

    const listed = await call("/api/v1/items?status=planned&search=polls");
    expect(listed.status).toBe(200);
    expect((await listed.json<any>()).data).toHaveLength(1);

    const updated = await call(`/api/v1/items/${id}`, {
      method: "PATCH",
      headers: mutationHeaders("api-update-polls"),
      body: JSON.stringify({
        expectedRevision: 1,
        patch: { description: "Implement complete native polls support end to end." },
      }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json<any>()).data.after.revision).toBe(2);

    const stale = await call(`/api/v1/items/${id}`, {
      method: "PATCH",
      headers: mutationHeaders("api-stale-polls"),
      body: JSON.stringify({ expectedRevision: 1, patch: { title: "Stale" } }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json<any>()).error.code).toBe("REVISION_CONFLICT");

    const history = await call(`/api/v1/items/${id}/history`);
    expect((await history.json<any>()).data).toHaveLength(2);
  });

  it("requires bearer auth, idempotency keys, and an allowed mutation origin", async () => {
    const body = JSON.stringify({
      title: "Protected",
      description: "Mutation security contract.",
      type: "feature",
      area: "platform",
      status: "planned",
      priority: "medium",
    });
    const noAuth = await call("/api/v1/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(noAuth.status).toBe(403);

    const noKey = await call("/api/v1/items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.ROADMAP_ADMIN_TOKEN}`,
      },
      body,
    });
    expect(noKey.status).toBe(400);

    const badOrigin = await call("/api/v1/items", {
      method: "POST",
      headers: {
        ...mutationHeaders("api-bad-origin"),
        Origin: "https://evil.example",
      },
      body,
    });
    expect(badOrigin.status).toBe(403);
  });

  it("starts ChatGPT OAuth with the registered loopback callback and protects completion", async () => {
    const started = await call("/api/v1/ai/oauth/start", {
      method: "POST",
      headers: mutationHeaders("api-start-oauth"),
      body: "{}",
    });
    expect(started.status).toBe(201);
    const authorizationUrl = new URL((await started.json<any>()).data.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://auth.openai.com");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "http://localhost:1455/auth/callback",
    );

    const unauthedCompletion = await call("/api/v1/ai/oauth/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "secret", state: "secret" }),
    });
    expect(unauthedCompletion.status).toBe(403);
  });

  it("clones immutable asset headers before security middleware modifies them", async () => {
    env.ASSETS = {
      fetch: async () => Response.redirect("https://roadmap.sakuracord.app/", 302),
    } as Fetcher;

    const response = await call("/favicon.ico");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://roadmap.sakuracord.app/");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("bounds JSON bodies, validates queries, and honors conditional reads", async () => {
    const oversized = await call("/api/v1/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `"${"x".repeat(1_048_576)}"`,
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json<any>()).resolves.toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });

    const invalidLimit = await call("/api/v1/items?limit=not-a-number");
    expect(invalidLimit.status).toBe(422);

    const initial = await call("/api/v1/items");
    const etag = initial.headers.get("ETag");
    expect(etag).toBeTruthy();
    const unchanged = await call("/api/v1/items", {
      headers: { "If-None-Match": etag! },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
  });

  function mutationHeaders(idempotencyKey: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.ROADMAP_ADMIN_TOKEN}`,
      "Idempotency-Key": idempotencyKey,
      Origin: "https://roadmap.sakuracord.app",
    };
  }

  function call(pathname: string, init?: RequestInit): Promise<Response> {
    return app.fetch(
      new Request(`https://roadmap.sakuracord.app${pathname}`, init),
      env,
      executionContext,
    );
  }
});
