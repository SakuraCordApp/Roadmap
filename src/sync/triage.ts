import { searchReports } from "../ai/search";
import {
  checkReportVersion,
  matchingRelease,
  reportReleases,
  type ReportRelease,
} from "../releases";
import { issueEmbeddingText } from "../ai/embeddings";
import { parseTriageResult } from "../ai/triage";
import {
  AGENT_LABELS,
  AREAS,
  PRIORITIES,
  ISSUE_TYPES,
  REPOSITORY_URL,
  areaLabel,
  priorityLabel,
} from "../config";
import { getIssue, getJsonState, getState, patchIssue, setState } from "../db/store";
import type { Env } from "../env";
import { GitHub } from "../github/client";
import { appBotLogin } from "../github/identity";
import { labelNames, type GhIssue, type GhComment } from "../github/types";
import { enqueue } from "../jobs/queue";
import { statusGithubLabel } from "../lifecycle";
import { valuesFromBody } from "../report/body";
import { sha256 } from "../util/crypto";
import { nowIso } from "../util/text";

/** Public report context for the read-only Actions agent, bounded to twelve candidates. */
export async function assessmentContext(env: Env, number: number) {
  const issue = await getIssue(env.DB, number);
  if (!issue) return null;
  const matches = await searchReports(env, issueEmbeddingText(issue), {
    limit: 12,
    exclude: number,
  });
  const releases = await reportReleases(env);
  const reportedVersion = valuesFromBody(issue.kind ?? "bug", issue.body).version ?? "";
  const reportedRelease =
    (await getJsonState<ReportRelease | null>(env.DB, `report:release:${number}`, null)) ??
    matchingRelease(reportedVersion, releases) ??
    null;
  const candidates = matches.map(({ issue: candidate, score }) => ({
    number: candidate.number,
    title: candidate.title,
    summary: candidate.summary,
    body: candidate.body.slice(0, 1800),
    kind: candidate.kind,
    status: candidate.status,
    fixes: [
      ...candidate.fixes,
      ...(candidate.triage?.resolution?.commit &&
      !candidate.fixes.some((fix) => fix.sha === candidate.triage?.resolution?.commit)
        ? [{ kind: "commit", sha: candidate.triage.resolution.commit, state: "merged" }]
        : []),
    ],
    shippedIn: candidate.shippedIn,
    shippedStableIn: candidate.shippedStableIn,
    similarity: score || null,
  }));
  return {
    areas: AREAS,
    priorities: PRIORITIES,
    candidates,
    reportedVersion,
    reportedRelease,
    reportedKind: issue.kind,
    releases,
  };
}

/** A single label starts the combined triage/investigation agent. No LLM runs here. */
export async function runTriage(
  env: Env,
  payload: { number: number; force?: boolean },
): Promise<void> {
  const issue = await getIssue(env.DB, payload.number);
  if (
    !issue ||
    issue.state !== "open" ||
    (!payload.force && (!["new", "needs_info"].includes(issue.status) || issue.triagedAt))
  )
    return;
  const github = new GitHub(env);
  const current = await github.request<GhIssue>("GET", github.repo(`/issues/${issue.number}`));
  if (current.state !== "open" || labelNames(current).includes(AGENT_LABELS.investigate.name))
    return;
  if (!(await checkReportVersion(env, current))) return;
  await github.request("PATCH", github.repo(`/issues/${issue.number}`), {
    labels: [
      ...labelNames(current).filter((name) => name !== statusGithubLabel("needs_info")),
      AGENT_LABELS.investigate.name,
      ...(labelNames(current).includes(statusGithubLabel("needs_info")!)
        ? [statusGithubLabel("new")!]
        : []),
    ],
  });
}

/** Apply only the trusted Actions comment, independently of its Discord mirror. */
export async function applyTriageResult(
  env: Env,
  payload: { number: number; commentId: number },
): Promise<void> {
  const github = new GitHub(env);
  const comment = await github.request<GhComment>(
    "GET",
    github.repo(`/issues/comments/${payload.commentId}`),
  );
  const envelope = parseTriageResult(comment, payload.number);
  if (!envelope) return;
  const hash = await sha256(JSON.stringify(envelope));
  const key = `triage:result:${payload.commentId}`;
  if ((await getState(env.DB, key)) === hash) return;
  const issue = await getIssue(env.DB, payload.number);
  if (!issue) throw new Error(`Report #${payload.number} has not synced yet`);
  const current = await github.request<GhIssue>("GET", github.repo(`/issues/${issue.number}`));
  const labels = new Set(labelNames(current));
  const result = { ...envelope.triage, model: envelope.model };
  // A report edited while the agent was working needs a fresh assessment.
  // Leave manual title edits alone; compare the body separately for retries.
  if ((await sha256(current.body ?? "")) !== envelope.bodyHash) {
    if (labels.has(AGENT_LABELS.investigate.name))
      await github.request(
        "DELETE",
        github.repo(
          `/issues/${issue.number}/labels/${encodeURIComponent(AGENT_LABELS.investigate.name)}`,
        ),
      );
    await enqueue(env, "triage", String(issue.number), { number: issue.number, force: true });
    await setState(env.DB, key, hash);
    return;
  }
  const inTriage = ![...labels].some(
    (name) =>
      name.startsWith("status: ") &&
      ![statusGithubLabel("new"), statusGithubLabel("needs_info")].includes(name),
  );
  const resolution = result.resolution;
  const confirmedFix =
    current.state === "open" &&
    (inTriage ||
      (labels.has(statusGithubLabel("in_nightly")!) &&
        issue.triage?.resolution?.commit === resolution?.commit &&
        issue.fixes.some((fix) => fix.sha === resolution?.commit))) &&
    envelope.confidence === "high" &&
    !result.needsInformation &&
    !result.duplicateOf &&
    resolution?.commit &&
    ["fixed_unreleased", "fixed_nightly", "fixed_regular"].includes(resolution.state);
  // Cache before removing the trigger label, so its webhook cannot start a
  // second run. Result retries still apply GitHub changes if that write failed.
  await patchIssue(env.DB, issue.number, {
    summary: result.summary,
    triage: result,
    triagedAt: nowIso(),
    ...(confirmedFix
      ? {
          fixes: [
            ...issue.fixes.filter((fix) => fix.sha !== resolution!.commit),
            {
              kind: "commit" as const,
              sha: resolution!.commit!,
              url: `${REPOSITORY_URL}/commit/${resolution!.commit}`,
              state: "merged" as const,
            },
          ],
        }
      : {}),
  });
  labels.delete(AGENT_LABELS.investigate.name);
  const patch: Record<string, unknown> = {};
  if (current.state === "open") {
    if (![...labels].some((name) => name.startsWith("area: "))) {
      const chosen = valuesFromBody(result.kind, issue.body).area;
      labels.add(areaLabel(chosen ?? result.area));
    }
    // Maintainer decisions made after intake take precedence over automated triage.
    if (inTriage) {
      for (const name of [...labels]) if (name.startsWith("priority: ")) labels.delete(name);
      labels.add(priorityLabel(result.priority));
      const ask =
        result.kind === "bug" &&
        result.needsInformation &&
        !(result.duplicateOf && result.duplicateConfidence >= 0.75);
      labels.delete(statusGithubLabel("new")!);
      labels.delete(statusGithubLabel("needs_info")!);
      labels.add(statusGithubLabel(ask ? "needs_info" : confirmedFix ? "in_nightly" : "new")!);
    }
    if (current.type?.name !== ISSUE_TYPES[result.kind].githubType)
      patch.type = ISSUE_TYPES[result.kind].githubType;
    const bot = await appBotLogin(env);
    if (
      bot &&
      current.user?.login === bot &&
      current.title === envelope.sourceTitle &&
      result.title !== current.title
    )
      patch.title = result.title;
  }
  patch.labels = [...labels];
  await github.request("PATCH", github.repo(`/issues/${issue.number}`), patch);
  await enqueue(env, "sync-issue", String(issue.number), { number: issue.number });
  if (confirmedFix && resolution?.releaseTag)
    await enqueue(env, "ship", `${issue.number}:${resolution.releaseTag}`, {
      number: issue.number,
      tag: resolution.releaseTag,
      url: `${REPOSITORY_URL}/releases/tag/${encodeURIComponent(resolution.releaseTag)}`,
    });
  await setState(env.DB, key, hash);
}
