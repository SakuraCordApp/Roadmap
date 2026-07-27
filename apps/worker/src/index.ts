import { createApp } from "./app.js";
import { processPendingInteractionJobs } from "./discord/interactions.js";
import type { Env } from "./env.js";
import { processPendingReleaseJobs } from "./release-automation.js";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        // Pending jobs are deliberately processed through the service rather
        // than by calling authenticated public mutation endpoints.
        const { RoadmapEngine } = await import("@roadmap/core");
        const { D1RoadmapStorage } = await import("./storage.js");
        const { DiscordSyncService } = await import("./discord/sync.js");
        const config = (await import("../../../roadmap.config.js")).default;
        const engine = new RoadmapEngine(new D1RoadmapStorage(env.DB), config);
        const sync = new DiscordSyncService(env, config, engine);
        await processPendingInteractionJobs(env, config, engine, 5);
        await sync.processPendingReportJobs(2);
        await sync.processPendingJobs();
        await processPendingReleaseJobs(env, config);
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
