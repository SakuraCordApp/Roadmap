import { RoadmapError, type RoadmapConfig } from "@roadmap/core";
import type { Env } from "./env.js";
import { retireReleaseAutomationJobs } from "./job-recovery.js";
import { readBodyTextLimited, SIGNED_WEBHOOK_BODY_LIMIT } from "./request-body.js";
import { constantTimeEqual } from "./security.js";

export async function acceptGithubReleaseWebhook(
  request: Request,
  env: Env,
  config: RoadmapConfig,
): Promise<{ accepted: boolean; duplicate?: boolean; reason?: string; jobId?: number }> {
  void config;
  if (!env.GITHUB_WEBHOOK_SECRET) {
    throw new RoadmapError(
      "GITHUB_WEBHOOK_NOT_CONFIGURED",
      "The GitHub webhook secret is not configured.",
      503,
    );
  }
  const body = await readBodyTextLimited(request, SIGNED_WEBHOOK_BODY_LIMIT);
  await verifyGithubWebhook(request, body, env.GITHUB_WEBHOOK_SECRET);
  const delivery = request.headers.get("X-GitHub-Delivery");
  if (!delivery || !/^[0-9a-f-]{16,80}$/i.test(delivery)) {
    throw new RoadmapError(
      "GITHUB_DELIVERY_INVALID",
      "Missing or invalid GitHub delivery ID.",
      400,
    );
  }
  const event = request.headers.get("X-GitHub-Event");
  if (event === "ping") return { accepted: false, reason: "ping" };
  if (event !== "release") return { accepted: false, reason: "event_not_supported" };

  // The application repository's release workflow is the sole owner of
  // GitHub release notes and Discord release announcements. The Roadmap Worker
  // authenticates release deliveries but never stores or processes them.
  return { accepted: false, reason: "github_actions_owned" };
}

export async function processPendingReleaseJobs(
  env: Env,
  config: RoadmapConfig,
  limit = 2,
): Promise<{ processed: number; failed: number }> {
  void config;
  void limit;
  await retireReleaseAutomationJobs(env.DB);
  return { processed: 0, failed: 0 };
}

export async function releaseAutomationStatus(env: Env): Promise<{
  aiConnected: boolean;
  pending: number;
  failed: number;
  lastCompletedAt: string | null;
  lastError: string | null;
}> {
  await retireReleaseAutomationJobs(env.DB);
  const [session, latest] = await Promise.all([
    env.DB.prepare("SELECT id FROM ai_oauth_session WHERE id='primary'").first(),
    env.DB.prepare(
      `SELECT completed_at,last_error FROM release_jobs
       ORDER BY COALESCE(completed_at,created_at) DESC LIMIT 1`,
    ).first<{ completed_at: string | null; last_error: string | null }>(),
  ]);
  return {
    aiConnected: Boolean(session),
    pending: 0,
    failed: 0,
    lastCompletedAt: latest?.completed_at ?? null,
    lastError: latest?.last_error ?? null,
  };
}

async function verifyGithubWebhook(request: Request, body: string, secret: string): Promise<void> {
  const received = request.headers.get("X-Hub-Signature-256");
  if (!received?.startsWith("sha256=")) {
    throw new RoadmapError("GITHUB_SIGNATURE_MISSING", "Missing GitHub webhook signature.", 401);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = `sha256=${[...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
  if (!(await constantTimeEqual(received, expected))) {
    throw new RoadmapError("GITHUB_SIGNATURE_INVALID", "Invalid GitHub webhook signature.", 401);
  }
}
