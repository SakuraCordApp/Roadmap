import { createApp } from "./app.js";
import { processPendingInteractionJobs } from "./discord/interactions.js";
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
        await runScheduledStep("Discord interaction processing", () =>
          processPendingInteractionJobs(env, config, engine, 5),
        );
        // Discover reports in this Worker before draining the analysis queue.
        // This keeps intake moving even when the compatibility DiscordBot
        // scheduler is unavailable and lets new submissions run in this cycle.
        await runScheduledStep("Discord reconciliation", () => sync.reconcile());
        await runScheduledStep("Discord report analysis", () => sync.processPendingReportJobs(5));
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
           WHERE status='complete' AND completed_at < datetime('now','-1 day')`,
        ).run();
        await env.DB.prepare(
          `UPDATE discord_interaction_jobs
           SET status='failed',attempts=10,payload_json='{}',locked_at=NULL,
               last_error='Interaction token expired before processing completed.'
           WHERE status!='complete' AND created_at < datetime('now','-20 minutes')`,
        ).run();
        await env.DB.prepare(
          `DELETE FROM discord_interaction_jobs
           WHERE status='failed' AND created_at < datetime('now','-1 day')`,
        ).run();
      })(),
    );
  },
};

async function runScheduledStep(name: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(`${name} failed`, redactError(error));
  }
}
