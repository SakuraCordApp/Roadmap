import { Hono } from "hono";
import { z } from "zod";
import { ISSUE_TYPES } from "../config";
import {
  addEvent,
  addSubscriber,
  getIssue,
  getState,
  listIssues,
  patchIssue,
  saveIssue,
  saveThread,
  setState,
  setThreadCursor,
} from "../db/store";
import type { Env } from "../env";
import { GitHub } from "../github/client";
import type { GhIssue, GhMilestone } from "../github/types";
import { enqueue, jobStats, type JobKind } from "../jobs/queue";
import { setupDiscord, checkBotPermissions } from "../setup/discord";
import { discordClient } from "../discord/threads";
import { setupGithub } from "../setup/github";
import { recordFromGithub } from "../sync/issue";
import { constantTimeEqual } from "../util/crypto";
import { HttpError } from "../util/http";
import { nowIso } from "../util/text";

export const admin = new Hono<{ Bindings: Env }>();

admin.use("*", async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (
    !token ||
    !c.env.ROADMAP_ADMIN_TOKEN ||
    !(await constantTimeEqual(token, c.env.ROADMAP_ADMIN_TOKEN))
  ) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

admin.get("/status", async (c) => {
  const issues = await listIssues(c.env.DB);
  return c.json({
    configured: {
      githubApp: Boolean(c.env.GITHUB_APP_ID && c.env.GITHUB_APP_PRIVATE_KEY),
      githubWebhook: Boolean(c.env.GITHUB_APP_WEBHOOK_SECRET),
      openai: Boolean(c.env.OPENAI_API_KEY),
      discord: Boolean(c.env.DISCORD_BOT_TOKEN),
    },
    issues: issues.length,
    jobs: await jobStats(c.env),
    reconciledAt: await getState(c.env.DB, "github:reconciled-at"),
  });
});

admin.get("/discord/permissions", async (c) => c.json(await checkBotPermissions(c.env)));
admin.post("/setup/github", async (c) => c.json(await setupGithub(c.env)));
admin.post("/setup/discord", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    emojis?: Record<string, string>;
    replaceEmojis?: string[];
  };
  return c.json(await setupDiscord(c.env, body));
});

admin.post("/discord/users", async (c) => {
  const { ids } = z
    .object({ ids: z.array(z.string().regex(/^\d{17,20}$/)).max(40) })
    .parse(await c.req.json());
  const discord = discordClient(c.env);
  const users: Record<string, { name: string; username: string } | null> = {};
  for (const id of ids) {
    const user = await discord
      .get<{ username: string; global_name?: string | null }>(`/users/${id}`)
      .catch(() => null);
    users[id] = user ? { name: user.global_name || user.username, username: user.username } : null;
  }
  return c.json(users);
});

admin.post("/state", async (c) => {
  const { key, value } = z
    .object({ key: z.string().min(1), value: z.string() })
    .parse(await c.req.json());
  await setState(c.env.DB, key, value);
  return c.json({ ok: true });
});

admin.post("/jobs", async (c) => {
  const body = z
    .object({
      kind: z.string(),
      key: z.string(),
      payload: z.record(z.string(), z.unknown()).default({}),
    })
    .parse(await c.req.json());
  await enqueue(c.env, body.kind as JobKind, body.key, body.payload);
  return c.json({ queued: true });
});

admin.post("/reconcile", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { full?: boolean };
  await enqueue(c.env, "reconcile", body.full ? "full" : "incremental", {
    full: Boolean(body.full),
  });
  return c.json({ queued: true });
});

admin.post("/reindex", async (c) => {
  const issues = await listIssues(c.env.DB);
  for (const issue of issues) {
    await patchIssue(c.env.DB, issue.number, { embeddedHash: null });
    await enqueue(c.env, "embed", String(issue.number), { number: issue.number });
  }
  return c.json({ queued: issues.length });
});

admin.post("/retriage/:number", async (c) => {
  const number = Number(c.req.param("number"));
  await patchIssue(c.env.DB, number, { triagedAt: null });
  await enqueue(c.env, "triage", String(number), { number });
  return c.json({ queued: true });
});

// ---------------------------------------------------------------------------
// Migration from the legacy D1 tracker. Every endpoint is idempotent.

const MilestoneInput = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  state: z.enum(["open", "closed"]),
  dueOn: z.string().nullable().optional(),
});

admin.post("/migrate/milestone", async (c) => {
  const input = MilestoneInput.parse(await c.req.json());
  const github = new GitHub(c.env);
  const milestones = await github.list<GhMilestone>(github.repo("/milestones?state=all"));
  const existing = milestones.find((milestone) => milestone.title === input.title);
  const body = {
    title: input.title,
    description: input.description,
    state: input.state,
    ...(input.dueOn ? { due_on: input.dueOn } : {}),
  };
  const milestone = existing
    ? await github.request<GhMilestone>(
        "PATCH",
        github.repo(`/milestones/${existing.number}`),
        body,
      )
    : await github.request<GhMilestone>("POST", github.repo("/milestones"), body);
  return c.json({ number: milestone.number, created: !existing });
});

const IssueInput = z.object({
  legacyId: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  kind: z.enum(["bug", "feature"]),
  title: z.string().min(1).max(256),
  body: z.string().max(65_000),
  labels: z.array(z.string()),
  state: z.enum(["open", "closed"]),
  stateReason: z.enum(["completed", "not_planned"]).optional(),
  milestone: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  reporter: z
    .object({
      source: z.enum(["discord", "website", "github", "legacy"]),
      name: z.string(),
      discordId: z.string().optional(),
      githubLogin: z.string().optional(),
    })
    .nullable()
    .optional(),
  createdAt: z.string(),
  shippedIn: z.string().nullable().optional(),
  threads: z
    .array(
      z.object({
        threadId: z.string(),
        forumId: z.string(),
        role: z.enum(["primary", "merged"]),
        lastMessageId: z.string().nullable().optional(),
      }),
    )
    .default([]),
  subscribers: z
    .array(z.object({ userId: z.string(), kind: z.enum(["reporter", "vote"]) }))
    .default([]),
});

admin.post("/migrate/issue", async (c) => {
  const input = IssueInput.parse(await c.req.json());
  const db = c.env.DB;
  const known = await db
    .prepare("SELECT issue_number FROM legacy_ids WHERE legacy_id=?")
    .bind(input.legacyId)
    .first<{ issue_number: number }>();
  if (known) return c.json({ number: known.issue_number, existing: true });

  const github = new GitHub(c.env);
  let milestoneNumber: number | undefined;
  if (input.milestone) {
    const milestones = await github.list<GhMilestone>(github.repo("/milestones?state=all"));
    milestoneNumber = milestones.find((milestone) => milestone.title === input.milestone)?.number;
  }
  let issue = await github.request<GhIssue>("POST", github.repo("/issues"), {
    title: input.title,
    body: input.body,
    labels: input.labels,
    type: ISSUE_TYPES[input.kind].githubType,
    ...(milestoneNumber ? { milestone: milestoneNumber } : {}),
  });
  const ids = [input.legacyId, ...input.aliases];
  await db.batch(
    ids.map((id) =>
      db
        .prepare("INSERT OR IGNORE INTO legacy_ids(legacy_id,issue_number) VALUES(?,?)")
        .bind(id, issue.number),
    ),
  );
  if (input.state === "closed") {
    issue = await github.request<GhIssue>("PATCH", github.repo(`/issues/${issue.number}`), {
      state: "closed",
      state_reason: input.stateReason ?? "completed",
    });
  }
  for (const thread of input.threads) {
    await saveThread(db, {
      threadId: thread.threadId,
      issueNumber: issue.number,
      forumId: thread.forumId,
      role: thread.role,
      cardMessageId: null,
      cardHash: null,
      stateHash: null,
      createdAt: nowIso(),
    });
    await setThreadCursor(db, thread.threadId, thread.lastMessageId ?? thread.threadId);
  }
  for (const subscriber of input.subscribers) {
    await addSubscriber(db, issue.number, subscriber.userId, subscriber.kind);
  }
  const record = recordFromGithub(issue, null);
  record.kind = input.kind;
  record.reporter = input.reporter ?? null;
  record.summary = input.summary ?? null;
  record.shippedIn = input.shippedIn ?? null;
  record.triagedAt = nowIso();
  await saveIssue(db, record);
  await addEvent(
    db,
    issue.number,
    "created",
    { status: record.status, migrated: true },
    null,
    input.createdAt,
  );
  await enqueue(c.env, "sync-issue", String(issue.number), { number: issue.number });
  return c.json({ number: issue.number, existing: false });
});

admin.post("/migrate/adopt/:number", async (c) => {
  const number = Number(c.req.param("number"));
  await enqueue(c.env, "sync-issue", String(number), { number });
  return c.json({ queued: true, known: Boolean(await getIssue(c.env.DB, number)) });
});

/** Remove a verification issue's Discord posts and hub records (the GitHub issue is deleted separately). */
admin.post("/test/remove/:number", async (c) => {
  const number = Number(c.req.param("number"));
  const discord = discordClient(c.env);
  const { results } = await c.env.DB.prepare("SELECT thread_id FROM threads WHERE issue_number=?")
    .bind(number)
    .all<{ thread_id: string }>();
  for (const row of results)
    await discord.delete(`/channels/${row.thread_id}`).catch(() => undefined);
  await c.env.DB.batch(
    [
      "issues WHERE number",
      "threads WHERE issue_number",
      "subscribers WHERE issue_number",
      "events WHERE issue_number",
      "comment_links WHERE issue_number",
    ].map((target) => c.env.DB.prepare(`DELETE FROM ${target}=?`).bind(number)),
  );
  await c.env.VECTORIZE.deleteByIds([String(number)]).catch(() => undefined);
  return c.json({ removed: true, threads: results.length });
});

admin.onError((error, c) => {
  const status = error instanceof HttpError ? error.status : 500;
  return c.json({ error: error.message }, status as 500);
});
