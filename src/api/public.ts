import {
  AREAS,
  DISCORD,
  ISSUE_TYPES,
  PRIORITIES,
  STATUSES,
  STATUS_BY_ID,
  type IssueKind,
} from "../config";
import {
  allPrimaryThreads,
  eventsForIssue,
  getIssue,
  listIssues,
  primaryThread,
  voteCount,
  voteCounts,
  type IssueRecord,
} from "../db/store";
import { issueUrl, threadUrl } from "../discord/cards";
import type { Env } from "../env";
import { loadVersions, visibleVersions } from "../roadmap";
import { parseSections } from "../report/body";
import { sha256 } from "../util/crypto";
import { json } from "../util/http";

export interface TrackerIssue {
  number: number;
  title: string;
  kind: IssueKind;
  status: string;
  area: string | null;
  priority: string | null;
  summary: string | null;
  votes: number;
  milestone: string | null;
  shippedIn: string | null;
  duplicateOf: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  url: string;
  threadUrl: string | null;
}

export function publicMeta() {
  return {
    kinds: (Object.keys(ISSUE_TYPES) as IssueKind[]).map((id) => ({
      id,
      label: ISSUE_TYPES[id].label,
      plural: ISSUE_TYPES[id].plural,
    })),
    statuses: STATUSES.map((status) => ({
      id: status.id,
      label: status.label,
      featureLabel: status.featureLabel ?? status.label,
      description: status.description,
      color: `#${status.color}`,
      open: status.open,
      emoji: status.emoji,
    })),
    areas: AREAS.map((area) => ({
      id: area.id,
      label: area.label,
      emoji: area.emoji,
      description: area.description,
      color: `#${area.color}`,
    })),
    priorities: PRIORITIES.map((priority) => ({
      id: priority.id,
      label: priority.label,
      color: `#${priority.color}`,
      description: priority.description,
    })),
  };
}

function toTracker(issue: IssueRecord, votes: number, thread: string | null): TrackerIssue {
  return {
    number: issue.number,
    title: issue.title,
    kind: issue.kind!,
    status: issue.status,
    area: issue.area,
    priority: issue.priority,
    summary: issue.summary,
    votes: votes + issue.reactionsUp,
    milestone: issue.milestoneTitle,
    shippedIn: issue.shippedStableIn ?? issue.shippedIn,
    duplicateOf: issue.duplicateOf,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    url: issueUrl(issue.number),
    threadUrl: thread ? threadUrl(DISCORD.guildId, thread) : null,
  };
}

export async function trackerSnapshot(env: Env) {
  const [issues, votes, threads] = await Promise.all([
    listIssues(env.DB),
    voteCounts(env.DB),
    allPrimaryThreads(env.DB),
  ]);
  const items = issues
    .filter((issue) => issue.kind)
    .map((issue) =>
      toTracker(issue, votes.get(issue.number) ?? 0, threads.get(issue.number)?.threadId ?? null),
    );
  const body = { issues: items, meta: publicMeta() };
  const etag = `"${(await sha256(JSON.stringify(body))).slice(0, 32)}"`;
  return { ...body, etag };
}

export async function issueDetail(env: Env, number: number) {
  const issue = await getIssue(env.DB, number);
  if (!issue?.kind) return null;
  const [votes, thread, events] = await Promise.all([
    voteCount(env.DB, number),
    primaryThread(env.DB, number),
    eventsForIssue(env.DB, number),
  ]);
  const sections = parseSections(issue.body);
  const attachments: Array<{ name: string; url: string; image: boolean }> = [];
  for (const section of sections) {
    for (const match of section.text.matchAll(/(!?)\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g)) {
      if (/screenshots|mockups|attachments/i.test(section.heading) || match[1] === "!") {
        attachments.push({
          name: match[2] || "attachment",
          url: match[3]!,
          image: match[1] === "!",
        });
      }
    }
  }
  return {
    ...toTracker(issue, votes, thread?.threadId ?? null),
    labels: issue.labels,
    reporter: issue.reporter ? { name: issue.reporter.name, source: issue.reporter.source } : null,
    sections: sections
      .filter(
        (section) => !/^(screenshots or recordings|mockups or examples)$/i.test(section.heading),
      )
      .map((section) => ({
        heading: section.heading,
        text: section.text.replace(/!\[[^\]]*\]\([^)]+\)/g, "").trim(),
      }))
      .filter((section) => section.text),
    attachments,
    fixes: issue.fixes.map((fix) => ({
      kind: fix.kind,
      number: fix.number ?? null,
      sha: fix.sha ?? null,
      url: fix.url,
      title: fix.title ?? null,
      state: fix.state,
    })),
    shippedStableIn: issue.shippedStableIn,
    timeline: events
      .filter((event) => event.kind !== "comment" || typeof event.data.body === "string")
      .map((event) => ({ kind: event.kind, createdAt: event.createdAt, data: event.data })),
    open: STATUS_BY_ID.get(issue.status)!.open,
  };
}

export async function roadmapData(env: Env) {
  const versions = await loadVersions(env.DB);
  return { versions, visible: visibleVersions(versions).map((version) => version.number) };
}

export async function cachedJson(
  request: Request,
  data: unknown,
  etag?: string,
): Promise<Response> {
  const tag = etag ?? `"${(await sha256(JSON.stringify(data))).slice(0, 32)}"`;
  if (request.headers.get("If-None-Match") === tag) {
    return new Response(null, { status: 304, headers: { ETag: tag } });
  }
  return json(data, 200, {
    ETag: tag,
    "Cache-Control": "public, max-age=15, stale-while-revalidate=60",
    "Access-Control-Allow-Origin": "*",
  });
}
