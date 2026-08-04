import { redactError } from "../security.js";

export interface DiscordReportQueueMessage {
  threadId: string;
  queuedAt: string;
}

export interface DiscordReportQueueResult {
  outcome: "processed" | "ignored" | "retry";
  retryAfterSeconds?: number;
}

export interface DiscordReportQueueProcessor {
  processQueuedReport(threadId: string): Promise<DiscordReportQueueResult>;
}

export async function handleDiscordReportQueue(
  batch: MessageBatch<DiscordReportQueueMessage>,
  processor: DiscordReportQueueProcessor,
): Promise<void> {
  for (const message of batch.messages) {
    const threadId = message.body?.threadId;
    if (typeof threadId !== "string" || !threadId.trim()) {
      console.error("Discarding invalid Discord report queue message", message.id);
      message.ack();
      continue;
    }
    try {
      const result = await processor.processQueuedReport(threadId);
      if (result.outcome === "retry") {
        message.retry({ delaySeconds: clampRetryDelay(result.retryAfterSeconds ?? 5) });
      } else {
        message.ack();
      }
    } catch (error) {
      console.error("Discord report queue processing failed", redactError(error));
      message.retry({ delaySeconds: queueBackoffSeconds(message.attempts) });
    }
  }
}

function queueBackoffSeconds(attempts: number): number {
  return clampRetryDelay(5 * 2 ** Math.min(Math.max(attempts, 0), 8));
}

function clampRetryDelay(seconds: number): number {
  return Math.min(3_600, Math.max(1, Math.ceil(seconds)));
}
