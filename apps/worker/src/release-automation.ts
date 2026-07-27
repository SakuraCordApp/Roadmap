import { RoadmapError, type RoadmapConfig } from "@roadmap/core";
import type { Env } from "./env.js";
import { DiscordRestClient } from "./discord/rest.js";
import { generateStructuredReleaseCopy } from "./ai-oauth.js";
import { readBodyTextLimited, SIGNED_WEBHOOK_BODY_LIMIT } from "./request-body.js";
import { constantTimeEqual, redactError, sha256 } from "./security.js";

const GITHUB_API = "https://api.github.com";

interface GithubReleasePayload {
  action: string;
  release: {
    id: number;
    tag_name: string;
    name: string | null;
    html_url: string;
    target_commitish: string;
    published_at: string | null;
    draft: boolean;
  };
  repository: { full_name: string };
}

interface ReleaseJob {
  id: number;
  repository: string;
  release_id: number;
  tag_name: string;
  release_name: string | null;
  release_url: string;
  target_commitish: string;
  published_at: string;
  previous_tag: string | null;
  generated_json: string | null;
  github_updated_at: string | null;
  discord_message_id: string | null;
  attempts: number;
}

interface GithubCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
    committer: { name: string; date: string } | null;
  };
}

interface GeneratedCopy {
  githubDescription: string;
  discordTitle: string;
  discordAnnouncement: string;
}

export async function acceptGithubReleaseWebhook(
  request: Request,
  env: Env,
  config: RoadmapConfig,
): Promise<{ accepted: boolean; duplicate?: boolean; reason?: string; jobId?: number }> {
  if (!config.releases.enabled || !config.releases.githubRepository) {
    throw new RoadmapError("RELEASE_AUTOMATION_DISABLED", "Release automation is disabled.", 503);
  }
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
  const payload = JSON.parse(body) as GithubReleasePayload;
  if (
    !["published", "released", "prereleased"].includes(payload.action) ||
    payload.release.draft ||
    !payload.release.published_at
  ) {
    return { accepted: false, reason: "release_not_published" };
  }
  if (
    payload.repository.full_name.toLowerCase() !== config.releases.githubRepository.toLowerCase()
  ) {
    throw new RoadmapError(
      "GITHUB_REPOSITORY_MISMATCH",
      "The webhook repository does not match the configured release repository.",
      403,
    );
  }
  try {
    await env.DB.prepare(
      "INSERT INTO replay_nonces(nonce,expires_at) VALUES(?,datetime('now','+30 days'))",
    )
      .bind(`github:${delivery}`)
      .run();
  } catch {
    return { accepted: true, duplicate: true };
  }
  const inserted = await env.DB.prepare(
    `INSERT INTO release_jobs(
      repository,release_id,tag_name,release_name,release_url,target_commitish,
      published_at,payload_json
    ) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(repository,release_id) DO NOTHING`,
  )
    .bind(
      payload.repository.full_name,
      payload.release.id,
      payload.release.tag_name,
      payload.release.name,
      payload.release.html_url,
      payload.release.target_commitish,
      payload.release.published_at,
      JSON.stringify(payload),
    )
    .run();
  if (inserted.meta.changes !== 1) return { accepted: true, duplicate: true };
  const row = await env.DB.prepare(
    "SELECT id FROM release_jobs WHERE repository=? AND release_id=?",
  )
    .bind(payload.repository.full_name, payload.release.id)
    .first<{ id: number }>();
  return { accepted: true, jobId: row?.id };
}

export async function processPendingReleaseJobs(
  env: Env,
  config: RoadmapConfig,
  limit = 2,
): Promise<{ processed: number; failed: number }> {
  if (!config.releases.enabled) return { processed: 0, failed: 0 };
  const jobs = await env.DB.prepare(
    `SELECT id,repository,release_id,tag_name,release_name,release_url,target_commitish,
      published_at,previous_tag,generated_json,github_updated_at,discord_message_id,attempts
     FROM release_jobs
     WHERE attempts < 10 AND (
       (status IN ('pending','failed')
         AND available_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       OR (status='processing' AND unixepoch(locked_at) <= unixepoch('now') - 300)
     )
     ORDER BY id LIMIT ?`,
  )
    .bind(limit)
    .all<ReleaseJob>();
  let processed = 0;
  let failed = 0;
  for (const job of jobs.results) {
    const locked = await env.DB.prepare(
      `UPDATE release_jobs SET status='processing',locked_at=?,attempts=attempts+1
       WHERE id=? AND attempts < 10 AND (
         status IN ('pending','failed')
         OR (status='processing' AND unixepoch(locked_at) <= unixepoch('now') - 300)
       )`,
    )
      .bind(new Date().toISOString(), job.id)
      .run();
    if (locked.meta.changes !== 1) continue;
    try {
      await processReleaseJob(env, config, job);
      await env.DB.prepare(
        `UPDATE release_jobs SET status='complete',completed_at=?,locked_at=NULL,last_error=NULL
         WHERE id=?`,
      )
        .bind(new Date().toISOString(), job.id)
        .run();
      processed += 1;
    } catch (error) {
      const delay = Math.min(21_600, 2 ** Math.min(job.attempts + 2, 14));
      await env.DB.prepare(
        `UPDATE release_jobs SET status='failed',last_error=?,
          available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),locked_at=NULL WHERE id=?`,
      )
        .bind(redactError(error).slice(0, 2_000), `+${delay} seconds`, job.id)
        .run();
      failed += 1;
    }
  }
  return { processed, failed };
}

export async function releaseAutomationStatus(env: Env): Promise<{
  aiConnected: boolean;
  pending: number;
  failed: number;
  lastCompletedAt: string | null;
  lastError: string | null;
}> {
  const [session, counts, latest] = await Promise.all([
    env.DB.prepare("SELECT id FROM ai_oauth_session WHERE id='primary'").first(),
    env.DB.prepare(
      `SELECT
        SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
       FROM release_jobs`,
    ).first<{ pending: number | null; failed: number | null }>(),
    env.DB.prepare(
      `SELECT completed_at,last_error FROM release_jobs
       ORDER BY COALESCE(completed_at,created_at) DESC LIMIT 1`,
    ).first<{ completed_at: string | null; last_error: string | null }>(),
  ]);
  return {
    aiConnected: Boolean(session),
    pending: Number(counts?.pending ?? 0),
    failed: Number(counts?.failed ?? 0),
    lastCompletedAt: latest?.completed_at ?? null,
    lastError: latest?.last_error ?? null,
  };
}

async function processReleaseJob(env: Env, config: RoadmapConfig, job: ReleaseJob): Promise<void> {
  const github = new GithubClient(requireSecret(env.GITHUB_RELEASE_TOKEN, "GITHUB_RELEASE_TOKEN"));
  let copy: GeneratedCopy;
  if (job.generated_json) {
    copy = JSON.parse(job.generated_json) as GeneratedCopy;
  } else {
    const previousTag = await findPreviousReleaseTag(github, job);
    const commits = await collectReleaseCommits(
      github,
      job.repository,
      previousTag,
      job.tag_name,
      config.releases.maxCommits,
    );
    if (!commits.length) {
      throw new RoadmapError(
        "RELEASE_COMMITS_EMPTY",
        `No commits were found for release ${job.tag_name}.`,
        422,
      );
    }
    copy = await generateStructuredReleaseCopy(env, config, {
      tagName: job.tag_name,
      releaseName: job.release_name ?? job.tag_name,
      releaseUrl: job.release_url,
      ...(previousTag ? { previousTag } : {}),
      commits,
    });
    copy.githubDescription = finalizeGithubDescription(
      copy.githubDescription,
      job.repository,
      previousTag,
      job.tag_name,
    );
    await env.DB.prepare("UPDATE release_jobs SET generated_json=?,previous_tag=? WHERE id=?")
      .bind(JSON.stringify(copy), previousTag ?? null, job.id)
      .run();
  }

  if (!job.github_updated_at) {
    await github.request(`/repos/${job.repository}/releases/${job.release_id}`, {
      method: "PATCH",
      body: { body: copy.githubDescription },
    });
    await env.DB.prepare("UPDATE release_jobs SET github_updated_at=? WHERE id=?")
      .bind(new Date().toISOString(), job.id)
      .run();
  }

  if (!job.discord_message_id) {
    const channelId =
      config.discord.releaseAnnouncementChannelId ?? config.discord.roadmapChannelId;
    const roleId = config.discord.updatesRoleId;
    if (!channelId || !roleId) {
      throw new RoadmapError(
        "RELEASE_DISCORD_NOT_CONFIGURED",
        "A release announcement channel and updates role are required.",
        503,
      );
    }
    const rest = new DiscordRestClient(requireSecret(env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN"));
    const nonce = (await sha256(`release:${job.repository}:${job.release_id}`)).slice(0, 25);
    const message = await rest.post<{ id: string }>(
      `/channels/${channelId}/messages`,
      {
        content: `<@&${roleId}>`,
        embeds: [
          {
            title: copy.discordTitle,
            description: copy.discordAnnouncement,
            color: Number.parseInt(config.branding.accentColor.slice(1), 16),
          },
        ],
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 5,
                label: "View release",
                url: job.release_url,
              },
            ],
          },
        ],
        allowed_mentions: { parse: [], roles: [roleId], replied_user: false },
        nonce,
        enforce_nonce: true,
      },
      `release-announcement:${job.release_id}`,
    );
    await env.DB.prepare("UPDATE release_jobs SET discord_message_id=? WHERE id=?")
      .bind(message.id, job.id)
      .run();
  }
}

async function findPreviousReleaseTag(
  github: GithubClient,
  job: ReleaseJob,
): Promise<string | undefined> {
  const releases = await github.request<
    Array<{ id: number; tag_name: string; draft: boolean; published_at: string | null }>
  >(`/repos/${job.repository}/releases?per_page=100`);
  return releases
    .filter(
      (release) =>
        release.id !== job.release_id &&
        !release.draft &&
        release.published_at &&
        Date.parse(release.published_at) < Date.parse(job.published_at),
    )
    .sort(
      (left, right) => Date.parse(right.published_at ?? "") - Date.parse(left.published_at ?? ""),
    )[0]?.tag_name;
}

async function collectReleaseCommits(
  github: GithubClient,
  repository: string,
  previousTag: string | undefined,
  tagName: string,
  maximum: number,
): Promise<
  Array<{ sha: string; message: string; author: string; committedAt: string; url: string }>
> {
  const commits: GithubCommit[] = [];
  if (previousTag) {
    for (let page = 1; ; page += 1) {
      const result = await github.request<{
        total_commits: number;
        commits: GithubCommit[];
      }>(
        `/repos/${repository}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(tagName)}?per_page=100&page=${page}`,
      );
      commits.push(...result.commits);
      if (commits.length >= result.total_commits || result.commits.length === 0) break;
      if (commits.length >= maximum) break;
    }
  } else {
    for (let page = 1; ; page += 1) {
      const result = await github.request<GithubCommit[]>(
        `/repos/${repository}/commits?sha=${encodeURIComponent(tagName)}&per_page=100&page=${page}`,
      );
      commits.push(...result);
      if (result.length < 100 || commits.length >= maximum) break;
    }
    commits.reverse();
  }
  if (commits.length > maximum) {
    throw new RoadmapError(
      "RELEASE_COMMIT_LIMIT_EXCEEDED",
      `Release ${tagName} contains more than the configured ${maximum} commit limit.`,
      422,
    );
  }
  return commits.map((commit) => ({
    sha: commit.sha,
    message: commit.commit.message,
    author: commit.commit.author?.name ?? commit.commit.committer?.name ?? "Unknown",
    committedAt: commit.commit.author?.date ?? commit.commit.committer?.date ?? "",
    url: commit.html_url,
  }));
}

function finalizeGithubDescription(
  generated: string,
  repository: string,
  previousTag: string | undefined,
  currentTag: string,
): string {
  const trimmed = generated.trim();
  if (!previousTag) return trimmed;
  const compareUrl = `https://github.com/${repository}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(currentTag)}`;
  const withoutGeneratedChangelog = trimmed
    .split(/\r?\n/)
    .filter((line) => {
      const plain = line
        .trim()
        .replace(/^#{1,6}\s+/, "")
        .replaceAll("**", "")
        .trim();
      return !/^Full Changelog\s*:/i.test(plain) && !line.includes(compareUrl);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const changelog = `**Full Changelog:** [${previousTag}...${currentTag}](${compareUrl})`;
  return withoutGeneratedChangelog ? `${withoutGeneratedChangelog}\n\n${changelog}` : changelog;
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

class GithubClient {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async request<T>(
    path: string,
    options: { method?: "GET" | "POST" | "PATCH"; body?: unknown } = {},
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await this.fetcher(`${GITHUB_API}${path}`, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "User-Agent": "SakuraCord-Roadmap",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      if (!response.ok) {
        throw new RoadmapError(
          "GITHUB_API_ERROR",
          `GitHub ${options.method ?? "GET"} ${path.split("?")[0]} failed with HTTP ${response.status}.`,
          502,
          { response: (await response.text()).slice(0, 1_000) },
        );
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
    throw new RoadmapError("GITHUB_RETRY_EXHAUSTED", "GitHub retry budget was exhausted.", 502);
  }
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value) throw new RoadmapError("RELEASE_SECRET_MISSING", `${name} is not configured.`, 503);
  return value;
}
