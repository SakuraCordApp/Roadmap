import {
  CreateRoadmapItemSchema,
  RoadmapError,
  RoadmapItemSchema,
  RoadmapVersionEngine,
  escapeDiscord,
  generateVersionRoadmapProjection,
  renderVersionDiscordText,
  type RoadmapConfig,
  type RoadmapEngine,
  type RoadmapItem,
} from "@roadmap/core";
import type { Env } from "../env.js";
import { D1RoadmapStorage } from "../storage.js";
import {
  analyzeDiscordReport,
  attachmentReferences,
  buildAcceptanceCriteria,
  type DiscordReportAttachment,
} from "../report-analysis.js";
import { redactError, sha256 } from "../security.js";
import { isTerminalAiAuthorizationError, MAX_AUTOMATION_ATTEMPTS } from "../job-recovery.js";
import {
  applyRoadmapTags,
  ensureForumTaxonomy,
  ensureRoadmapTimelineEmojis,
  resolveAppliedTagNames,
  type RoadmapEmojiPayloads,
  type TagIconPayloads,
} from "./forums.js";
import { DiscordRestClient, safeAllowedMentions } from "./rest.js";

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  author: { id: string; bot?: boolean };
  attachments?: DiscordReportAttachment[];
  mentions?: Array<{ id: string }>;
  webhook_id?: string;
  application_id?: string;
}

interface DiscordThread {
  id: string;
  guild_id: string;
  parent_id: string;
  name: string;
  owner_id?: string;
  last_message_id?: string;
  applied_tags?: string[];
  thread_metadata?: {
    archived: boolean;
    locked: boolean;
    create_timestamp?: string;
    archive_timestamp: string;
  };
}

interface ArchivedThreadsResponse {
  threads: DiscordThread[];
  has_more: boolean;
}

interface ThreadMessageCheckpoint {
  lastMessageId: string | null;
  checkedAt: string;
}

const ACTIVE_THREAD_FULL_REFRESH_MS = 60 * 60 * 1_000;

export class DiscordSyncService {
  private readonly rest: DiscordRestClient | null;
  private readonly versionEngine: RoadmapVersionEngine;

  constructor(
    private readonly env: Env,
    private readonly config: RoadmapConfig,
    private readonly engine: RoadmapEngine,
  ) {
    this.rest = env.DISCORD_BOT_TOKEN ? new DiscordRestClient(env.DISCORD_BOT_TOKEN) : null;
    this.versionEngine = new RoadmapVersionEngine(new D1RoadmapStorage(env.DB), config);
  }

  async publishRoadmap(force = false): Promise<{
    changed: boolean;
    hash: string;
    messageId?: string;
  }> {
    const rest = this.requireRest();
    const channelId = this.config.discord.roadmapChannelId;
    if (!channelId) throw new Error("discord.roadmapChannelId is not configured.");
    const versions = await this.versionEngine.list({
      states: ["released", "planned"],
      limit: 50,
    });
    const projection = await generateVersionRoadmapProjection(versions);
    const emojiIds = await this.roadmapEmojiIds();
    const previousHash = await this.getState("roadmap_projection_hash");
    const configuredMessageId =
      (await this.getState("roadmap_message_id")) ?? this.config.discord.roadmapMessageId;
    if (!force && previousHash === projection.hash && configuredMessageId) {
      return { changed: false, hash: projection.hash, messageId: configuredMessageId };
    }
    const body = this.config.discord.enableComponentsV2
      ? componentsV2RoadmapBody(projection, this.config, emojiIds)
      : {
          content: renderVersionDiscordText(projection),
          allowed_mentions: safeAllowedMentions(),
        };
    let messageId = configuredMessageId;
    if (messageId) {
      try {
        const edited = await rest.patch<{ id: string }>(
          `/channels/${channelId}/messages/${messageId}`,
          this.config.discord.enableComponentsV2
            ? componentsV2RoadmapEditBody(projection, this.config, emojiIds)
            : body,
          "Update canonical roadmap projection",
        );
        messageId = edited.id;
      } catch (error) {
        if (!isDiscordStatus(error, 404)) throw error;
        messageId = undefined;
      }
    }
    if (!messageId) {
      const created = await rest.post<{ id: string }>(
        `/channels/${channelId}/messages`,
        body,
        `roadmap-projection:${projection.hash}`,
      );
      messageId = created.id;
    }
    await this.setState("roadmap_projection_hash", projection.hash);
    await this.setState("roadmap_message_id", messageId);
    await this.setState("roadmap_last_published_at", new Date().toISOString());
    return { changed: true, hash: projection.hash, messageId };
  }

  async configureForums(iconPayloads: TagIconPayloads = {}, replaceIconKeys: string[] = []) {
    return ensureForumTaxonomy(this.requireRest(), this.config, iconPayloads, replaceIconKeys);
  }

  async configureRoadmapEmojis(payloads: RoadmapEmojiPayloads, replaceKeys: string[] = []) {
    const emojis = await ensureRoadmapTimelineEmojis(
      this.requireRest(),
      this.config,
      payloads,
      new Set(replaceKeys),
    );
    await Promise.all(
      emojis.map((emoji) => this.setState(`roadmap_emoji_${emoji.key}_id`, emoji.id)),
    );
    if (emojis.length) {
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO sync_jobs (job_key,kind,payload)
         VALUES (?,?,'{}')`,
      )
        .bind(
          `roadmap-emojis:${emojis.map((emoji) => `${emoji.key}:${emoji.id}`).join(",")}`,
          "publish_roadmap",
        )
        .run();
    }
    return emojis;
  }

  async reportAutomationStatus(): Promise<{
    pending: number;
    processing: number;
    failed: number;
    completed: number;
    lastCompletedAt: string | null;
    lastError: string | null;
  }> {
    const [counts, latest] = await Promise.all([
      this.env.DB.prepare(
        `SELECT status,count(*) AS count FROM discord_report_jobs GROUP BY status`,
      ).all<{ status: string; count: number }>(),
      this.env.DB.prepare(
        `SELECT completed_at,last_error FROM discord_report_jobs
         ORDER BY COALESCE(completed_at,created_at) DESC LIMIT 1`,
      ).first<{ completed_at: string | null; last_error: string | null }>(),
    ]);
    const count = (status: string) =>
      Number(counts.results.find((row) => row.status === status)?.count ?? 0);
    return {
      pending: count("pending"),
      processing: count("processing"),
      failed: count("failed"),
      completed: count("complete"),
      lastCompletedAt: latest?.completed_at ?? null,
      lastError: latest?.last_error ?? null,
    };
  }

  async processPendingReportJobs(limit = 2): Promise<{ processed: number; failed: number }> {
    await this.env.DB.prepare(
      `UPDATE discord_report_jobs
       SET status='failed',locked_at=NULL,
           last_error=COALESCE(last_error,'Report analysis exceeded its retry budget.')
       WHERE status='processing' AND attempts >= ?
         AND unixepoch(locked_at) <= unixepoch('now') - 300`,
    )
      .bind(MAX_AUTOMATION_ATTEMPTS)
      .run();
    const jobs = await this.env.DB.prepare(
      `SELECT id,thread_id,attempts FROM discord_report_jobs
       WHERE attempts < ? AND (
         (status IN ('pending','failed')
           AND available_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         OR (status='processing' AND unixepoch(locked_at) <= unixepoch('now') - 300)
       )
       ORDER BY id LIMIT ?`,
    )
      .bind(MAX_AUTOMATION_ATTEMPTS, Math.min(Math.max(limit, 1), MAX_AUTOMATION_ATTEMPTS))
      .all<{ id: number; thread_id: string; attempts: number }>();
    let processed = 0;
    let failed = 0;
    for (const job of jobs.results) {
      const locked = await this.env.DB.prepare(
        `UPDATE discord_report_jobs
         SET status='processing',locked_at=datetime('now'),attempts=attempts+1
         WHERE id=? AND attempts < ? AND (
           status IN ('pending','failed')
           OR (status='processing' AND unixepoch(locked_at) <= unixepoch('now') - 300)
         )`,
      )
        .bind(job.id, MAX_AUTOMATION_ATTEMPTS)
        .run();
      if (locked.meta.changes !== 1) continue;
      try {
        const result = await this.processReportJob(job.thread_id);
        await this.env.DB.prepare(
          `UPDATE discord_report_jobs
           SET status=IIF(rerun_requested=1,'pending','complete'),
               rerun_requested=0,analysis_json=?,
               linked_item_id=IIF(?=1,?,linked_item_id),
               completed_at=IIF(rerun_requested=1,NULL,datetime('now')),
               available_at=IIF(
                 rerun_requested=1,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                 available_at
               ),
               locked_at=NULL,last_error=NULL
           WHERE id=?`,
        )
          .bind(
            JSON.stringify(result.analysis),
            result.updateManagedItemId ? 1 : 0,
            result.itemId,
            job.id,
          )
          .run();
        processed += 1;
      } catch (error) {
        const terminal = isTerminalAiAuthorizationError(error);
        const delay = Math.min(3_600, 2 ** Math.min(job.attempts + 1, 10));
        await this.env.DB.prepare(
          `UPDATE discord_report_jobs
           SET status='failed',attempts=IIF(?=1,?,attempts),last_error=?,
               available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),locked_at=NULL
           WHERE id=?`,
        )
          .bind(
            terminal ? 1 : 0,
            MAX_AUTOMATION_ATTEMPTS,
            redactError(error).slice(0, 2_000),
            `+${delay} seconds`,
            job.id,
          )
          .run();
        failed += 1;
      }
    }
    return { processed, failed };
  }

  async syncItem(itemId: string): Promise<void> {
    const rest = this.requireRest();
    const item = await this.engine.get(itemId);
    for (const thread of item.linkedDiscordThreads) {
      let current: DiscordThread;
      try {
        current = await rest.get<DiscordThread>(`/channels/${thread.threadId}`);
      } catch (error) {
        if (isDiscordStatus(error, 404)) continue;
        throw error;
      }
      const appliedTags = await applyRoadmapTags(rest, this.config, current, item);
      const terminal = ["done", "declined", "duplicate"].includes(item.status);
      await rest.patch(
        `/channels/${thread.threadId}`,
        {
          applied_tags: appliedTags,
          archived: false,
          locked: false,
        },
        `Roadmap ${item.id} moved to ${item.status}`,
      );
      const stateKey = `thread_status:${thread.threadId}`;
      const previousStatus = await this.getState(stateKey);
      if (previousStatus && previousStatus !== item.status) {
        const completion =
          item.status === "done"
            ? thread.kind === "bug_report"
              ? `✅ **Bug fixed**\n${escapeDiscord(item.title)} has been fixed.`
              : `✅ **Feature implemented**\n${escapeDiscord(item.title)} has been implemented.`
            : `**Roadmap update — ${escapeDiscord(item.id)}**\n${escapeDiscord(item.title)} is now **${escapeDiscord(this.statusLabel(item.status))}**.`;
        await rest.post(
          `/channels/${thread.threadId}/messages`,
          { content: completion, allowed_mentions: safeAllowedMentions() },
          `${stateKey}:${item.status}`,
        );
      }
      if (terminal) {
        await rest.patch(
          `/channels/${thread.threadId}`,
          { archived: true, locked: true },
          `Archive thread after ${item.status} roadmap decision`,
        );
      }
      await this.setState(stateKey, item.status);
    }
  }

  async reconcile(): Promise<{ threads: number; messages: number; errors: string[] }> {
    const rest = this.requireRest();
    const botUserId = await this.discordBotUserId();
    const guildId = this.config.discord.guildId;
    if (!guildId) throw new Error("discord.guildId is not configured.");
    const forumIds = [
      this.config.discord.featureRequestsForumId,
      this.config.discord.bugReportsForumId,
    ].filter((value): value is string => Boolean(value));
    const active = await rest.get<{ threads: DiscordThread[] }>(
      `/guilds/${guildId}/threads/active`,
    );
    const threads = active.threads.filter((thread) => forumIds.includes(thread.parent_id));
    for (const forumId of forumIds) {
      let before: string | undefined;
      for (;;) {
        const query = before ? `?before=${encodeURIComponent(before)}&limit=100` : "?limit=100";
        const page = await rest.get<ArchivedThreadsResponse>(
          `/channels/${forumId}/threads/archived/public${query}`,
        );
        threads.push(...page.threads);
        if (!page.has_more || page.threads.length === 0) break;
        before = page.threads.at(-1)?.thread_metadata?.archive_timestamp;
        if (!before) break;
      }
    }
    const unique = [...new Map(threads.map((thread) => [thread.id, thread])).values()];
    let messageCount = 0;
    const errors: string[] = [];
    for (const thread of unique) {
      try {
        await this.upsertThread(thread);
        // Queue a new report before crawling its message history so discovery
        // does not depend on a complete history scan.
        await this.ensureReportAutomation(thread);
        if (!(await this.shouldFetchThreadMessages(thread))) continue;
        let reportChanged = false;
        let before: string | undefined;
        for (;;) {
          const query = before ? `?limit=100&before=${before}` : "?limit=100";
          const messages = await rest.get<DiscordMessage[]>(
            `/channels/${thread.id}/messages${query}`,
          );
          for (const message of messages) {
            if (await this.upsertMessage(message, botUserId)) reportChanged = true;
          }
          messageCount += messages.length;
          if (messages.length < 100) break;
          before = messages.at(-1)?.id;
        }
        if (reportChanged) await this.enqueueReportAnalysis(thread.id, true);
        await this.setThreadMessageCheckpoint(thread);
      } catch (error) {
        errors.push(`${thread.id}: ${redactError(error)}`);
      }
    }
    await this.setState("last_reconcile_at", new Date().toISOString());
    return { threads: unique.length, messages: messageCount, errors };
  }

  async processPendingJobs(limit = 20): Promise<{ processed: number; failed: number }> {
    await this.coalesceRoadmapPublishJobs();
    const jobs = await this.env.DB.prepare(
      `SELECT id,kind,item_id,attempts FROM sync_jobs
       WHERE attempts < 10 AND (
         (status IN ('pending','failed')
           AND available_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         OR (status='processing' AND unixepoch(locked_at) <= unixepoch('now') - 300)
       )
       ORDER BY id LIMIT ?`,
    )
      .bind(limit)
      .all<{ id: number; kind: string; item_id: string | null; attempts: number }>();
    let processed = 0;
    let failed = 0;
    for (const job of jobs.results) {
      const locked = await this.env.DB.prepare(
        `UPDATE sync_jobs SET status='processing', locked_at=datetime('now'), attempts=attempts+1
         WHERE id=? AND attempts < 10 AND (
           status IN ('pending','failed')
           OR (status='processing' AND unixepoch(locked_at) <= unixepoch('now') - 300)
         )`,
      )
        .bind(job.id)
        .run();
      if (locked.meta.changes !== 1) continue;
      try {
        if (job.kind === "publish_roadmap") await this.publishRoadmap();
        else if (job.kind === "sync_item" && job.item_id) await this.syncItem(job.item_id);
        else if (job.kind === "reconcile") await this.reconcile();
        await this.env.DB.prepare(
          `UPDATE sync_jobs SET status='complete', completed_at=datetime('now'),
             locked_at=NULL,last_error=NULL
           WHERE id=?`,
        )
          .bind(job.id)
          .run();
        processed += 1;
      } catch (error) {
        const delay = Math.min(3_600, 2 ** Math.min(job.attempts + 1, 10));
        await this.env.DB.prepare(
          `UPDATE sync_jobs SET status='failed', last_error=?,
             available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?), locked_at=NULL WHERE id=?`,
        )
          .bind(redactError(error).slice(0, 2_000), `+${delay} seconds`, job.id)
          .run();
        failed += 1;
      }
    }
    return { processed, failed };
  }

  private async upsertThread(thread: DiscordThread): Promise<void> {
    const featureForum = this.config.discord.featureRequestsForumId;
    const bugForum = this.config.discord.bugReportsForumId;
    if (thread.parent_id !== featureForum && thread.parent_id !== bugForum) return;
    const kind = thread.parent_id === bugForum ? "bug_report" : "feature_request";
    const createdAt =
      thread.thread_metadata?.create_timestamp ??
      thread.thread_metadata?.archive_timestamp ??
      new Date().toISOString();
    await this.env.DB.prepare(
      `INSERT INTO discord_submissions(
        thread_id,forum_id,guild_id,kind,title,author_id,starter_message_id,
        archived,locked,applied_tags_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET
        title=excluded.title,
        archived=excluded.archived,
        locked=excluded.locked,
        applied_tags_json=excluded.applied_tags_json,
        updated_at=excluded.updated_at`,
    )
      .bind(
        thread.id,
        thread.parent_id,
        thread.guild_id,
        kind,
        sanitizeText(thread.name, 100),
        thread.owner_id ?? null,
        thread.id,
        thread.thread_metadata?.archived ? 1 : 0,
        thread.thread_metadata?.locked ? 1 : 0,
        JSON.stringify(thread.applied_tags ?? []),
        createdAt,
        new Date().toISOString(),
      )
      .run();
  }

  private async upsertMessage(message: DiscordMessage, botUserId: string | null): Promise<boolean> {
    let submission = await this.env.DB.prepare(
      "SELECT thread_id, starter_message_id FROM discord_submissions WHERE thread_id=?",
    )
      .bind(message.channel_id)
      .first<{ thread_id: string; starter_message_id: string | null }>();
    if (!submission && this.rest) {
      const thread = await this.rest.get<DiscordThread>(`/channels/${message.channel_id}`);
      await this.upsertThread(thread);
      submission = await this.env.DB.prepare(
        "SELECT thread_id, starter_message_id FROM discord_submissions WHERE thread_id=?",
      )
        .bind(message.channel_id)
        .first<{ thread_id: string; starter_message_id: string | null }>();
    }
    if (!submission) return false;
    const content = sanitizeText(message.content ?? "", 40_000);
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const attachmentsJson = JSON.stringify(attachments);
    const updatedAt = message.edited_timestamp ?? message.timestamp;
    const existing = await this.env.DB.prepare(
      `SELECT content,attachments_json,updated_at,deleted_at
       FROM discord_messages WHERE message_id=?`,
    )
      .bind(message.id)
      .first<{
        content: string;
        attachments_json: string;
        updated_at: string;
        deleted_at: string | null;
      }>();
    const changed =
      !existing ||
      existing.content !== content ||
      attachmentContentFingerprint(parseAttachments(existing.attachments_json)) !==
        attachmentContentFingerprint(attachments) ||
      existing.updated_at !== updatedAt ||
      existing.deleted_at !== null;
    await this.env.DB.prepare(
      `INSERT INTO discord_messages(
        message_id,thread_id,author_id,content,attachments_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(message_id) DO UPDATE SET
        content=excluded.content,
        attachments_json=excluded.attachments_json,
        updated_at=excluded.updated_at,
        deleted_at=NULL`,
    )
      .bind(
        message.id,
        message.channel_id,
        message.author.id,
        content,
        attachmentsJson,
        message.timestamp,
        updatedAt,
      )
      .run();
    const isStarter =
      message.id === submission.starter_message_id || message.id === message.channel_id;
    if (isStarter) {
      await this.env.DB.prepare(
        `UPDATE discord_submissions
         SET content=?, attachments_json=?, structured_metadata_json=?, updated_at=?
         WHERE thread_id=?`,
      )
        .bind(
          content,
          attachmentsJson,
          JSON.stringify(extractBugMetadata(content)),
          updatedAt,
          message.channel_id,
        )
        .run();
    }
    const isUserAuthored = isUserAuthoredDiscordMessage(message, botUserId);
    const isEvidence = isStarter || messageMentionsUser(message, botUserId);
    const wasEvidence =
      isStarter || Boolean(existing && contentMentionsUser(existing.content, botUserId));
    return isUserAuthored && changed && (isEvidence || wasEvidence);
  }

  private async upsertReaction(data: Record<string, any>, occurredAt: string): Promise<void> {
    const emoji = data.emoji ?? {};
    const emojiKey = emoji.id ? `${emoji.name}:${emoji.id}` : String(emoji.name ?? "");
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO discord_reactions(message_id,user_id,emoji_key,thread_id,created_at)
       VALUES(?,?,?,?,?)`,
    )
      .bind(
        String(data.message_id),
        String(data.user_id),
        emojiKey,
        String(data.channel_id),
        occurredAt,
      )
      .run();
  }

  private async removeReaction(data: Record<string, any>): Promise<void> {
    const emoji = data.emoji ?? {};
    const emojiKey = emoji.id ? `${emoji.name}:${emoji.id}` : String(emoji.name ?? "");
    await this.env.DB.prepare(
      "DELETE FROM discord_reactions WHERE message_id=? AND user_id=? AND emoji_key=?",
    )
      .bind(String(data.message_id), String(data.user_id), emojiKey)
      .run();
  }

  private async processReportJob(threadId: string): Promise<{
    itemId: string;
    analysis: unknown;
    updateManagedItemId: boolean;
  }> {
    const rest = this.requireRest();
    let submission = await this.env.DB.prepare(
      `SELECT thread_id,forum_id,guild_id,kind,title,starter_message_id,content,
              attachments_json,linked_item_id,
              (SELECT linked_item_id FROM discord_report_jobs WHERE thread_id=?) AS managed_item_id
       FROM discord_submissions WHERE thread_id=?`,
    )
      .bind(threadId, threadId)
      .first<{
        thread_id: string;
        forum_id: string;
        guild_id: string;
        kind: "feature_request" | "bug_report";
        title: string;
        starter_message_id: string | null;
        content: string;
        attachments_json: string;
        linked_item_id: string | null;
        managed_item_id: string | null;
      }>();
    if (!submission) throw new Error(`Discord submission ${threadId} was not found.`);
    if (submission.linked_item_id && submission.linked_item_id !== submission.managed_item_id) {
      const item = await this.engine.get(submission.linked_item_id);
      await this.syncItem(item.id);
      return { itemId: item.id, analysis: { managed: false }, updateManagedItemId: false };
    }
    const botUserId = await this.discordBotUserId();
    const thread = await rest.get<DiscordThread>(`/channels/${threadId}`);
    if (!submission.content && submission.starter_message_id) {
      const starter = await rest.get<DiscordMessage>(
        `/channels/${threadId}/messages/${submission.starter_message_id}`,
      );
      await this.upsertMessage(starter, botUserId);
      submission = (await this.env.DB.prepare(
        `SELECT thread_id,forum_id,guild_id,kind,title,starter_message_id,content,
                attachments_json,linked_item_id,
                (SELECT linked_item_id FROM discord_report_jobs WHERE thread_id=?) AS managed_item_id
         FROM discord_submissions WHERE thread_id=?`,
      )
        .bind(threadId, threadId)
        .first()) as typeof submission;
    }
    const threadMessages = await this.fetchThreadMessages(threadId);
    const evidenceMessages = threadMessages.filter((message) =>
      isReportEvidenceMessage(message, submission.starter_message_id, botUserId),
    );
    const attachments = evidenceMessages
      .flatMap((message) =>
        (message.attachments ?? []).map((attachment) => ({
          ...attachment,
          evidence_message_id: message.id,
        })),
      )
      .slice(0, 20);
    const reportAttachments = attachments.length
      ? attachments
      : parseAttachments(submission.attachments_json).map((attachment) => ({
          ...attachment,
          evidence_message_id: submission.starter_message_id ?? threadId,
        }));
    const reportContent = combineUserReportText(
      evidenceMessages,
      submission.starter_message_id,
      submission.content || submission.title,
      botUserId,
    );
    const selectedTags = await resolveAppliedTagNames(rest, thread);
    const analyzed = await analyzeDiscordReport(this.env, this.config, {
      kind: submission.kind,
      title: submission.title,
      content: reportContent,
      selectedTags,
      attachments: reportAttachments,
    });
    const eligibleFollowUpIds = new Set(
      evidenceMessages
        .filter((message) => message.id !== submission.starter_message_id)
        .map((message) => message.id),
    );
    const relevantFollowUpMessageIds = [
      ...new Set(
        analyzed.relevantFollowUpMessageIds.filter((messageId) =>
          eligibleFollowUpIds.has(messageId),
        ),
      ),
    ].sort();
    const relevantIds = new Set(relevantFollowUpMessageIds);
    const relevantMessages = evidenceMessages.filter(
      (message) => message.id === submission.starter_message_id || relevantIds.has(message.id),
    );
    const relevantAttachments = reportAttachments.filter(
      (attachment) =>
        !attachment.evidence_message_id ||
        attachment.evidence_message_id === submission.starter_message_id ||
        relevantIds.has(attachment.evidence_message_id),
    );
    const relevantContent = combineUserReportText(
      relevantMessages,
      submission.starter_message_id,
      submission.content || submission.title,
      botUserId,
    );
    const sourceRevision = await discordReportSourceRevision({
      kind: submission.kind,
      title: submission.title,
      content: relevantContent,
      attachments: relevantAttachments,
    });
    const mutationId = `discord-report:${threadId}:${sourceRevision}`;
    const replay = await this.env.DB.prepare(
      "SELECT item_id FROM audit_history WHERE mutation_id=?",
    )
      .bind(mutationId)
      .first<{ item_id: string }>();
    if (replay) {
      const item = await this.engine.get(replay.item_id);
      await this.env.DB.prepare(
        `UPDATE discord_submissions
         SET linked_item_id=?,review_state='linked',updated_at=?
         WHERE thread_id=?`,
      )
        .bind(item.id, new Date().toISOString(), threadId)
        .run();
      await this.syncItem(item.id);
      return {
        itemId: item.id,
        analysis: { replayed: true, sourceRevision, relevantFollowUpMessageIds },
        updateManagedItemId: true,
      };
    }
    const analysis = { ...analyzed, relevantFollowUpMessageIds };
    const threadUrl = `https://discord.com/channels/${submission.guild_id}/${threadId}`;
    const threadLink = {
      threadId,
      forumId: submission.forum_id,
      guildId: submission.guild_id,
      kind: submission.kind,
      url: threadUrl,
      title: submission.title,
      linkedAt: new Date().toISOString(),
    };
    const analysisFields = {
      title: analysis.title,
      description: analysis.description,
      type: submission.kind === "bug_report" ? ("bug" as const) : ("feature" as const),
      labels: [analysis.classification],
      area: analysis.area,
      priority: analysis.priority,
      references: [
        { kind: "research" as const, label: "Discord forum submission", url: threadUrl },
        ...attachmentReferences(relevantAttachments),
      ],
      acceptanceCriteria: buildAcceptanceCriteria(analysis.acceptanceCriteria),
    };
    const actor = {
      id: "discord-report-analyzer",
      displayName: "Discord report analyzer",
      kind: "system" as const,
    };
    const result = submission.linked_item_id
      ? await (async () => {
          const item = await this.engine.get(submission.linked_item_id!);
          return this.engine.update(
            item.id,
            {
              ...analysisFields,
              linkedDiscordThreads: [
                ...item.linkedDiscordThreads.filter((link) => link.threadId !== threadId),
                threadLink,
              ],
            },
            item.revision,
            {
              actor,
              mutationId,
            },
          );
        })()
      : await this.engine.create(
          CreateRoadmapItemSchema.parse({
            ...analysisFields,
            status: "planned",
            linkedDiscordThreads: [threadLink],
          }),
          {
            actor,
            mutationId,
          },
        );
    await this.env.DB.prepare(
      `UPDATE discord_submissions
       SET linked_item_id=?,review_state='linked',updated_at=?
       WHERE thread_id=?`,
    )
      .bind(result.after.id, new Date().toISOString(), threadId)
      .run();
    await this.syncItem(result.after.id);
    if (!result.replayed) {
      await rest.post(
        `/channels/${threadId}/messages`,
        {
          content: submission.linked_item_id
            ? `**Roadmap analysis updated — ${escapeDiscord(result.after.id)}**\nThe latest report edits and follow-up messages have been incorporated.`
            : reportCreatedContent(
                result.after.id,
                analysis,
                this.priorityLabel(analysis.priority),
              ),
          allowed_mentions: safeAllowedMentions(),
        },
        `report-analysis:${threadId}:${sourceRevision}`,
      );
    }
    return { itemId: result.after.id, analysis, updateManagedItemId: true };
  }

  private async fetchThreadMessages(threadId: string): Promise<DiscordMessage[]> {
    const rest = this.requireRest();
    const botUserId = await this.discordBotUserId();
    const messages: DiscordMessage[] = [];
    let before: string | undefined;
    for (;;) {
      const query = before ? `?limit=100&before=${before}` : "?limit=100";
      const page = await rest.get<DiscordMessage[]>(`/channels/${threadId}/messages${query}`);
      messages.push(...page);
      for (const message of page) await this.upsertMessage(message, botUserId);
      if (page.length < 100) break;
      before = page.at(-1)?.id;
      if (!before) break;
    }
    return messages;
  }

  private async enqueueReportAnalysis(threadId: string, ready = false): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO discord_report_jobs(thread_id,status)
       VALUES(?,'pending')
       ON CONFLICT(thread_id) DO UPDATE SET
         status=IIF(status='processing',status,'pending'),
         rerun_requested=IIF(status='processing',1,rerun_requested),
         attempts=IIF(status='processing',attempts,0),
         completed_at=IIF(status='complete',NULL,completed_at),
         available_at=IIF(
           status='processing',
           available_at,
           strftime('%Y-%m-%dT%H:%M:%fZ','now')
         ),
         locked_at=IIF(status='processing',locked_at,NULL),
         last_error=IIF(status='processing',last_error,NULL)`,
    )
      .bind(threadId)
      .run();
    if (ready) {
      await this.env.DB.prepare(
        `UPDATE discord_report_jobs
         SET status=IIF(status='processing',status,'pending'),
             rerun_requested=IIF(status='processing',1,rerun_requested),
             attempts=IIF(status='processing',attempts,0),
             completed_at=IIF(status='complete',NULL,completed_at),
             available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             locked_at=IIF(status='processing',locked_at,NULL),
             last_error=IIF(status='processing',last_error,NULL)
         WHERE thread_id=?`,
      )
        .bind(threadId)
        .run();
    }
  }

  private async ensureReportAutomation(thread: DiscordThread): Promise<void> {
    const submission = await this.env.DB.prepare(
      `SELECT s.review_state,s.linked_item_id,j.id AS job_id
       FROM discord_submissions s
       LEFT JOIN discord_report_jobs j ON j.thread_id=s.thread_id
       WHERE s.thread_id=?`,
    )
      .bind(thread.id)
      .first<{ review_state: string; linked_item_id: string | null; job_id: number | null }>();
    if (!submission || submission.review_state !== "inbox" || submission.linked_item_id) {
      return;
    }

    // Reconciliation runs frequently. An existing job is already the durable
    // record of work and must not be marked for a rerun merely because the
    // submission is still awaiting its first completed analysis.
    if (submission.job_id == null) {
      await this.enqueueReportAnalysis(thread.id, true);
    }
  }

  private async shouldFetchThreadMessages(thread: DiscordThread): Promise<boolean> {
    const raw = await this.getState(`thread_messages:${thread.id}`);
    if (!raw) return true;
    let checkpoint: ThreadMessageCheckpoint;
    try {
      checkpoint = JSON.parse(raw) as ThreadMessageCheckpoint;
    } catch {
      return true;
    }
    if (checkpoint.lastMessageId !== (thread.last_message_id ?? null)) return true;
    if (thread.thread_metadata?.archived) return false;
    const checkedAt = Date.parse(checkpoint.checkedAt);
    return !Number.isFinite(checkedAt) || checkedAt <= Date.now() - ACTIVE_THREAD_FULL_REFRESH_MS;
  }

  private async setThreadMessageCheckpoint(thread: DiscordThread): Promise<void> {
    await this.setState(
      `thread_messages:${thread.id}`,
      JSON.stringify({
        lastMessageId: thread.last_message_id ?? null,
        checkedAt: new Date().toISOString(),
      } satisfies ThreadMessageCheckpoint),
    );
  }

  private async discordBotUserId(): Promise<string | null> {
    const stored = await this.getState("discord_bot_user_id");
    if (stored) return stored;
    if (!this.rest) return null;
    const bot = await this.rest.get<{ id?: string }>("/users/@me");
    const id = typeof bot.id === "string" && bot.id ? bot.id : null;
    if (id) await this.setState("discord_bot_user_id", id);
    return id;
  }

  private async allItems(): Promise<RoadmapItem[]> {
    const items: RoadmapItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.engine.list({ limit: 250, ...(cursor ? { cursor } : {}) });
      items.push(...page.data.map((item) => RoadmapItemSchema.parse(item)));
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  private requireRest(): DiscordRestClient {
    if (!this.rest) throw new Error("DISCORD_BOT_TOKEN is not configured.");
    return this.rest;
  }

  private async getState(key: string): Promise<string | null> {
    const row = await this.env.DB.prepare("SELECT value FROM discord_state WHERE key=?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  private async setState(key: string, value: string): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO discord_state(key,value,updated_at) VALUES(?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    )
      .bind(key, value, new Date().toISOString())
      .run();
  }

  private async roadmapEmojiIds(): Promise<RoadmapTimelineEmojiIds> {
    const [line, dot] = await Promise.all([
      this.getState("roadmap_emoji_line_id"),
      this.getState("roadmap_emoji_dot_id"),
    ]);
    return { ...(line ? { line } : {}), ...(dot ? { dot } : {}) };
  }

  private async coalesceRoadmapPublishJobs(): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE sync_jobs
       SET status='complete',completed_at=datetime('now'),locked_at=NULL,last_error=NULL
       WHERE kind='publish_roadmap' AND status!='complete'
         AND id < (
           SELECT COALESCE(MAX(id),0) FROM sync_jobs
           WHERE kind='publish_roadmap' AND status!='complete'
         )`,
    ).run();
    await this.env.DB.prepare(
      `UPDATE sync_jobs
       SET status='failed',locked_at=NULL,
           last_error=COALESCE(last_error,'Synchronization exceeded its retry budget.')
       WHERE status='processing' AND attempts >= ?
         AND unixepoch(locked_at) <= unixepoch('now') - 300`,
    )
      .bind(MAX_AUTOMATION_ATTEMPTS)
      .run();
  }

  private statusLabel(status: string): string {
    return this.config.lifecycle.find((state) => state.id === status)?.label ?? status;
  }

  private priorityLabel(priority: string): string {
    return this.config.priorities.find((value) => value.id === priority)?.label ?? priority;
  }
}

export function componentsV2RoadmapBody(
  projection: Awaited<ReturnType<typeof generateVersionRoadmapProjection>>,
  config: RoadmapConfig,
  emojiIds: RoadmapTimelineEmojiIds = {},
) {
  const versionContainers = projection.versions.map((version) => {
    const dot = discordRoadmapEmoji("sakura_roadmap_dot", emojiIds.dot, "◉");
    const line = discordRoadmapEmoji("sakura_roadmap_line", emojiIds.line, "│");
    const highlights = version.highlights.map(
      (highlight) => `${line} **${escapeDiscord(highlight.title)}**`,
    );
    return {
      type: 17,
      accent_color: colorValue(config.branding.primaryColor),
      components: [
        {
          type: 10,
          content: `${dot} **v${escapeDiscord(version.version)} — ${escapeDiscord(version.title)}**\n${
            highlights.length ? highlights.join("\n") : "_Highlights are being prepared._"
          }`,
        },
      ],
    };
  });
  if (versionContainers.length === 0) {
    versionContainers.push({
      type: 17,
      accent_color: colorValue(config.branding.primaryColor),
      components: [
        {
          type: 10,
          content:
            "## The next version plan is being prepared.\nCheck back soon for a focused view of what comes next.",
        },
      ],
    });
  }
  const components: unknown[] = [
    {
      type: 17,
      accent_color: colorValue(config.branding.accentColor),
      components: [
        {
          type: 10,
          content: `# ${escapeDiscord(config.project.name)} Roadmap`,
        },
      ],
    },
    ...versionContainers,
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: "Open roadmap",
          url: config.project.publicUrl,
        },
        ...(config.project.trackerUrl
          ? [
              {
                type: 2,
                style: 5,
                label: "Detailed tracker",
                url: config.project.trackerUrl,
              },
            ]
          : []),
        {
          type: 2,
          style: 2,
          label: "Subscribe",
          custom_id: "roadmap:subscribe",
        },
      ],
    },
  ];
  return { flags: 1 << 15, components, allowed_mentions: safeAllowedMentions() };
}

export function componentsV2RoadmapEditBody(
  projection: Awaited<ReturnType<typeof generateVersionRoadmapProjection>>,
  config: RoadmapConfig,
  emojiIds: RoadmapTimelineEmojiIds = {},
) {
  return {
    ...componentsV2RoadmapBody(projection, config, emojiIds),
    content: null,
    embeds: [],
    attachments: [],
    poll: null,
  };
}

export interface RoadmapTimelineEmojiIds {
  line?: string;
  dot?: string;
}

function discordRoadmapEmoji(name: string, id: string | undefined, fallback: string): string {
  return id ? `<:${name}:${id}>` : fallback;
}

export function combineUserReportText(
  messages: Array<{
    id: string;
    content: string;
    timestamp: string;
    author: { id?: string; bot?: boolean };
    attachments?: DiscordReportAttachment[];
    mentions?: Array<{ id: string }>;
    webhook_id?: string;
    application_id?: string;
  }>,
  starterMessageId: string | null,
  fallback: string,
  botUserId: string | null = null,
): string {
  const report = messages
    .filter(
      (message) =>
        isReportEvidenceMessage(message, starterMessageId, botUserId) &&
        (message.content.trim() || (message.attachments?.length ?? 0) > 0),
    )
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .map((message) => {
      const label =
        message.id === starterMessageId
          ? "Initial report"
          : `Bot-mentioned follow-up evidence (message ID: ${message.id})`;
      const attachmentNote = (message.attachments ?? []).length
        ? `Attached files: ${(message.attachments ?? [])
            .map((attachment) => attachment.filename ?? attachment.id ?? "attachment")
            .join(", ")}`
        : "";
      return `${label}:\n${[message.content.trim(), attachmentNote].filter(Boolean).join("\n")}`;
    })
    .join("\n\n");
  return sanitizeText(report || fallback, 40_000);
}

export function isReportEvidenceMessage(
  message: {
    id: string;
    content?: string;
    author: { id?: string; bot?: boolean };
    mentions?: Array<{ id: string }>;
    webhook_id?: string;
    application_id?: string;
  },
  starterMessageId: string | null,
  botUserId: string | null = null,
): boolean {
  return (
    isUserAuthoredDiscordMessage(message, botUserId) &&
    (message.id === starterMessageId || messageMentionsUser(message, botUserId))
  );
}

function messageMentionsUser(
  message: { content?: string; mentions?: Array<{ id: string }> },
  userId: string | null,
): boolean {
  if (!userId) return false;
  return (
    message.mentions?.some((mention) => mention.id === userId) === true ||
    contentMentionsUser(message.content ?? "", userId)
  );
}

function contentMentionsUser(content: string, userId: string | null): boolean {
  return Boolean(userId && (content.includes(`<@${userId}>`) || content.includes(`<@!${userId}>`)));
}

export function isUserAuthoredDiscordMessage(
  message: {
    author: { id?: string; bot?: boolean };
    webhook_id?: string;
    application_id?: string;
  },
  botUserId: string | null = null,
): boolean {
  return (
    message.author.bot !== true &&
    (!botUserId || message.author.id !== botUserId) &&
    !message.webhook_id &&
    !message.application_id
  );
}

export function reportCreatedContent(
  itemId: string,
  analysis: { title: string; classification: "visual" | "functionality" },
  priorityLabel: string,
): string {
  return [
    `**Roadmap report created — ${escapeDiscord(itemId)}**`,
    `**${escapeDiscord(analysis.title)}**`,
    `Classification: **${analysis.classification === "visual" ? "Visual" : "Functionality"}** · Priority: **${escapeDiscord(priorityLabel)}** · Status: **Planned**`,
  ].join("\n");
}

function colorValue(color: string): number {
  return Number.parseInt(color.slice(1), 16);
}

function isDiscordStatus(error: unknown, status: number): boolean {
  if (!(error instanceof RoadmapError) || error.code !== "DISCORD_API_ERROR") return false;
  const details = error.details;
  return Boolean(
    details &&
    typeof details === "object" &&
    "status" in details &&
    (details as { status?: unknown }).status === status,
  );
}

function sanitizeText(value: string, max: number): string {
  return value.split("\u0000").join("").slice(0, max);
}

function extractBugMetadata(content: string): Record<string, string> {
  const aliases: Record<string, string> = {
    "application version": "applicationVersion",
    "app version": "applicationVersion",
    "operating system": "operatingSystemVersion",
    "os version": "operatingSystemVersion",
    hardware: "hardware",
    "reproduction steps": "reproductionSteps",
    "steps to reproduce": "reproductionSteps",
    "expected behavior": "expectedBehavior",
    "actual behavior": "actualBehavior",
    diagnostics: "diagnostics",
  };
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^(?:#{1,4}\s*)?([^:]{2,40}):\s*(.+)$/);
    if (!match) continue;
    const key = aliases[match[1]!.trim().toLowerCase()];
    if (key) result[key] = match[2]!.trim().slice(0, 5_000);
  }
  return result;
}

function parseAttachments(value: string): DiscordReportAttachment[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function attachmentContentFingerprint(attachments: DiscordReportAttachment[]): string {
  return JSON.stringify(stableAttachmentContent(attachments));
}

export async function discordReportSourceRevision(input: {
  kind: "feature_request" | "bug_report";
  title: string;
  content: string;
  attachments: DiscordReportAttachment[];
}): Promise<string> {
  return (
    await sha256(
      JSON.stringify({
        kind: input.kind,
        title: input.title,
        content: input.content,
        attachments: stableAttachmentContent(input.attachments),
      }),
    )
  ).slice(0, 24);
}

function stableAttachmentContent(attachments: DiscordReportAttachment[]) {
  return attachments.map((attachment) => ({
    id: attachment.id ?? null,
    filename: attachment.filename ?? null,
    description: attachment.description ?? null,
    contentType: attachment.content_type ?? null,
    size: attachment.size ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    url: stableAttachmentUrl(attachment.url),
    proxyUrl: stableAttachmentUrl(attachment.proxy_url),
  }));
}

function stableAttachmentUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split("?")[0]!.split("#")[0]!;
  }
}
