import { DISCORD, STATUS_BY_ID, type IssueKind, type StatusId } from "../config";
import {
  getJsonState,
  getState,
  setState,
  primaryThread,
  saveThread,
  setThreadCursor,
  subscribers,
  takePendingNote,
  threadsForIssue,
  voteCount,
  type IssueRecord,
  type ThreadRecord,
} from "../db/store";
import { enqueue } from "../jobs/queue";
import type { Env } from "../env";
import { sha256 } from "../util/crypto";
import { nowIso, truncate } from "../util/text";
import { issueCard, PING_VOTERS, statusMessageText, threadUrl } from "./cards";
import { Discord, DiscordError, mentionUsers, noMentions, type UploadFile } from "./rest";

export interface ForumTagMap {
  [forumId: string]: { status: Partial<Record<StatusId, string>>; area: Record<string, string> };
}

export const TAG_STATE_KEY = "discord:forum-tags";

export function discordClient(env: Env): Discord {
  return new Discord(env.DISCORD_BOT_TOKEN, env.DISCORD_APPLICATION_ID);
}

export function forumFor(kind: IssueKind | null): string {
  return kind === "feature" ? DISCORD.featureForumId : DISCORD.bugForumId;
}

export function attachmentProxyUrl(
  env: Env,
  channelId: string,
  messageId: string,
  attachmentId: string,
  filename: string,
): string {
  return `${env.HUB_URL}/attachments/${channelId}/${messageId}/${attachmentId}/${encodeURIComponent(filename)}`;
}

/** Image links in the issue body that point at our attachment proxy. */
export function galleryFromBody(
  env: Env,
  body: string,
): Array<{ url: string; description?: string }> {
  const prefix = `${env.HUB_URL}/attachments/`;
  const items: Array<{ url: string; description?: string }> = [];
  for (const match of body.matchAll(/!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g)) {
    if (match[2]!.startsWith(prefix))
      items.push({ url: match[2]!, description: match[1] || undefined });
  }
  return items.slice(0, 10);
}

async function tagsFor(env: Env, forumId: string, issue: IssueRecord): Promise<string[]> {
  const map = await getJsonState<ForumTagMap>(env.DB, TAG_STATE_KEY, {});
  const forum = map[forumId];
  if (!forum) return [];
  const tags: string[] = [];
  const status = forum.status[issue.status];
  if (status) tags.push(status);
  if (issue.area && forum.area[issue.area]) tags.push(forum.area[issue.area]!);
  return tags;
}

/** Post a message in a thread, unarchiving it first if Discord requires that. */
export async function postInThread(
  env: Env,
  threadId: string,
  body: Record<string, unknown>,
  options: { nonceKey?: string; files?: UploadFile[] } = {},
): Promise<{
  id: string;
  attachments?: Array<{ id: string; filename: string; content_type?: string }>;
}> {
  const discord = discordClient(env);
  const send = () =>
    discord.post<{
      id: string;
      attachments?: Array<{ id: string; filename: string; content_type?: string }>;
    }>(`/channels/${threadId}/messages`, body, options);
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof DiscordError) || error.code !== 50083) throw error;
    const thread = await discord.get<{ thread_metadata?: { locked?: boolean } }>(
      `/channels/${threadId}`,
    );
    const locked = Boolean(thread.thread_metadata?.locked);
    await discord.patch(`/channels/${threadId}`, { archived: false });
    try {
      return await send();
    } finally {
      await discord.patch(`/channels/${threadId}`, { archived: true, locked });
    }
  }
}

/** Create the forum post for an issue that does not have one yet. */
export async function createThread(
  env: Env,
  issue: IssueRecord,
  options: { pingReporter: boolean },
): Promise<ThreadRecord> {
  const discord = discordClient(env);
  const forumId = forumFor(issue.kind);
  const card = issueCard(issue, {
    websiteUrl: env.WEBSITE_URL,
    votes: await voteCount(env.DB, issue.number),
    attachmentUrls: galleryFromBody(env, issue.body),
  });
  const reporterId = issue.reporter?.discordId;
  const thread = await discord.post<{ id: string }>(
    `/channels/${forumId}/threads`,
    {
      name: truncate(issue.title, 100),
      applied_tags: await tagsFor(env, forumId, issue),
      auto_archive_duration: 10080,
      message: {
        ...card,
        allowed_mentions:
          options.pingReporter && reporterId ? mentionUsers([reporterId]) : noMentions,
      },
    },
    { reason: `SakuraCord issue #${issue.number}` },
  );
  const record: ThreadRecord = {
    threadId: thread.id,
    issueNumber: issue.number,
    forumId,
    role: "primary",
    cardMessageId: thread.id,
    cardHash: await sha256(JSON.stringify(card)),
    stateHash: null,
    createdAt: nowIso(),
  };
  await saveThread(env.DB, record);
  await setThreadCursor(env.DB, thread.id, thread.id);
  if (reporterId) {
    await discord.put(`/channels/${thread.id}/thread-members/${reporterId}`).catch(() => undefined);
  }
  return record;
}

export interface ProjectionInput {
  issue: IssueRecord;
  previousStatus: StatusId | null;
  /** Create a forum post when none exists (GitHub-originated issues). */
  createIfMissing: boolean;
}

/** Bring every Discord thread of an issue in line with the canonical issue. */
export async function projectIssue(
  env: Env,
  input: ProjectionInput,
): Promise<{ created: boolean }> {
  const { issue } = input;
  if (!issue.kind) return { created: false };
  const discord = discordClient(env);
  let primary = await primaryThread(env.DB, issue.number);
  let created = false;
  if (!primary) {
    if (!input.createIfMissing || issue.state === "closed") return { created: false };
    primary = await createThread(env, issue, { pingReporter: false });
    created = true;
  }
  if (primary.forumId !== forumFor(issue.kind)) {
    const old = primary;
    const matching = (await threadsForIssue(env.DB, issue.number)).find(
      (thread) => thread.forumId === forumFor(issue.kind) && thread.role === "primary",
    );
    primary = matching ?? (await createThread(env, issue, { pingReporter: false }));
    await setState(env.DB, `discord:relocated:${old.threadId}`, "1");
    await saveThread(env.DB, { ...old, role: "merged", stateHash: null });
    await postInThread(
      env,
      primary.threadId,
      {
        content: `Reclassified as a ${issue.kind === "bug" ? "bug" : "feature suggestion"}. [Previous discussion](${threadUrl(DISCORD.guildId, old.threadId)}) remains available; continue here.`,
        allowed_mentions: noMentions,
      },
      { nonceKey: `reclassified:${old.threadId}:${primary.threadId}` },
    );
  }
  const closed = !STATUS_BY_ID.get(issue.status)!.open;
  const tags = await tagsFor(env, primary.forumId, issue);
  const desiredState = { name: truncate(issue.title, 100), tags, closed };
  const stateHash = await sha256(JSON.stringify(desiredState));
  const card = issueCard(issue, {
    websiteUrl: env.WEBSITE_URL,
    votes: await voteCount(env.DB, issue.number),
    attachmentUrls: galleryFromBody(env, issue.body),
  });
  const cardHash = await sha256(JSON.stringify(card));
  const statusChanged = input.previousStatus !== null && input.previousStatus !== issue.status;
  const needsWork =
    primary.stateHash !== stateHash ||
    primary.cardHash !== cardHash ||
    statusChanged ||
    !primary.cardMessageId;
  if (!needsWork) {
    for (const merged of (await threadsForIssue(env.DB, issue.number)).filter(
      (t) => t.role === "merged",
    )) {
      await projectMergedThread(env, merged, issue);
    }
    return { created };
  }

  // Discord rejects edits inside archived threads, so open the thread first and
  // archive it again at the end when the issue is closed.
  try {
    await discord.patch(
      `/channels/${primary.threadId}`,
      { archived: false, locked: false, name: desiredState.name, applied_tags: tags },
      { reason: `Sync SakuraCord issue #${issue.number}` },
    );
  } catch (error) {
    // The post was deleted in Discord; forget it rather than retrying forever.
    if (!(error instanceof DiscordError) || error.code !== 10003) throw error;
    await forgetThread(env, primary.threadId);
    if (input.createIfMissing && !closed) {
      await enqueue(env, "sync-issue", String(issue.number), { number: issue.number });
    }
    return { created };
  }
  if (!primary.cardMessageId && !closed) {
    // Threads that predate the hub get the card as a new message.
    const posted = await discord.post<{ id: string }>(`/channels/${primary.threadId}/messages`, {
      ...card,
      allowed_mentions: noMentions,
    });
    primary.cardMessageId = posted.id;
  } else if (primary.cardMessageId && primary.cardHash !== cardHash) {
    try {
      await discord.patch(`/channels/${primary.threadId}/messages/${primary.cardMessageId}`, {
        ...card,
        allowed_mentions: noMentions,
      });
    } catch (error) {
      if (!(error instanceof DiscordError) || error.status !== 404) throw error;
      const posted = await discord.post<{ id: string }>(`/channels/${primary.threadId}/messages`, {
        ...card,
        allowed_mentions: noMentions,
      });
      primary.cardMessageId = posted.id;
    }
  }
  if (statusChanged) await announceStatus(env, issue, input.previousStatus!, primary);
  if (closed) {
    await discord.patch(`/channels/${primary.threadId}`, { archived: true, locked: true });
  }
  await saveThread(env.DB, { ...primary, cardHash, stateHash });

  for (const merged of (await threadsForIssue(env.DB, issue.number)).filter(
    (t) => t.role === "merged",
  )) {
    await projectMergedThread(env, merged, issue);
  }
  return { created };
}

async function announceStatus(
  env: Env,
  issue: IssueRecord,
  previous: StatusId,
  thread: ThreadRecord,
): Promise<void> {
  const note = await takePendingNote(env.DB, issue.number, issue.status);
  let duplicateThreadId: string | null = null;
  if (issue.status === "duplicate" && issue.duplicateOf) {
    duplicateThreadId = (await primaryThread(env.DB, issue.duplicateOf))?.threadId ?? null;
  }
  const text = statusMessageText({ issue, previous, note, duplicateThreadId });
  const people = await subscribers(env.DB, issue.number);
  const reporter = people.filter((person) => person.kind === "reporter").map((p) => p.userId);
  const pinged = PING_VOTERS.has(issue.status) ? people.map((person) => person.userId) : reporter;
  const mentions = pinged.slice(0, 50);
  const content = mentions.length
    ? `${text}\n-# ${mentions.map((id) => `<@${id}>`).join(" ")}`
    : text;
  await discordClient(env).post(
    `/channels/${thread.threadId}/messages`,
    { content: truncate(content, 2000), allowed_mentions: mentionUsers(mentions), flags: 1 << 2 },
    { nonceKey: `status:${issue.number}:${previous}:${issue.status}:${issue.updatedAt}` },
  );
}

async function forgetThread(env: Env, threadId: string) {
  await env.DB.prepare("DELETE FROM threads WHERE thread_id=?").bind(threadId).run();
}

async function projectMergedThread(env: Env, thread: ThreadRecord, issue: IssueRecord) {
  const forum = (await getJsonState<ForumTagMap>(env.DB, TAG_STATE_KEY, {}))[thread.forumId];
  const relocated = (await getState(env.DB, `discord:relocated:${thread.threadId}`)) === "1";
  const tags = !relocated && forum?.status.duplicate ? [forum.status.duplicate] : [];
  const stateHash = await sha256(JSON.stringify({ merged: issue.number, tags }));
  if (thread.stateHash === stateHash) return;
  const discord = discordClient(env);
  try {
    await discord.patch(`/channels/${thread.threadId}`, {
      archived: false,
      locked: false,
      applied_tags: tags,
    });
  } catch (error) {
    if (!(error instanceof DiscordError) || error.code !== 10003) throw error;
    await forgetThread(env, thread.threadId);
    return;
  }
  const primary = await primaryThread(env.DB, issue.number);
  await discord.post(
    `/channels/${thread.threadId}/messages`,
    {
      content: `🔁 **${relocated ? "Reclassified — continue with" : "Merged into"} #${issue.number}: ${truncate(issue.title, 150)}.**${
        primary ? ` Follow ${threadUrl(DISCORD.guildId, primary.threadId)} for updates.` : ""
      }`,
      allowed_mentions: noMentions,
      flags: 1 << 2,
    },
    { nonceKey: `merged:${thread.threadId}:${issue.number}` },
  );
  await discord.patch(`/channels/${thread.threadId}`, { archived: true, locked: true });
  await saveThread(env.DB, { ...thread, stateHash });
}

/** Re-render just the card (e.g. after a vote) without touching thread state. */
export async function refreshCard(env: Env, issue: IssueRecord): Promise<void> {
  const thread = await primaryThread(env.DB, issue.number);
  if (!thread?.cardMessageId) return;
  const card = issueCard(issue, {
    websiteUrl: env.WEBSITE_URL,
    votes: await voteCount(env.DB, issue.number),
    attachmentUrls: galleryFromBody(env, issue.body),
  });
  const cardHash = await sha256(JSON.stringify(card));
  if (cardHash === thread.cardHash) return;
  await discordClient(env).patch(`/channels/${thread.threadId}/messages/${thread.cardMessageId}`, {
    ...card,
    allowed_mentions: noMentions,
  });
  await saveThread(env.DB, { ...thread, cardHash });
}
