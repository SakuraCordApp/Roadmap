import { describe, expect, it, vi } from "vitest";
import type { DiscordReportQueueMessage, DiscordReportQueueProcessor } from "./report-queue.js";
import { handleDiscordReportQueue } from "./report-queue.js";

describe("Discord report queue", () => {
  it("acknowledges completed work and retries deferred work independently", async () => {
    const completed = queueMessage("completed");
    const deferred = queueMessage("deferred");
    const processor = {
      processQueuedReport: vi.fn(async (threadId: string) =>
        threadId === "deferred"
          ? { outcome: "retry" as const, retryAfterSeconds: 17 }
          : { outcome: "processed" as const },
      ),
    } satisfies DiscordReportQueueProcessor;

    await handleDiscordReportQueue(queueBatch([completed.message, deferred.message]), processor);

    expect(completed.ack).toHaveBeenCalledOnce();
    expect(completed.retry).not.toHaveBeenCalled();
    expect(deferred.retry).toHaveBeenCalledWith({ delaySeconds: 17 });
    expect(deferred.ack).not.toHaveBeenCalled();
  });

  it("acknowledges malformed messages instead of retrying them forever", async () => {
    const invalid = queueMessage("");
    const processor = {
      processQueuedReport: vi.fn(),
    } satisfies DiscordReportQueueProcessor;

    await handleDiscordReportQueue(queueBatch([invalid.message]), processor);

    expect(invalid.ack).toHaveBeenCalledOnce();
    expect(invalid.retry).not.toHaveBeenCalled();
    expect(processor.processQueuedReport).not.toHaveBeenCalled();
  });

  it("retries unexpected consumer failures with bounded backoff", async () => {
    const failed = queueMessage("failed", 2);
    const processor = {
      processQueuedReport: vi.fn(async () => {
        throw new Error("temporary failure");
      }),
    } satisfies DiscordReportQueueProcessor;

    await handleDiscordReportQueue(queueBatch([failed.message]), processor);

    expect(failed.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    expect(failed.ack).not.toHaveBeenCalled();
  });
});

function queueMessage(threadId: string, attempts = 1) {
  const ack = vi.fn();
  const retry = vi.fn();
  const message = {
    id: `message-${threadId || "invalid"}`,
    timestamp: new Date(),
    attempts,
    body: { threadId, queuedAt: new Date().toISOString() },
    ack,
    retry,
  } satisfies Message<DiscordReportQueueMessage>;
  return { message, ack, retry };
}

function queueBatch(
  messages: Message<DiscordReportQueueMessage>[],
): MessageBatch<DiscordReportQueueMessage> {
  return {
    queue: "sakuracord-discord-reports",
    messages,
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 100 } },
    ackAll() {},
    retryAll() {},
  };
}
