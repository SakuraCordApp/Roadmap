import { AGENT_LABELS, STATUS_BY_ID, type StatusId } from "./config";
import { getIssue, patchIssue, setPendingNote } from "./db/store";
import type { Env } from "./env";
import { GitHub } from "./github/client";
import { labelNames, type GhIssue, type GhMilestone } from "./github/types";
import { enqueue } from "./jobs/queue";
import { statusGithubLabel } from "./lifecycle";
import { neutralizeUserText } from "./report/body";
import { NO_MIRROR } from "./sync/markers";

export type MaintainerAction =
  | "confirm"
  | "needs_info"
  | "in_progress"
  | "plan"
  | "unplan"
  | "duplicate"
  | "decline"
  | "cant_reproduce"
  | "reopen"
  | "investigate"
  | "fix";

export interface ActionOption {
  value: MaintainerAction;
  label: string;
  description: string;
  emoji: string;
  /** Needs a text answer (opens a modal). */
  input?: { label: string; placeholder: string; required: boolean; short?: boolean };
}

export function actionOptions(status: StatusId, kind: "bug" | "feature" | null): ActionOption[] {
  const open = STATUS_BY_ID.get(status)!.open;
  const feature = kind === "feature";
  const options: ActionOption[] = [];
  if (open) {
    if (status === "new" || status === "needs_info") {
      options.push({
        value: "confirm",
        label: feature ? "Accept" : "Confirm",
        description: feature ? "Accept this suggestion" : "Confirm this bug",
        emoji: "✅",
        input: {
          label: "Note for the reporter (optional)",
          placeholder: "Thanks! …",
          required: false,
        },
      });
    }
    if (status !== "needs_info") {
      options.push({
        value: "needs_info",
        label: "Ask for more information",
        description: "Ping the reporter with questions",
        emoji: "❓",
        input: {
          label: "What do you need to know?",
          placeholder: "Which macOS version…",
          required: true,
        },
      });
    }
    options.push({
      value: "plan",
      label: "Plan for a version…",
      description: "Assign a milestone",
      emoji: "🗓️",
    });
    if (status === "planned") {
      options.push({
        value: "unplan",
        label: "Remove from version",
        description: "Clear the milestone",
        emoji: "↩️",
      });
    }
    if (status !== "in_progress") {
      options.push({
        value: "in_progress",
        label: "Mark in progress",
        description: "Someone is working on it",
        emoji: "🛠️",
      });
    }
    options.push({
      value: "duplicate",
      label: "Close as duplicate…",
      description: "Merge into another report",
      emoji: "🔁",
      input: {
        label: "Duplicate of issue number",
        placeholder: "123",
        required: true,
        short: true,
      },
    });
    options.push({
      value: "decline",
      label: feature ? "Decline…" : "Won't fix…",
      description: "Close as not planned",
      emoji: "🚫",
      input: {
        label: "Reason (shown publicly)",
        placeholder: "This is out of scope because…",
        required: true,
      },
    });
    if (!feature) {
      options.push({
        value: "cant_reproduce",
        label: "Can't reproduce…",
        description: "Close until there's more information",
        emoji: "🔍",
        input: { label: "Note (shown publicly)", placeholder: "We tried on…", required: false },
      });
    }
    options.push({
      value: "investigate",
      label: "Run triage & investigation",
      description: "Assess the report and inspect the code",
      emoji: "🔎",
    });
    options.push({
      value: "fix",
      label: "Run fix agent",
      description: "Open a draft pull request with a fix",
      emoji: "🤖",
    });
  } else {
    options.push({
      value: "reopen",
      label: "Reopen",
      description: "Reopen this report",
      emoji: "🔄",
    });
  }
  return options;
}

const exclusive = (labels: string[], status: StatusId) => [
  ...labels.filter((name) => !name.startsWith("status: ")),
  statusGithubLabel(status)!,
];

/** Apply a maintainer action on GitHub. Discord follows via the sync job. */
export async function performAction(
  env: Env,
  number: number,
  action: MaintainerAction,
  actor: string,
  input: { note?: string; milestone?: number | null } = {},
): Promise<string> {
  const github = new GitHub(env);
  const path = github.repo(`/issues/${number}`);
  const issue = await github.request<GhIssue>("GET", path);
  const labels = labelNames(issue);
  const note = input.note?.trim();
  const comment = async (text: string) =>
    github.request("POST", github.repo(`/issues/${number}/comments`), {
      body: `${NO_MIRROR}\n${neutralizeUserText(text)}\n\n<sub>— ${neutralizeUserText(actor)} via Discord</sub>`,
    });
  let message: string;
  switch (action) {
    case "confirm":
      await github.request("PATCH", path, { labels: exclusive(labels, "confirmed") });
      if (note) {
        await setPendingNote(
          env.DB,
          number,
          issue.milestone ? "planned" : "confirmed",
          note,
          actor,
        );
        await comment(note);
      }
      message = "Confirmed.";
      break;
    case "needs_info":
      await setPendingNote(env.DB, number, "needs_info", note ?? "", actor);
      await github.request("PATCH", path, { labels: exclusive(labels, "needs_info") });
      if (note) await comment(note);
      message = "Asked the reporter for more information.";
      break;
    case "in_progress":
      await github.request("PATCH", path, { labels: exclusive(labels, "in_progress") });
      message = "Marked in progress.";
      break;
    case "plan": {
      if (!input.milestone) throw new Error("Pick a milestone.");
      const status: StatusId = labels.includes(statusGithubLabel("in_progress")!)
        ? "in_progress"
        : labels.includes(statusGithubLabel("in_nightly")!)
          ? "in_nightly"
          : "planned";
      await github.request("PATCH", path, {
        milestone: input.milestone,
        labels: exclusive(labels, status),
      });
      const milestone = await github.request<GhMilestone>(
        "GET",
        github.repo(`/milestones/${input.milestone}`),
      );
      message = `Planned for v${milestone.title}.`;
      break;
    }
    case "unplan":
      await github.request("PATCH", path, {
        milestone: null,
        labels: exclusive(labels, "confirmed"),
      });
      message = "Removed from its version.";
      break;
    case "duplicate": {
      const target = Number((note ?? "").replace(/[^\d]/g, ""));
      if (!target || target === number) throw new Error("Enter the number of the original report.");
      const original = await github.request<GhIssue>("GET", github.repo(`/issues/${target}`));
      await patchIssue(env.DB, number, { duplicateOf: target });
      await github.request("PATCH", path, {
        state: "closed",
        state_reason: "duplicate",
        duplicate_issue_id: original.id,
        labels: labels.filter((name) => !name.startsWith("status: ")),
      });
      message = `Closed as a duplicate of #${target}.`;
      break;
    }
    case "decline":
      if (note) await setPendingNote(env.DB, number, "declined", note, actor);
      if (note) await comment(note);
      await github.request("PATCH", path, {
        state: "closed",
        state_reason: "not_planned",
        labels: exclusive(labels, "declined"),
      });
      message = "Closed as not planned.";
      break;
    case "cant_reproduce":
      if (note) await setPendingNote(env.DB, number, "cant_reproduce", note, actor);
      if (note) await comment(note);
      await github.request("PATCH", path, {
        state: "closed",
        state_reason: "not_planned",
        labels: exclusive(labels, "cant_reproduce"),
      });
      message = "Closed as can't reproduce.";
      break;
    case "reopen":
      await github.request("PATCH", path, {
        state: "open",
        state_reason: "reopened",
        labels: exclusive(labels, issue.milestone ? "planned" : "confirmed"),
      });
      message = "Reopened.";
      break;
    case "investigate":
      if (labels.includes(AGENT_LABELS.investigate.name)) {
        await github.request(
          "DELETE",
          github.repo(
            `/issues/${number}/labels/${encodeURIComponent(AGENT_LABELS.investigate.name)}`,
          ),
        );
      }
      await github.request("POST", github.repo(`/issues/${number}/labels`), {
        labels: [AGENT_LABELS.investigate.name],
      });
      message =
        "The triage and investigation agent is starting. Its assessment will be posted here.";
      break;
    case "fix":
      await github.request("POST", github.repo(`/issues/${number}/labels`), {
        labels: [AGENT_LABELS.fix.name],
      });
      message = "The fix agent is starting. It will open a draft pull request when it's done.";
      break;
  }
  await enqueue(env, "sync-issue", String(number), { number });
  return message;
}

/** Open milestones from the synced cache (fast enough for Discord's 3-second window). */
export async function openMilestones(env: Env): Promise<GhMilestone[]> {
  const { results } = await env.DB.prepare(
    "SELECT number,title,description FROM milestones WHERE state='open'",
  ).all<{ number: number; title: string; description: string }>();
  return results
    .map((row) => ({ ...row, state: "open" }) as unknown as GhMilestone)
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}

export async function issueExists(env: Env, number: number) {
  return Boolean(await getIssue(env.DB, number));
}
