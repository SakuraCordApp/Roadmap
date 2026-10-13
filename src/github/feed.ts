import { DISCORD } from "../config";
import { DiscordError } from "../discord/rest";
import { discordClient } from "../discord/threads";
import type { Env } from "../env";
import { enqueue } from "../jobs/queue";
import { sha256 } from "../util/crypto";
import { nowIso } from "../util/text";
import { feedEmoji } from "./feed-emoji";
import {
  COLORS,
  renderChecks,
  renderNote,
  renderPull,
  renderPush,
  type Actor,
  type Card,
  type JobItem,
  type NoteItem,
  type PullItem,
  type PushItem,
  type RunItem,
} from "./feed-render";

// GitHub activity for the Discord updates channel.
//
// Pushes, pull requests and checks are stateful cards: each webhook upserts an
// item in D1, and one coalesced job renders every item of a card into a single
// message that is posted once and then edited. Only the first post pings:
// one per push, per opened PR, per commit's checks, and per human comment or
// review. Checks render from webhook payloads alone; nothing is fetched.

type JsonObject = Record<string, any>;

/** Wait briefly so bursts (both refs of a push, a matrix of queued jobs) post as one message. */
const COALESCE_SECONDS = 4;
/** A head commit pushed again later gets a new card instead of editing an old one. */
const PUSH_MERGE_WINDOW_MS = 10 * 60_000;
const STORED_COMMITS = 20;
/** Workflow events whose runs are checks of a commit. Agent and housekeeping triggers are not. */
const CHECK_EVENTS = new Set([
  "push",
  "pull_request",
  "workflow_dispatch",
  "schedule",
  "release",
  "merge_group",
]);
const COMMIT_EVENTS = new Set(["push", "pull_request", "merge_group"]);
const SUPPRESS_NOTIFICATIONS = 1 << 12;

export async function recordFeedEvent(
  env: Env,
  event: string,
  payload: JsonObject,
  delivery: string,
  botLogin: string | null,
): Promise<void> {
  const repository = payload.repository ?? {};
  const repo: string | undefined = repository.full_name;
  const repoUrl = https(repository.html_url);
  if (!repo || !repoUrl) return;
  const base = { repo, repoUrl };
  const human = !isBot(payload.sender, botLogin);
  const action: string | undefined = payload.action;
  switch (event) {
    case "push":
      if (human) await recordPush(env, payload, base);
      return;
    case "pull_request":
      return recordPull(env, payload, base, action, human);
    case "workflow_run":
      return recordRun(env, payload.workflow_run, base);
    case "workflow_job":
      return recordJob(env, payload.workflow_job);
  }
  const note = human ? noteFor(event, action, payload, base, botLogin) : null;
  if (note) await enqueue(env, "feed", `note:${delivery}`, { note: note.item, ping: note.ping });
}

// ---------------------------------------------------------------------------

async function recordPush(env: Env, payload: JsonObject, base: Base) {
  const ref: string = payload.ref ?? "";
  if (!ref.startsWith("refs/heads/") || payload.deleted || !payload.commits?.length) return;
  const branch = ref.slice("refs/heads/".length);
  const after: string = payload.after;
  let card = `push:${base.repo}:${after}`;
  const existing = await env.DB.prepare("SELECT created_at FROM feed_cards WHERE key=?")
    .bind(card)
    .first<{ created_at: string }>();
  if (existing && Date.now() - Date.parse(existing.created_at) > PUSH_MERGE_WINDOW_MS)
    card += `:${branch}`;
  const commits: any[] = payload.commits;
  const item: PushItem = {
    ...base,
    branch,
    after,
    compare: https(payload.compare) ?? `${base.repoUrl}/commit/${after}`,
    forced: payload.forced === true,
    created: payload.created === true,
    total: commits.length,
    commits: commits.slice(-STORED_COMMITS).map((commit) => {
      const [headline = "", ...rest] = String(commit.message ?? "").split(/\r?\n/);
      const subject = rest.find((line) => line.trim());
      return {
        sha: commit.id,
        headline: headline.slice(0, 300),
        url: https(commit.url) ?? `${base.repoUrl}/commit/${commit.id}`,
        author: commit.author?.username ?? commit.author?.name,
        ...(/^Merge pull request #\d+/.test(headline) && subject
          ? { subject: subject.trim().slice(0, 200) }
          : {}),
      };
    }),
    actor: actor(payload.sender) ?? { login: payload.pusher?.name ?? "Someone" },
    at: payload.head_commit?.timestamp,
  };
  await saveItem(env, card, `ref:${branch}`, 0, item);
  await enqueue(env, "feed", card, { card }, COALESCE_SECONDS);
}

async function recordPull(
  env: Env,
  payload: JsonObject,
  base: Base,
  action: string | undefined,
  human: boolean,
) {
  const pull = payload.pull_request;
  if (!pull || !action) return;
  const card = `pr:${base.repo}:${pull.number}`;
  if (action === "opened") {
    // Bot-authored PRs stay out of the channel entirely.
    if (!human) return;
    await saveItem(env, card, "announce", 0, { at: nowIso() });
  }
  const merged = pull.merged === true;
  const item: PullItem = {
    ...base,
    number: pull.number,
    title: String(pull.title ?? ""),
    url: https(pull.html_url) ?? `${base.repoUrl}/pull/${pull.number}`,
    state: merged ? "merged" : pull.state === "closed" ? "closed" : pull.draft ? "draft" : "open",
    head: pull.head?.ref ?? "?",
    base: pull.base?.ref ?? "?",
    commits: num(pull.commits),
    additions: num(pull.additions),
    deletions: num(pull.deletions),
    files: num(pull.changed_files),
    body: String(pull.body ?? "").slice(0, 2000),
    author: actor(pull.user) ?? { login: "unknown" },
    closedBy: merged
      ? pull.merged_by?.login
      : pull.state === "closed"
        ? payload.sender?.login
        : undefined,
    createdAt: pull.created_at,
  };
  await saveItem(env, card, "pr", Date.parse(pull.updated_at) || 0, item);
  await enqueue(env, "feed", card, { card }, COALESCE_SECONDS);
}

async function recordRun(env: Env, run: JsonObject | undefined, base: Base) {
  if (!run || !CHECK_EVENTS.has(run.event)) return;
  const card = COMMIT_EVENTS.has(run.event)
    ? `ci:${base.repo}:${run.head_sha}`
    : `ci:${base.repo}:run:${run.id}`;
  const item: RunItem = {
    ...base,
    id: run.id,
    name: run.name ?? "Workflow",
    event: run.event,
    branch: run.head_branch ?? "?",
    sha: run.head_sha,
    attempt: run.run_attempt ?? 1,
    status: run.status,
    conclusion: run.conclusion ?? null,
    url: https(run.html_url) ?? `${base.repoUrl}/actions/runs/${run.id}`,
    startedAt: run.run_started_at ?? run.created_at,
    updatedAt: run.updated_at,
    title: String(run.display_title ?? run.head_commit?.message ?? "").split(/\r?\n/, 1)[0]!,
    pr: run.event === "pull_request" ? run.pull_requests?.[0]?.number : undefined,
    actor: actor(run.triggering_actor ?? run.actor),
  };
  await saveItem(env, card, `run:${run.id}`, progress(item.attempt, item.status), item);
  await enqueue(env, "feed", card, { card }, COALESCE_SECONDS);
}

async function recordJob(env: Env, job: JsonObject | undefined) {
  if (!job?.run_id) return;
  const item: JobItem = {
    id: job.id,
    runId: job.run_id,
    attempt: job.run_attempt ?? 1,
    name: job.name ?? "job",
    status: job.status,
    conclusion: job.conclusion ?? null,
    startedAt: job.started_at,
    completedAt: job.completed_at ?? undefined,
    url: https(job.html_url) ?? "",
    failedStep: (job.steps ?? []).find((step: JsonObject) =>
      ["failure", "timed_out"].includes(step.conclusion),
    )?.name,
  };
  await saveItem(
    env,
    `jobs:${job.run_id}`,
    `job:${job.id}`,
    progress(item.attempt, item.status),
    item,
  );
  const owner = await env.DB.prepare(
    "SELECT card_key FROM feed_items WHERE item_key=? AND card_key LIKE 'ci:%'",
  )
    .bind(`run:${job.run_id}`)
    .first<{ card_key: string }>();
  // Jobs that arrive before their run are picked up when the run event renders.
  if (owner) await enqueue(env, "feed", owner.card_key, { card: owner.card_key }, COALESCE_SECONDS);
}

function noteFor(
  event: string,
  action: string | undefined,
  payload: JsonObject,
  base: Base,
  botLogin: string | null,
): { item: NoteItem; ping: boolean } | null {
  const sender = actor(payload.sender)!;
  if (event === "issue_comment" || event === "discussion_comment") {
    const comment = payload.comment;
    if (action !== "created" || !comment || isBot(comment.user, botLogin)) return null;
    const subject = payload.issue ?? payload.discussion ?? {};
    const label =
      event === "discussion_comment" ? "discussion" : subject.pull_request ? "PR" : "issue";
    return {
      ping: true,
      item: {
        ...base,
        kind: "comment",
        title: `Comment on ${label} #${subject.number} · ${subject.title ?? ""}`,
        url: https(comment.html_url) ?? base.repoUrl,
        body: String(comment.body ?? "").slice(0, 2000),
        color: COLORS.comment,
        actor: actor(comment.user) ?? sender,
        at: comment.created_at,
        button: "Open comment",
      },
    };
  }
  if (event === "pull_request_review") {
    const review = payload.review;
    const pull = payload.pull_request ?? {};
    if (action !== "submitted" || !review || isBot(review.user, botLogin)) return null;
    const state = String(review.state ?? "").toLowerCase();
    const verb =
      state === "approved"
        ? "Approved"
        : state === "changes_requested"
          ? "Changes requested on"
          : "Reviewed";
    return {
      ping: true,
      item: {
        ...base,
        kind: "review",
        title: `${verb} PR #${pull.number} · ${pull.title ?? ""}`,
        url: https(review.html_url) ?? https(pull.html_url) ?? base.repoUrl,
        body: String(review.body ?? "").slice(0, 2000),
        color:
          state === "approved"
            ? COLORS.success
            : state === "changes_requested"
              ? COLORS.failure
              : COLORS.comment,
        actor: actor(review.user) ?? sender,
        at: review.submitted_at,
        button: "Open review",
      },
    };
  }
  if (event === "issues" && ["opened", "closed", "reopened"].includes(action ?? "")) {
    const issue = payload.issue;
    const verb =
      action === "closed"
        ? issue.state_reason === "not_planned"
          ? "closed as not planned"
          : "closed"
        : action;
    return {
      ping: false,
      item: {
        ...base,
        kind: "issue",
        title: `Issue #${issue.number} ${verb} · ${issue.title ?? ""}`,
        url: https(issue.html_url) ?? base.repoUrl,
        ...(action === "opened" ? { body: String(issue.body ?? "").slice(0, 2000) } : {}),
        color: action === "closed" ? COLORS.merged : COLORS.open,
        actor: sender,
        at: issue.updated_at,
        button: "Open issue",
      },
    };
  }
  if (event === "discussion" && action === "created") {
    const discussion = payload.discussion;
    return {
      ping: false,
      item: {
        ...base,
        kind: "discussion",
        title: `Discussion #${discussion.number} · ${discussion.title ?? ""}`,
        url: https(discussion.html_url) ?? base.repoUrl,
        body: String(discussion.body ?? "").slice(0, 2000),
        color: COLORS.sakura,
        actor: sender,
        at: discussion.created_at,
        button: "Open discussion",
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------

export async function deliverFeed(
  env: Env,
  payload: { card?: string; note?: NoteItem; ping?: boolean },
): Promise<void> {
  if (payload.note) {
    await post(env, `note:${payload.note.url}`, renderNote(payload.note), payload.ping === true);
    return;
  }
  // Deliveries queued by the previous feed format are dropped.
  if (!payload.card) return;
  const key = payload.card;
  const row = await env.DB.prepare("SELECT message_id,content_hash FROM feed_cards WHERE key=?")
    .bind(key)
    .first<{ message_id: string | null; content_hash: string | null }>();
  const card = await renderCard(env, key, Boolean(row?.message_id));
  if (!card) return;
  const hash = await sha256(JSON.stringify(card));
  if (row?.content_hash === hash) return;
  if (!row?.message_id) {
    const id = await post(env, `card:${key}`, card, true);
    await env.DB.prepare(
      `INSERT INTO feed_cards(key,message_id,content_hash,created_at,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET message_id=excluded.message_id,
         content_hash=excluded.content_hash,updated_at=excluded.updated_at`,
    )
      .bind(key, id, hash, nowIso(), nowIso())
      .run();
    return;
  }
  try {
    await discordClient(env).patch(
      `/channels/${DISCORD.githubUpdatesChannelId}/messages/${row.message_id}`,
      { ...messageBody(card), allowed_mentions: { parse: [] } },
    );
  } catch (error) {
    // A card deleted in Discord stays deleted.
    if (!(error instanceof DiscordError && error.status === 404)) throw error;
  }
  await env.DB.prepare("UPDATE feed_cards SET content_hash=?,updated_at=? WHERE key=?")
    .bind(hash, nowIso(), key)
    .run();
}

async function renderCard(env: Env, key: string, posted: boolean): Promise<Card | null> {
  const items = await loadItems(env, key);
  if (key.startsWith("push:"))
    return renderPush(items.filter((item) => item.key.startsWith("ref:")).map((item) => item.data));
  if (key.startsWith("pr:")) {
    const pull = items.find((item) => item.key === "pr")?.data;
    if (!pull || (!posted && !items.some((item) => item.key === "announce"))) return null;
    return renderPull(pull);
  }
  if (key.startsWith("ci:")) {
    const runs: RunItem[] = items.filter((item) => item.key.startsWith("run:")).map((i) => i.data);
    if (!runs.length) return null;
    const { results } = await env.DB.prepare(
      `SELECT data_json FROM feed_items WHERE card_key IN (${runs.map(() => "?").join(",")})`,
    )
      .bind(...runs.map((run) => `jobs:${run.id}`))
      .all<{ data_json: string }>();
    const jobs: JobItem[] = results.map((row) => JSON.parse(row.data_json));
    return renderChecks(runs, jobs, await feedEmoji(env));
  }
  return null;
}

async function post(env: Env, nonceKey: string, card: Card, ping: boolean): Promise<string> {
  const role = DISCORD.githubUpdatesRoleId;
  const message = await discordClient(env).post<{ id: string }>(
    `/channels/${DISCORD.githubUpdatesChannelId}/messages`,
    {
      ...messageBody(card),
      ...(ping ? { content: `<@&${role}>` } : { flags: SUPPRESS_NOTIFICATIONS }),
      allowed_mentions: { parse: [], roles: ping ? [role] : [] },
    },
    { nonceKey: `github-feed:${nonceKey}` },
  );
  return message.id;
}

function messageBody(card: Card) {
  return {
    embeds: [card.embed],
    components: card.button
      ? [{ type: 1, components: [{ type: 2, style: 5, ...card.button }] }]
      : [],
  };
}

// ---------------------------------------------------------------------------

type Base = { repo: string; repoUrl: string };

async function saveItem(env: Env, card: string, item: string, rank: number, data: unknown) {
  // Webhooks can arrive out of order; never let an older state replace a newer one.
  await env.DB.prepare(
    `INSERT INTO feed_items(card_key,item_key,rank,data_json,updated_at) VALUES(?,?,?,?,?)
     ON CONFLICT(card_key,item_key) DO UPDATE SET rank=excluded.rank,
       data_json=excluded.data_json,updated_at=excluded.updated_at
     WHERE excluded.rank>=feed_items.rank`,
  )
    .bind(card, item, rank, JSON.stringify(data), nowIso())
    .run();
}

async function loadItems(env: Env, card: string): Promise<Array<{ key: string; data: any }>> {
  const { results } = await env.DB.prepare(
    "SELECT item_key,data_json FROM feed_items WHERE card_key=? ORDER BY rowid",
  )
    .bind(card)
    .all<{ item_key: string; data_json: string }>();
  return results.map((row) => ({ key: row.item_key, data: JSON.parse(row.data_json) }));
}

const STATUS_PROGRESS: Record<string, number> = {
  requested: 0,
  pending: 0,
  waiting: 0,
  queued: 0,
  in_progress: 1,
  completed: 2,
};

/** Monotonic rank: a rerun outranks every state of its earlier attempts. */
const progress = (attempt: number, status: string) => attempt * 10 + (STATUS_PROGRESS[status] ?? 0);

function isBot(user: JsonObject | undefined, botLogin: string | null): boolean {
  const login: string = user?.login ?? "";
  return user?.type === "Bot" || login.endsWith("[bot]") || (!!botLogin && login === botLogin);
}

function actor(user: JsonObject | undefined): Actor | undefined {
  if (!user?.login) return undefined;
  return {
    login: user.login,
    ...(https(user.avatar_url) ? { avatar: user.avatar_url } : {}),
    ...(https(user.html_url) ? { url: user.html_url } : {}),
  };
}

const https = (value: unknown): string | undefined =>
  typeof value === "string" && value.startsWith("https://") ? value : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
