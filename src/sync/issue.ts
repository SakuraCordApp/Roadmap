import { indexIssue } from "../ai/embeddings";
import { STATUS_BY_ID } from "../config";
import {
  addEvent,
  getIssue,
  moveSubscribers,
  patchIssue,
  primaryThread,
  saveIssue,
  subscribers,
  type IssueRecord,
} from "../db/store";
import { projectIssue, discordClient } from "../discord/threads";
import type { Env } from "../env";
import { GitHub } from "../github/client";
import { appBotLogin } from "../github/identity";
import { labelNames, type GhIssue } from "../github/types";
import { enqueue, enqueueMany } from "../jobs/queue";
import { deriveStatus, issueArea, issueKind, issuePriority, planLabels } from "../lifecycle";
import { parseMeta } from "../report/body";
import { nowIso } from "../util/text";

export interface SyncIssuePayload {
  number: number;
  addedLabel?: string | null;
  reopened?: boolean;
}

export function recordFromGithub(issue: GhIssue, previous: IssueRecord | null): IssueRecord {
  const meta = parseMeta(issue.body);
  const kind = issueKind(issue) ?? previous?.kind ?? null;
  const reporter =
    meta?.reporter ??
    (issue.user && issue.user.type !== "Bot"
      ? { source: "github" as const, name: issue.user.login, githubLogin: issue.user.login }
      : null);
  return {
    number: issue.number,
    githubId: issue.id,
    nodeId: issue.node_id,
    title: issue.title,
    body: issue.body ?? "",
    kind,
    state: issue.state,
    stateReason: issue.state_reason,
    status: deriveStatus(issue),
    area: issueArea(issue),
    priority: issuePriority(issue),
    labels: labelNames(issue),
    milestoneNumber: issue.milestone?.number ?? null,
    milestoneTitle: issue.milestone?.title ?? null,
    authorLogin: issue.user?.login ?? null,
    authorType: issue.user?.type ?? null,
    reporter,
    summary: previous?.summary ?? null,
    reactionsUp: issue.reactions?.["+1"] ?? 0,
    commentsCount: issue.comments,
    duplicateOf: issue.state_reason === "duplicate" ? (previous?.duplicateOf ?? null) : null,
    fixes: previous?.fixes ?? [],
    shippedIn: previous?.shippedIn ?? null,
    shippedStableIn: previous?.shippedStableIn ?? null,
    triage: previous?.triage ?? null,
    triagedAt: previous?.triagedAt ?? null,
    embeddedHash: previous?.embeddedHash ?? null,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    syncedAt: nowIso(),
  };
}

async function duplicateTarget(github: GitHub, number: number): Promise<number | null> {
  const data = await github.graphql<{
    repository: {
      issue: {
        timelineItems: { nodes: Array<{ canonical?: { number?: number } | null }> };
      } | null;
    };
  }>(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){
      timelineItems(last:1,itemTypes:[MARKED_AS_DUPLICATE_EVENT]){nodes{... on MarkedAsDuplicateEvent{
        canonical{... on Issue{number}}}}}}}}`,
    { owner: "SakuraCordApp", name: "SakuraCord", number },
  );
  return data.repository.issue?.timelineItems.nodes[0]?.canonical?.number ?? null;
}

export async function syncIssue(env: Env, payload: SyncIssuePayload): Promise<void> {
  const github = new GitHub(env);
  let issue = await github.request<GhIssue>("GET", github.repo(`/issues/${payload.number}`));
  if (issue.pull_request) return;

  const plan = planLabels(issue, payload);
  if (plan.add.length || plan.remove.length) {
    const labels = [
      ...labelNames(issue).filter((name) => !plan.remove.includes(name)),
      ...plan.add,
    ];
    issue = await github.request<GhIssue>("PATCH", github.repo(`/issues/${issue.number}`), {
      labels,
    });
  }

  const previous = await getIssue(env.DB, issue.number);
  const record = recordFromGithub(issue, previous);
  if (record.status === "duplicate" && !record.duplicateOf) {
    record.duplicateOf = await duplicateTarget(github, issue.number).catch(() => null);
  }
  await saveIssue(env.DB, record);

  if (!previous) {
    await addEvent(
      env.DB,
      record.number,
      "created",
      { status: record.status },
      null,
      record.createdAt,
    );
  } else if (previous.status !== record.status) {
    await addEvent(env.DB, record.number, "status", { from: previous.status, to: record.status });
  }

  if (record.status === "duplicate" && record.duplicateOf && previous?.status !== "duplicate") {
    await mergeIntoCanonical(env, record, record.duplicateOf);
  }

  const bot = await appBotLogin(env);
  const createdByHub = Boolean(bot && issue.user?.login === bot);
  const age = Date.now() - Date.parse(issue.created_at);
  const projection = await projectIssue(env, {
    issue: record,
    previousStatus: previous?.status ?? null,
    // Hub-filed reports get their post while filing; only adopt them here if
    // that failed. GitHub-filed reports get one as soon as they have a type.
    createIfMissing: !createdByHub || age > 10 * 60_000,
  });

  if (projection.created && record.commentsCount > 0) {
    // A GitHub-filed issue just got its Discord post: bring the conversation over.
    const comments = await github.request<Array<{ id: number }>>(
      "GET",
      github.repo(`/issues/${record.number}/comments?per_page=100`),
    );
    await enqueueMany(
      env,
      comments.map((comment) => ({
        kind: "comment" as const,
        key: String(comment.id),
        payload: { number: record.number, commentId: comment.id, action: "created" },
      })),
    );
  }
  if (record.kind) {
    await enqueue(env, "embed", String(record.number), { number: record.number });
  }
  // Untyped issues (e.g. blank GitHub issues) are triaged too; triage sets the type.
  if (
    (record.kind || !issue.type) &&
    record.state === "open" &&
    ["new", "needs_info"].includes(record.status) &&
    !record.triagedAt &&
    env.GITHUB_APP_ID
  ) {
    await enqueue(env, "triage", String(record.number), { number: record.number });
  }
  if (
    previous &&
    (previous.milestoneNumber !== record.milestoneNumber || previous.state !== record.state)
  ) {
    await enqueue(env, "milestones", "all", {}, 5);
  }
}

/** Move followers of a duplicate to the canonical report and tell both threads. */
async function mergeIntoCanonical(env: Env, duplicate: IssueRecord, canonical: number) {
  const moved = await moveSubscribers(env.DB, duplicate.number, canonical);
  await addEvent(env.DB, canonical, "merged", { from: duplicate.number, title: duplicate.title });
  const target = await primaryThread(env.DB, canonical);
  if (target) {
    const people = await subscribers(env.DB, duplicate.number);
    const discord = discordClient(env);
    for (const person of people.slice(0, 25)) {
      await discord
        .put(`/channels/${target.threadId}/thread-members/${person.userId}`)
        .catch(() => undefined);
    }
    await discord
      .post(
        `/channels/${target.threadId}/messages`,
        {
          content: `🔁 **#${duplicate.number} was merged into this report**${moved ? ` — ${moved} more ${moved === 1 ? "person is" : "people are"} following it now` : ""}.`,
          allowed_mentions: { parse: [] },
          flags: 1 << 2,
        },
        { nonceKey: `merge:${duplicate.number}:${canonical}` },
      )
      .catch((error) => console.error("Merge announcement failed", error));
  }
  await enqueue(env, "sync-issue", String(canonical), { number: canonical });
}

export async function embedIssue(env: Env, payload: { number: number }): Promise<void> {
  const issue = await getIssue(env.DB, payload.number);
  if (!issue?.kind) return;
  const hash = await indexIssue(env, issue);
  if (hash && hash !== issue.embeddedHash)
    await patchIssue(env.DB, issue.number, { embeddedHash: hash });
}

export function isOpenStatus(record: IssueRecord) {
  return STATUS_BY_ID.get(record.status)!.open;
}
