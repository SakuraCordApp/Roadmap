import { sqlite, db } from "./d1";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSchema } from "../src/db/schema";
import type { Env } from "../src/env";
import {
  enqueue,
  enqueueMany,
  runNextDueJob,
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

  it("keeps work durable during quota exhaustion and runs it without the queue", async () => {
    sendBatch.mockRejectedValueOnce(new Error("daily write operations limit (10253)"));
    await enqueue(env, "sync-issue", "51", { number: 51 });
    expect(row().status).toBe("pending");
    expect(row().attempts).toBe(0);
    expect(await wakeDueJobs(env)).toBe(false);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    const handler = vi.fn(async () => {});
    expect(await runNextDueJob(env, handlers(handler))).toMatchObject({
      status: "done",
      last_error: null,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await runNextDueJob(env, handlers(handler))).toBeNull();
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
