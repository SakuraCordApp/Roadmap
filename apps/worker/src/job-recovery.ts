import { RoadmapError } from "@roadmap/core";

export const MAX_AUTOMATION_ATTEMPTS = 10;

const TERMINAL_AI_ERROR_CODES = new Set([
  "AI_OAUTH_NOT_CONFIGURED",
  "AI_OAUTH_REQUIRED",
  "AI_OAUTH_REFRESH_REQUIRED",
]);

export function isTerminalAiAuthorizationError(error: unknown): boolean {
  return error instanceof RoadmapError && TERMINAL_AI_ERROR_CODES.has(error.code);
}

export async function requeueAiAutomationJobs(db: D1Database): Promise<{
  reports: number;
  releases: number;
}> {
  const [reports, releases] = await db.batch([
    db.prepare(
      `UPDATE discord_report_jobs
       SET status='pending',attempts=0,
           available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           locked_at=NULL,last_error=NULL,completed_at=NULL,rerun_requested=0
       WHERE linked_item_id IS NULL AND status!='complete'`,
    ),
    db.prepare(
      `UPDATE release_jobs
       SET status='pending',attempts=0,
           available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           locked_at=NULL,last_error=NULL,completed_at=NULL
       WHERE status!='complete'
         AND (github_updated_at IS NULL OR discord_message_id IS NULL)`,
    ),
  ]);
  return {
    reports: Number(reports?.meta.changes ?? 0),
    releases: Number(releases?.meta.changes ?? 0),
  };
}
