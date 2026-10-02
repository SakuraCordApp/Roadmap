import { DISCORD, STATUS_BY_ID } from "../config";
import {
  deleteLink,
  getIssue,
  getJsonState,
  getThread,
  linkByDiscordMessage,
  linkByGithubComment,
  primaryThread,
  recentDiscordLinks,
  saveLink,
  setThreadCursor,
  threadCursors,
  updateLink,
  upsertCommentEvent,
  type CommentLink,
  type DraftUser,
} from "../db/store";
import { DiscordError, webhookRequest, type Discord, type WebhookRef } from "../discord/rest";
import { attachmentProxyUrl, discordClient } from "../discord/threads";
import type { Env } from "../env";
import { GitHub } from "../github/client";
import { appBotLogin } from "../github/identity";
import type { GhComment } from "../github/types";
import { enqueue, enqueueMany } from "../jobs/queue";
import { attachmentMarkdown, neutralizeUserText } from "../report/body";
import { sha256 } from "../util/crypto";
import { githubToDiscord, nowIso, truncate } from "../util/text";
import { returnToTriage } from "./activity";

// Three-way conversation sync. Every reply in a report's Discord post becomes a
// GitHub comment, every GitHub comment appears in the Discord post, and website
// comments go to both. Each mirrored copy carries an origin marker so it is
// never mirrored back, and comment_links tracks the copies for edits/deletes.

const ORIGIN_PATTERN = /<!--\s*sakuracord:(no-mirror|origin=)/;
const AGENT_MARKER = /<!--\s*sakuracord:(investigation|agent)/;
const WATCH_MS = 30 * 60_000;
const MESSAGES_PER_JOB = 8;

export const webhookStateKey = (forumId: string) => `discord:webhook:${forumId}`;

async function forumWebhook(env: Env, threadId: string): Promise<WebhookRef | null> {
  const thread = await getThread(env.DB, threadId);
  if (!thread) return null;
  return getJsonState<WebhookRef | null>(env.DB, webhookStateKey(thread.forumId), null);
}

/** Run a Discord write against a thread that may be archived or locked. */
async function withWritableThread<T>(
  discord: Discord,
  threadId: string,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof DiscordError) || ![50083, 50001, 160005].includes(error.code ?? 0)) {
      throw error;
    }
    const thread = await discord.get<{
      thread_metadata?: { archived?: boolean; locked?: boolean };
    }>(`/channels/${threadId}`);
    await discord.patch(`/channels/${threadId}`, { archived: false, locked: false });
    try {
      return await write();
    } finally {
      await discord.patch(`/channels/${threadId}`, {
        archived: Boolean(thread.thread_metadata?.archived),
        locked: Boolean(thread.thread_metadata?.locked),
      });
    }
  }
}

interface Persona {
  username: string;
  avatarUrl?: string | null;
  /** Prefix used when falling back to a plain bot message. */
  fallbackHeading: string;
}

async function postMirrored(
  env: Env,
  threadId: string,
  persona: Persona,
  content: string,
): Promise<{ id: string; via: "webhook" | "bot" }> {
  const discord = discordClient(env);
  const webhook = await forumWebhook(env, threadId);
  if (webhook) {
    const message = await withWritableThread(discord, threadId, () =>
      webhookRequest<{ id: string }>(discord, "POST", webhook, threadId, {
        content: truncate(content, 2000),
        username: truncate(persona.username, 80),
        ...(persona.avatarUrl ? { avatar_url: persona.avatarUrl } : {}),
      }),
    );
    return { id: message.id, via: "webhook" };
  }
  const message = await withWritableThread(discord, threadId, () =>
    discord.post<{ id: string }>(`/channels/${threadId}/messages`, {
      content: truncate(`${persona.fallbackHeading}\n${content}`, 2000),
      allowed_mentions: { parse: [] },
    }),
  );
  return { id: message.id, via: "bot" };
}

async function editMirrored(env: Env, link: CommentLink, persona: Persona, content: string) {
  if (!link.discordMessageId || !link.threadId) return;
  const discord = discordClient(env);
  if (link.discordVia === "webhook") {
    const webhook = await forumWebhook(env, link.threadId);
    if (!webhook) return;
    await withWritableThread(discord, link.threadId, () =>
      webhookRequest(
        discord,
        "PATCH",
        webhook,
        link.threadId!,
        { content: truncate(content, 2000) },
        link.discordMessageId!,
      ),
    );
  } else {
    await withWritableThread(discord, link.threadId, () =>
      discord.patch(`/channels/${link.threadId}/messages/${link.discordMessageId}`, {
        content: truncate(`${persona.fallbackHeading}\n${content}`, 2000),
      }),
    );
  }
}

async function deleteMirrored(env: Env, link: CommentLink) {
  if (!link.discordMessageId || !link.threadId) return;
  const discord = discordClient(env);
  const webhook = link.discordVia === "webhook" ? await forumWebhook(env, link.threadId) : null;
  await withWritableThread(discord, link.threadId, () =>
    webhook
      ? webhookRequest(
          discord,
          "DELETE",
          webhook,
          link.threadId!,
          undefined,
          link.discordMessageId!,
        )
      : discord.delete(`/channels/${link.threadId}/messages/${link.discordMessageId}`),
  ).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// GitHub → Discord + website

function agentSummary(body: string): string {
  const summary = body.match(/###\s*Summary\s*\n+([\s\S]*?)(?:\n###|$)/i)?.[1]?.trim();
  const locations = body.match(/###\s*Likely locations?\s*\n+([\s\S]*?)(?:\n###|$)/i)?.[1]?.trim();
  return (
    [summary, locations ? `**Likely location**\n${locations}` : null]
      .filter(Boolean)
      .join("\n\n") || body
  );
}

function githubContent(body: string, url: string, agent: boolean): string {
  const text = githubToDiscord(agent ? agentSummary(body) : body, 1750)
    // Put images on their own line so Discord previews them.
    .replace(/\[([^\]]*)\]\((https:\/\/[^)\s]+\.(?:png|jpe?g|gif|webp)[^)\s]*)\)/gi, "$2")
    .replace(
      /\[(?:image|Image)[^\]]*\]\((https:\/\/github\.com\/user-attachments\/[^)\s]+)\)/g,
      "$1",
    );
  return `${text}\n-# [${agent ? "Full investigation" : "View"} on GitHub](<${url}>)`;
}

export async function syncGithubComment(
  env: Env,
  payload: { number: number; commentId: number; action: string },
): Promise<void> {
  const link = await linkByGithubComment(env.DB, payload.commentId);
  if (payload.action === "deleted") {
    if (link) {
      if (link.origin === "github") await deleteMirrored(env, link);
      await deleteLink(env.DB, link.id);
    }
    return;
  }
  const github = new GitHub(env);
  const comment = await github.request<GhComment>(
    "GET",
    github.repo(`/issues/comments/${payload.commentId}`),
  );
  const issue = await getIssue(env.DB, payload.number);
  if (!issue) return;
  const login = comment.user?.login ?? "someone";

  if (
    payload.action === "created" &&
    issue.status === "needs_info" &&
    issue.reporter?.githubLogin === login
  ) {
    await returnToTriage(env, issue.number);
  }
  if (ORIGIN_PATTERN.test(comment.body)) return;
  const agent = login === "github-actions[bot]" && AGENT_MARKER.test(comment.body);
  if (!agent && (login === (await appBotLogin(env)) || comment.user?.type === "Bot")) return;

  const body = comment.body.replace(/<!--[\s\S]*?-->/g, "").trim();
  const hash = await sha256(body);
  if (link && link.contentHash === hash) return;
  const thread = await primaryThread(env.DB, issue.number);
  const linkId =
    link?.id ??
    (await saveLink(env.DB, {
      issueNumber: issue.number,
      origin: "github",
      githubCommentId: comment.id,
      discordMessageId: null,
      discordVia: null,
      threadId: thread?.threadId ?? null,
      contentHash: hash,
      createdAt: comment.created_at,
    }));
  const author = agent ? "Investigation agent" : login;
  await upsertCommentEvent(
    env.DB,
    { id: linkId, issueNumber: issue.number },
    {
      source: "github",
      author,
      avatarUrl: agent ? null : (comment.user?.avatar_url ?? null),
      agent,
      body: truncate(body, 8000),
      url: comment.html_url,
    },
    comment.created_at,
  );
  if (!thread) return;
  const persona: Persona = {
    username: agent ? "Investigation agent · GitHub" : `${login} · GitHub`,
    avatarUrl: agent ? null : comment.user?.avatar_url,
    fallbackHeading: agent
      ? "🔎 **Investigation agent** looked into the code:"
      : `💬 **${login}** on GitHub:`,
  };
  const content = githubContent(body, comment.html_url, agent);
  if (link?.discordMessageId) {
    await editMirrored(env, link, persona, content);
    await updateLink(env.DB, link.id, { contentHash: hash });
  } else {
    const posted = await postMirrored(env, thread.threadId, persona, content);
    await updateLink(env.DB, linkId, {
      discordMessageId: posted.id,
      discordVia: posted.via,
      contentHash: hash,
    });
  }
}

// ---------------------------------------------------------------------------
// Discord → GitHub + website

interface DiscordMessage {
  id: string;
  type: number;
  content: string;
  author: {
    id: string;
    username: string;
    global_name?: string | null;
    bot?: boolean;
    avatar?: string | null;
  };
  member?: { nick?: string | null };
  webhook_id?: string;
  attachments?: Array<{ id: string; filename: string; content_type?: string; url: string }>;
  mentions?: Array<{ id: string; username: string; global_name?: string | null }>;
  referenced_message?: DiscordMessage | null;
  timestamp: string;
  edited_timestamp?: string | null;
}

const snowflake = (value: string | null | undefined) => BigInt(value || "0");

function displayName(message: DiscordMessage): string {
  return message.member?.nick || message.author.global_name || message.author.username;
}

/** Convert Discord markup to readable GitHub markdown that cannot ping anyone. */
export function discordToGithub(message: DiscordMessage): string {
  let text = message.content ?? "";
  for (const user of message.mentions ?? []) {
    text = text.replace(
      new RegExp(`<@!?${user.id}>`, "g"),
      `@${user.global_name || user.username}`,
    );
  }
  text = text
    .replace(/<@&\d+>/g, "@role")
    .replace(/<#(\d+)>/g, "#channel")
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/<t:(\d+)(?::\w)?>/g, (_, seconds: string) =>
      new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace("T", " "),
    );
  return neutralizeUserText(text);
}

function discordAvatar(message: DiscordMessage): string | null {
  return message.author.avatar
    ? `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.png`
    : null;
}

async function messageHash(message: DiscordMessage) {
  return sha256(`${message.content}|${(message.attachments ?? []).map((a) => a.id).join(",")}`);
}

function githubCommentBody(env: Env, threadId: string, message: DiscordMessage): string {
  const link = `https://discord.com/channels/${DISCORD.guildId}/${threadId}/${message.id}`;
  const attachments = (message.attachments ?? []).map((attachment) => ({
    name: attachment.filename,
    url: attachmentProxyUrl(env, threadId, message.id, attachment.id, attachment.filename),
    contentType: attachment.content_type ?? null,
  }));
  const reply = message.referenced_message
    ? `> ↩︎ **${neutralizeUserText(displayName(message.referenced_message))}**: ${neutralizeUserText(truncate(message.referenced_message.content || "(attachment)", 160)).replace(/\n/g, " ")}\n\n`
    : "";
  const text = discordToGithub(message);
  return `<!-- sakuracord:origin=discord message=${message.id} -->\n**${neutralizeUserText(displayName(message))}** on [Discord](${link}):\n\n${reply}${text}${attachments.length ? `\n\n${attachmentMarkdown(attachments)}` : ""}`.slice(
    0,
    65_000,
  );
}

async function mirrorDiscordMessage(
  env: Env,
  threadId: string,
  issueNumber: number,
  message: DiscordMessage,
) {
  if (await linkByDiscordMessage(env.DB, message.id)) return;
  const github = new GitHub(env);
  const created = await github.request<GhComment>(
    "POST",
    github.repo(`/issues/${issueNumber}/comments`),
    {
      body: githubCommentBody(env, threadId, message),
    },
  );
  const linkId = await saveLink(env.DB, {
    issueNumber,
    origin: "discord",
    githubCommentId: created.id,
    discordMessageId: message.id,
    discordVia: null,
    threadId,
    contentHash: await messageHash(message),
    createdAt: nowIso(),
  });
  await upsertCommentEvent(
    env.DB,
    { id: linkId, issueNumber },
    {
      source: "discord",
      author: displayName(message),
      avatarUrl: discordAvatar(message),
      body: truncate(discordToGithub(message), 8000),
      attachments: (message.attachments ?? []).map((attachment) => ({
        name: attachment.filename,
        url: attachmentProxyUrl(env, threadId, message.id, attachment.id, attachment.filename),
        image: Boolean(attachment.content_type?.startsWith("image/")),
      })),
      url: `https://discord.com/channels/${DISCORD.guildId}/${threadId}/${message.id}`,
    },
    message.timestamp,
  );
}

export async function syncDiscordThread(env: Env, payload: { threadId: string }): Promise<void> {
  const cursor = (await threadCursors(env.DB)).get(payload.threadId);
  if (!cursor) return;
  const issue = await getIssue(env.DB, cursor.issueNumber);
  if (!issue) return;
  const discord = discordClient(env);
  const fetched = await discord.get<DiscordMessage[]>(
    `/channels/${payload.threadId}/messages?limit=50&after=${cursor.lastMessageId ?? payload.threadId}`,
  );
  const ordered = fetched.sort((a, b) => (snowflake(a.id) < snowflake(b.id) ? -1 : 1));
  const human = (message: DiscordMessage) =>
    !message.author.bot && !message.webhook_id && (message.type === 0 || message.type === 19);
  let processed = 0;
  let last = cursor.lastMessageId ?? payload.threadId;
  let reporterReplied = false;
  for (const message of ordered) {
    if (human(message)) {
      if (processed >= MESSAGES_PER_JOB) break;
      await mirrorDiscordMessage(env, payload.threadId, issue.number, message);
      processed += 1;
      if (issue.reporter?.discordId === message.author.id) reporterReplied = true;
    }
    last = message.id;
  }
  const watchUntil = processed ? new Date(Date.now() + WATCH_MS).toISOString() : null;
  await setThreadCursor(env.DB, payload.threadId, last, watchUntil);
  if (reporterReplied && issue.status === "needs_info") await returnToTriage(env, issue.number);
  if (ordered.some((message) => snowflake(message.id) > snowflake(last))) {
    await enqueue(env, "discord-thread", payload.threadId, payload, 1);
  }

  // Recently active threads: carry edits and deletions over to GitHub.
  if (cursor.watchUntil && Date.parse(cursor.watchUntil) > Date.now()) {
    const links = await recentDiscordLinks(
      env.DB,
      payload.threadId,
      new Date(Date.now() - WATCH_MS * 2).toISOString(),
    );
    if (!links.length) return;
    const recent = await discord.get<DiscordMessage[]>(
      `/channels/${payload.threadId}/messages?limit=50`,
    );
    const byId = new Map(recent.map((message) => [message.id, message]));
    const oldest = recent.reduce(
      (min, message) => (snowflake(message.id) < min ? snowflake(message.id) : min),
      snowflake(last),
    );
    const github = new GitHub(env);
    for (const link of links) {
      const message = byId.get(link.discordMessageId!);
      if (!message) {
        if (snowflake(link.discordMessageId) > oldest && link.githubCommentId) {
          await github
            .request("DELETE", github.repo(`/issues/comments/${link.githubCommentId}`))
            .catch(() => undefined);
          await deleteLink(env.DB, link.id);
        }
        continue;
      }
      const hash = await messageHash(message);
      if (hash !== link.contentHash && link.githubCommentId) {
        await github.request("PATCH", github.repo(`/issues/comments/${link.githubCommentId}`), {
          body: githubCommentBody(env, payload.threadId, message),
        });
        await updateLink(env.DB, link.id, { contentHash: hash });
        await upsertCommentEvent(
          env.DB,
          { id: link.id, issueNumber: issue.number },
          {
            source: "discord",
            author: displayName(message),
            avatarUrl: discordAvatar(message),
            body: truncate(discordToGithub(message), 8000),
            url: `https://discord.com/channels/${DISCORD.guildId}/${payload.threadId}/${message.id}`,
            edited: true,
          },
          message.timestamp,
        );
      }
    }
  }
}

/** Cron: find report threads with new or recently edited messages. */
export async function pollDiscordThreads(env: Env): Promise<number> {
  const active = await discordClient(env).get<{
    threads: Array<{ id: string; parent_id?: string; last_message_id?: string | null }>;
  }>(`/guilds/${DISCORD.guildId}/threads/active`);
  const cursors = await threadCursors(env.DB);
  const due: string[] = [];
  const now = Date.now();
  for (const thread of active.threads) {
    const cursor = cursors.get(thread.id);
    if (!cursor) continue;
    const hasNew = snowflake(thread.last_message_id) > snowflake(cursor.lastMessageId);
    const watching = cursor.watchUntil && Date.parse(cursor.watchUntil) > now;
    if (!cursor.lastMessageId && thread.last_message_id) {
      // First sighting: start from here rather than backfilling history.
      await setThreadCursor(env.DB, thread.id, thread.last_message_id);
      continue;
    }
    if (hasNew || watching) due.push(thread.id);
  }
  if (!due.length) return 0;
  return enqueueMany(
    env,
    due
      .slice(0, 30)
      .map((threadId) => ({ kind: "discord-thread", key: threadId, payload: { threadId } })),
  );
}

// ---------------------------------------------------------------------------
// Website → GitHub + Discord

export async function websiteComment(
  env: Env,
  number: number,
  user: DraftUser,
  text: string,
): Promise<{ url: string }> {
  const issue = await getIssue(env.DB, number);
  if (!issue) throw new Error(`Report #${number} was not found.`);
  if (!STATUS_BY_ID.get(issue.status)!.open) throw new Error("This report is closed.");
  const body = text.trim();
  if (!body) throw new Error("Write a comment first.");
  const github = new GitHub(env);
  const created = await github.request<GhComment>(
    "POST",
    github.repo(`/issues/${number}/comments`),
    {
      body: `<!-- sakuracord:origin=website -->\n**${neutralizeUserText(user.name)}** on sakuracord.app:\n\n${neutralizeUserText(truncate(body, 6000))}`,
    },
  );
  const thread = await primaryThread(env.DB, number);
  const linkId = await saveLink(env.DB, {
    issueNumber: number,
    origin: "website",
    githubCommentId: created.id,
    discordMessageId: null,
    discordVia: null,
    threadId: thread?.threadId ?? null,
    contentHash: await sha256(body),
    createdAt: nowIso(),
  });
  await upsertCommentEvent(
    env.DB,
    { id: linkId, issueNumber: number },
    {
      source: "website",
      author: user.name,
      avatarUrl: user.avatarUrl ?? null,
      body: truncate(body, 8000),
      url: created.html_url,
    },
    nowIso(),
  );
  if (thread) {
    const posted = await postMirrored(
      env,
      thread.threadId,
      {
        username: `${user.name} · sakuracord.app`,
        avatarUrl: user.avatarUrl,
        fallbackHeading: `🌐 **${user.name}** on sakuracord.app:`,
      },
      `${githubToDiscord(neutralizeUserText(body).replace(/@\u200b/g, "@"), 1900)}`,
    );
    await updateLink(env.DB, linkId, { discordMessageId: posted.id, discordVia: posted.via });
  }
  if (issue.status === "needs_info" && issue.reporter?.discordId === user.id) {
    await returnToTriage(env, number);
  }
  return { url: created.html_url };
}
