import { sqlite, db } from "./d1";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema } from "../src/db/schema";
import type { Env } from "../src/env";
import {
  enqueue,
  enqueueMany,
  runNextDueJob,
  runJobByKey,
  wakeDueJobs,
  type JobHandler,
  type JobKind,
} from "../src/jobs/queue";

// Exercise real SQL, including upserts and execution leases, with D1's binding limit.
const sendBatch = vi.fn<(messages: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
const env = { DB: db, JOBS: { sendBatch } } as unknown as Env;
const handlers = (handler: JobHandler) =>
  ({ "sync-issue": handler }) as Record<JobKind, JobHandler>;
const row = () => sqlite.prepare("SELECT * FROM jobs ORDER BY id LIMIT 1").get()!;

beforeAll(async () => {
  await ensureSchema(db);
});
beforeEach(() => {
  sqlite.exec("DELETE FROM jobs; DELETE FROM kv;");
  vi.useRealTimers();
  sendBatch.mockReset();
  sendBatch.mockResolvedValue(undefined);
});
afterAll(() => {
  vi.useRealTimers();
  sqlite.close();
});

describe("durable job recovery", () => {
  it("coalesces repeated events and cron wakeups, then retries a lost notification after its lease", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 30; i++) {
      await enqueue(env, "sync-issue", "51", { number: 51, revision: i });
      await wakeDueJobs(env);
    }
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(row().payload_json)).revision).toBe(29);
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await wakeDueJobs(env);
    expect(sendBatch).toHaveBeenCalledTimes(2);
  });

  it("queues a migration burst within D1's parameter limit without multiplying notifications", async () => {
    const jobs = Array.from({ length: 197 }, (_, i) => ({
      kind: "sync-issue" as const,
      key: String(i),
      payload: { number: i },
    }));
    await enqueueMany(env, jobs);
    await enqueueMany(env, jobs);
    await wakeDueJobs(env);
    expect(sendBatch.mock.calls.flatMap(([messages]) => messages)).toHaveLength(197);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM jobs").get()!.count).toBe(197);
  });

  it("recovers report changes before older background work during quota exhaustion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    sendBatch.mockRejectedValueOnce(new Error("daily write operations limit (10253)"));
    await enqueue(env, "embed", "50", { number: 50 });
    vi.setSystemTime(Date.now() + 1000);
    await enqueue(env, "sync-issue", "51", { number: 51 });
    expect(row().status).toBe("pending");
    expect(row().attempts).toBe(0);
    expect(await wakeDueJobs(env)).toBe(false);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    const handler = vi.fn(async () => {});
    const recoveryHandlers = { ...handlers(handler), embed: handler };
    expect(await runNextDueJob(env, recoveryHandlers)).toMatchObject({
      key: "sync-issue:51",
      status: "done",
      last_error: null,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await runNextDueJob(env, recoveryHandlers)).toMatchObject({
      key: "embed:50",
      status: "done",
    });
    expect(await runNextDueJob(env, recoveryHandlers)).toBeNull();
  });

  it("runs an event received during execution once more with the latest payload", async () => {
    await enqueue(env, "sync-issue", "51", { revision: 1 });
    const seen: number[] = [];
    const handler: JobHandler = async (_env, payload) => {
      seen.push(payload.revision);
      if (payload.revision === 1) await enqueue(env, "sync-issue", "51", { revision: 2 });
    };
    await runNextDueJob(env, handlers(handler));
    expect(row().status).toBe("pending");
    await runNextDueJob(env, handlers(handler));
    expect(seen).toEqual([1, 2]);
    expect(row().status).toBe("done");
  });

  it("runs a selected report immediately while Queues are paused without repeating completion", async () => {
    sendBatch.mockRejectedValueOnce(new Error("daily write operations limit (10253)"));
    await enqueue(env, "sync-issue", "50", { number: 50 });
    await enqueue(env, "sync-issue", "165", { number: 165 });
    const handler = vi.fn(async () => {});
    expect(await runJobByKey(env, "sync-issue:165", handlers(handler))).toMatchObject({
      key: "sync-issue:165",
      status: "done",
    });
    expect(handler).toHaveBeenCalledWith(env, { number: 165 });
    expect(row().status).toBe("pending");
    await runJobByKey(env, "sync-issue:165", handlers(handler));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendBatch).toHaveBeenCalledTimes(1);
  });

  it("respects failure backoff and never claims a job that is already running", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await enqueue(env, "sync-issue", "51", {});
    const handler: JobHandler = async () => {
      throw new Error("temporary failure");
    };
    await runNextDueJob(env, handlers(handler));
    expect(row().status).toBe("pending");
    expect(await runNextDueJob(env, handlers(handler))).toBeNull();
    vi.setSystemTime(Date.now() + 61_000);
    await runNextDueJob(
      env,
      handlers(async () => {
        expect(await runNextDueJob(env, handlers(handler))).toBeNull();
      }),
    );
    expect(row().status).toBe("done");
  });
});
