import { duplicateClosure } from "../actions";
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
  NIGHTLY_BRANCH,
  REPOSITORY_SLUG,
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
  setAssessmentNote,
  setState,
  type IssueRecord,
} from "../db/store";
import { reclassifiedKey } from "../discord/threads";
import { checkReleases, nightlyFix, recordNightlyFix } from "../fixes";
import type { Env } from "../env";
import { GitHub } from "../github/client";
import { appBotLogin } from "../github/identity";
import { labelNames, type GhIssue, type GhComment, type GhPull } from "../github/types";
import { enqueue } from "../jobs/queue";
import { deriveStatus, issueKind, referencedIssues, statusGithubLabel } from "../lifecycle";
import { valuesFromBody } from "../report/body";
import { sha256 } from "../util/crypto";
import { nowIso } from "../util/text";
import { questionsAllowed } from "./activity";
import { enqueueAgentStatus } from "./agents";

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

/** A fix in progress: an open pull request into nightly from this repository, not a fork. */
async function openPull(github: GitHub, number: number): Promise<GhPull | null> {
  const pull = await github.request<GhPull>("GET", github.repo(`/pulls/${number}`));
  return pull.state === "open" &&
    pull.base.ref === NIGHTLY_BRANCH &&
    pull.head.repo?.full_name === REPOSITORY_SLUG
    ? pull
    : null;
}

/** Add "Fixes #N" to a pull request unless it already names the report, then track it. */
async function linkPull(env: Env, number: number, report: number): Promise<void> {
  const github = new GitHub(env);
  const path = github.repo(`/pulls/${number}`);
  const pull = await github.request<GhPull>("GET", path);
  if (!referencedIssues(`${pull.title}\n${pull.body ?? ""}`).includes(report))
    await github.request("PATCH", path, {
      body: `${pull.body ? `${pull.body.trimEnd()}\n\n` : ""}Fixes #${report} (linked by the triage assessment)`,
    });
  await enqueue(env, "pull", String(number), { number });
}

/** What a result's first attempt decided: the status it started from and set. */
type Decision = { hash: string; from: StatusId; to: StatusId | null };

/** The original, unless it was itself closed as a duplicate, or declined. */
async function duplicateTarget(github: GitHub, number: number): Promise<GhIssue | null> {
  const target = await github.request<GhIssue>("GET", github.repo(`/issues/${number}`));
  return !target.pull_request &&
    !["duplicate", "declined", "cant_reproduce"].includes(deriveStatus(target))
    ? target
    : null;
}

const inTriageStatus = (status: StatusId) => status === "new" || status === "needs_info";

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
  const issuePath = github.repo(`/issues/${issue.number}`);
  const first = await github.request<GhIssue>("GET", issuePath);
  const result = { ...envelope.triage, model: envelope.model };
  // A report edited while the agent was working needs a fresh assessment.
  // Leave manual title edits alone; compare the body separately for retries.
  if ((await sha256(first.body ?? "")) !== envelope.bodyHash) {
    if (labelNames(first).includes(AGENT_LABELS.investigate.name))
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
  // A retry decides from the status its first attempt started from, so it can
  // finish that attempt's change but never redo one a maintainer has corrected.
  const decisionKey = `triage:decision:${payload.commentId}`;
  const stored = await getJsonState<Decision | null>(env.DB, decisionKey, null);
  const attempt = stored?.hash === hash ? stored : null;
  const status = attempt?.from ?? deriveStatus(first);
  const open = first.state === "open";
  const inTriage = inTriageStatus(status);
  // Confirmed and planned reports may still move forward on verified progress.
  const advancing =
    inTriage || (Boolean(findings) && (status === "confirmed" || status === "planned"));
  const resolution = result.resolution;
  // Every lookup comes before the fresh read below; only cache writes and the
  // GitHub write follow it.
  const foundDuplicate =
    open && inTriage && sure("duplicate") && result.duplicateOf
      ? await duplicateTarget(github, result.duplicateOf)
      : null;
  // Only an accepted duplicate holds back progress and questions; results
  // without ratings keep their rule that a suggested (or likely) one does.
  const progress =
    open &&
    advancing &&
    !result.needsInformation &&
    (findings ? !foundDuplicate : !result.duplicateOf);
  const foundFix =
    progress &&
    (findings ? sure("fix") : envelope.confidence === "high") &&
    resolution?.commit &&
    FIXED_STATES.includes(resolution.state)
      ? await nightlyFix(github, resolution.commit)
      : null;
  const foundPull =
    progress && !foundFix && sure("pullRequest") && resolution?.pullRequest
      ? await openPull(github, resolution.pullRequest)
      : null;
  const releases = foundFix ? await reportReleases(env) : [];
  const mayAsk =
    inTriage &&
    result.needsInformation &&
    !(findings ? foundDuplicate : result.duplicateOf && result.duplicateConfidence >= 0.75) &&
    (await questionsAllowed(env, issue.number));
  const bot = await appBotLogin(env);
  // GitHub has no conditional update, so a maintainer's change in the moment
  // between this read and the write below can still be overwritten.
  const current = await github.request<GhIssue>("GET", issuePath);
  const now = deriveStatus(current);
  // A status a maintainer set since the result was first read cancels every
  // automatic status change.
  const proceed = attempt
    ? now === attempt.to || (attempt.to !== null && now === attempt.from)
    : now === status;
  const duplicate = proceed ? foundDuplicate : null;
  const fix = proceed ? foundFix : null;
  const pull = proceed ? foundPull : null;
  const regression = sure("fix") && resolution?.state === "possible_regression";
  const reportedKind = issueKind(current);
  // A duplicate keeps its kind, so closing it doesn't move its Discord post.
  const kind =
    !reportedKind || (!duplicate && (!findings || sure("kind"))) ? result.kind : reportedKind;
  const labels = new Set(labelNames(current));
  labels.delete(AGENT_LABELS.investigate.name);
  const patch: Record<string, unknown> = {};
  let next: StatusId | null = null;
  if (current.state === "open") {
    if (![...labels].some((name) => name.startsWith("area: "))) {
      const chosen = valuesFromBody(kind, issue.body).area;
      labels.add(areaLabel(chosen ?? result.area));
    }
    // Maintainer decisions made after intake take precedence over automated triage.
    if (proceed) {
      next = fix ? "in_nightly" : null;
      if (inTriage) {
        for (const name of [...labels]) if (name.startsWith("priority: ")) labels.delete(name);
        labels.add(priorityLabel(result.priority));
        const ask = (kind === "bug" || sure("existingFeature")) && mayAsk;
        next = duplicate ? null : ask ? "needs_info" : (next ?? (regression ? "confirmed" : "new"));
      }
    }
    if (next || duplicate)
      for (const name of [...labels]) if (name.startsWith("status: ")) labels.delete(name);
    if (next) labels.add(statusGithubLabel(next)!);
    if (duplicate) Object.assign(patch, duplicateClosure(duplicate));
    if (current.type?.name !== ISSUE_TYPES[kind].githubType)
      patch.type = ISSUE_TYPES[kind].githubType;
    if (
      bot &&
      current.user?.login === bot &&
      current.title === envelope.sourceTitle &&
      result.title !== current.title
    )
      patch.title = result.title;
  }
  patch.labels = [...labels];
  if (!attempt)
    await setState(
      env.DB,
      decisionKey,
      JSON.stringify({
        hash,
        from: status,
        to: !proceed ? null : duplicate ? "duplicate" : (next ?? now),
      } satisfies Decision),
    );
  // Cache before removing the trigger label, so its webhook cannot start a
  // second run. Result retries still apply GitHub changes if that write failed.
  await patchIssue(env.DB, issue.number, {
    summary: result.summary,
    triage: result,
    triagedAt: nowIso(),
    ...(duplicate ? { duplicateOf: duplicate.number } : {}),
  });
  const changed = duplicate ? "duplicate" : next !== status && next !== "new" ? next : null;
  await setAssessmentNote(
    env.DB,
    issue.number,
    changed
      ? {
          status: changed,
          text:
            changed === "confirmed"
              ? `Set by the assessment: the reported release already has the fix from ${resolution!.commit!.slice(0, 7)}, so this broke again.`
              : "Set by the assessment.",
          author: ASSESSMENT,
        }
      : null,
  );
  // The moved Discord post says who moved it.
  if (patch.type && current.type) await setState(env.DB, reclassifiedKey(issue.number), kind);
  await github.request("PATCH", issuePath, patch);
  // Recorded as Mark as fixed records a fix; a retry only finishes it.
  if (fix) {
    if (!issue.fixes.some((existing) => existing.sha === fix.sha))
      await recordNightlyFix(
        env,
        issue,
        fix,
        `The assessment verified this is fixed in the code by ${fix.url}. Published releases will be checked for this fix.`,
      );
    await checkReleases(env, issue.number, releases);
  }
  await enqueue(env, "sync-issue", String(issue.number), { number: issue.number });
  // triagedAt is cached before the GitHub write; this marks the result applied.
  await setState(env.DB, `triage:applied:${issue.number}`, nowIso());
  // The assessment card shows what this result changed.
  await enqueueAgentStatus(env, issue.number, "investigate");
  // The pull request gets the closing reference that pull request tracking
  // follows (open: In Progress, merged: In Nightly), and a maintainer can remove.
  if (pull) await linkPull(env, pull.number, issue.number);
  await setState(env.DB, key, hash);
}
