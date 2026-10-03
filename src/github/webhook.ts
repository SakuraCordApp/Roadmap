import { setState } from "../db/store";
import { FEED_REPOSITORIES, NIGHTLY_BRANCH, REPOSITORY_SLUG } from "../config";
import { claimDelivery, getIssue } from "../db/store";
import type { Env } from "../env";
import { enqueue } from "../jobs/queue";
import { constantTimeEqual, hmacSha256Hex } from "../util/crypto";
import { json } from "../util/http";
import { feedWorthy, renderFeed } from "./feed";
import { commentAgentRun, identifyAgentRun } from "./agent-runs";
import { trackAgentRun } from "../sync/agents";
import { agentCommentContent } from "../sync/comments";
import { appBotLogin } from "./identity";

const MAX_BODY = 5 * 1024 * 1024;

export async function handleGithubWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_APP_WEBHOOK_SECRET) return json({ error: "GitHub App is not configured." }, 503);
  const event = request.headers.get("X-GitHub-Event");
  const delivery = request.headers.get("X-GitHub-Delivery");
  if (!event || !delivery) return json({ error: "Missing GitHub headers." }, 400);
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > MAX_BODY) return json({ error: "Payload too large." }, 413);
  const body = await request.text();
  const signature = request.headers.get("X-Hub-Signature-256") ?? "";
  const expected = `sha256=${await hmacSha256Hex(env.GITHUB_APP_WEBHOOK_SECRET, body)}`;
  if (!(await constantTimeEqual(signature, expected))) {
    return json({ error: "Invalid signature." }, 401);
  }
  if (!(await claimDelivery(env.DB, delivery)))
    return json({ accepted: true, duplicate: true }, 202);
  const payload = JSON.parse(body) as Record<string, any>;
  const repository: string | undefined = payload.repository?.full_name;
  if (event === "ping" || !repository) return json({ accepted: true }, 202);

  const bot = await appBotLogin(env);
  if (FEED_REPOSITORIES.has(repository) && feedWorthy(event, payload, bot)) {
    const updates = renderFeed(event, payload);
    if (updates.length) await enqueue(env, "feed", delivery, { delivery, updates });
  }
  if (repository === REPOSITORY_SLUG) await routeRepositoryEvent(env, event, payload, bot);
  return json({ accepted: true }, 202);
}

async function routeRepositoryEvent(
  env: Env,
  event: string,
  payload: Record<string, any>,
  bot: string | null,
): Promise<void> {
  const action: string | undefined = payload.action;
  const sender: string | undefined = payload.sender?.login;
  switch (event) {
    case "workflow_run": {
      const run = identifyAgentRun(payload.workflow_run);
      if (run) await trackAgentRun(env, run);
      return;
    }
    case "issues": {
      const number: number = payload.issue.number;
      if (action === "deleted") {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM issues WHERE number=?").bind(number),
          env.DB.prepare("DELETE FROM subscribers WHERE issue_number=?").bind(number),
        ]);
        await env.VECTORIZE.deleteByIds([String(number)]).catch(() => undefined);
        return;
      }
      await enqueue(env, "sync-issue", String(number), {
        number,
        addedLabel: action === "labeled" && sender !== bot ? payload.label?.name : null,
        reopened: action === "reopened",
      });
      return;
    }
    case "issue_comment": {
      if (payload.issue.pull_request) return;
      // Capture the assessment immediately so the status card can finish even
      // when comment mirroring is waiting for Queue recovery.
      if (action !== "deleted" && payload.comment.user?.login === "github-actions[bot]") {
        const run = commentAgentRun(payload.comment.body, payload.issue.number);
        if (run)
          await trackAgentRun(
            env,
            run,
            agentCommentContent(payload.comment.body, payload.comment.html_url),
          );
      }
      await enqueue(env, "comment", String(payload.comment.id), {
        number: payload.issue.number,
        commentId: payload.comment.id,
        action,
      });
      if (await getIssue(env.DB, payload.issue.number)) {
        await enqueue(env, "sync-issue", String(payload.issue.number), {
          number: payload.issue.number,
        });
      }
      return;
    }
    case "pull_request":
      if (["opened", "reopened", "closed", "edited", "ready_for_review"].includes(action ?? "")) {
        await enqueue(env, "pull", String(payload.pull_request.number), {
          number: payload.pull_request.number,
        });
      }
      return;
    case "push":
      if (payload.ref === `refs/heads/${NIGHTLY_BRANCH}` && payload.commits?.length) {
        await enqueue(env, "push", payload.after, {
          commits: payload.commits.slice(0, 200).map((commit: any) => ({
            id: commit.id,
            message: String(commit.message ?? "").slice(0, 4000),
            url: commit.url,
            author: commit.author?.username ?? commit.author?.name,
          })),
        });
      }
      return;
    case "release":
      await setState(env.DB, "github:releases-refreshed", "0");
      if (action === "published" && !payload.release?.draft) {
        await enqueue(env, "release", payload.release.tag_name, {
          tag: payload.release.tag_name,
          url: payload.release.html_url,
        });
      }
      return;
    case "milestone":
      await enqueue(env, "milestones", "all", {}, 3);
      return;
    default:
      return;
  }
}
