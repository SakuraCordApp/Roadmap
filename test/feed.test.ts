import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sqlite, db } from "./d1";
import { ensureSchema } from "../src/db/schema";
import { Discord } from "../src/discord/rest";
import type { Env } from "../src/env";
import { deliverFeed } from "../src/github/feed";
import { FALLBACK_EMOJI } from "../src/github/feed-emoji";
import { handleGithubWebhook } from "../src/github/webhook";
import { hmacSha256Hex } from "../src/util/crypto";

vi.mock("../src/github/identity", () => ({ appBotLogin: async () => "hub[bot]" }));
const env = {
  DB: db,
  JOBS: { sendBatch: vi.fn() },
  GITHUB_APP_WEBHOOK_SECRET: "test-secret",
  DISCORD_APPLICATION_ID: "app",
} as unknown as Env;
const discord = vi.spyOn(Discord.prototype, "request");
const repository = {
  full_name: "SakuraCordApp/SakuraCord",
  html_url: "https://github.com/SakuraCordApp/SakuraCord",
};
const human = { login: "super", type: "User", avatar_url: "https://avatars/super" };
const bot = { login: "github-actions[bot]", type: "Bot" };
let delivery = 0;

async function send(event: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ repository, sender: human, ...payload });
  const response = await handleGithubWebhook(
    new Request("https://hub/webhooks/github-app", {
      method: "POST",
      body,
      headers: {
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": `d${++delivery}`,
        "X-Hub-Signature-256": `sha256=${await hmacSha256Hex("test-secret", body)}`,
      },
    }),
    env,
  );
  expect(response.status).toBe(202);
}

/** Run pending feed jobs the way the queue consumer would. */
async function flush() {
  const jobs = sqlite
    .prepare("SELECT id,payload_json FROM jobs WHERE kind='feed' AND status='pending'")
    .all() as Array<{ id: number; payload_json: string }>;
  for (const job of jobs) {
    sqlite.prepare("UPDATE jobs SET status='done' WHERE id=?").run(job.id);
    await deliverFeed(env, JSON.parse(job.payload_json));
  }
}

const calls = (method: string) =>
  discord.mock.calls.filter(([m]) => m === method).map(([, , options]) => (options as any).body);

const run = (overrides: Record<string, unknown> = {}) => ({
  id: 900,
  name: "CI",
  event: "push",
  head_branch: "main",
  head_sha: "abc1234def",
  run_attempt: 1,
  status: "in_progress",
  conclusion: null,
  html_url: "https://github.com/SakuraCordApp/SakuraCord/actions/runs/900",
  run_started_at: "2026-10-14T10:00:00Z",
  updated_at: "2026-10-14T10:00:00Z",
  display_title: "Fix Force Click lookup",
  pull_requests: [],
  triggering_actor: human,
  ...overrides,
});

const job = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  run_id: 900,
  run_attempt: 1,
  name: "build (app)",
  status: "queued",
  conclusion: null,
  started_at: "2026-10-14T10:00:05Z",
  completed_at: null,
  html_url: "https://github.com/x",
  steps: [],
  ...overrides,
});

beforeAll(async () => {
  await ensureSchema(db);
});
afterAll(() => {
  vi.restoreAllMocks();
  sqlite.close();
});
beforeEach(() => {
  sqlite.exec(`DELETE FROM jobs; DELETE FROM kv; DELETE FROM webhook_deliveries;
    DELETE FROM feed_cards; DELETE FROM feed_items;`);
  sqlite
    .prepare("INSERT INTO kv(key,value,updated_at) VALUES(?,?,?)")
    .run("discord:feed-emoji:v1", JSON.stringify(FALLBACK_EMOJI), "now");
  vi.clearAllMocks();
  discord.mockResolvedValue({ id: "message" });
});

describe("GitHub updates feed", () => {
  it("posts one pinged card for a push that reached several branches", async () => {
    const commits = [
      {
        id: "1111111aaa",
        message: "Preserve icon transparency\n\nbody",
        author: { username: "super" },
      },
      { id: "abc1234def", message: "Fix Force Click lookup (#301)", author: { username: "kai" } },
    ];
    for (const ref of ["refs/heads/main", "refs/heads/nightly"])
      await send("push", { ref, after: "abc1234def", commits, compare: "https://github.com/c" });
    await send("push", { ref: "refs/heads/main", after: "zzz", commits, sender: bot });
    await flush();

    const posts = calls("POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].content).toBe("<@&1530350339549560985>");
    expect(posts[0].embeds[0].title).toBe("Pushed 2 commits to main, nightly");
    const lines = posts[0].embeds[0].description.split("\n");
    expect(lines[0]).toContain("Fix Force Click lookup ([#301]");
    expect(lines[0]).toContain("— kai");
    expect(lines[1]).not.toContain("—");
  });

  it("titles a merge push after its pull request", async () => {
    await send("push", {
      ref: "refs/heads/nightly",
      after: "m",
      commits: [
        { id: "c1", message: "Add thing" },
        { id: "m", message: "Merge pull request #308 from a/b\n\nImplement suggestion" },
      ],
    });
    await flush();
    const embed = calls("POST")[0].embeds[0];
    expect(embed.title).toBe("Merged #308 into nightly");
    expect(embed.description).toContain("**Implement suggestion**");
    expect(embed.description).not.toContain("Merge pull request");
  });

  it("keeps one live checks card per commit and pings only when it first posts", async () => {
    await send("workflow_run", { action: "requested", workflow_run: run({ status: "queued" }) });
    await send("workflow_job", { action: "queued", workflow_job: job() });
    await flush();
    expect(calls("POST")).toHaveLength(0);

    await send("workflow_job", {
      action: "in_progress",
      workflow_job: job({ status: "in_progress" }),
    });
    await send("workflow_job", {
      action: "completed",
      workflow_job: job({ id: 2, name: "package", status: "completed", conclusion: "skipped" }),
    });
    // The same workflow on nightly joins the card for this commit.
    await send("workflow_run", {
      action: "requested",
      workflow_run: run({ id: 901, head_branch: "nightly", status: "queued" }),
    });
    await flush();
    const [created] = calls("POST");
    expect(calls("POST")).toHaveLength(1);
    expect(created.content).toBe("<@&1530350339549560985>");
    expect(created.embeds[0].description).toContain("🟡 **Running** · 1/2 jobs · started <t:");
    expect(created.embeds[0].description).toContain("🟡 build (app) · started <t:");
    expect(created.embeds[0].description).toContain("⚪ package · skipped");

    await send("workflow_job", {
      action: "completed",
      workflow_job: job({
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-10-14T10:02:10Z",
        steps: [
          { name: "Build", conclusion: "success" },
          { name: "Run tests", conclusion: "failure" },
        ],
      }),
    });
    // A late in_progress delivery must not undo the completion.
    await send("workflow_job", {
      action: "in_progress",
      workflow_job: job({ status: "in_progress" }),
    });
    await send("workflow_run", {
      action: "completed",
      workflow_run: run({
        status: "completed",
        conclusion: "failure",
        updated_at: "2026-10-14T10:02:12Z",
      }),
    });
    await send("workflow_run", {
      action: "completed",
      workflow_run: run({
        id: 901,
        head_branch: "nightly",
        status: "completed",
        conclusion: "skipped",
      }),
    });
    await flush();
    expect(calls("POST")).toHaveLength(1);
    const [edited] = calls("PATCH");
    expect(edited.content).toBeUndefined();
    expect(edited.allowed_mentions).toEqual({ parse: [] });
    expect(edited.embeds[0].description).toContain("❌ **Failed** · 1 job failed · 2m 12s");
    expect(edited.embeds[0].description).toContain(
      "❌ build (app) · failed at **Run tests** · 2m 5s",
    );
  });

  it("never posts checks for workflows that only skipped or belong to agents", async () => {
    await send("workflow_run", {
      action: "completed",
      workflow_run: run({ status: "completed", conclusion: "skipped" }),
    });
    await send("workflow_job", {
      action: "completed",
      workflow_job: job({ status: "completed", conclusion: "skipped" }),
    });
    await send("workflow_run", {
      action: "in_progress",
      workflow_run: run({ id: 950, event: "issues", name: "Agent · Triage · #51" }),
    });
    await send("workflow_job", {
      action: "in_progress",
      workflow_job: job({ id: 5, run_id: 950, status: "in_progress" }),
    });
    await flush();
    expect(discord).not.toHaveBeenCalled();
  });

  it("announces a pull request once and edits it when it merges", async () => {
    const pull = {
      number: 312,
      title: "Fix duplicate timeline",
      html_url: "https://github.com/SakuraCordApp/SakuraCord/pull/312",
      state: "open",
      draft: false,
      head: { ref: "fix/timeline" },
      base: { ref: "nightly" },
      commits: 3,
      additions: 120,
      deletions: 34,
      changed_files: 6,
      body: "Fixes #301\n\n<!-- template -->\nDeduplicates rows.",
      user: human,
      created_at: "2026-10-14T09:00:00Z",
      updated_at: "2026-10-14T09:00:00Z",
    };
    await send("pull_request", { action: "opened", pull_request: pull });
    await flush();
    await send("pull_request", {
      action: "closed",
      pull_request: {
        ...pull,
        state: "closed",
        merged: true,
        merged_by: human,
        updated_at: "2026-10-14T11:00:00Z",
      },
    });
    await flush();
    const [post] = calls("POST");
    expect(calls("POST")).toHaveLength(1);
    expect(post.content).toBe("<@&1530350339549560985>");
    expect(post.embeds[0].description).toContain("**Open** · `fix/timeline` → `nightly`");
    expect(post.embeds[0].description).toContain("-# 3 commits · 6 files · +120 −34");
    expect(post.embeds[0].description).not.toContain("template");
    expect(calls("PATCH")[0].embeds[0].description).toContain("**Merged** by super");
  });

  it("does not announce bot pull requests", async () => {
    await send("pull_request", {
      action: "opened",
      sender: bot,
      pull_request: {
        number: 7,
        title: "Agent fix",
        state: "open",
        user: bot,
        updated_at: "2026-10-14T09:00:00Z",
      },
    });
    await flush();
    expect(discord).not.toHaveBeenCalled();
  });

  it("pings human comments, ignores bot comments, and posts issue changes silently", async () => {
    const issue = {
      number: 51,
      title: "Crash",
      html_url: "https://github.com/i/51",
      body: "Steps",
    };
    await send("issue_comment", {
      action: "created",
      issue,
      comment: { body: "Looks good", user: human, html_url: "https://github.com/c/1" },
    });
    await send("issue_comment", {
      action: "created",
      sender: bot,
      issue,
      comment: { body: "Assessment", user: bot, html_url: "https://github.com/c/2" },
    });
    await send("issues", { action: "opened", issue });
    await flush();
    const posts = calls("POST");
    expect(posts).toHaveLength(2);
    expect(posts[0].content).toBe("<@&1530350339549560985>");
    expect(posts[0].embeds[0].title).toBe("Comment on issue #51 · Crash");
    expect(posts[0].embeds[0].description).toBe("Looks good");
    expect(posts[1].content).toBeUndefined();
    expect(posts[1].flags).toBe(4096);
  });
});
