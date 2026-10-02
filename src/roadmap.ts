import { DISCORD } from "./config";
import { getJsonState, getState, setState } from "./db/store";
import { roadmapMessage, type RoadmapVersion } from "./discord/cards";
import { isDiscordStatus } from "./discord/rest";
import { discordClient } from "./discord/threads";
import type { Env } from "./env";
import { sha256 } from "./util/crypto";

// Milestones are the roadmap. A milestone's description follows a small
// convention so it reads well on GitHub and renders on the website and Discord:
//
//   Stay connected                      <- first line: version headline
//   A more complete communication...    <- optional summary paragraph
//
//   - Inbox, friends, and message requests (#123, #130)   <- highlights

export interface MilestoneRow {
  number: number;
  title: string;
  description: string;
  state: "open" | "closed";
  due_on: string | null;
  closed_at: string | null;
  open_issues: number;
  closed_issues: number;
  html_url: string | null;
}

export interface ParsedVersion {
  number: number;
  version: string;
  headline: string;
  summary: string;
  highlights: Array<{ text: string; issues: number[] }>;
  state: "open" | "closed";
  dueOn: string | null;
  closedAt: string | null;
  openIssues: number;
  closedIssues: number;
  url: string | null;
}

export function parseMilestone(row: MilestoneRow): ParsedVersion {
  const lines = (row.description ?? "").replace(/\r\n?/g, "\n").split("\n");
  const highlights: ParsedVersion["highlights"] = [];
  const prose: string[] = [];
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      const issues = [...bullet[1]!.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
      const text = bullet[1]!.replace(/\s*\((?:\s*#\d+\s*,?)+\)\s*$/, "").trim();
      highlights.push({ text, issues });
    } else {
      prose.push(line);
    }
  }
  const paragraphs = prose
    .join("\n")
    .trim()
    .split(/\n\s*\n/);
  const firstParagraph = paragraphs[0]?.split("\n") ?? [];
  const headline = firstParagraph[0]?.trim() ?? "";
  const summary = [firstParagraph.slice(1).join(" "), ...paragraphs.slice(1)].join("\n\n").trim();
  return {
    number: row.number,
    version: row.title,
    headline: headline || `Version ${row.title}`,
    summary,
    highlights,
    state: row.state,
    dueOn: row.due_on,
    closedAt: row.closed_at,
    openIssues: row.open_issues,
    closedIssues: row.closed_issues,
    url: row.html_url,
  };
}

export function renderMilestoneDescription(version: {
  headline: string;
  summary?: string;
  highlights: Array<{ text: string; issues: number[] }>;
}): string {
  const highlights = version.highlights.map(
    (highlight) =>
      `- ${highlight.text}${highlight.issues.length ? ` (${highlight.issues.map((n) => `#${n}`).join(", ")})` : ""}`,
  );
  return [version.headline, version.summary ?? "", "", ...highlights]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

export async function loadVersions(db: D1Database): Promise<ParsedVersion[]> {
  const { results } = await db.prepare("SELECT * FROM milestones").all<MilestoneRow>();
  return results.map(parseMilestone).sort((a, b) => compareVersions(a.version, b.version));
}

/** The latest shipped version plus every open (upcoming) version. */
export function visibleVersions(versions: ParsedVersion[]): ParsedVersion[] {
  const open = versions.filter((version) => version.state === "open");
  const closed = versions.filter((version) => version.state === "closed");
  const latest = closed.sort((a, b) => compareVersions(b.version, a.version))[0];
  return [...(latest ? [latest] : []), ...open];
}

async function roadmapEmoji(env: Env): Promise<{ dot?: string; line?: string }> {
  const cached = await getJsonState<{ dot?: string; line?: string } | null>(
    env.DB,
    "discord:roadmap-emoji",
    null,
  );
  if (cached) return cached;
  const emojis = await discordClient(env)
    .get<Array<{ id: string; name: string }>>(`/guilds/${DISCORD.guildId}/emojis`)
    .catch(() => []);
  const result = {
    dot: emojis.find((emoji) => emoji.name === "sakura_roadmap_dot")?.id,
    line: emojis.find((emoji) => emoji.name === "sakura_roadmap_line")?.id,
  };
  await setState(env.DB, "discord:roadmap-emoji", JSON.stringify(result));
  return result;
}

export async function publishRoadmap(env: Env, payload: { force?: boolean } = {}): Promise<void> {
  const versions: RoadmapVersion[] = visibleVersions(await loadVersions(env.DB)).map((version) => ({
    version: version.version,
    title: version.headline,
    highlights: version.highlights.map((highlight) => highlight.text),
    state: version.state,
    ...(version.state === "open"
      ? { progress: { open: version.openIssues, closed: version.closedIssues } }
      : {}),
  }));
  const message = roadmapMessage(versions, env.WEBSITE_URL, await roadmapEmoji(env));
  const hash = await sha256(JSON.stringify(message));
  const messageId = await getState(env.DB, "discord:roadmap-message-id");
  if (!payload.force && messageId && hash === (await getState(env.DB, "discord:roadmap-hash")))
    return;
  const discord = discordClient(env);
  let id = messageId;
  if (id) {
    try {
      await discord.patch(`/channels/${DISCORD.roadmapChannelId}/messages/${id}`, {
        ...message,
        content: null,
        embeds: [],
      });
    } catch (error) {
      if (!isDiscordStatus(error, 404)) throw error;
      id = null;
    }
  }
  if (!id) {
    const created = await discord.post<{ id: string }>(
      `/channels/${DISCORD.roadmapChannelId}/messages`,
      message,
    );
    id = created.id;
  }
  await setState(env.DB, "discord:roadmap-message-id", id);
  await setState(env.DB, "discord:roadmap-hash", hash);
}
