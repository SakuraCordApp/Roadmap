import type { IssueKind, StatusId } from "../config";
import type { AttachmentRef, Reporter } from "../report/body";
import type { ReportValues } from "../report/schema";
import { nowIso } from "../util/text";

export interface FixRef {
  kind: "pr" | "commit";
  number?: number;
  sha?: string;
  url: string;
  title?: string;
  author?: string;
  state: "open" | "merged" | "closed";
  base?: string;
}

export interface TriageResult {
  resolution?: {
    state:
      "unresolved" | "possible_regression" | "fixed_unreleased" | "fixed_nightly" | "fixed_regular";
    commit: string | null;
    releaseTag: string | null;
    explanation: string;
  };
  kind: IssueKind;
  area: string;
  priority: string;
  title: string;
  summary: string;
  duplicateOf: number | null;
  duplicateConfidence: number;
  duplicateReason: string;
  needsInformation: boolean;
  questions: string[];
  model: string;
}

export interface IssueRecord {
  number: number;
  githubId: number | null;
  nodeId: string | null;
  title: string;
  body: string;
  kind: IssueKind | null;
  state: "open" | "closed";
  stateReason: string | null;
  status: StatusId;
  area: string | null;
  priority: string | null;
  labels: string[];
  milestoneNumber: number | null;
  milestoneTitle: string | null;
  authorLogin: string | null;
  authorType: string | null;
  reporter: Reporter | null;
  summary: string | null;
  reactionsUp: number;
  commentsCount: number;
  duplicateOf: number | null;
  fixes: FixRef[];
  shippedIn: string | null;
  shippedStableIn: string | null;
  triage: TriageResult | null;
  triagedAt: string | null;
  embeddedHash: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  syncedAt: string;
}

type Row = Record<string, any>;

const parse = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

function toIssue(row: Row): IssueRecord {
  return {
    number: row.number,
    githubId: row.github_id ?? null,
    nodeId: row.node_id ?? null,
    title: row.title,
    body: row.body ?? "",
    kind: row.kind ?? null,
    state: row.state,
    stateReason: row.state_reason ?? null,
    status: row.status,
    area: row.area ?? null,
    priority: row.priority ?? null,
    labels: parse(row.labels_json, []),
    milestoneNumber: row.milestone_number ?? null,
    milestoneTitle: row.milestone_title ?? null,
    authorLogin: row.author_login ?? null,
    authorType: row.author_type ?? null,
    reporter: parse(row.reporter_json, null),
    summary: row.summary ?? null,
    reactionsUp: row.reactions_up ?? 0,
    commentsCount: row.comments_count ?? 0,
    duplicateOf: row.duplicate_of ?? null,
    fixes: parse(row.fixes_json, []),
    shippedIn: row.shipped_in ?? null,
    shippedStableIn: row.shipped_stable_in ?? null,
    triage: parse(row.triage_json, null),
    triagedAt: row.triaged_at ?? null,
    embeddedHash: row.embedded_hash ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? null,
    syncedAt: row.synced_at,
  };
}

export async function getIssue(db: D1Database, number: number): Promise<IssueRecord | null> {
  const row = await db.prepare("SELECT * FROM issues WHERE number=?").bind(number).first<Row>();
  return row ? toIssue(row) : null;
}

export async function listIssues(db: D1Database): Promise<IssueRecord[]> {
  const { results } = await db.prepare("SELECT * FROM issues ORDER BY number DESC").all<Row>();
  return results.map(toIssue);
}

export async function saveIssue(db: D1Database, issue: IssueRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO issues(number,github_id,node_id,title,body,kind,state,state_reason,status,area,
        priority,labels_json,milestone_number,milestone_title,author_login,author_type,reporter_json,
        summary,reactions_up,comments_count,duplicate_of,fixes_json,shipped_in,shipped_stable_in,
        triage_json,triaged_at,embedded_hash,created_at,updated_at,closed_at,synced_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(number) DO UPDATE SET github_id=excluded.github_id,node_id=excluded.node_id,
        title=excluded.title,body=excluded.body,kind=excluded.kind,state=excluded.state,
        state_reason=excluded.state_reason,status=excluded.status,area=excluded.area,
        priority=excluded.priority,labels_json=excluded.labels_json,
        milestone_number=excluded.milestone_number,milestone_title=excluded.milestone_title,
        author_login=excluded.author_login,author_type=excluded.author_type,
        reporter_json=excluded.reporter_json,summary=excluded.summary,
        reactions_up=excluded.reactions_up,comments_count=excluded.comments_count,
        duplicate_of=excluded.duplicate_of,fixes_json=excluded.fixes_json,
        shipped_in=excluded.shipped_in,shipped_stable_in=excluded.shipped_stable_in,
        triage_json=excluded.triage_json,triaged_at=excluded.triaged_at,
        embedded_hash=excluded.embedded_hash,created_at=excluded.created_at,
        updated_at=excluded.updated_at,closed_at=excluded.closed_at,synced_at=excluded.synced_at`,
    )
    .bind(
      issue.number,
      issue.githubId,
      issue.nodeId,
      issue.title,
      issue.body,
      issue.kind,
      issue.state,
      issue.stateReason,
      issue.status,
      issue.area,
      issue.priority,
      JSON.stringify(issue.labels),
      issue.milestoneNumber,
      issue.milestoneTitle,
      issue.authorLogin,
      issue.authorType,
      issue.reporter ? JSON.stringify(issue.reporter) : null,
      issue.summary,
      issue.reactionsUp,
      issue.commentsCount,
      issue.duplicateOf,
      JSON.stringify(issue.fixes),
      issue.shippedIn,
      issue.shippedStableIn,
      issue.triage ? JSON.stringify(issue.triage) : null,
      issue.triagedAt,
      issue.embeddedHash,
      issue.createdAt,
      issue.updatedAt,
      issue.closedAt,
      issue.syncedAt,
    )
    .run();
}

export async function patchIssue(
  db: D1Database,
  number: number,
  patch: Partial<
    Pick<
      IssueRecord,
      | "summary"
      | "triage"
      | "triagedAt"
      | "embeddedHash"
      | "fixes"
      | "shippedIn"
      | "shippedStableIn"
      | "duplicateOf"
    >
  >,
): Promise<void> {
  const columns: Record<string, string> = {
    summary: "summary",
    triage: "triage_json",
    triagedAt: "triaged_at",
    embeddedHash: "embedded_hash",
    fixes: "fixes_json",
    shippedIn: "shipped_in",
    shippedStableIn: "shipped_stable_in",
    duplicateOf: "duplicate_of",
  };
  const entries = Object.entries(patch).filter(([key]) => key in columns);
  if (!entries.length) return;
  const assignments = entries.map(([key]) => `${columns[key]}=?`).join(",");
  const values = entries.map(([key, value]) =>
    key === "triage" || key === "fixes" ? (value == null ? null : JSON.stringify(value)) : value,
  );
  await db
    .prepare(`UPDATE issues SET ${assignments} WHERE number=?`)
    .bind(...values, number)
    .run();
}

// Threads

export interface ThreadRecord {
  threadId: string;
  issueNumber: number;
  forumId: string;
  role: "primary" | "merged";
  cardMessageId: string | null;
  cardHash: string | null;
  stateHash: string | null;
  createdAt: string;
}

const toThread = (row: Row): ThreadRecord => ({
  threadId: row.thread_id,
  issueNumber: row.issue_number,
  forumId: row.forum_id,
  role: row.role,
  cardMessageId: row.card_message_id ?? null,
  cardHash: row.card_hash ?? null,
  stateHash: row.state_hash ?? null,
  createdAt: row.created_at,
});

export async function threadsForIssue(db: D1Database, number: number): Promise<ThreadRecord[]> {
  const { results } = await db
    .prepare("SELECT * FROM threads WHERE issue_number=? ORDER BY role='primary' DESC, created_at")
    .bind(number)
    .all<Row>();
  return results.map(toThread);
}

export async function primaryThread(db: D1Database, number: number): Promise<ThreadRecord | null> {
  const row = await db
    .prepare("SELECT * FROM threads WHERE issue_number=? AND role='primary' LIMIT 1")
    .bind(number)
    .first<Row>();
  return row ? toThread(row) : null;
}

export async function getThread(db: D1Database, threadId: string): Promise<ThreadRecord | null> {
  const row = await db
    .prepare("SELECT * FROM threads WHERE thread_id=?")
    .bind(threadId)
    .first<Row>();
  return row ? toThread(row) : null;
}

export async function allPrimaryThreads(db: D1Database): Promise<Map<number, ThreadRecord>> {
  const { results } = await db.prepare("SELECT * FROM threads WHERE role='primary'").all<Row>();
  return new Map(results.map((row) => [row.issue_number as number, toThread(row)]));
}

export async function saveThread(db: D1Database, thread: ThreadRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO threads(thread_id,issue_number,forum_id,role,card_message_id,card_hash,state_hash,created_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(thread_id) DO UPDATE SET issue_number=excluded.issue_number,
        forum_id=excluded.forum_id,role=excluded.role,card_message_id=excluded.card_message_id,
        card_hash=excluded.card_hash,state_hash=excluded.state_hash`,
    )
    .bind(
      thread.threadId,
      thread.issueNumber,
      thread.forumId,
      thread.role,
      thread.cardMessageId,
      thread.cardHash,
      thread.stateHash,
      thread.createdAt,
    )
    .run();
}

// Subscribers: the reporter plus everyone who said "me too". Both count as votes.

export async function addSubscriber(
  db: D1Database,
  number: number,
  userId: string,
  kind: "reporter" | "vote",
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO subscribers(issue_number,user_id,kind,created_at) VALUES(?,?,?,?)
       ON CONFLICT(issue_number,user_id) DO UPDATE SET kind=CASE
         WHEN subscribers.kind='reporter' THEN 'reporter' ELSE excluded.kind END`,
    )
    .bind(number, userId, kind, nowIso())
    .run();
  return result.meta.changes > 0;
}

export async function removeVote(db: D1Database, number: number, userId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM subscribers WHERE issue_number=? AND user_id=? AND kind='vote'")
    .bind(number, userId)
    .run();
  return result.meta.changes > 0;
}

export async function subscriberRole(
  db: D1Database,
  number: number,
  userId: string,
): Promise<"reporter" | "vote" | null> {
  const row = await db
    .prepare("SELECT kind FROM subscribers WHERE issue_number=? AND user_id=?")
    .bind(number, userId)
    .first<{ kind: "reporter" | "vote" }>();
  return row?.kind ?? null;
}

export async function subscribers(
  db: D1Database,
  number: number,
): Promise<Array<{ userId: string; kind: "reporter" | "vote" }>> {
  const { results } = await db
    .prepare("SELECT user_id,kind FROM subscribers WHERE issue_number=? ORDER BY created_at")
    .bind(number)
    .all<{ user_id: string; kind: "reporter" | "vote" }>();
  return results.map((row) => ({ userId: row.user_id, kind: row.kind }));
}

export async function voteCounts(db: D1Database): Promise<Map<number, number>> {
  const { results } = await db
    .prepare("SELECT issue_number, COUNT(*) AS votes FROM subscribers GROUP BY issue_number")
    .all<{ issue_number: number; votes: number }>();
  return new Map(results.map((row) => [row.issue_number, row.votes]));
}

export async function voteCount(db: D1Database, number: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS votes FROM subscribers WHERE issue_number=?")
    .bind(number)
    .first<{ votes: number }>();
  return row?.votes ?? 0;
}

export async function moveSubscribers(db: D1Database, from: number, to: number): Promise<number> {
  const moved = await db
    .prepare(
      `INSERT OR IGNORE INTO subscribers(issue_number,user_id,kind,created_at)
       SELECT ?, user_id, 'vote', created_at FROM subscribers WHERE issue_number=?`,
    )
    .bind(to, from)
    .run();
  return moved.meta.changes;
}

// Drafts (interactive submissions that have not been filed yet)

export interface DraftUser {
  id: string;
  name: string;
  username: string;
  avatarUrl?: string | null;
}

export interface DraftAttachment extends AttachmentRef {
  id: string;
  size?: number;
}

export interface DraftRecord {
  id: string;
  source: "discord" | "website";
  kind: IssueKind;
  user: DraftUser;
  values: ReportValues;
  attachments: DraftAttachment[];
  candidates: number[];
  issueNumber: number | null;
  threadId: string | null;
}

export async function saveDraft(db: D1Database, draft: DraftRecord): Promise<void> {
  const now = new Date();
  await db
    .prepare(
      `INSERT INTO drafts(id,source,kind,user_json,values_json,attachments_json,candidates_json,
        issue_number,thread_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET values_json=excluded.values_json,
        attachments_json=excluded.attachments_json,candidates_json=excluded.candidates_json,
        issue_number=excluded.issue_number,thread_id=excluded.thread_id`,
    )
    .bind(
      draft.id,
      draft.source,
      draft.kind,
      JSON.stringify(draft.user),
      JSON.stringify(draft.values),
      JSON.stringify(draft.attachments),
      JSON.stringify(draft.candidates),
      draft.issueNumber,
      draft.threadId,
      now.toISOString(),
      new Date(now.getTime() + 2 * 3600_000).toISOString(),
    )
    .run();
}

export async function getDraft(db: D1Database, id: string): Promise<DraftRecord | null> {
  const row = await db.prepare("SELECT * FROM drafts WHERE id=?").bind(id).first<Row>();
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    user: parse(row.user_json, { id: "", name: "", username: "" }),
    values: parse(row.values_json, {}),
    attachments: parse(row.attachments_json, []),
    candidates: parse(row.candidates_json, []),
    issueNumber: row.issue_number ?? null,
    threadId: row.thread_id ?? null,
  };
}

/** Claim a draft for filing exactly once. */
export async function claimDraft(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE drafts SET issue_number=0 WHERE id=? AND issue_number IS NULL")
    .bind(id)
    .run();
  return result.meta.changes === 1;
}

// Events (public timeline)

export interface EventRecord {
  id: number;
  issueNumber: number;
  kind: string;
  actor: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export async function addEvent(
  db: D1Database,
  number: number,
  kind: string,
  data: Record<string, unknown>,
  actor: string | null = null,
  createdAt = nowIso(),
): Promise<void> {
  await db
    .prepare("INSERT INTO events(issue_number,kind,actor,data_json,created_at) VALUES(?,?,?,?,?)")
    .bind(number, kind, actor, JSON.stringify(data), createdAt)
    .run();
}

export async function eventsForIssue(db: D1Database, number: number): Promise<EventRecord[]> {
  const { results } = await db
    .prepare("SELECT * FROM events WHERE issue_number=? ORDER BY created_at, id")
    .bind(number)
    .all<Row>();
  return results.map((row) => ({
    id: row.id,
    issueNumber: row.issue_number,
    kind: row.kind,
    actor: row.actor ?? null,
    data: parse(row.data_json, {}),
    createdAt: row.created_at,
  }));
}

// Key-value state

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM kv WHERE key=?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO kv(key,value,updated_at) VALUES(?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    )
    .bind(key, value, nowIso())
    .run();
}

export async function getJsonState<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  return parse(await getState(db, key), fallback);
}

// Notes left by maintainers in Discord, delivered with the next status message.

export async function setPendingNote(
  db: D1Database,
  number: number,
  status: StatusId,
  text: string,
  author: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending_notes(issue_number,status,text,author,created_at) VALUES(?,?,?,?,?)
       ON CONFLICT(issue_number,status) DO UPDATE SET text=excluded.text,author=excluded.author,
        created_at=excluded.created_at`,
    )
    .bind(number, status, text, author, nowIso())
    .run();
}

export async function takePendingNote(
  db: D1Database,
  number: number,
  status: StatusId,
): Promise<{ text: string; author: string } | null> {
  const row = await db
    .prepare("DELETE FROM pending_notes WHERE issue_number=? AND status=? RETURNING text,author")
    .bind(number, status)
    .first<{ text: string; author: string }>();
  return row ?? null;
}

// Webhook replay protection

export async function claimDelivery(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO webhook_deliveries(id,received_at) VALUES(?,?)")
    .bind(id, nowIso())
    .run();
  return result.meta.changes === 1;
}

// Discord thread polling cursors

export async function threadCursors(
  db: D1Database,
): Promise<
  Map<string, { issueNumber: number; lastMessageId: string | null; watchUntil: string | null }>
> {
  const { results } = await db
    .prepare(
      "SELECT thread_id,issue_number,last_message_id,watch_until FROM threads WHERE role='primary'",
    )
    .all<Row>();
  return new Map(
    results.map((row) => [
      row.thread_id as string,
      {
        issueNumber: row.issue_number as number,
        lastMessageId: (row.last_message_id as string) ?? null,
        watchUntil: (row.watch_until as string) ?? null,
      },
    ]),
  );
}

export async function setThreadCursor(
  db: D1Database,
  threadId: string,
  lastMessageId: string,
  watchUntil?: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE threads SET last_message_id=?,
         watch_until=COALESCE(?,watch_until) WHERE thread_id=?`,
    )
    .bind(lastMessageId, watchUntil ?? null, threadId)
    .run();
}

// Links between mirrored comments on GitHub, Discord, and the website

export interface CommentLink {
  id: number;
  issueNumber: number;
  origin: "github" | "discord" | "website";
  githubCommentId: number | null;
  discordMessageId: string | null;
  discordVia: "webhook" | "bot" | null;
  threadId: string | null;
  contentHash: string | null;
  createdAt: string;
}

const toLink = (row: Row): CommentLink => ({
  id: row.id,
  issueNumber: row.issue_number,
  origin: row.origin,
  githubCommentId: row.github_comment_id ?? null,
  discordMessageId: row.discord_message_id ?? null,
  discordVia: row.discord_via ?? null,
  threadId: row.thread_id ?? null,
  contentHash: row.content_hash ?? null,
  createdAt: row.created_at,
});

export async function linkByGithubComment(db: D1Database, id: number): Promise<CommentLink | null> {
  const row = await db
    .prepare("SELECT * FROM comment_links WHERE github_comment_id=?")
    .bind(id)
    .first<Row>();
  return row ? toLink(row) : null;
}

export async function linkByDiscordMessage(
  db: D1Database,
  id: string,
): Promise<CommentLink | null> {
  const row = await db
    .prepare("SELECT * FROM comment_links WHERE discord_message_id=?")
    .bind(id)
    .first<Row>();
  return row ? toLink(row) : null;
}

export async function recentDiscordLinks(
  db: D1Database,
  threadId: string,
  since: string,
): Promise<CommentLink[]> {
  const { results } = await db
    .prepare("SELECT * FROM comment_links WHERE thread_id=? AND origin='discord' AND created_at>=?")
    .bind(threadId, since)
    .all<Row>();
  return results.map(toLink);
}

export async function saveLink(db: D1Database, link: Omit<CommentLink, "id">): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO comment_links(issue_number,origin,github_comment_id,discord_message_id,discord_via,thread_id,content_hash,created_at)
       VALUES(?,?,?,?,?,?,?,?) RETURNING id`,
    )
    .bind(
      link.issueNumber,
      link.origin,
      link.githubCommentId,
      link.discordMessageId,
      link.discordVia,
      link.threadId,
      link.contentHash,
      link.createdAt,
    )
    .first<{ id: number }>();
  return row!.id;
}

export async function updateLink(
  db: D1Database,
  id: number,
  patch: {
    githubCommentId?: number | null;
    discordMessageId?: string | null;
    discordVia?: "webhook" | "bot" | null;
    contentHash?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE comment_links SET
         github_comment_id=COALESCE(?,github_comment_id),
         discord_message_id=COALESCE(?,discord_message_id),
         discord_via=COALESCE(?,discord_via),
         content_hash=COALESCE(?,content_hash)
       WHERE id=?`,
    )
    .bind(
      patch.githubCommentId ?? null,
      patch.discordMessageId ?? null,
      patch.discordVia ?? null,
      patch.contentHash ?? null,
      id,
    )
    .run();
}

export async function deleteLink(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM comment_links WHERE id=?").bind(id),
    db
      .prepare("DELETE FROM events WHERE kind='comment' AND json_extract(data_json,'$.linkId')=?")
      .bind(id),
  ]);
}

export async function upsertCommentEvent(
  db: D1Database,
  link: { id: number; issueNumber: number },
  data: Record<string, unknown>,
  createdAt: string,
): Promise<void> {
  const payload = JSON.stringify({ ...data, linkId: link.id });
  const updated = await db
    .prepare(
      "UPDATE events SET data_json=? WHERE kind='comment' AND json_extract(data_json,'$.linkId')=?",
    )
    .bind(payload, link.id)
    .run();
  if (!updated.meta.changes) {
    await db
      .prepare("INSERT INTO events(issue_number,kind,actor,data_json,created_at) VALUES(?,?,?,?,?)")
      .bind(link.issueNumber, "comment", (data.author as string) ?? null, payload, createdAt)
      .run();
  }
}
