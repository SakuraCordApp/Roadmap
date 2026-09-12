import { createApp } from "./app.js";
import { processPendingInteractionJobs } from "./discord/interactions.js";
import {
  handleDiscordReportQueue,
  type DiscordReportQueueMessage,
} from "./discord/report-queue.js";
import type { Env } from "./env.js";
import { processPendingReleaseJobs } from "./release-automation.js";
import { ensureCurrentSchema } from "./schema-migrations.js";
import { redactError } from "./security.js";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await ensureCurrentSchema(env.DB);
        // Pending jobs are deliberately processed through the service rather
        // than by calling authenticated public mutation endpoints.
        const { RoadmapEngine } = await import("@roadmap/core");
        const { D1RoadmapStorage } = await import("./storage.js");
        const { DiscordSyncService } = await import("./discord/sync.js");
        const config = (await import("../../../roadmap.config.js")).default;
        const engine = new RoadmapEngine(new D1RoadmapStorage(env.DB), config);
        const sync = new DiscordSyncService(env, config, engine);
        // Discover latency-sensitive active reports first. Normal report intake
        // is woken immediately by Cloudflare Queues, independently of the
        // remaining scheduled maintenance work.
        await runScheduledStep("Discord reconciliation", () => sync.reconcile());
        // Drain stranded D1 work after discovery. Normal report intake
        // is woken immediately by Cloudflare Queues; this remains a recovery
        // path if publishing a queue message was temporarily unavailable.
        await runScheduledStep("Discord report recovery", () => sync.processPendingReportJobs(2));
        await runScheduledStep("Discord interaction processing", () =>
          processPendingInteractionJobs(env, config, engine, 5),
        );
        await runScheduledStep("Discord synchronization", () => sync.processPendingJobs());
        await runScheduledStep("release processing", () => processPendingReleaseJobs(env, config));
        await env.DB.prepare("DELETE FROM replay_nonces WHERE expires_at < datetime('now')").run();
        await env.DB.prepare(
          "DELETE FROM ai_oauth_requests WHERE expires_at < datetime('now','-1 day')",
        ).run();
        await env.DB.prepare(
          "DELETE FROM rate_limit_windows WHERE window_start < unixepoch('now') - 86400",
        ).run();
        await env.DB.prepare(
          `DELETE FROM discord_interaction_jobs
           WHERE status='complete' AND unixepoch(completed_at) < unixepoch('now') - 86400`,
        ).run();
        await env.DB.prepare(
          `UPDATE discord_interaction_jobs
           SET status='failed',attempts=10,payload_json='{}',locked_at=NULL,
               last_error=?1
           WHERE status!='complete' AND unixepoch(created_at) < unixepoch('now') - 1200
             AND (status IS NOT 'failed' OR attempts IS NOT 10 OR payload_json IS NOT '{}'
                  OR locked_at IS NOT NULL OR last_error IS NOT ?1)`,
        )
          .bind("Interaction token expired before processing completed.")
          .run();
        await env.DB.prepare(
          `DELETE FROM discord_interaction_jobs
           WHERE status='failed' AND unixepoch(created_at) < unixepoch('now') - 86400`,
        ).run();
      })(),
    );
  },
  async queue(batch: MessageBatch<DiscordReportQueueMessage>, env: Env) {
    await ensureCurrentSchema(env.DB);
    const { RoadmapEngine } = await import("@roadmap/core");
    const { D1RoadmapStorage } = await import("./storage.js");
    const { DiscordSyncService } = await import("./discord/sync.js");
    const config = (await import("../../../roadmap.config.js")).default;
    const engine = new RoadmapEngine(new D1RoadmapStorage(env.DB), config);
    const sync = new DiscordSyncService(env, config, engine);
    await handleDiscordReportQueue(batch, sync);
  },
} satisfies ExportedHandler<Env, DiscordReportQueueMessage>;

async function runScheduledStep(name: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(`${name} failed`, redactError(error));
  }
}
