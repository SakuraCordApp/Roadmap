import { cachedReportReleases, reportReleases, requireSupportedVersion } from "./releases";
import { searchReports } from "./ai/search";
import {
  DISCORD,
  ISSUE_TYPES,
  STATUS_BY_ID,
  areaLabel,
  priorityLabel,
  statusLabel,
  type IssueKind,
} from "./config";
import {
  addEvent,
  addSubscriber,
  claimDraft,
  getIssue,
  primaryThread,
  saveDraft,
  saveIssue,
  setState,
  subscriberRole,
  voteCount,
  type DraftRecord,
  type DraftUser,
  type IssueRecord,
} from "./db/store";
import { issueUrl, threadUrl, trackerUrl } from "./discord/cards";
import { noMentions, type UploadFile } from "./discord/rest";
import {
  attachmentProxyUrl,
  createThread,
  discordClient,
  postInThread,
  refreshCard,
} from "./discord/threads";
import type { Env } from "./env";
import { GitHub } from "./github/client";
import type { GhIssue } from "./github/types";
import { enqueue } from "./jobs/queue";
import { statusGithubLabel } from "./lifecycle";
import {
  attachmentMarkdown,
  neutralizeUserText,
  renderIssueBody,
  withFooter,
  type AttachmentRef,
  type Reporter,
} from "./report/body";
import { TITLE_MAX_LENGTH, derivedPriority } from "./report/schema";
import { recordFromGithub } from "./sync/issue";
import { returnToTriage } from "./sync/activity";
import { escapeDiscord, truncate } from "./util/text";

export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ORIGIN_DISCORD = "<!-- sakuracord:origin=discord -->";

export interface SimilarReport {
  number: number;
  title: string;
  kind: IssueKind | null;
  status: string;
  statusLabel: string;
  open: boolean;
  votes: number;
  score: number;
  url: string;
  trackerUrl: string;
  threadUrl: string | null;
  resolution: string | null;
}

export async function findSimilar(env: Env, text: string, limit = 3): Promise<SimilarReport[]> {
  if (text.trim().length < 4) return [];
  const matches = await searchReports(env, text, { limit });
  const results: SimilarReport[] = [];
  for (const { issue, score } of matches) {
    if (!issue.kind) continue;
    const thread = await primaryThread(env.DB, issue.number);
    results.push({
      number: issue.number,
      title: issue.title,
      kind: issue.kind,
      status: issue.status,
      statusLabel: statusLabel(issue.status, issue.kind),
      open: STATUS_BY_ID.get(issue.status)!.open,
      votes: await voteCount(env.DB, issue.number),
      score,
      resolution: issue.shippedStableIn
        ? `Available in regular release ${issue.shippedStableIn}.`
        : issue.shippedIn
          ? `Available in nightly ${issue.shippedIn}; not yet in a regular release.`
          : issue.fixes.some((fix) => fix.state === "merged")
            ? "A fix is in the code but has not shipped in a release yet."
            : null,
      url: issueUrl(issue.number),
      trackerUrl: trackerUrl(env.WEBSITE_URL, issue.number),
      threadUrl: thread ? threadUrl(DISCORD.guildId, thread.threadId) : null,
    });
    if (results.length >= limit) break;
  }
  return results;
}

/** Discord uses cached choices within its three-second interaction window. */
export async function cachedVersionOptions(env: Env): Promise<string[]> {
  return (await cachedReportReleases(env)).map((release) => release.version);
}
export async function versionOptions(env: Env): Promise<string[]> {
  return (await reportReleases(env)).map((release) => release.version);
}

export function reporterFor(user: DraftUser, source: "discord" | "website"): Reporter {
  return { source, name: user.name || user.username, discordId: user.id };
}

export interface FiledReport {
  number: number;
  threadId: string | null;
  issueUrl: string;
  threadUrl: string | null;
  trackerUrl: string;
}

/**
 * File a report: GitHub issue (canonical) → Discord forum post → attachments →
 * final issue body with links. Safe to call again for the same draft.
 */
export async function fileReport(
  env: Env,
  draft: DraftRecord,
  files: UploadFile[],
): Promise<FiledReport> {
  if (!(await claimDraft(env.DB, draft.id))) {
    const existing = await env.DB.prepare("SELECT issue_number,thread_id FROM drafts WHERE id=?")
      .bind(draft.id)
      .first<{ issue_number: number; thread_id: string | null }>();
    if (existing?.issue_number)
      return describeFiled(env, existing.issue_number, existing.thread_id);
    throw new Error("This report is already being filed.");
  }
  try {
    const release = await requireSupportedVersion(env, draft.values.version ?? "");
    draft.values.version = release.version;
    const github = new GitHub(env);
    const reporter = reporterFor(draft.user, draft.source);
    const values = draft.values;
    const labels = [
      statusGithubLabel("new")!,
      priorityLabel(derivedPriority(draft.kind, values)),
      ...(values.area ? [areaLabel(values.area)] : []),
    ];
    const created = await github.request<GhIssue>("POST", github.repo("/issues"), {
      title: truncate(values.title ?? "Untitled report", TITLE_MAX_LENGTH),
      body: renderIssueBody({ kind: draft.kind, values, reporter }),
      labels,
      type: ISSUE_TYPES[draft.kind].githubType,
    });
    const record = recordFromGithub(created, null);
    record.reporter = reporter;
    record.kind = draft.kind;
    await saveIssue(env.DB, record);
    await setState(env.DB, `report:release:${record.number}`, JSON.stringify(release));
    await addEvent(env.DB, record.number, "created", { status: "new", source: draft.source });
    await addSubscriber(env.DB, record.number, draft.user.id, "reporter");
    await env.DB.prepare("UPDATE drafts SET issue_number=? WHERE id=?")
      .bind(record.number, draft.id)
      .run();

    const thread = await createThread(env, record, { pingReporter: true });
    await env.DB.prepare("UPDATE drafts SET thread_id=? WHERE id=?")
      .bind(thread.threadId, draft.id)
      .run();

    const attachments = await uploadFiles(
      env,
      thread.threadId,
      files,
      `📎 Attachments from <@${draft.user.id}>`,
    );
    const body = withFooter(renderIssueBody({ kind: draft.kind, values, reporter, attachments }), {
      kind: draft.kind,
      reporter,
      threadUrl: threadUrl(DISCORD.guildId, thread.threadId),
      trackerUrl: trackerUrl(env.WEBSITE_URL, record.number),
    });
    const updated = await github.request<GhIssue>(
      "PATCH",
      github.repo(`/issues/${record.number}`),
      { body },
    );
    const final = recordFromGithub(updated, record);
    final.reporter = reporter;
    await saveIssue(env.DB, final);
    await refreshCard(env, final).catch((error) => console.error("Card refresh failed", error));
    await enqueue(env, "sync-issue", String(record.number), { number: record.number });
    return describeFiled(env, record.number, thread.threadId);
  } catch (error) {
    const row = await env.DB.prepare("SELECT issue_number FROM drafts WHERE id=?")
      .bind(draft.id)
      .first<{ issue_number: number }>();
    if (!row?.issue_number) {
      await env.DB.prepare("UPDATE drafts SET issue_number=NULL WHERE id=?").bind(draft.id).run();
    }
    throw error;
  }
}

function describeFiled(env: Env, number: number, threadId: string | null): FiledReport {
  return {
    number,
    threadId,
    issueUrl: issueUrl(number),
    threadUrl: threadId ? threadUrl(DISCORD.guildId, threadId) : null,
    trackerUrl: trackerUrl(env.WEBSITE_URL, number),
  };
}

/** Upload files into a thread and return proxy references for GitHub and the website. */
export async function uploadFiles(
  env: Env,
  threadId: string,
  files: UploadFile[],
  caption: string,
): Promise<AttachmentRef[]> {
  const accepted = files.filter((file) => sizeOf(file) <= MAX_FILE_BYTES).slice(0, MAX_FILES);
  if (!accepted.length) return [];
  const message = await postInThread(
    env,
    threadId,
    {
      content: caption,
      allowed_mentions: noMentions,
      attachments: accepted.map((file, index) => ({
        id: index,
        filename: safeFilename(file.name),
      })),
    },
    { files: accepted.map((file) => ({ ...file, name: safeFilename(file.name) })) },
  );
  return (message.attachments ?? []).map((attachment, index) => ({
    name: attachment.filename,
    url: attachmentProxyUrl(env, threadId, message.id, attachment.id, attachment.filename),
    contentType: attachment.content_type ?? accepted[index]?.contentType ?? null,
  }));
}

function sizeOf(file: UploadFile): number {
  return file.data instanceof Blob ? file.data.size : file.data.byteLength;
}

export function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(-80);
  return cleaned || "attachment";
}

/** Download Discord modal uploads so they can be re-posted permanently. */
export async function downloadAttachments(
  attachments: Array<{
    url: string;
    filename: string;
    content_type?: string | null;
    size?: number;
  }>,
): Promise<UploadFile[]> {
  const files: UploadFile[] = [];
  for (const attachment of attachments.slice(0, MAX_FILES)) {
    if ((attachment.size ?? 0) > MAX_FILE_BYTES) continue;
    const response = await fetch(attachment.url);
    if (!response.ok) continue;
    files.push({
      name: attachment.filename,
      contentType: attachment.content_type ?? response.headers.get("content-type"),
      data: await response.blob(),
    });
  }
  return files;
}

/** "Me too": follow an existing report, optionally adding your own description. */
export async function addMeToo(
  env: Env,
  number: number,
  user: DraftUser,
  source: "discord" | "website",
  note?: string,
): Promise<FiledReport> {
  const issue = await getIssue(env.DB, number);
  if (!issue) throw new Error(`Report #${number} was not found.`);
  const role = await subscriberRole(env.DB, number, user.id);
  if (!role) await addSubscriber(env.DB, number, user.id, "vote");
  const thread = await primaryThread(env.DB, number);
  if (thread) {
    await discordClient(env)
      .put(`/channels/${thread.threadId}/thread-members/${user.id}`)
      .catch(() => undefined);
  }
  const text = note?.trim();
  if (text && thread && STATUS_BY_ID.get(issue.status)!.open) {
    await postInThread(
      env,
      thread.threadId,
      {
        content: `👍 <@${user.id}> has the same ${issue.kind === "feature" ? "request" : "problem"}:\n> ${escapeDiscord(truncate(text, 1200)).replace(/\n/g, "\n> ")}`,
        allowed_mentions: noMentions,
        flags: 1 << 2,
      },
      { nonceKey: `metoo:${number}:${user.id}` },
    );
    const github = new GitHub(env);
    await github.request("POST", github.repo(`/issues/${number}/comments`), {
      body: `${ORIGIN_DISCORD}\n👍 **${neutralizeUserText(user.name)}** reported the same ${issue.kind === "feature" ? "request" : "problem"} ${source === "website" ? "on sakuracord.app" : "on Discord"}:\n\n> ${neutralizeUserText(truncate(text, 3000)).replace(/\n/g, "\n> ")}`,
    });
    await addEvent(env.DB, number, "me-too", { name: user.name }, user.id);
  }
  await refreshCard(env, issue).catch(() => undefined);
  return describeFiled(env, number, thread?.threadId ?? null);
}

/** Add details (text and files) to an existing report from Discord or the website. */
export async function addDetails(
  env: Env,
  number: number,
  user: DraftUser,
  input: {
    text?: string;
    files?: UploadFile[];
    existing?: AttachmentRef[];
    skipThreadPost?: boolean;
  },
  source: "discord" | "website",
): Promise<FiledReport> {
  const issue = await getIssue(env.DB, number);
  if (!issue) throw new Error(`Report #${number} was not found.`);
  const thread = await primaryThread(env.DB, number);
  const text = input.text?.trim() ?? "";
  let attachments: AttachmentRef[] = input.existing ?? [];
  if (thread && !input.skipThreadPost && (text || input.files?.length)) {
    if (input.files?.length) {
      attachments = [
        ...attachments,
        ...(await uploadFiles(
          env,
          thread.threadId,
          input.files,
          `📎 **Details from <@${user.id}>**${text ? `\n> ${escapeDiscord(truncate(text, 1500)).replace(/\n/g, "\n> ")}` : ""}`,
        )),
      ];
    } else {
      await postInThread(env, thread.threadId, {
        content: `📎 **Details from <@${user.id}>**\n> ${escapeDiscord(truncate(text, 1500)).replace(/\n/g, "\n> ")}`,
        allowed_mentions: noMentions,
        flags: 1 << 2,
      });
    }
  }
  if (text || attachments.length) {
    const github = new GitHub(env);
    await github.request("POST", github.repo(`/issues/${number}/comments`), {
      body: `${ORIGIN_DISCORD}\n📎 **${neutralizeUserText(user.name)}** added details ${source === "website" ? "on sakuracord.app" : "on Discord"}:\n\n${text ? `> ${neutralizeUserText(truncate(text, 4000)).replace(/\n/g, "\n> ")}\n\n` : ""}${attachmentMarkdown(attachments)}`,
    });
    await addEvent(
      env.DB,
      number,
      "details",
      { name: user.name, files: attachments.length },
      user.id,
    );
  }
  if (issue.status === "needs_info" && issue.reporter?.discordId === user.id) {
    await returnToTriage(env, number);
  }
  return describeFiled(env, number, thread?.threadId ?? null);
}

export async function createDraft(
  env: Env,
  draft: Omit<DraftRecord, "issueNumber" | "threadId">,
): Promise<DraftRecord> {
  const record: DraftRecord = { ...draft, issueNumber: null, threadId: null };
  await saveDraft(env.DB, record);
  return record;
}

export type { IssueRecord };
