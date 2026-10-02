// One-time migration from the legacy D1 tracker to GitHub Issues.
//
//   npm run migrate -- <path to exported legacy D1 sqlite> [--dry-run]
//
// Resumable: progress lives in .migration/state.json. Every hub endpoint used
// is idempotent (legacy IDs map to issue numbers), so re-running is safe.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  DISCORD,
  areaLabel,
  priorityLabel,
  releaseDisplayName,
  releaseMilestoneTitle,
} from "../src/config";
import {
  attachmentMarkdown,
  neutralizeUserText,
  renderFooter,
  type AttachmentRef,
  type Reporter,
} from "../src/report/body";
import { renderMilestoneDescription } from "../src/roadmap";

const HUB = process.env.HUB_URL ?? "https://roadmap.sakuracord.app";
const LEGACY_BOT_ID = "1530180517155176458";
const STATE_PATH = ".migration/state.json";
const args = process.argv.slice(2);
const database = args.find((arg) => !arg.startsWith("--"));
const dryRun = args.includes("--dry-run");
if (!database) throw new Error("Pass the path to the exported legacy sqlite database.");

/** Canonical legacy ID ← duplicates merged into it (reviewed by hand). */
const DUPLICATES: Record<string, string[]> = {
  "SCR-01M3FJRB7T77H4JGPQX6RFH3MT": ["SCR-01M3Y18N84MNFFSA77RPXJNAEK"],
  "SCR-01M2D5D4AVTQCTMYF4WEDADY6T": ["SCR-01M35YBT30JAN7M11VW0K6VT0D"],
  "SCR-01M354SXDY6JJH9BSR1S6JNJ34": ["SCR-01M31H8NHM2H7N46TXXF5EF6MD"],
  "SCR-01M2ZX6NA1Y2F48DTVPKYQ7TST": ["SCR-01M31JYBK8P1PG5CAVQFAG5VYT"],
  "SCR-01M2K2D6B36YFG1QTDEHB415H4": ["SCR-01M39K247W5JD0HF3TQCDKFYF5"],
  "SCR-01KYX1Q23EMYMPH6CQZCRQHFND": ["SCR-01M2H8EAT2RN5SXN2E8QPZQPQR"],
  "SCR-01KYX1QHBEYABJHH3M2104WBDZ": ["SCR-01KZ53XC66JY0A5EKMF5YVQYQX"],
};
/** Reports filed under the wrong type. */
const KIND_FIXES: Record<string, "bug" | "feature"> = {
  "SCR-01M3KSGCB0JF4Z7SG57SWVQHTM": "bug",
};
const ADOPT_GITHUB_ISSUES = [7, 24, 27];

interface LegacyItem {
  id: string;
  title: string;
  description: string;
  type: "bug" | "feature";
  area: string;
  status: string;
  priority: string;
  acceptanceCriteria: Array<{ statement: string; satisfied: boolean }>;
  linkedDiscordThreads: Array<{ threadId: string; forumId: string }>;
  createdAt: string;
  completedAt?: string;
  updatedAt: string;
}

interface Submission {
  thread_id: string;
  forum_id: string;
  author_id: string | null;
  starter_message_id: string | null;
  content: string;
  attachments_json: string;
  created_at: string;
}

interface Message {
  message_id: string;
  thread_id: string;
  author_id: string | null;
  content: string;
  attachments_json: string;
  created_at: string;
  deleted_at: string | null;
}

const query = <T>(sql: string): T[] =>
  JSON.parse(
    execFileSync("sqlite3", ["-json", database!, sql], {
      encoding: "utf8",
      maxBuffer: 200 * 1024 * 1024,
    }) || "[]",
  );

const token = execFileSync(
  "security",
  [
    "find-generic-password",
    "-s",
    "dev.sakuracord.roadmap-maintainer",
    "-a",
    "super_original",
    "-w",
  ],
  { encoding: "utf8" },
).trim();

async function hub<T>(path: string, body?: unknown): Promise<T> {
  if (dryRun && body !== undefined) return { number: 0, existing: false } as T;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`${HUB}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.ok) return (await response.json()) as T;
    const text = await response.text();
    if (attempt < 4 && response.status >= 500) {
      console.warn(`  retrying ${path} after ${response.status}: ${text.slice(0, 200)}`);
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
      continue;
    }
    throw new Error(`${path} failed (${response.status}): ${text.slice(0, 500)}`);
  }
}

mkdirSync(".migration", { recursive: true });
const state: {
  issues: Record<string, number>;
  milestones: Record<string, boolean>;
  users?: Record<string, string>;
} = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
  : { issues: {}, milestones: {} };
const save = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

const items = query<{ document: string }>("SELECT document FROM roadmap_items").map(
  (row) => JSON.parse(row.document) as LegacyItem,
);
const submissions = new Map(
  query<Submission>("SELECT * FROM discord_submissions").map((row) => [row.thread_id, row]),
);
const messages = query<Message>(
  "SELECT * FROM discord_messages WHERE deleted_at IS NULL ORDER BY thread_id, message_id",
);
const versions = query<{ document: string }>("SELECT document FROM roadmap_versions")
  .map(
    (row) =>
      JSON.parse(row.document) as {
        version: string;
        title: string;
        summary: string;
        state: string;
        highlights: Array<{ title: string; linkedTrackerItemIds: string[] }>;
        releasedAt?: string;
      },
  )
  .filter((version) => version.state !== "cancelled");
const releases = JSON.parse(
  execFileSync(
    "gh",
    [
      "release",
      "list",
      "-R",
      "SakuraCordApp/SakuraCord",
      "--limit",
      "100",
      "--json",
      "tagName,publishedAt",
    ],
    {
      encoding: "utf8",
    },
  ),
) as Array<{ tagName: string; publishedAt: string }>;
releases.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

// --- Discord display names -------------------------------------------------
const authorIds = new Set<string>();
for (const submission of submissions.values())
  if (submission.author_id) authorIds.add(submission.author_id);
for (const message of messages)
  if (message.author_id && message.author_id !== LEGACY_BOT_ID) authorIds.add(message.author_id);
state.users ??= {};
const missingUsers = [...authorIds].filter((id) => !state.users![id]);
for (let index = 0; index < missingUsers.length; index += 40) {
  const batch = missingUsers.slice(index, index + 40);
  const found = dryRun
    ? Object.fromEntries(batch.map((id) => [id, { name: `user-${id.slice(-4)}`, username: "" }]))
    : await hub<Record<string, { name: string } | null>>("/admin/discord/users", { ids: batch });
  for (const id of batch) state.users[id] = found[id]?.name ?? "Discord user";
  save();
}
const nameOf = (id: string | null | undefined) =>
  id ? (state.users![id] ?? "Discord user") : "Discord user";

// --- Helpers -----------------------------------------------------------------
const threadUrl = (threadId: string) =>
  `https://discord.com/channels/${DISCORD.guildId}/${threadId}`;
const proxy = (threadId: string, messageId: string, attachmentId: string, filename: string) =>
  `${HUB}/attachments/${threadId}/${messageId}/${attachmentId}/${encodeURIComponent(filename)}`;

function attachmentsOf(threadId: string, messageId: string, json: string): AttachmentRef[] {
  try {
    return (JSON.parse(json) as Array<{ id?: string; filename?: string; content_type?: string }>)
      .filter((attachment) => attachment.id && attachment.filename)
      .map((attachment) => ({
        name: attachment.filename!,
        url: proxy(threadId, messageId, attachment.id!, attachment.filename!),
        contentType: attachment.content_type ?? null,
      }));
  } catch {
    return [];
  }
}

const quote = (text: string) => neutralizeUserText(text).replace(/\n/g, "\n> ");

function discussion(threadId: string, starterId: string | null): string {
  const replies = messages.filter(
    (message) =>
      message.thread_id === threadId &&
      message.message_id !== starterId &&
      message.author_id !== LEGACY_BOT_ID &&
      (message.content.trim() || message.attachments_json !== "[]"),
  );
  if (!replies.length) return "";
  const lines = replies.map((message) => {
    const files = attachmentsOf(threadId, message.message_id, message.attachments_json);
    return `**${neutralizeUserText(nameOf(message.author_id))}** · ${message.created_at.slice(0, 10)}\n> ${quote(message.content.slice(0, 1500)) || "_(attachment)_"}${files.length ? `\n\n${attachmentMarkdown(files)}` : ""}`;
  });
  return `<details><summary>${replies.length} ${replies.length === 1 ? "reply" : "replies"} on Discord before the move</summary>\n\n${lines.join("\n\n")}\n\n</details>`;
}

function shippedRelease(item: LegacyItem): string | null {
  const done = item.completedAt ?? item.updatedAt;
  return releases.find((release) => release.publishedAt >= done)?.tagName ?? null;
}

const milestoneFor = new Map<string, string>();
for (const version of versions) {
  for (const highlight of version.highlights) {
    for (const id of highlight.linkedTrackerItemIds)
      if (version.state === "planned") milestoneFor.set(id, version.version);
  }
}

function buildIssue(item: LegacyItem, duplicates: LegacyItem[]) {
  const kind = KIND_FIXES[item.id] ?? item.type;
  const thread = item.linkedDiscordThreads[0];
  const submission = thread ? submissions.get(thread.threadId) : undefined;
  const reporter: Reporter | null = submission?.author_id
    ? { source: "legacy", name: nameOf(submission.author_id), discordId: submission.author_id }
    : null;
  const sections: string[] = [];
  sections.push(
    `### ${kind === "bug" ? "What happened?" : "What would you like?"}\n\n${neutralizeUserText(item.description)}`,
  );
  if (item.acceptanceCriteria.length) {
    sections.push(
      `### Acceptance criteria\n\n${item.acceptanceCriteria
        .map(
          (criterion) =>
            `- [${criterion.satisfied ? "x" : " "}] ${neutralizeUserText(criterion.statement)}`,
        )
        .join("\n")}`,
    );
  }
  const attachments: AttachmentRef[] = [];
  const reports: string[] = [];
  for (const source of [item, ...duplicates]) {
    const link = source.linkedDiscordThreads[0];
    const original = link ? submissions.get(link.threadId) : undefined;
    if (!link || !original) continue;
    const starter = original.starter_message_id ?? link.threadId;
    attachments.push(...attachmentsOf(link.threadId, starter, original.attachments_json));
    const heading =
      source === item
        ? "Original report"
        : `Also reported (formerly “${neutralizeUserText(source.title)}”)`;
    reports.push(
      `<details><summary>${heading} by ${neutralizeUserText(nameOf(original.author_id))} · ${original.created_at.slice(0, 10)}</summary>\n\n> ${quote(original.content.slice(0, 6000)) || "_(no text)_"}\n\n</details>`,
    );
    const thread = discussion(link.threadId, starter);
    if (thread) reports.push(thread);
  }
  if (attachments.length)
    sections.push(
      `### Screenshots or recordings\n\n${attachmentMarkdown(attachments.slice(0, 20))}`,
    );
  if (reports.length) sections.push(`### Discord history\n\n${reports.join("\n\n")}`);

  let issueState: "open" | "closed" = "open";
  let status = "status: confirmed";
  let shippedIn: string | null = null;
  let milestone: string | null = milestoneFor.get(item.id) ?? null;
  if (item.status === "in_progress" || item.status === "polishing") status = "status: in progress";
  if (milestone && status === "status: confirmed") status = "status: planned";
  if (item.status === "done") {
    const release = shippedRelease(item);
    if (release) {
      issueState = "closed";
      status = "status: shipped";
      shippedIn = releaseDisplayName(release);
      const title = releaseMilestoneTitle(release);
      milestone = versions.some((version) => version.version === title) ? title : null;
    } else {
      status = "status: in nightly";
    }
  }
  if (item.status === "declined") {
    issueState = "closed";
    status = "status: declined";
  }
  const body = `${sections.join("\n\n")}${renderFooter({
    kind,
    ...(reporter ? { reporter } : {}),
    ...(thread ? { threadUrl: threadUrl(thread.threadId) } : {}),
    legacyId: item.id,
  })}`;
  const threadInputs = [item, ...duplicates].flatMap((source, index) =>
    source.linkedDiscordThreads.slice(0, 1).map((link) => ({
      threadId: link.threadId,
      forumId: link.forumId,
      role: (index === 0 ? "primary" : "merged") as "primary" | "merged",
      lastMessageId:
        messages.filter((message) => message.thread_id === link.threadId).at(-1)?.message_id ??
        link.threadId,
    })),
  );
  const subscribers = [item, ...duplicates].flatMap((source, index) => {
    const author =
      source.linkedDiscordThreads[0] &&
      submissions.get(source.linkedDiscordThreads[0].threadId)?.author_id;
    return author
      ? [{ userId: author, kind: (index === 0 ? "reporter" : "vote") as "reporter" | "vote" }]
      : [];
  });
  return {
    legacyId: item.id,
    aliases: duplicates.map((duplicate) => duplicate.id),
    kind,
    title: item.title.slice(0, 256),
    body:
      body.length > 64_000
        ? `${body.slice(0, 63_000)}\n\n_History truncated._${renderFooter({ kind, ...(reporter ? { reporter } : {}), legacyId: item.id })}`
        : body,
    labels: [status, areaLabel(item.area), priorityLabel(item.priority)],
    state: issueState,
    ...(issueState === "closed"
      ? { stateReason: item.status === "declined" ? "not_planned" : "completed" }
      : {}),
    milestone,
    summary: null,
    reporter,
    createdAt: item.createdAt,
    shippedIn,
    threads: threadInputs,
    subscribers: [
      ...new Map(subscribers.map((subscriber) => [subscriber.userId, subscriber])).values(),
    ],
  };
}

// --- Milestones (without issue references first) ----------------------------
for (const version of versions) {
  if (state.milestones[version.version]) continue;
  console.log(`Milestone ${version.version}`);
  await hub("/admin/migrate/milestone", {
    title: version.version,
    description: renderMilestoneDescription({
      headline: version.title,
      summary: version.summary,
      highlights: version.highlights.map((highlight) => ({ text: highlight.title, issues: [] })),
    }),
    state: version.state === "released" ? "closed" : "open",
  });
  state.milestones[version.version] = true;
  save();
}

// --- Issues, oldest first ------------------------------------------------------
const merged = new Set(Object.values(DUPLICATES).flat());
const byId = new Map(items.map((item) => [item.id, item]));
const canonical = items
  .filter((item) => !merged.has(item.id))
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
let created = 0;
for (const item of canonical) {
  if (state.issues[item.id]) continue;
  const duplicates = (DUPLICATES[item.id] ?? []).map((id) => byId.get(id)!).filter(Boolean);
  const payload = buildIssue(item, duplicates);
  if (dryRun) {
    console.log(
      `[dry-run] ${payload.kind} ${payload.state} ${payload.labels.join(", ")} · ${payload.title} (${payload.body.length} chars, ${payload.threads.length} threads)`,
    );
    continue;
  }
  const result = await hub<{ number: number; existing: boolean }>("/admin/migrate/issue", payload);
  state.issues[item.id] = result.number;
  for (const alias of payload.aliases) state.issues[alias] = result.number;
  save();
  created += 1;
  console.log(`#${result.number} ← ${item.id} ${item.title}`);
  await new Promise((resolve) => setTimeout(resolve, 3500));
}

// --- Milestone highlights now link to issues ---------------------------------
if (!dryRun) {
  for (const version of versions) {
    await hub("/admin/migrate/milestone", {
      title: version.version,
      description: renderMilestoneDescription({
        headline: version.title,
        summary: version.summary,
        highlights: version.highlights.map((highlight) => ({
          text: highlight.title,
          issues: [
            ...new Set(
              highlight.linkedTrackerItemIds
                .map((id) => state.issues[id])
                .filter((n): n is number => Boolean(n)),
            ),
          ],
        })),
      }),
      state: version.state === "released" ? "closed" : "open",
    });
  }
  await hub("/admin/state", { key: "discord:roadmap-message-id", value: "1532573669853757460" });
  for (const number of ADOPT_GITHUB_ISSUES) await hub(`/admin/migrate/adopt/${number}`, {});
  await hub("/admin/jobs", { kind: "milestones", key: "all", payload: {} });
}
console.log(
  `Done. ${created} issues created this run, ${Object.keys(state.issues).length} legacy IDs mapped.`,
);
