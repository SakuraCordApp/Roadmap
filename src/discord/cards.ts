import {
  AREAS,
  BRAND,
  ISSUE_TYPES,
  PRIORITIES,
  REPOSITORY_URL,
  STATUS_BY_ID,
  statusLabel,
  type IssueKind,
  type StatusId,
} from "../config";
import type { IssueRecord } from "../db/store";
import { parseSections } from "../report/body";
import { escapeDiscord, plural, truncate } from "../util/text";

export const COMPONENTS_V2 = 1 << 15;
export const EPHEMERAL = 1 << 6;

const kindEmoji = (kind: IssueKind | null) => (kind === "feature" ? "✨" : "🐞");

export function colorOf(status: StatusId): number {
  return Number.parseInt(STATUS_BY_ID.get(status)!.color, 16);
}

export function issueUrl(number: number) {
  return `${REPOSITORY_URL}/issues/${number}`;
}

export function trackerUrl(websiteUrl: string, number: number) {
  return `${websiteUrl}/tracker/items/${number}`;
}

export function threadUrl(guildId: string, threadId: string) {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

function sectionText(issue: IssueRecord, headings: string[]): string | undefined {
  const sections = parseSections(issue.body);
  for (const heading of headings) {
    const found = sections.find(
      (section) => section.heading.toLowerCase() === heading.toLowerCase(),
    );
    if (found) return found.text;
  }
  return undefined;
}

function reporterLine(issue: IssueRecord): string | null {
  const reporter = issue.reporter;
  if (reporter?.discordId) {
    return reporter.source === "legacy"
      ? `Originally reported by <@${reporter.discordId}>`
      : `Reported by <@${reporter.discordId}>`;
  }
  if (reporter?.githubLogin || (issue.authorLogin && issue.authorType !== "Bot")) {
    return `Reported by **${escapeDiscord(reporter?.githubLogin ?? issue.authorLogin!)}** on GitHub`;
  }
  if (reporter?.name) return `Reported by **${escapeDiscord(reporter.name)}**`;
  return null;
}

function progressLine(issue: IssueRecord): string | null {
  if (issue.status === "duplicate" && issue.duplicateOf) {
    return `🔁 Duplicate of [#${issue.duplicateOf}](${issueUrl(issue.duplicateOf)})`;
  }
  if (issue.shippedStableIn) return `🌸 Shipped in SakuraCord ${issue.shippedStableIn}`;
  if (issue.shippedIn) return `🌸 Shipped in SakuraCord ${issue.shippedIn}`;
  const fixes = issue.fixes.filter((fix) => fix.state !== "closed");
  if (fixes.length) {
    return fixes
      .slice(0, 3)
      .map((fix) =>
        fix.kind === "pr"
          ? `🔧 [PR #${fix.number}](${fix.url})${fix.state === "merged" ? " (merged)" : ""}`
          : `🔧 [Commit ${fix.sha?.slice(0, 7)}](${fix.url})`,
      )
      .join(" · ");
  }
  if (issue.milestoneTitle && issue.state === "open")
    return `🗓️ Planned for v${issue.milestoneTitle}`;
  return null;
}

export interface CardContext {
  websiteUrl: string;
  votes: number;
  attachmentUrls?: Array<{ url: string; description?: string }>;
}

/** The report card: the thread's starter message for reports filed through the hub. */
export function issueCard(issue: IssueRecord, context: CardContext) {
  const status = STATUS_BY_ID.get(issue.status)!;
  const area = AREAS.find((value) => value.id === issue.area);
  const priority = PRIORITIES.find((value) => value.id === issue.priority);
  const meta = [
    `#${issue.number}`,
    issue.kind ? ISSUE_TYPES[issue.kind].label : null,
    area ? `${area.emoji} ${area.label}` : null,
    priority ? `${priority.label} priority` : null,
  ].filter(Boolean);
  const description =
    issue.kind === "feature"
      ? sectionText(issue, ["What would you like?", "Description"])
      : sectionText(issue, ["What happened?", "Description"]);
  const secondary =
    issue.kind === "feature"
      ? sectionText(issue, ["Why do you want it?"])
      : sectionText(issue, ["Steps to reproduce"]);
  const environment = [
    sectionText(issue, ["SakuraCord version"]),
    sectionText(issue, ["macOS version"]),
    sectionText(issue, ["Mac model"]),
  ].filter((value): value is string => Boolean(value));

  const blocks: unknown[] = [
    {
      type: 10,
      content: `## ${kindEmoji(issue.kind)} ${escapeDiscord(truncate(issue.title, 180))}\n-# ${meta.join(" · ")}`,
    },
    {
      type: 10,
      content: `**${status.emoji} ${statusLabel(issue.status, issue.kind)}** — ${status.description}`,
    },
  ];
  if (issue.summary || description) {
    blocks.push({ type: 14, divider: true, spacing: 1 });
    blocks.push({
      type: 10,
      content: escapeDiscord(truncate(description ?? issue.summary ?? "", 900)),
    });
  }
  if (secondary) {
    blocks.push({
      type: 10,
      content: `**${issue.kind === "feature" ? "Why" : "Steps to reproduce"}**\n${escapeDiscord(truncate(secondary, 600))}`,
    });
  }
  const gallery = (context.attachmentUrls ?? [])
    .filter((item) => /^https:\/\//.test(item.url))
    .slice(0, 10);
  if (gallery.length) {
    blocks.push({
      type: 12,
      items: gallery.map((item) => ({
        media: { url: item.url },
        ...(item.description ? { description: truncate(item.description, 200) } : {}),
      })),
    });
  }
  const footer = [
    environment.length ? environment.map(escapeDiscord).join(" · ") : null,
    reporterLine(issue),
    progressLine(issue),
  ].filter(Boolean);
  if (footer.length)
    blocks.push({ type: 10, content: footer.map((line) => `-# ${line}`).join("\n") });

  const votes = context.votes;
  return {
    flags: COMPONENTS_V2,
    components: [
      { type: 17, accent_color: colorOf(issue.status), components: blocks },
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            custom_id: `i:vote:${issue.number}`,
            emoji: { name: "👍" },
            label: votes ? `Me too · ${votes}` : "Me too",
            disabled: !status.open,
          },
          {
            type: 2,
            style: 2,
            custom_id: `i:details:${issue.number}`,
            emoji: { name: "📎" },
            label: "Add details",
            disabled: !status.open,
          },
          { type: 2, style: 5, label: "GitHub", url: issueUrl(issue.number) },
          {
            type: 2,
            style: 5,
            label: "Tracker",
            url: trackerUrl(context.websiteUrl, issue.number),
          },
          {
            type: 2,
            style: 2,
            custom_id: `i:manage:${issue.number}`,
            emoji: { name: "⚙️" },
            label: "Manage",
          },
        ],
      },
    ],
  };
}

export interface StatusMessageInput {
  issue: IssueRecord;
  previous: StatusId | null;
  note?: { text: string; author: string } | null;
  duplicateThreadId?: string | null;
}

/** The message posted in a thread when an issue's status changes. */
export function statusMessageText(input: StatusMessageInput): string {
  const { issue } = input;
  const feature = issue.kind === "feature";
  const label = statusLabel(issue.status, issue.kind);
  const fix = issue.fixes.find((value) => value.state === "merged") ?? issue.fixes[0];
  const fixText = fix
    ? fix.kind === "pr"
      ? ` in [PR #${fix.number}](${fix.url})`
      : ` in [${fix.sha?.slice(0, 7)}](${fix.url})`
    : "";
  const reopened =
    input.previous &&
    !STATUS_BY_ID.get(input.previous)!.open &&
    STATUS_BY_ID.get(issue.status)!.open;
  let text: string;
  switch (issue.status) {
    case "new":
      text = reopened
        ? "🔄 **Reopened.** The team will take another look."
        : "🌱 **Back in triage.**";
      break;
    case "needs_info": {
      const questions = issue.triage?.needsInformation ? issue.triage.questions : [];
      text = `❓ **More information needed.**${questions.length ? `\n${questions.map((q) => `> ${escapeDiscord(q)}`).join("\n")}` : ""}\n-# Reply in this post or use **Add details** on the report card.`;
      break;
    }
    case "confirmed":
      text = reopened
        ? `🔄 **Reopened** and ${feature ? "accepted" : "confirmed"}.`
        : feature
          ? "✅ **Accepted.** This suggestion is on the list."
          : "✅ **Confirmed.** The team has confirmed this bug.";
      break;
    case "planned":
      text = `🗓️ **Planned${issue.milestoneTitle ? ` for v${issue.milestoneTitle}` : ""}.**`;
      break;
    case "in_progress":
      text = `🛠️ **In progress**${fixText}.`;
      break;
    case "in_nightly":
      text = feature
        ? `🌙 **Implemented in nightly**${fixText}. It ships with the next nightly build.`
        : `🌙 **Fixed in nightly**${fixText}. The fix ships with the next nightly build.`;
      break;
    case "shipped":
      text =
        issue.shippedStableIn && issue.shippedIn !== issue.shippedStableIn
          ? `🌸 **Now in the regular release: SakuraCord ${issue.shippedStableIn}.**`
          : `🌸 **Shipped in SakuraCord ${issue.shippedIn ?? "the latest release"}!** Update from **SakuraCord → Check for Updates…**`;
      break;
    case "done":
      text = `✔️ **${feature ? "Done" : "Fixed"}.** Closed as completed.`;
      break;
    case "duplicate":
      text = issue.duplicateOf
        ? `🔁 **Duplicate of [#${issue.duplicateOf}](${issueUrl(issue.duplicateOf)}).**${input.duplicateThreadId ? ` Follow <#${input.duplicateThreadId}> for updates — your vote moved there.` : ""}`
        : "🔁 **Closed as a duplicate.**";
      break;
    case "declined":
      text = `🚫 **${label}.**`;
      break;
    case "cant_reproduce":
      text =
        "🔍 **Can't reproduce.** If it happens again, use **Add details** with new information and we'll take another look.";
      break;
  }
  if (input.note?.text) {
    text += `\n> ${escapeDiscord(truncate(input.note.text, 1500)).replace(/\n/g, "\n> ")}\n-# — ${escapeDiscord(input.note.author)}`;
  }
  return text;
}

/** Only completed reports ping their subscribers. */
export const PING_SUBSCRIBERS: ReadonlySet<StatusId> = new Set(["shipped", "done"]);

export function guidePost(kind: IssueKind, websiteUrl: string) {
  const bug = kind === "bug";
  const body = bug
    ? [
        "## 🐞 Report a bug",
        "Found something broken in SakuraCord? Press **Report a bug** below (or type `/bug` anywhere in the server).",
        "",
        "**How it works**",
        "1. Fill in a short form: what happened, how bad it is, and your SakuraCord version.",
        "2. We check for similar reports first, so you can add yourself to an existing one instead of filing a duplicate.",
        "3. Your report gets its own post here and a GitHub issue. You'll be pinged when it's completed.",
        "",
        "-# Already reported? Press 👍 **Me too** on the report to follow it and help us prioritize.",
      ]
    : [
        "## ✨ Suggest a feature",
        "Have an idea for SakuraCord? Press **Suggest a feature** below (or type `/suggest`).",
        "",
        "**How it works**",
        "1. Describe what you'd like and why it matters to you.",
        "2. We show similar suggestions first, so you can vote for an existing one instead of starting a new post.",
        "3. Each suggestion gets its own post here and a GitHub issue. You'll be pinged when it's completed.",
        "",
        "-# Votes matter: press 👍 **Me too** on suggestions you want.",
      ];
  return {
    flags: COMPONENTS_V2,
    allowed_mentions: { parse: [] },
    components: [
      {
        type: 17,
        accent_color: BRAND.primary,
        components: [{ type: 10, content: body.join("\n") }],
      },
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            custom_id: `r:${kind}`,
            emoji: { name: bug ? "🐞" : "✨" },
            label: bug ? "Report a bug" : "Suggest a feature",
          },
          {
            type: 2,
            style: 5,
            label: "Browse the tracker",
            url: `${websiteUrl}/tracker?kind=${kind}`,
          },
          {
            type: 2,
            style: 5,
            label: "Report on the web",
            url: `${websiteUrl}/report?type=${kind}`,
          },
        ],
      },
    ],
  };
}

export interface RoadmapVersion {
  version: string;
  title: string;
  highlights: string[];
  state: "open" | "closed";
  progress?: { open: number; closed: number };
}

export function roadmapMessage(
  versions: RoadmapVersion[],
  websiteUrl: string,
  emoji: { dot?: string; line?: string },
) {
  const dot = emoji.dot ? `<:sakura_roadmap_dot:${emoji.dot}>` : "◉";
  const line = emoji.line ? `<:sakura_roadmap_line:${emoji.line}>` : "│";
  const containers = versions.map((version) => {
    const progress = version.progress
      ? `\n-# ${plural(version.progress.closed, "item")} done · ${version.progress.open} to go`
      : "";
    return {
      type: 17,
      accent_color: BRAND.primary,
      components: [
        {
          type: 10,
          content: `${dot} **v${escapeDiscord(version.version)} — ${escapeDiscord(version.title)}**\n${
            version.highlights.length
              ? version.highlights
                  .map((highlight) => `${line} ${escapeDiscord(highlight)}`)
                  .join("\n")
              : `${line} _Highlights are being prepared._`
          }${progress}`,
        },
      ],
    };
  });
  if (!containers.length) {
    containers.push({
      type: 17,
      accent_color: BRAND.primary,
      components: [{ type: 10, content: "## The next version plan is being prepared." }],
    });
  }
  return {
    flags: COMPONENTS_V2,
    allowed_mentions: { parse: [] },
    components: [
      {
        type: 17,
        accent_color: BRAND.accent,
        components: [{ type: 10, content: "# SakuraCord Roadmap" }],
      },
      ...containers,
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "Roadmap", url: `${websiteUrl}/roadmap` },
          { type: 2, style: 5, label: "Tracker", url: `${websiteUrl}/tracker` },
          { type: 2, style: 2, custom_id: "r:bug", emoji: { name: "🐞" }, label: "Report a bug" },
          { type: 2, style: 2, custom_id: "r:feature", emoji: { name: "✨" }, label: "Suggest" },
          {
            type: 2,
            style: 2,
            custom_id: "roadmap:subscribe",
            emoji: { name: "🔔" },
            label: "Updates",
          },
        ],
      },
    ],
  };
}
