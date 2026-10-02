import {
  AREAS,
  ISSUE_TYPES,
  PRIORITIES,
  STATUSES,
  STATUS_BY_ID,
  areaLabel,
  priorityLabel,
  type IssueKind,
  type StatusId,
} from "./config";
import { labelNames, type GhIssue } from "./github/types";
import { parseMeta } from "./report/body";

// GitHub is canonical. Status is derived from the issue's state, close reason,
// status label, and milestone; the hub keeps exactly one status label applied.

const OPEN_PRECEDENCE: StatusId[] = [
  "in_nightly",
  "in_progress",
  "planned",
  "confirmed",
  "needs_info",
  "new",
];

const labelToStatus = new Map(
  STATUSES.filter((status) => status.githubLabel).map((status) => [status.githubLabel!, status.id]),
);

export function statusGithubLabel(status: StatusId): string | undefined {
  return STATUS_BY_ID.get(status)?.githubLabel;
}

export function deriveStatus(issue: Pick<GhIssue, "state" | "state_reason" | "labels">): StatusId {
  const names = new Set(labelNames(issue));
  if (issue.state === "closed") {
    if (issue.state_reason === "duplicate") return "duplicate";
    if (issue.state_reason === "not_planned") {
      return names.has(statusGithubLabel("cant_reproduce")!) ? "cant_reproduce" : "declined";
    }
    return names.has(statusGithubLabel("shipped")!) ? "shipped" : "done";
  }
  for (const status of OPEN_PRECEDENCE) {
    if (names.has(statusGithubLabel(status)!)) return status;
  }
  return "new";
}

export function issueKind(issue: Pick<GhIssue, "type" | "body" | "labels">): IssueKind | null {
  const typeName = issue.type?.name?.toLowerCase();
  if (typeName === ISSUE_TYPES.bug.githubType.toLowerCase()) return "bug";
  if (typeName === ISSUE_TYPES.feature.githubType.toLowerCase()) return "feature";
  if (typeName) return null;
  return parseMeta(issue.body)?.kind ?? null;
}

export function issueArea(issue: Pick<GhIssue, "labels">): string | null {
  const names = labelNames(issue);
  return AREAS.find((area) => names.includes(areaLabel(area.id)))?.id ?? null;
}

export function issuePriority(issue: Pick<GhIssue, "labels">): string | null {
  const names = labelNames(issue);
  return PRIORITIES.find((priority) => names.includes(priorityLabel(priority.id)))?.id ?? null;
}

export interface LabelContext {
  /** The label that triggered this sync, if a person just added it. */
  addedLabel?: string | null;
  /** The issue was just reopened. */
  reopened?: boolean;
}

export interface LabelPlan {
  add: string[];
  remove: string[];
}

/**
 * Compute the label changes that keep exactly one consistent status label, one
 * area label, and one priority label on an issue.
 */
export function planLabels(
  issue: Pick<GhIssue, "state" | "state_reason" | "labels"> & {
    milestone: { number: number } | null;
  },
  context: LabelContext = {},
): LabelPlan {
  const names = labelNames(issue);
  const present = new Set(names);
  const desired = new Set(names);

  const statusLabels = names.filter((name) => labelToStatus.has(name));
  for (const name of statusLabels) desired.delete(name);

  if (issue.state === "open") {
    const added = context.addedLabel ? labelToStatus.get(context.addedLabel) : undefined;
    const openPresent = statusLabels
      .map((name) => labelToStatus.get(name)!)
      .filter((status) => STATUS_BY_ID.get(status)!.open);
    let chosen: StatusId =
      added && STATUS_BY_ID.get(added)!.open
        ? added
        : (OPEN_PRECEDENCE.find((status) => openPresent.includes(status)) ??
          (context.reopened ? "confirmed" : "new"));
    if (issue.milestone && (chosen === "new" || chosen === "confirmed")) chosen = "planned";
    if (!issue.milestone && chosen === "planned") chosen = "confirmed";
    desired.add(statusGithubLabel(chosen)!);
  } else if (issue.state_reason === "not_planned") {
    if (present.has(statusGithubLabel("cant_reproduce")!)) {
      desired.add(statusGithubLabel("cant_reproduce")!);
    } else {
      desired.add(statusGithubLabel("declined")!);
    }
  } else if (issue.state_reason !== "duplicate" && present.has(statusGithubLabel("shipped")!)) {
    desired.add(statusGithubLabel("shipped")!);
  }

  for (const prefix of ["area: ", "priority: "]) {
    const matching = names.filter((name) => name.startsWith(prefix));
    if (matching.length > 1) {
      const keep =
        context.addedLabel && matching.includes(context.addedLabel)
          ? context.addedLabel
          : matching[matching.length - 1]!;
      for (const name of matching) if (name !== keep) desired.delete(name);
    }
  }

  return {
    add: [...desired].filter((name) => !present.has(name)),
    remove: names.filter((name) => !desired.has(name)),
  };
}

/** Statuses a maintainer can move an issue to from Discord. */
export const MAINTAINER_TRANSITIONS: Record<StatusId, StatusId[]> = {
  new: ["confirmed", "needs_info", "duplicate", "declined", "cant_reproduce"],
  needs_info: ["confirmed", "duplicate", "declined", "cant_reproduce"],
  confirmed: ["in_progress", "needs_info", "duplicate", "declined", "cant_reproduce"],
  planned: ["in_progress", "confirmed", "duplicate", "declined"],
  in_progress: ["in_nightly", "confirmed", "declined"],
  in_nightly: ["shipped", "in_progress"],
  shipped: ["confirmed"],
  done: ["confirmed"],
  duplicate: ["confirmed"],
  declined: ["confirmed"],
  cant_reproduce: ["confirmed"],
};

/** Closing keywords GitHub understands, applied to text from PRs and commits. */
export function referencedIssues(text: string | null | undefined): number[] {
  if (!text) return [];
  const pattern =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:SakuraCordApp\/SakuraCord)?#(\d+)/gi;
  const numbers = new Set<number>();
  for (const match of text.matchAll(pattern)) numbers.add(Number(match[1]));
  return [...numbers];
}
