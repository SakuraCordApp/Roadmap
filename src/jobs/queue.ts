import { getState, setState } from "../db/store";
import type { Env } from "../env";
import { errorMessage } from "../util/http";
import { nowIso } from "../util/text";

// Durable jobs live in D1; the Cloudflare Queue (max_concurrency 1) only wakes
// them. Jobs are keyed so repeated events coalesce, and a job re-requested
// while it runs is executed once more afterwards.

export type JobKind =
  | "sync-issue"
  | "triage"
  | "triage-result"
  | "agent-status"
  | "embed"
  | "comment"
  | "discord-thread"
  | "ship"
  | "pull"
  | "push"
  | "release"
  | "milestones"
  | "roadmap"
  | "feed"
  | "reconcile";

export interface JobMessage {
  id: number;
}

interface JobRow {
  id: number;
  key: string;
  kind: JobKind;
  payload_json: string;
  attempts: number;
  rerun: number;
}

export type JobHandler = (env: Env, payload: any) => Promise<void>;

const MAX_ATTEMPTS = 8;
const WAKE_LEASE_MS = 15 * 60_000;

/** Lease notifications so cron and duplicate webhooks cannot flood the queue.
 * D1 is durable: a failed notification must not fail an already-saved mutation.
 */
async function notifyJobs(env: Env, ids: number[], delaySeconds = 0): Promise<boolean> {
  const pausedUntil = await getState(env.DB, "queue:paused-until");
  if (pausedUntil && Date.parse(pausedUntil) > Date.now()) return false;
  let available = true;
  for (let start = 0; start < ids.length; start += 90) {
    const chunk = ids.slice(start, start + 90);
    const { results } = await env.DB.prepare(
      `UPDATE jobs SET wake_after=? WHERE id IN (${chunk.map(() => "?").join(",")})
       AND status='pending' AND (wake_after IS NULL OR wake_after<=?) RETURNING id`,
    )
      .bind(
        new Date(Date.now() + delaySeconds * 1000 + WAKE_LEASE_MS).toISOString(),
        ...chunk,
        nowIso(),
      )
      .all<{ id: number }>();
    if (!results.length) continue;
    try {
      await env.JOBS.sendBatch(
        results.map(({ id }) => ({
          body: { id } satisfies JobMessage,
          ...(delaySeconds > 0 ? { delaySeconds: Math.min(delaySeconds, 43_200) } : {}),
        })),
      );
    } catch (error) {
      available = false;
      console.error("Queue notification unavailable; jobs remain in D1", errorMessage(error));
      if (/10253|daily.*limit/i.test(errorMessage(error))) {
        const reset = new Date();
        reset.setUTCHours(24, 0, 0, 0);
        await setState(env.DB, "queue:paused-until", reset.toISOString());
      }
      await env.DB.prepare(
        `UPDATE jobs SET wake_after=NULL WHERE id IN (${results.map(() => "?").join(",")})`,
      )
        .bind(...results.map(({ id }) => id))
        .run();
    }
  }
  return available;
}

export async function enqueue(
  env: Env,
  kind: JobKind,
  key: string,
  payload: Record<string, unknown> = {},
  delaySeconds = 0,
): Promise<void> {
  const now = nowIso();
  const runAfter = new Date(Date.now() + delaySeconds * 1000).toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO jobs(key,kind,payload_json,status,run_after,created_at,updated_at)
     VALUES(?,?,?,'pending',?,?,?)
     ON CONFLICT(key) DO UPDATE SET
       payload_json=excluded.payload_json,
       rerun=CASE WHEN jobs.status='running' THEN 1 ELSE jobs.rerun END,
       status=CASE WHEN jobs.status='running' THEN 'running' ELSE 'pending' END,
       attempts=CASE WHEN jobs.status IN ('done','failed') THEN 0 ELSE jobs.attempts END,
       run_after=CASE WHEN jobs.status IN ('done','failed') THEN excluded.run_after
                      ELSE MIN(jobs.run_after, excluded.run_after) END,
       updated_at=excluded.updated_at
     RETURNING id,status`,
  )
    .bind(`${kind}:${key}`, kind, JSON.stringify(payload), runAfter, now, now)
    .first<{ id: number; status: string }>();
  if (row && row.status === "pending") {
    await notifyJobs(env, [row.id], delaySeconds);
  }
}

/** Enqueue many jobs with at most 96 bound parameters per insert and leased queue notifications. */
export async function enqueueMany(
  env: Env,
  jobs: Array<{ kind: JobKind; key: string; payload?: Record<string, unknown> }>,
  delaySeconds = 0,
): Promise<number> {
  const now = nowIso();
  const runAfter = new Date(Date.now() + delaySeconds * 1000).toISOString();
  const ids: number[] = [];
  for (let start = 0; start < jobs.length; start += 16) {
    const chunk = jobs.slice(start, start + 16);
    const values = chunk.map(() => "(?,?,?,'pending',?,?,?)").join(",");
    const bindings = chunk.flatMap((job) => [
      `${job.kind}:${job.key}`,
      job.kind,
      JSON.stringify(job.payload ?? {}),
      runAfter,
      now,
      now,
    ]);
    const { results } = await env.DB.prepare(
      `INSERT INTO jobs(key,kind,payload_json,status,run_after,created_at,updated_at) VALUES ${values}
       ON CONFLICT(key) DO UPDATE SET
         payload_json=excluded.payload_json,
         rerun=CASE WHEN jobs.status='running' THEN 1 ELSE jobs.rerun END,
         status=CASE WHEN jobs.status='running' THEN 'running' ELSE 'pending' END,
         attempts=CASE WHEN jobs.status IN ('done','failed') THEN 0 ELSE jobs.attempts END,
         run_after=CASE WHEN jobs.status IN ('done','failed') THEN excluded.run_after
                        ELSE MIN(jobs.run_after, excluded.run_after) END,
         updated_at=excluded.updated_at
       RETURNING id,status`,
    )
      .bind(...bindings)
      .all<{ id: number; status: string }>();
    ids.push(...results.filter((row) => row.status === "pending").map((row) => row.id));
  }
  await notifyJobs(env, ids, delaySeconds);
  return ids.length;
}

export async function runJob(
  env: Env,
  id: number,
  handlers: Record<JobKind, JobHandler>,
): Promise<void> {
  const claimed = await env.DB.prepare(
    `UPDATE jobs SET status='running',locked_at=?,attempts=attempts+1,updated_at=?
     WHERE id=? AND run_after<=? AND (status='pending'
       OR (status='running' AND locked_at < ?))
     RETURNING id,key,kind,payload_json,attempts,rerun`,
  )
    .bind(nowIso(), nowIso(), id, nowIso(), new Date(Date.now() - 15 * 60_000).toISOString())
    .first<JobRow>();
  if (!claimed) return;
  try {
    await handlers[claimed.kind](env, JSON.parse(claimed.payload_json));
    const finished = await env.DB.prepare(
      `UPDATE jobs SET status=CASE WHEN rerun=1 THEN 'pending' ELSE 'done' END,
         rerun=0,locked_at=NULL,wake_after=NULL,last_error=NULL,attempts=CASE WHEN rerun=1 THEN 0 ELSE attempts END,
         updated_at=?
       WHERE id=? RETURNING status`,
    )
      .bind(nowIso(), id)
      .first<{ status: string }>();
    if (finished?.status === "pending") await notifyJobs(env, [id]);
  } catch (error) {
    const attempts = claimed.attempts;
    const failed = attempts >= MAX_ATTEMPTS;
    const delay = Math.min(30 * 2 ** attempts, 3600);
    console.error(`Job ${claimed.key} failed (attempt ${attempts})`, errorMessage(error));
    await env.DB.prepare(
      `UPDATE jobs SET status=?,locked_at=NULL,wake_after=NULL,last_error=?,run_after=?,updated_at=? WHERE id=?`,
    )
      .bind(
        failed ? "failed" : "pending",
        errorMessage(error),
        new Date(Date.now() + delay * 1000).toISOString(),
        nowIso(),
        id,
      )
      .run();
  }
}

/** Cron safety net: wake jobs whose queue message was lost or delayed. */
export async function wakeDueJobs(env: Env): Promise<boolean> {
  // Recover expired execution leases before claiming notification leases.
  await env.DB.prepare(
    `UPDATE jobs SET status='pending',locked_at=NULL,wake_after=NULL
     WHERE status='running' AND locked_at<?`,
  )
    .bind(new Date(Date.now() - WAKE_LEASE_MS).toISOString())
    .run();
  const { results } = await env.DB.prepare(
    `SELECT id FROM jobs WHERE status='pending' AND run_after<=?
     AND (wake_after IS NULL OR wake_after<=?) ORDER BY run_after LIMIT 50`,
  )
    .bind(nowIso(), nowIso())
    .all<{ id: number }>();
  return notifyJobs(
    env,
    results.map(({ id }) => id),
  );
}

/** Execute a specific saved job immediately, with the same lease and retry protection. */
export async function runJobByKey(env: Env, key: string, handlers: Record<JobKind, JobHandler>) {
  const row = await env.DB.prepare("SELECT id FROM jobs WHERE key=?")
    .bind(key)
    .first<{ id: number }>();
  if (!row) return null;
  await runJob(env, row.id, handlers);
  return env.DB.prepare("SELECT key,status,last_error FROM jobs WHERE id=?")
    .bind(row.id)
    .first<{ key: string; status: string; last_error: string | null }>();
}

/** Recover report changes before background work; keep one bounded job per invocation. */
export async function runNextDueJob(env: Env, handlers: Record<JobKind, JobHandler>) {
  const row = await env.DB.prepare(
    `SELECT id,key FROM jobs WHERE (status='pending' AND run_after<=?)
     OR (status='running' AND locked_at<?)
     ORDER BY CASE WHEN kind='sync-issue' THEN 0 ELSE 1 END, run_after, id LIMIT 1`,
  )
    .bind(nowIso(), new Date(Date.now() - WAKE_LEASE_MS).toISOString())
    .first<{ id: number; key: string }>();
  if (!row) return null;
  await runJob(env, row.id, handlers);
  return env.DB.prepare("SELECT key,status,last_error FROM jobs WHERE id=?")
    .bind(row.id)
    .first<{ key: string; status: string; last_error: string | null }>();
}

export async function jobStats(env: Env) {
  const { results: counts } = await env.DB.prepare(
    "SELECT kind,status,COUNT(*) AS count FROM jobs GROUP BY kind,status",
  ).all();
  const { results: failures } = await env.DB.prepare(
    `SELECT key,attempts,last_error,updated_at FROM jobs
     WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 20`,
  ).all();
  return { counts, failures, queuePausedUntil: await getState(env.DB, "queue:paused-until") };
}

export async function cleanupJobs(env: Env): Promise<void> {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM jobs WHERE status='done' AND updated_at<?").bind(dayAgo),
    env.DB.prepare("DELETE FROM drafts WHERE expires_at<?").bind(nowIso()),
    env.DB.prepare("DELETE FROM webhook_deliveries WHERE received_at<?").bind(
      new Date(Date.now() - 7 * 86_400_000).toISOString(),
    ),
    env.DB.prepare("DELETE FROM attachment_cache WHERE expires_at<?").bind(nowIso()),
  ]);
}
