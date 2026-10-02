import {
  DEFAULT_BRANCH,
  NIGHTLY_BRANCH,
  REPOSITORY_URL,
  STATUS_BY_ID,
  isPrereleaseTag,
  releaseDisplayName,
  releaseMilestoneTitle,
} from "../config";
import {
  addEvent,
  getIssue,
  getState,
  listIssues,
  patchIssue,
  primaryThread,
  setState,
  subscribers,
  type FixRef,
  type IssueRecord,
} from "../db/store";
import { mentionUsers } from "../discord/rest";
import { postInThread } from "../discord/threads";
import type { Env } from "../env";
import { GitHub } from "../github/client";
import type { GhIssue, GhMilestone, GhPull } from "../github/types";
import { labelNames } from "../github/types";
import { enqueue, enqueueMany } from "../jobs/queue";
import { referencedIssues, statusGithubLabel } from "../lifecycle";
import { truncate } from "../util/text";
import { NO_MIRROR } from "./markers";

export async function returnToTriage(env: Env, number: number): Promise<void> {
  const github = new GitHub(env);
  const issue = await github.request<GhIssue>("GET", github.repo(`/issues/${number}`));
  if (issue.state !== "open") return;
  const labels = labelNames(issue).filter((name) => name !== statusGithubLabel("needs_info"));
  labels.push(statusGithubLabel("new")!);
  await patchIssue(env.DB, number, { triagedAt: null });
  await github.request("PATCH", github.repo(`/issues/${number}`), { labels: [...new Set(labels)] });
  await enqueue(env, "sync-issue", String(number), { number });
}

// ---------------------------------------------------------------------------
// Fix tracking: pull requests and nightly commits move issues through
// In Progress → In Nightly; releases ship them.

async function setStatusLabel(
  env: Env,
  number: number,
  status: "in_progress" | "in_nightly" | "confirmed",
) {
  const github = new GitHub(env);
  const issue = await github.request<GhIssue>("GET", github.repo(`/issues/${number}`));
  if (issue.state !== "open") return;
  const labels = labelNames(issue).filter((name) => !name.startsWith("status: "));
  labels.push(statusGithubLabel(status)!);
  await github.request("PATCH", github.repo(`/issues/${number}`), { labels });
  await enqueue(env, "sync-issue", String(number), {
    number,
    addedLabel: statusGithubLabel(status),
  });
}

function upsertFix(fixes: FixRef[], fix: FixRef): FixRef[] {
  const key = (value: FixRef) => (value.kind === "pr" ? `pr:${value.number}` : `sha:${value.sha}`);
  const others = fixes.filter((value) => key(value) !== key(fix));
  // A PR's merge commit may also arrive as a pushed commit; keep the PR entry.
  if (
    fix.kind === "commit" &&
    fixes.some((value) => value.kind === "pr" && value.sha === fix.sha)
  ) {
    return fixes;
  }
  return [...others, fix];
}

export async function syncPull(env: Env, payload: { number: number }): Promise<void> {
  const github = new GitHub(env);
  const pull = await github.request<GhPull>("GET", github.repo(`/pulls/${payload.number}`));
  if (pull.base.ref === DEFAULT_BRANCH && pull.head.ref === NIGHTLY_BRANCH) return;
  const numbers = referencedIssues(`${pull.title}\n${pull.body ?? ""}`);
  for (const number of numbers) {
    const issue = (await getIssue(env.DB, number)) ?? null;
    if (!issue?.kind) continue;
    const state: FixRef["state"] = pull.merged
      ? "merged"
      : pull.state === "open"
        ? "open"
        : "closed";
    const fixes = upsertFix(issue.fixes, {
      kind: "pr",
      number: pull.number,
      url: pull.html_url,
      title: truncate(pull.title, 200),
      author: pull.user?.login,
      state,
      base: pull.base.ref,
      ...(pull.merge_commit_sha && pull.merged ? { sha: pull.merge_commit_sha } : {}),
    });
    await patchIssue(env.DB, number, { fixes });
    const open = STATUS_BY_ID.get(issue.status)!.open;
    if (!open) continue;
    if (state === "open" && ["new", "needs_info", "confirmed", "planned"].includes(issue.status)) {
      await addEvent(
        env.DB,
        number,
        "fix",
        { pr: pull.number, url: pull.html_url, state },
        pull.user?.login,
      );
      await setStatusLabel(env, number, "in_progress");
    } else if (state === "merged" && issue.status !== "in_nightly") {
      await addEvent(
        env.DB,
        number,
        "fix",
        { pr: pull.number, url: pull.html_url, state },
        pull.user?.login,
      );
      await setStatusLabel(env, number, "in_nightly");
    } else if (
      state === "closed" &&
      issue.status === "in_progress" &&
      !fixes.some((fix) => fix.state !== "closed")
    ) {
      await setStatusLabel(env, number, "confirmed");
    } else {
      await enqueue(env, "sync-issue", String(number), { number });
    }
  }
}

export async function syncPush(
  env: Env,
  payload: { commits: Array<{ id: string; message: string; url: string; author?: string }> },
): Promise<void> {
  for (const commit of payload.commits) {
    for (const number of referencedIssues(commit.message)) {
      const issue = await getIssue(env.DB, number);
      if (!issue?.kind) continue;
      const fixes = upsertFix(issue.fixes, {
        kind: "commit",
        sha: commit.id,
        url: commit.url,
        title: truncate(commit.message.split("\n")[0] ?? "", 200),
        author: commit.author,
        state: "merged",
        base: NIGHTLY_BRANCH,
      });
      await patchIssue(env.DB, number, { fixes });
      if (STATUS_BY_ID.get(issue.status)!.open && issue.status !== "in_nightly") {
        await addEvent(
          env.DB,
          number,
          "fix",
          { sha: commit.id, url: commit.url, state: "merged" },
          commit.author ?? null,
        );
        await setStatusLabel(env, number, "in_nightly");
      } else {
        await enqueue(env, "sync-issue", String(number), { number });
      }
    }
  }
}

export async function handleRelease(
  env: Env,
  payload: { tag: string; url: string },
): Promise<void> {
  const prerelease = isPrereleaseTag(payload.tag);
  const candidates = (await listIssues(env.DB)).filter(
    (issue) =>
      issue.kind &&
      (issue.fixes.some((fix) => fix.state === "merged" && fix.sha) || issue.shippedIn) &&
      (!issue.shippedIn || (!prerelease && !issue.shippedStableIn)) &&
      !["duplicate", "declined", "cant_reproduce"].includes(issue.status),
  );
  await enqueueMany(
    env,
    candidates.map((issue) => ({
      kind: "ship" as const,
      key: `${issue.number}:${payload.tag}`,
      payload: { number: issue.number, tag: payload.tag, url: payload.url },
    })),
  );
  await setState(env.DB, "github:releases-refreshed", "0");
}

/** Ship one issue if the release tag contains any of its merged fixes. */
export async function shipIssue(
  env: Env,
  payload: { number: number; tag: string; url: string },
): Promise<void> {
  const issue = await getIssue(env.DB, payload.number);
  if (!issue) return;
  const github = new GitHub(env);
  if (!(await containsAnyFix(env, github, issue, payload.tag))) return;
  await recordShipment(env, issue, payload, isPrereleaseTag(payload.tag));
}

/** Shared release completion for verified ancestry and explicit maintainer confirmation. */
export async function recordShipment(
  env: Env,
  issue: IssueRecord,
  payload: { tag: string; url: string },
  prerelease: boolean,
  confirmation?: string,
): Promise<void> {
  const github = new GitHub(env);
  const version = releaseDisplayName(payload.tag);
  const current =
    !issue.shippedIn || issue.state === "open"
      ? await github.request<GhIssue>("GET", github.repo(`/issues/${issue.number}`))
      : null;
  if (!issue.shippedIn || current?.state === "open") {
    let milestone: number | undefined;
    if (!current!.milestone) {
      const title = releaseMilestoneTitle(payload.tag);
      milestone = (
        await env.DB.prepare("SELECT number FROM milestones WHERE title=?")
          .bind(title)
          .first<{ number: number }>()
      )?.number;
    }
    const labels = labelNames(current!).filter((name) => !name.startsWith("status: "));
    labels.push(statusGithubLabel("shipped")!);
    await github.request("POST", github.repo(`/issues/${issue.number}/comments`), {
      body: `${NO_MIRROR}\n🌸 Shipped in [SakuraCord ${version}](${payload.url}).${confirmation ? `\n\n${confirmation}` : ""}`,
    });
    await setState(env.DB, `ship:tag:${issue.number}`, payload.tag);
    await patchIssue(env.DB, issue.number, {
      shippedIn: version,
      shippedStableIn: prerelease ? null : version,
    });
    await github.request("PATCH", github.repo(`/issues/${issue.number}`), {
      labels,
      state: "closed",
      state_reason: "completed",
      ...(milestone ? { milestone } : {}),
    });
    await addEvent(env.DB, issue.number, "shipped", { version, url: payload.url, prerelease });
  } else if (!prerelease && !issue.shippedStableIn) {
    await patchIssue(env.DB, issue.number, { shippedStableIn: version });
    await addEvent(env.DB, issue.number, "shipped", {
      version,
      url: payload.url,
      prerelease: false,
    });
    await announceStableRelease(env, issue, version);
  }
  await enqueue(env, "sync-issue", String(issue.number), { number: issue.number });
}

async function containsAnyFix(
  env: Env,
  github: GitHub,
  issue: IssueRecord,
  tag: string,
): Promise<boolean> {
  for (const fix of issue.fixes) {
    if (fix.state !== "merged" || !fix.sha) continue;
    try {
      const comparison = await github.request<{ status: string }>(
        "GET",
        github.repo(`/compare/${fix.sha}...${encodeURIComponent(tag)}`),
      );
      if (comparison.status === "ahead" || comparison.status === "identical") return true;
    } catch (error) {
      console.error(`Could not compare ${fix.sha} with ${tag}`, error);
    }
  }
  // A maintainer may confirm a published nightly without knowing the original
  // fix SHA. Its release tag is sufficient evidence for later release ancestry.
  if (issue.shippedIn) {
    const shippedTag =
      (await getState(env.DB, `ship:tag:${issue.number}`)) ??
      `v${issue.shippedIn.replace(/^v/, "").replace(/ Beta /i, "-Beta-")}`;
    const comparison = await github.request<{ status: string }>(
      "GET",
      github.repo(`/compare/${encodeURIComponent(shippedTag)}...${encodeURIComponent(tag)}`),
    );
    return comparison.status === "ahead" || comparison.status === "identical";
  }
  return false;
}

async function announceStableRelease(env: Env, issue: IssueRecord, version: string) {
  const thread = await primaryThread(env.DB, issue.number);
  if (!thread) return;
  const people = (await subscribers(env.DB, issue.number))
    .map((person) => person.userId)
    .slice(0, 50);
  await postInThread(
    env,
    thread.threadId,
    {
      content: `🌸 **Now in the regular release: SakuraCord ${version}.**${people.length ? `\n-# ${people.map((id) => `<@${id}>`).join(" ")}` : ""}`,
      allowed_mentions: mentionUsers(people),
      flags: 1 << 2,
    },
    { nonceKey: `stable:${issue.number}:${version}` },
  );
}

// ---------------------------------------------------------------------------
// Milestones (the roadmap) and periodic reconciliation.

export async function syncMilestones(env: Env): Promise<void> {
  const github = new GitHub(env);
  const milestones = await github.list<GhMilestone>(github.repo("/milestones?state=all"));
  const statements = [env.DB.prepare("DELETE FROM milestones")];
  for (const milestone of milestones) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO milestones(number,title,description,state,due_on,closed_at,open_issues,closed_issues,html_url,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        milestone.number,
        milestone.title,
        milestone.description ?? "",
        milestone.state,
        milestone.due_on,
        milestone.closed_at,
        milestone.open_issues,
        milestone.closed_issues,
        milestone.html_url,
        milestone.updated_at,
      ),
    );
  }
  await env.DB.batch(statements);
  await setState(env.DB, "github:milestones-refreshed", new Date().toISOString());
  await enqueue(env, "roadmap", "publish", {}, 2);
}

/** Catch anything a missed webhook would have changed. */
export async function reconcile(env: Env, payload: { full?: boolean } = {}): Promise<void> {
  const github = new GitHub(env);
  const since = payload.full ? null : await getState(env.DB, "github:reconciled-at");
  const startedAt = Date.now();
  const issues = await github.list<GhIssue>(
    github.repo(`/issues?state=all&sort=updated&direction=desc${since ? `&since=${since}` : ""}`),
    payload.full ? 10 : 3,
  );
  const known = new Map((await listIssues(env.DB)).map((issue) => [issue.number, issue.updatedAt]));
  const changed = issues.filter(
    (issue) =>
      !issue.pull_request && (payload.full || known.get(issue.number) !== issue.updated_at),
  );
  await enqueueMany(
    env,
    changed.map((issue) => ({
      kind: "sync-issue" as const,
      key: String(issue.number),
      payload: { number: issue.number },
    })),
  );
  await setState(env.DB, "github:reconciled-at", new Date(startedAt - 120_000).toISOString());
  const milestonesRefreshed = await getState(env.DB, "github:milestones-refreshed");
  if (
    payload.full ||
    !milestonesRefreshed ||
    Date.now() - Date.parse(milestonesRefreshed) >= 3600_000
  ) {
    await enqueue(env, "milestones", "all", {});
  }
}

export const REPOSITORY_ISSUES_URL = `${REPOSITORY_URL}/issues`;
