import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sqlite, db } from "./d1";
import { ensureSchema } from "../src/db/schema";
import { Discord, DiscordError } from "../src/discord/rest";
import type { Env } from "../src/env";
import { identifyAgentRun, type WorkflowRun } from "../src/github/agent-runs";
import { GitHub } from "../src/github/client";
import { handleGithubWebhook } from "../src/github/webhook";
import { hmacSha256Hex } from "../src/util/crypto";
import { pollAgentRuns, syncAgentStatus, trackAgentRun } from "../src/sync/agents";
import { syncGithubComment } from "../src/sync/comments";

vi.mock("../src/github/identity", () => ({ appBotLogin: async () => "hub[bot]" }));
const env = {
  DB: db,
  JOBS: { sendBatch: vi.fn() },
  GITHUB_APP_WEBHOOK_SECRET: "test-secret",
} as unknown as Env;
const payload = { number: 51, kind: "investigate" as const };
const identity = { ...payload, runId: 100, attempt: 1 };
let run: WorkflowRun;
let step: string;
let comment: any;
const github = vi.spyOn(GitHub.prototype, "request");
const discord = vi.spyOn(Discord.prototype, "request");
const row = () => sqlite.prepare("SELECT * FROM agent_runs WHERE issue_number=51").get()!;

beforeAll(async () => {
  await ensureSchema(db);
});
afterAll(() => {
  vi.restoreAllMocks();
  sqlite.close();
});
beforeEach(() => {
  sqlite.exec(`DELETE FROM agent_runs; DELETE FROM jobs; DELETE FROM kv;
    DELETE FROM issues; DELETE FROM threads; DELETE FROM comment_links; DELETE FROM events; DELETE FROM webhook_deliveries;
    INSERT INTO issues(number,title,state,status,created_at,updated_at,synced_at)
      VALUES(51,'Report','open','new','2026-10-03','2026-10-03','2026-10-03');
    INSERT INTO threads(thread_id,issue_number,forum_id,role,created_at)
      VALUES('thread',51,'forum','primary','2026-10-03');`);
  vi.clearAllMocks();
  run = {
    id: 100,
    run_attempt: 1,
    path: ".github/workflows/agent-investigate.yml",
    event: "issues",
    display_title: "Agent · Triage · #51",
    status: "queued",
    conclusion: null,
    run_started_at: "2026-10-03T12:00:00Z",
  };
  step = "Investigate with Codex";
  github.mockImplementation(async (_method, path) => {
    if (path.endsWith("/actions/runs/100")) return run;
    if (path.includes("/jobs?"))
      return {
        jobs:
          run.status === "queued"
            ? []
            : [
                {
                  status: run.status,
                  conclusion: run.conclusion,
                  steps: [{ name: step, status: run.status, conclusion: run.conclusion }],
                },
              ],
      };
    if (path.endsWith("/issues/comments/123")) return comment;
    if (path.includes("/pulls?"))
      return [
        {
          number: 99,
          html_url: "https://github.com/SakuraCordApp/SakuraCord/pull/99",
          updated_at: "2026-10-03T12:30:00Z",
        },
      ];
    throw new Error(`Unexpected GitHub request: ${path}`);
  });
  discord.mockResolvedValue({ id: "message" });
});

describe("agent progress delivery", () => {
  it("edits one card through progress and the final assessment, without mirroring another message", async () => {
    await trackAgentRun(env, identity);
    await syncAgentStatus(env, payload);
    run.status = "in_progress";
    await syncAgentStatus(env, payload);
    const edits = discord.mock.calls.length;
    await syncAgentStatus(env, payload);
    expect(discord).toHaveBeenCalledTimes(edits);
    comment = {
      id: 123,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: "<!-- sakuracord:investigation -->\n<!-- sakuracord:agent-run investigate 100 1 -->\n### Summary\nFound the cause.",
      html_url: "https://github.com/SakuraCordApp/SakuraCord/issues/51#issuecomment-123",
      created_at: "2026-10-03T12:01:00Z",
    };
    const body = JSON.stringify({
      action: "created",
      repository: { full_name: "SakuraCordApp/SakuraCord" },
      sender: comment.user,
      issue: { number: 51 },
      comment,
    });
    const response = await handleGithubWebhook(
      new Request("https://hub/webhooks/github-app", {
        method: "POST",
        body,
        headers: {
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "result",
          "X-Hub-Signature-256": `sha256=${await hmacSha256Hex("test-secret", body)}`,
        },
      }),
      env,
    );
    expect(response.status).toBe(202);
    expect(row().result_text).toContain("Found the cause.");
    await syncGithubComment(env, { number: 51, commentId: 123, action: "created" });
    run.status = "completed";
    run.conclusion = "success";
    await syncAgentStatus(env, payload);
    expect(discord.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    expect(discord.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(2);
    const card = discord.mock.calls.at(-1)![2]!.body as any;
    expect(card.components).toHaveLength(1);
    expect(card.components[0].type).toBe(17);
    expect(JSON.stringify(card)).toContain("Found the cause.");
    expect(card.allowed_mentions.parse).toEqual([]);
    expect(row().active).toBe(0);
    sqlite.exec("DELETE FROM jobs");
    await pollAgentRuns(env);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM jobs").get()!.n).toBe(0);
  });

  it("keeps newer attempts and their results when older webhooks and comments arrive", async () => {
    await trackAgentRun(env, identity, "Old result");
    await syncAgentStatus(env, payload);
    run.run_attempt = 2;
    await trackAgentRun(env, { ...identity, attempt: 2 });
    expect(row().result_text).toBeNull();
    await trackAgentRun(env, { ...identity, attempt: 2 }, "New result");
    await trackAgentRun(env, identity, "Late old result");
    await trackAgentRun(env, { ...identity, runId: 99, attempt: 9 });
    await syncAgentStatus(env, payload);
    expect(row()).toMatchObject({
      run_id: 100,
      attempt: 2,
      result_text: "New result",
      message_id: "message",
    });
    expect(discord.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
  });

  it("reports terminal failures and recovers a deleted status card on a rerun", async () => {
    await trackAgentRun(env, identity);
    await syncAgentStatus(env, payload);
    run.status = "completed";
    run.conclusion = "cancelled";
    await syncAgentStatus(env, payload);
    expect(JSON.stringify(discord.mock.calls.at(-1))).toContain("Cancelled");
    expect(row().active).toBe(0);
    run.run_attempt = 2;
    run.status = "in_progress";
    run.conclusion = null;
    await trackAgentRun(env, { ...identity, attempt: 2 });
    discord.mockRejectedValueOnce(new DiscordError(404, 10008, "Unknown Message"));
    await syncAgentStatus(env, payload);
    expect(discord.mock.calls.filter(([method]) => method === "POST")).toHaveLength(2);
    expect(row().active).toBe(1);
    run.status = "completed";
    run.conclusion = "timed_out";
    await syncAgentStatus(env, payload);
    expect(JSON.stringify(discord.mock.calls.at(-1))).toContain("Timed out");
  });

  it("links the fix PR and rejects unrelated or skipped workflow runs", async () => {
    expect(identifyAgentRun({ ...run, display_title: "Agent · Skipped" })).toBeNull();
    expect(identifyAgentRun({ ...run, path: ".github/workflows/ci.yml" })).toBeNull();
    run = {
      ...run,
      display_title: "Agent · Fix · #51",
      path: ".github/workflows/agent-fix.yml",
      status: "completed",
      conclusion: "success",
    };
    await trackAgentRun(env, { ...identity, kind: "fix" });
    await syncAgentStatus(env, { ...payload, kind: "fix" });
    expect(JSON.stringify(discord.mock.calls.at(-1))).toContain("PR #99");
    expect(row().active).toBe(0);
  });
});
