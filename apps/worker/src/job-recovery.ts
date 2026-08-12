import { RoadmapError } from "@roadmap/core";

export const MAX_AUTOMATION_ATTEMPTS = 10;
export const RELEASE_AUTOMATION_RETIRED_MESSAGE =
  "Release automation is disabled; GitHub Actions owns release publication.";

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
  const reports = await db
    .prepare(
      `UPDATE discord_report_jobs
       SET status='pending',attempts=0,
           available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           locked_at=NULL,last_error=NULL,completed_at=NULL,rerun_requested=0
       WHERE linked_item_id IS NULL AND status!='complete'`,
    )
    .run();
  const releases = await retireReleaseAutomationJobs(db);
  return {
    reports: Number(reports?.meta.changes ?? 0),
    releases,
  };
}

export async function retireReleaseAutomationJobs(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE release_jobs
       SET status='complete',attempts=?,locked_at=NULL,
           completed_at=COALESCE(completed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
           last_error=?
       WHERE status!='complete'`,
    )
    .bind(MAX_AUTOMATION_ATTEMPTS, RELEASE_AUTOMATION_RETIRED_MESSAGE)
    .run();
  return Number(result.meta.changes ?? 0);
}
