import {
  CreateRoadmapItemSchema,
  DiscordGatewayEventSchema,
  RoadmapItemSchema,
  escapeDiscord,
  generateDiscordProjection,
  renderDiscordText,
  type DiscordGatewayEvent,
  type RoadmapConfig,
  type RoadmapEngine,
  type RoadmapItem,
} from "@roadmap/core";
import type { Env } from "../env.js";
import {
  analyzeDiscordReport,
  attachmentReferences,
  buildAcceptanceCriteria,
  type DiscordReportAttachment,
} from "../report-analysis.js";
import { redactError, sha256 } from "../security.js";
import {
  applyRoadmapTags,
  ensureForumTaxonomy,
  resolveAppliedTagNames,
  type TagIconPayloads,
} from "./forums.js";
import { reviewControls } from "./interactions.js";
import { DiscordRestClient, safeAllowedMentions } from "./rest.js";

interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  author: { id: string; bot?: boolean };
  attachments?: DiscordReportAttachment[];
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

interface DiscordEmoji {
  id: string;
  name: string;
}

export class DiscordSyncService {
  private readonly rest: DiscordRestClient | null;

  constructor(
    private readonly env: Env,
    private readonly config: RoadmapConfig,
    private readonly engine: RoadmapEngine,
  ) {
    this.rest = env.DISCORD_BOT_TOKEN ? new DiscordRestClient(env.DISCORD_BOT_TOKEN) : null;
  }

  async publishRoadmap(force = false): Promise<{
    changed: boolean;
    hash: string;
    messageId?: string;
  }> {
    const rest = this.requireRest();
    const channelId = this.config.discord.roadmapChannelId;
    if (!channelId) throw new Error("discord.roadmapChannelId is not configured.");
    const items = await this.allItems();
    const projection = await generateDiscordProjection(items, this.config);
    const previousHash = await this.getState("roadmap_projection_hash");
    const configuredMessageId =
      (await this.getState("roadmap_message_id")) ?? this.config.discord.roadmapMessageId;
    if (!force && previousHash === projection.hash && configuredMessageId) {
      return { changed: false, hash: projection.hash, messageId: configuredMessageId };
    }
    const emojiIds = this.config.discord.enableComponentsV2
      ? await this.tagEmojiIds(rest)
      : new Map<string, string>();
    const body = this.config.discord.enableComponentsV2
      ? componentsV2RoadmapBody(projection, this.config, emojiIds)
      : {
          content: renderDiscordText(projection),
          allowed_mentions: safeAllowedMentions(),
        };
    let messageId = configuredMessageId;
    if (messageId) {
      try {
        const edited = await rest.patch<{ id: string }>(
          `/channels/${channelId}/messages/${messageId}`,
          body,
          "Update canonical roadmap projection",
        );
        messageId = edited.id;
      } catch {
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
    const jobs = await this.env.DB.prepare(
      `SELECT id,thread_id,attempts FROM discord_report_jobs
       WHERE status IN ('pending','failed')
         AND available_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
       ORDER BY id LIMIT ?`,
    )
      .bind(Math.min(Math.max(limit, 1), 10))
      .all<{ id: number; thread_id: string; attempts: number }>();
    let processed = 0;
    let failed = 0;
    for (const job of jobs.results) {
      const locked = await this.env.DB.prepare(
        `UPDATE discord_report_jobs
         SET status='processing',locked_at=datetime('now'),attempts=attempts+1
         WHERE id=? AND status IN ('pending','failed')`,
      )
        .bind(job.id)
        .run();
      if (locked.meta.changes !== 1) continue;
      try {
        const result = await this.processReportJob(job.thread_id);
        await this.env.DB.prepare(
          `UPDATE discord_report_jobs
           SET status='complete',analysis_json=?,linked_item_id=?,completed_at=datetime('now'),
               locked_at=NULL,last_error=NULL
           WHERE id=?`,
        )
          .bind(JSON.stringify(result.analysis), result.itemId, job.id)
          .run();
        processed += 1;
      } catch (error) {
        const delay = Math.min(3_600, 2 ** Math.min(job.attempts + 1, 10));
        await this.env.DB.prepare(
          `UPDATE discord_report_jobs
           SET status='failed',last_error=?,
               available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),locked_at=NULL
           WHERE id=?`,
        )
          .bind(redactError(error).slice(0, 2_000), `+${delay} seconds`, job.id)
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
      const current = await rest.get<DiscordThread>(`/channels/${thread.threadId}`);
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
      if (previousStatus && previousStatus !== item.status && item.status !== "inbox") {
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

  async processEvent(raw: unknown): Promise<{ duplicate: boolean; eventType: string }> {
    const event = DiscordGatewayEventSchema.parse(raw);
    const payloadHash = await sha256(JSON.stringify(event.data));
    try {
      await this.env.DB.prepare(
        `INSERT INTO discord_events(
          event_id,sequence,event_type,payload_hash,status,received_at
        ) VALUES(?,?,?,?,?,?)`,
      )
        .bind(event.eventId, event.sequence, event.type, payloadHash, "received", event.occurredAt)
        .run();
    } catch {
      return { duplicate: true, eventType: event.type };
    }
    try {
      await this.applyEvent(event);
      await this.env.DB.prepare(
        `UPDATE discord_events SET status='processed', processed_at=? WHERE event_id=?`,
      )
        .bind(new Date().toISOString(), event.eventId)
        .run();
      if (event.sequence !== null) await this.setState("gateway_sequence", String(event.sequence));
      return { duplicate: false, eventType: event.type };
    } catch (error) {
      await this.env.DB.prepare(
        `UPDATE discord_events SET status='failed', error=?, processed_at=? WHERE event_id=?`,
      )
        .bind(redactError(error).slice(0, 2_000), new Date().toISOString(), event.eventId)
        .run();
      throw error;
    }
  }

  async reconcile(): Promise<{ threads: number; messages: number; errors: string[] }> {
    const rest = this.requireRest();
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
        let before: string | undefined;
        for (;;) {
          const query = before ? `?limit=100&before=${before}` : "?limit=100";
          const messages = await rest.get<DiscordMessage[]>(
            `/channels/${thread.id}/messages${query}`,
          );
          for (const message of messages) await this.upsertMessage(message);
          messageCount += messages.length;
          if (messages.length < 100) break;
          before = messages.at(-1)?.id;
        }
        await this.ensureReportAutomation(thread);
      } catch (error) {
        errors.push(`${thread.id}: ${redactError(error)}`);
      }
    }
    await this.setState("last_reconcile_at", new Date().toISOString());
    return { threads: unique.length, messages: messageCount, errors };
  }

  async processPendingJobs(limit = 20): Promise<{ processed: number; failed: number }> {
    const jobs = await this.env.DB.prepare(
      `SELECT id,kind,item_id,attempts FROM sync_jobs
       WHERE status IN ('pending','failed')
         AND available_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
       ORDER BY id LIMIT ?`,
    )
      .bind(limit)
      .all<{ id: number; kind: string; item_id: string | null; attempts: number }>();
    let processed = 0;
    let failed = 0;
    for (const job of jobs.results) {
      const locked = await this.env.DB.prepare(
        `UPDATE sync_jobs SET status='processing', locked_at=datetime('now'), attempts=attempts+1
         WHERE id=? AND status IN ('pending','failed')`,
      )
        .bind(job.id)
        .run();
      if (locked.meta.changes !== 1) continue;
      try {
        if (job.kind === "publish_roadmap") await this.publishRoadmap();
        else if (job.kind === "sync_item" && job.item_id) await this.syncItem(job.item_id);
        else if (job.kind === "reconcile") await this.reconcile();
        await this.env.DB.prepare(
          `UPDATE sync_jobs SET status='complete', completed_at=datetime('now'), last_error=NULL
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

  private async applyEvent(event: DiscordGatewayEvent): Promise<void> {
    const data = event.data as Record<string, any>;
    switch (event.type) {
      case "THREAD_CREATE":
        await this.upsertThread(data as DiscordThread);
        await this.ensureReportAutomation(data as DiscordThread);
        return;
      case "THREAD_UPDATE":
        await this.upsertThread(data as DiscordThread);
        return;
      case "THREAD_DELETE":
        await this.env.DB.prepare(
          `UPDATE discord_submissions SET archived=1, updated_at=? WHERE thread_id=?`,
        )
          .bind(event.occurredAt, String(data.id))
          .run();
        return;
      case "MESSAGE_CREATE":
      case "MESSAGE_UPDATE":
        if (await this.upsertMessage(data as DiscordMessage)) {
          await this.enqueueReportAnalysis(String(data.channel_id), true);
        }
        return;
      case "MESSAGE_DELETE":
        await this.env.DB.prepare(
          `UPDATE discord_messages SET deleted_at=?, updated_at=? WHERE message_id=?`,
        )
          .bind(event.occurredAt, event.occurredAt, String(data.id))
          .run();
        return;
      case "MESSAGE_REACTION_ADD":
        await this.upsertReaction(data, event.occurredAt);
        return;
      case "MESSAGE_REACTION_REMOVE":
        await this.removeReaction(data);
        return;
      case "MESSAGE_REACTION_REMOVE_ALL":
        await this.env.DB.prepare("DELETE FROM discord_reactions WHERE message_id=?")
          .bind(String(data.message_id))
          .run();
        await this.refreshCommunityCount(String(data.channel_id));
        return;
      case "THREAD_LIST_SYNC":
        return;
    }
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

  private async upsertMessage(message: DiscordMessage): Promise<boolean> {
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
        JSON.stringify(attachments),
        message.timestamp,
        message.edited_timestamp ?? message.timestamp,
      )
      .run();
    if (message.id === submission.starter_message_id || message.id === message.channel_id) {
      await this.env.DB.prepare(
        `UPDATE discord_submissions
         SET content=?, attachments_json=?, structured_metadata_json=?, updated_at=?
         WHERE thread_id=?`,
      )
        .bind(
          content,
          JSON.stringify(attachments),
          JSON.stringify(extractBugMetadata(content)),
          message.edited_timestamp ?? message.timestamp,
          message.channel_id,
        )
        .run();
      return true;
    }
    return false;
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
    await this.refreshCommunityCount(String(data.channel_id));
  }

  private async removeReaction(data: Record<string, any>): Promise<void> {
    const emoji = data.emoji ?? {};
    const emojiKey = emoji.id ? `${emoji.name}:${emoji.id}` : String(emoji.name ?? "");
    await this.env.DB.prepare(
      "DELETE FROM discord_reactions WHERE message_id=? AND user_id=? AND emoji_key=?",
    )
      .bind(String(data.message_id), String(data.user_id), emojiKey)
      .run();
    await this.refreshCommunityCount(String(data.channel_id));
  }

  private async refreshCommunityCount(threadId: string): Promise<void> {
    const linked = await this.env.DB.prepare(
      "SELECT linked_item_id FROM discord_submissions WHERE thread_id=?",
    )
      .bind(threadId)
      .first<{ linked_item_id: string | null }>();
    if (!linked?.linked_item_id) return;
    const row = await this.env.DB.prepare(
      `SELECT count(DISTINCT r.user_id) AS count
       FROM discord_reactions r
       JOIN discord_submissions s ON s.thread_id = r.thread_id
       WHERE s.linked_item_id=?`,
    )
      .bind(linked.linked_item_id)
      .first<{ count: number }>();
    const item = await this.engine.get(linked.linked_item_id);
    await this.engine.update(item.id, { communityReactionCount: row?.count ?? 0 }, item.revision, {
      actor: { id: "discord-sync", displayName: "Discord sync", kind: "system" },
      mutationId: `reaction-count:${threadId}:${row?.count ?? 0}:rev${item.revision}`,
    });
  }

  private async postReviewControls(thread: DiscordThread): Promise<void> {
    if (!this.rest) return;
    const isConfiguredForum =
      thread.parent_id === this.config.discord.featureRequestsForumId ||
      thread.parent_id === this.config.discord.bugReportsForumId;
    if (!isConfiguredForum) return;
    const key = `review_controls:${thread.id}`;
    if (await this.getState(key)) return;
    await this.rest.post(
      `/channels/${thread.id}/messages`,
      {
        content:
          "I’m scanning this submission and its attachments now. It will be created in the roadmap **Inbox** for maintainer review, with classification and priority tags corrected when needed.",
        components: reviewControls(thread.id, this.config),
        allowed_mentions: safeAllowedMentions(),
      },
      key,
    );
    await this.setState(key, new Date().toISOString());
  }

  private async processReportJob(threadId: string): Promise<{
    itemId: string;
    analysis: unknown;
  }> {
    const rest = this.requireRest();
    let submission = await this.env.DB.prepare(
      `SELECT thread_id,forum_id,guild_id,kind,title,starter_message_id,content,
              attachments_json,linked_item_id
       FROM discord_submissions WHERE thread_id=?`,
    )
      .bind(threadId)
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
      }>();
    if (!submission) throw new Error(`Discord submission ${threadId} was not found.`);
    if (submission.linked_item_id) {
      const item = await this.engine.get(submission.linked_item_id);
      await this.syncItem(item.id);
      return { itemId: item.id, analysis: { replayed: true } };
    }
    const thread = await rest.get<DiscordThread>(`/channels/${threadId}`);
    if (!submission.content && submission.starter_message_id) {
      const starter = await rest.get<DiscordMessage>(
        `/channels/${threadId}/messages/${submission.starter_message_id}`,
      );
      await this.upsertMessage(starter);
      submission = (await this.env.DB.prepare(
        `SELECT thread_id,forum_id,guild_id,kind,title,starter_message_id,content,
                attachments_json,linked_item_id
         FROM discord_submissions WHERE thread_id=?`,
      )
        .bind(threadId)
        .first()) as typeof submission;
    }
    const threadMessages = await this.fetchThreadMessages(threadId);
    const attachments = threadMessages
      .filter((message) => !message.author.bot)
      .flatMap((message) => message.attachments ?? [])
      .slice(0, 20);
    const reportAttachments = attachments.length
      ? attachments
      : parseAttachments(submission.attachments_json);
    const selectedTags = await resolveAppliedTagNames(rest, thread);
    const analysis = await analyzeDiscordReport(this.env, this.config, {
      kind: submission.kind,
      title: submission.title,
      content: combineUserReportText(
        threadMessages,
        submission.starter_message_id,
        submission.content || submission.title,
      ),
      selectedTags,
      attachments: reportAttachments,
    });
    const threadUrl = `https://discord.com/channels/${submission.guild_id}/${threadId}`;
    const created = await this.engine.create(
      CreateRoadmapItemSchema.parse({
        title: analysis.title,
        description: analysis.description,
        type: submission.kind === "bug_report" ? "bug" : "feature",
        labels: [analysis.classification],
        area: analysis.area,
        status: "planned",
        priority: analysis.priority,
        difficulty: analysis.difficulty,
        confidence: analysis.confidence,
        proposedImplementation: analysis.proposedImplementation,
        affectedComponents: analysis.affectedComponents,
        risks: analysis.risks,
        requiredResearch: analysis.requiredResearch,
        references: [
          { kind: "research", label: "Discord forum submission", url: threadUrl },
          ...attachmentReferences(reportAttachments),
        ],
        acceptanceCriteria: buildAcceptanceCriteria(analysis.acceptanceCriteria),
        linkedDiscordThreads: [
          {
            threadId,
            forumId: submission.forum_id,
            guildId: submission.guild_id,
            kind: submission.kind,
            url: threadUrl,
            title: submission.title,
            linkedAt: new Date().toISOString(),
          },
        ],
      }),
      {
        actor: {
          id: "discord-report-analyzer",
          displayName: "Discord report analyzer",
          kind: "system",
        },
        mutationId: `discord-report:${threadId}`,
      },
    );
    await this.env.DB.prepare(
      `UPDATE discord_submissions
       SET linked_item_id=?,review_state='linked',updated_at=?
       WHERE thread_id=?`,
    )
      .bind(created.after.id, new Date().toISOString(), threadId)
      .run();
    await this.syncItem(created.after.id);
    await rest.post(
      `/channels/${threadId}/messages`,
      {
        content: reportCreatedContent(
          created.after.id,
          analysis,
          this.priorityLabel(analysis.priority),
        ),
        allowed_mentions: safeAllowedMentions(),
      },
      `report-analysis:${threadId}`,
    );
    return { itemId: created.after.id, analysis };
  }

  private async fetchThreadMessages(threadId: string): Promise<DiscordMessage[]> {
    const rest = this.requireRest();
    const messages: DiscordMessage[] = [];
    let before: string | undefined;
    for (;;) {
      const query = before ? `?limit=100&before=${before}` : "?limit=100";
      const page = await rest.get<DiscordMessage[]>(`/channels/${threadId}/messages${query}`);
      messages.push(...page);
      for (const message of page) await this.upsertMessage(message);
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
         status=IIF(status IN ('complete','processing'),status,'pending'),
         available_at=IIF(
           status IN ('complete','processing'),
           available_at,
           strftime('%Y-%m-%dT%H:%M:%fZ','now')
         ),
         locked_at=IIF(status IN ('complete','processing'),locked_at,NULL),
         last_error=IIF(status IN ('complete','processing'),last_error,NULL)`,
    )
      .bind(threadId)
      .run();
    if (ready) {
      await this.env.DB.prepare(
        `UPDATE discord_report_jobs
         SET status='pending',
             available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             locked_at=NULL
         WHERE thread_id=? AND status NOT IN ('complete','processing')`,
      )
        .bind(threadId)
        .run();
    }
  }

  private async ensureReportAutomation(thread: DiscordThread): Promise<void> {
    const submission = await this.env.DB.prepare(
      `SELECT review_state,linked_item_id
       FROM discord_submissions WHERE thread_id=?`,
    )
      .bind(thread.id)
      .first<{ review_state: string; linked_item_id: string | null }>();
    if (!submission || submission.review_state !== "inbox" || submission.linked_item_id) {
      return;
    }

    await this.enqueueReportAnalysis(thread.id, true);
    if (!(await this.getState(`review_controls:${thread.id}`))) {
      await this.applyInitialInboxTag(thread);
      await this.postReviewControls(thread);
    }
  }

  private async applyInitialInboxTag(thread: DiscordThread): Promise<void> {
    const rest = this.requireRest();
    const inboxTag =
      this.config.discord.statusTagMappings[`${thread.parent_id}:inbox`] ??
      this.config.discord.statusTagMappings.inbox;
    if (!inboxTag) return;
    const statusTags = new Set(Object.values(this.config.discord.statusTagMappings));
    const retained = (thread.applied_tags ?? []).filter((tag) => !statusTags.has(tag));
    await rest.patch(
      `/channels/${thread.id}`,
      { applied_tags: [...retained, inboxTag].slice(0, 5), archived: false, locked: false },
      "Place new roadmap submission in Inbox",
    );
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

  private statusLabel(status: string): string {
    return this.config.lifecycle.find((state) => state.id === status)?.label ?? status;
  }

  private priorityLabel(priority: string): string {
    return this.config.priorities.find((value) => value.id === priority)?.label ?? priority;
  }

  private async tagEmojiIds(rest: DiscordRestClient): Promise<Map<string, string>> {
    const guildId = this.config.discord.guildId;
    if (!guildId) return new Map();
    const emojis = await rest.get<DiscordEmoji[]>(`/guilds/${guildId}/emojis`);
    return new Map(
      emojis
        .filter((emoji) => emoji.name.startsWith("sakura_tag_"))
        .map((emoji) => [emoji.name.slice("sakura_tag_".length), emoji.id]),
    );
  }
}

export function componentsV2RoadmapBody(
  projection: Awaited<ReturnType<typeof generateDiscordProjection>>,
  config: RoadmapConfig,
  emojiIds: Map<string, string> = new Map(),
) {
  const statusContainers = config.publicSections.map((publicSection) => {
    const statusId = publicSection.statuses[0] ?? publicSection.id;
    const status = config.lifecycle.find((value) => value.id === statusId);
    const statusEmoji = customEmoji(statusId, emojiIds);
    const groupContent = projection.groups
      .map((group) => {
        const section = group.sections.find((value) => value.id === publicSection.id);
        const groupEmoji = group.id === "feature" ? "💡" : group.id === "bug" ? "🪲" : "•";
        const lines = (section?.items ?? []).map((item) => {
          const priorityEmoji = customEmoji(item.priority, emojiIds);
          return `${priorityEmoji ? `${priorityEmoji} ` : "• "}**${escapeDiscord(item.title)}**`;
        });
        return `### ${groupEmoji} ${escapeDiscord(group.label)}\n${
          lines.length ? lines.join("\n") : "_Nothing here yet._"
        }`;
      })
      .join("\n\n");
    return {
      type: 17,
      accent_color: colorValue(status?.color ?? config.branding.accentColor),
      components: [
        {
          type: 10,
          content: `## ${statusEmoji ? `${statusEmoji} ` : ""}${escapeDiscord(publicSection.label)}\n${groupContent}`,
        },
      ],
    };
  });
  const components: unknown[] = [
    {
      type: 17,
      accent_color: colorValue(config.branding.accentColor),
      components: [
        {
          type: 10,
          content: `# ${escapeDiscord(config.project.name)} Roadmap\nFeatures and fixes, grouped by delivery stage.`,
        },
      ],
    },
    ...statusContainers,
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: "Open detailed roadmap",
          url: config.project.publicUrl,
        },
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

export function combineUserReportText(
  messages: Array<{
    id: string;
    content: string;
    timestamp: string;
    author: { bot?: boolean };
  }>,
  starterMessageId: string | null,
  fallback: string,
): string {
  const report = messages
    .filter((message) => !message.author.bot && message.content.trim())
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .map((message) => {
      const label = message.id === starterMessageId ? "Initial report" : "Follow-up message";
      return `${label}:\n${message.content.trim()}`;
    })
    .join("\n\n");
  return sanitizeText(report || fallback, 40_000);
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

function customEmoji(key: string, emojiIds: Map<string, string>): string {
  const id = emojiIds.get(key);
  return id ? `<:sakura_tag_${key}:${id}>` : "";
}

function colorValue(color: string): number {
  return Number.parseInt(color.slice(1), 16);
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
