import { performAction } from "../actions";
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
  REPOSITORY_SLUG,
  REPOSITORY_URL,
  STATUS_BY_ID,
  areaLabel,
  priorityLabel,
  type StatusId,
} from "../config";
import {
  getIssue,
  getJsonState,
  getState,
  patchIssue,
  setPendingNote,
  setState,
  type IssueRecord,
} from "../db/store";
import { reclassifiedKey } from "../discord/threads";
import { onNightly } from "../fixes";
import type { Env } from "../env";
import { GitHub } from "../github/client";
import { appBotLogin } from "../github/identity";
import { labelNames, type GhIssue, type GhComment, type GhPull } from "../github/types";
import { enqueue } from "../jobs/queue";
import { deriveStatus, issueKind, statusGithubLabel } from "../lifecycle";
import { valuesFromBody } from "../report/body";
import { sha256 } from "../util/crypto";
import { nowIso } from "../util/text";
import { pullFixRef, questionsAllowed, upsertFix } from "./activity";

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
    questionsAllowed: await questionsAllowed(env, number),
    previousQuestions: issue.triage?.needsInformation ? issue.triage.questions : [],
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

export type FixProposal = { commit: string; releaseTag: string | null };

const FIXED_STATES: readonly string[] = ["fixed_unreleased", "fixed_nightly", "fixed_regular"];

/**
 * A verified fix the assessment found but did not apply on its own (it needs
 * high confidence), waiting for a maintainer to confirm it.
 */
export function pendingFixProposal(issue: IssueRecord): FixProposal | null {
  const resolution = issue.triage?.resolution;
  if (
    !resolution?.commit ||
    !FIXED_STATES.includes(resolution.state) ||
    !STATUS_BY_ID.get(issue.status)!.open ||
    // Any recorded fix or shipment, including a maintainer's own correction,
    // supersedes the assessment's finding.
    issue.fixes.length > 0 ||
    issue.shippedIn
  )
    return null;
  return { commit: resolution.commit, releaseTag: resolution.releaseTag };
}

/** Signs the Discord notices for status changes the assessment makes. */
const ASSESSMENT = "Triage & investigation";

/** A fix in progress: an open pull request from this repository, not a fork. */
async function openPull(github: GitHub, number: number): Promise<GhPull | null> {
  const pull = await github.request<GhPull>("GET", github.repo(`/pulls/${number}`));
  return pull.state === "open" && pull.head.repo?.full_name === REPOSITORY_SLUG ? pull : null;
}

/** A report can absorb a duplicate unless it was itself closed as one, or declined. */
async function acceptsDuplicates(github: GitHub, number: number): Promise<boolean> {
  const target = await github.request<GhIssue>("GET", github.repo(`/issues/${number}`));
  return (
    !target.pull_request &&
    !["duplicate", "declined", "cant_reproduce"].includes(deriveStatus(target))
  );
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
  // A status change needs its own finding rated high. Results from before
  // these ratings applied a fix at high overall confidence, and always their kind.
  const findings = envelope.findings;
  const sure = (finding: keyof NonNullable<typeof findings>) => findings?.[finding] === "high";
  const status = deriveStatus(current);
  const inTriage = status === "new" || status === "needs_info";
  // Confirmed and planned reports may still move forward on verified progress.
  const advancing =
    inTriage || (Boolean(findings) && (status === "confirmed" || status === "planned"));
  const resolution = result.resolution;
  const progress = current.state === "open" && !result.needsInformation && !result.duplicateOf;
  const confirmedFix =
    progress &&
    (findings ? sure("fix") : envelope.confidence === "high") &&
    resolution?.commit &&
    FIXED_STATES.includes(resolution.state) &&
    ((labels.has(statusGithubLabel("in_nightly")!) &&
      issue.triage?.resolution?.commit === resolution.commit &&
      issue.fixes.some((fix) => fix.sha === resolution.commit)) ||
      (advancing && (await onNightly(github, resolution.commit))));
  const pull =
    progress && advancing && !confirmedFix && sure("pullRequest") && resolution?.pullRequest
      ? await openPull(github, resolution.pullRequest)
      : null;
  const duplicate =
    current.state === "open" &&
    inTriage &&
    sure("duplicate") &&
    result.duplicateOf &&
    (await acceptsDuplicates(github, result.duplicateOf))
      ? result.duplicateOf
      : null;
  const regression = sure("fix") && resolution?.state === "possible_regression";
  const reportedKind = issueKind(current);
  // A duplicate keeps its kind, so closing it doesn't move its Discord post.
  const kind =
    !reportedKind || (!duplicate && (!findings || sure("kind"))) ? result.kind : reportedKind;
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
      : pull
        ? { fixes: upsertFix(issue.fixes, pullFixRef(pull)) }
        : {}),
  });
  labels.delete(AGENT_LABELS.investigate.name);
  const patch: Record<string, unknown> = {};
  if (current.state === "open") {
    if (![...labels].some((name) => name.startsWith("area: "))) {
      const chosen = valuesFromBody(kind, issue.body).area;
      labels.add(areaLabel(chosen ?? result.area));
    }
    let next: StatusId | null = confirmedFix ? "in_nightly" : pull ? "in_progress" : null;
    // Maintainer decisions made after intake take precedence over automated triage.
    if (inTriage) {
      for (const name of [...labels]) if (name.startsWith("priority: ")) labels.delete(name);
      labels.add(priorityLabel(result.priority));
      const ask =
        (kind === "bug" || sure("existingFeature")) &&
        result.needsInformation &&
        !(result.duplicateOf && result.duplicateConfidence >= 0.75) &&
        (await questionsAllowed(env, issue.number));
      next = duplicate ? null : ask ? "needs_info" : (next ?? (regression ? "confirmed" : "new"));
    }
    if (next) {
      for (const name of [...labels]) if (name.startsWith("status: ")) labels.delete(name);
      labels.add(statusGithubLabel(next)!);
    }
    const changed = duplicate ? "duplicate" : next !== status && next !== "new" ? next : null;
    if (changed)
      await setPendingNote(
        env.DB,
        issue.number,
        changed,
        changed === "confirmed"
          ? `Set by the assessment: the reported release already has the fix from ${resolution!.commit!.slice(0, 7)}, so this broke again.`
          : "Set by the assessment.",
        ASSESSMENT,
      );
    if (current.type?.name !== ISSUE_TYPES[kind].githubType) {
      patch.type = ISSUE_TYPES[kind].githubType;
      // The moved Discord post says who moved it.
      if (current.type) await setState(env.DB, reclassifiedKey(issue.number), kind);
    }
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
  if (duplicate)
    await performAction(env, issue.number, "duplicate", ASSESSMENT, { note: String(duplicate) });
  await enqueue(env, "sync-issue", String(issue.number), { number: issue.number });
  if (confirmedFix && resolution?.releaseTag)
    await enqueue(env, "ship", `${issue.number}:${resolution.releaseTag}`, {
      number: issue.number,
      tag: resolution.releaseTag,
      url: `${REPOSITORY_URL}/releases/tag/${encodeURIComponent(resolution.releaseTag)}`,
    });
  await setState(env.DB, key, hash);
}
