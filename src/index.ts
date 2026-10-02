import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { admin } from "./api/admin";
import { attachmentRedirect } from "./api/attachments";
import { cachedJson, issueDetail, publicMeta, roadmapData, trackerSnapshot } from "./api/public";
import { ensureSchema } from "./db/schema";
import { getState, setState } from "./db/store";
import { handleInteraction } from "./discord/interactions";
import type { Env } from "./env";
import { deliverFeed } from "./github/feed";
import { handleGithubWebhook } from "./github/webhook";
import {
  cleanupJobs,
  enqueue,
  runJob,
  wakeDueJobs,
  type JobHandler,
  type JobKind,
  type JobMessage,
} from "./jobs/queue";
import { publishRoadmap } from "./roadmap";
import { rpc } from "./rpc";
import {
  handleRelease,
  reconcile,
  shipIssue,
  syncMilestones,
  syncPull,
  syncPush,
} from "./sync/activity";
import { pollDiscordThreads, syncDiscordThread, syncGithubComment } from "./sync/comments";
import { embedIssue, syncIssue } from "./sync/issue";
import { runTriage } from "./sync/triage";
import { errorMessage, HttpError } from "./util/http";

const handlers: Record<JobKind, JobHandler> = {
  "sync-issue": syncIssue,
  triage: runTriage,
  embed: embedIssue,
  comment: syncGithubComment,
  "discord-thread": syncDiscordThread,
  pull: syncPull,
  push: syncPush,
  release: handleRelease,
  ship: shipIssue,
  milestones: (env) => syncMilestones(env),
  roadmap: publishRoadmap,
  feed: deliverFeed,
  reconcile,
};

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

// Legacy subdomains redirect to the website.
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname === "tracker.sakuracord.app") {
    return c.redirect(`${c.env.WEBSITE_URL}/tracker${url.search}`, 301);
  }
  await next();
});

app.get("/", (c) => c.redirect(`${c.env.WEBSITE_URL}/roadmap`, 301));
app.get("/healthz", (c) => c.json({ ok: true, service: "sakuracord-hub" }));
app.get("/tracker", (c) => c.redirect(`${c.env.WEBSITE_URL}/tracker`, 301));
app.get("/items/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT issue_number FROM legacy_ids WHERE legacy_id=?")
    .bind(id)
    .first<{ issue_number: number }>();
  return c.redirect(
    `${c.env.WEBSITE_URL}/tracker/items/${row?.issue_number ?? encodeURIComponent(id)}`,
    301,
  );
});

app.use("/api/*", async (c, next) => {
  const outcome = await c.env.PUBLIC_RATE_LIMITER.limit({
    key: c.req.header("CF-Connecting-IP") ?? "internal",
  });
  if (!outcome.success) return c.json({ error: "Too many requests" }, 429);
  await next();
});

app.get("/api/v2/config", (c) => c.json(publicMeta()));
app.get("/api/v2/tracker", async (c) => {
  const snapshot = await trackerSnapshot(c.env);
  return cachedJson(c.req.raw, snapshot, snapshot.etag);
});
app.get("/api/v2/issues/:number", async (c) => {
  const detail = await issueDetail(c.env, Number(c.req.param("number")));
  return detail ? cachedJson(c.req.raw, detail) : c.json({ error: "Not found" }, 404);
});
app.get("/api/v2/roadmap", async (c) => cachedJson(c.req.raw, await roadmapData(c.env)));
app.get("/api/v2/legacy/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT issue_number FROM legacy_ids WHERE legacy_id=?")
    .bind(c.req.param("id"))
    .first<{ issue_number: number }>();
  return row ? c.json({ number: row.issue_number }) : c.json({ error: "Not found" }, 404);
});

app.get("/attachments/:channel/:message/:attachment/:filename", (c) =>
  attachmentRedirect(
    c.env,
    c.req.param("channel"),
    c.req.param("message"),
    c.req.param("attachment"),
  ),
);

app.post("/interactions/discord", (c) =>
  handleInteraction(c.req.raw, c.env, c.executionCtx as ExecutionContext),
);
app.post("/webhooks/github-app", (c) => handleGithubWebhook(c.req.raw, c.env));
app.post("/webhooks/github", (c) =>
  c.json({ error: "Retired. Use the SakuraCord GitHub App." }, 410),
);

app.route("/admin", admin);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  console.error("Request failed", errorMessage(error));
  const status = error instanceof HttpError ? error.status : 500;
  return c.json({ error: status === 500 ? "Internal error" : error.message }, status as 500);
});

export default class Hub extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  override async scheduled(controller: ScheduledController): Promise<void> {
    const env = this.env;
    await ensureSchema(env.DB);
    const minute = new Date(controller.scheduledTime).getUTCMinutes();
    const step = async (name: string, task: () => Promise<unknown>) => {
      try {
        await task();
      } catch (error) {
        console.error(`${name} failed`, errorMessage(error));
      }
    };
    await step("wake jobs", () => wakeDueJobs(env));
    if (env.DISCORD_BOT_TOKEN) await step("poll Discord", () => pollDiscordThreads(env));
    if (minute % 10 === 0 && env.GITHUB_APP_ID) {
      await step("reconcile", () => enqueue(env, "reconcile", "incremental", {}));
    }
    if (minute === 7) {
      await step("cleanup", () => cleanupJobs(env));
      const lastRoadmap = await getState(env.DB, "discord:roadmap-checked");
      if (lastRoadmap !== new Date().toISOString().slice(0, 13)) {
        await setState(env.DB, "discord:roadmap-checked", new Date().toISOString().slice(0, 13));
        await step("roadmap", () => enqueue(env, "roadmap", "publish", {}));
      }
    }
  }

  override async queue(batch: MessageBatch<JobMessage>): Promise<void> {
    await ensureSchema(this.env.DB);
    for (const message of batch.messages) {
      await runJob(this.env, message.body.id, handlers);
      message.ack();
    }
  }

  // RPC for the website (service binding only).
  reportForm() {
    return rpc.reportForm(this.env);
  }
  similar(input: unknown) {
    return rpc.similar(this.env, input);
  }
  submit(input: unknown) {
    return rpc.submit(this.env, input);
  }
  meToo(input: unknown) {
    return rpc.meToo(this.env, input);
  }
  comment(input: unknown) {
    return rpc.comment(this.env, input);
  }
  addDetails(input: unknown) {
    return rpc.addDetails(this.env, input);
  }
}
