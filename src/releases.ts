import { releaseDisplayName } from "./config";
import { getJsonState, getState, setState } from "./db/store";
import type { Env } from "./env";
import { GitHub } from "./github/client";
import type { GhIssue, GhRelease } from "./github/types";
import { parseSections } from "./report/body";
import { HttpError } from "./util/http";

export interface ReportRelease {
  tag: string;
  version: string;
  channel: "nightly" | "regular";
  url: string;
  publishedAt: string;
}
const CACHE_KEY = "github:supported-releases";
export function normalizeVersion(value: string): string {
  return value
    .trim()
    .replace(/^v(?=\d)/i, "")
    .replace(/-beta-/i, " beta ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}
export function selectReportReleases(releases: GhRelease[]): ReportRelease[] {
  const published = releases
    .filter((release) => !release.draft && release.published_at)
    .sort((a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!));
  return [published.find((r) => r.prerelease), published.find((r) => !r.prerelease)]
    .filter((r): r is GhRelease => Boolean(r))
    .map((r) => ({
      tag: r.tag_name,
      version: releaseDisplayName(r.tag_name),
      channel: r.prerelease ? "nightly" : "regular",
      url: r.html_url,
      publishedAt: r.published_at!,
    }));
}
export async function cachedReportReleases(env: Env): Promise<ReportRelease[]> {
  return (
    (await getJsonState<{ at: number; releases: ReportRelease[] } | null>(env.DB, CACHE_KEY, null))
      ?.releases ?? []
  );
}
export async function reportReleases(env: Env): Promise<ReportRelease[]> {
  const cached = await getJsonState<{ at: number; releases: ReportRelease[] } | null>(
    env.DB,
    CACHE_KEY,
    null,
  );
  const stale = (await getState(env.DB, "github:releases-refreshed")) === "0";
  if (cached && !stale && Date.now() - cached.at < 300_000) return cached.releases;
  const github = new GitHub(env);
  try {
    const releases = await github.request<GhRelease[]>(
      "GET",
      github.repo("/releases?per_page=100"),
    );
    // The regular release can be older than a whole page of nightlies.
    const regular = await github
      .request<GhRelease>("GET", github.repo("/releases/latest"))
      .catch((error) => {
        if (error instanceof HttpError && error.status === 404) return null;
        throw error;
      });
    const chosen = selectReportReleases(releases.filter((r) => r.prerelease));
    if (regular && !regular.draft && !regular.prerelease)
      chosen.push(...selectReportReleases([regular]));
    if (!chosen.length) throw new Error("No published releases are available");
    await setState(env.DB, CACHE_KEY, JSON.stringify({ at: Date.now(), releases: chosen }));
    await setState(env.DB, "github:releases-refreshed", "1");
    return chosen;
  } catch (error) {
    // Never accept an obsolete release list when its freshness cannot be verified.
    console.error("Supported release lookup failed", error);
    throw new HttpError(503, "We couldn't verify the latest releases. Please try again shortly.");
  }
}
export function matchingRelease(value: string, releases: ReportRelease[]) {
  return releases.find((release) => normalizeVersion(release.tag) === normalizeVersion(value));
}
export async function requireSupportedVersion(env: Env, value: string) {
  const releases = await reportReleases(env);
  const release = matchingRelease(value, releases);
  if (!release)
    throw new HttpError(
      400,
      `Please update and retest on ${releases.map((r) => `${r.version} (${r.channel})`).join(" or ")}, then select that version. Only the latest published nightly and regular releases are supported.`,
    );
  return release;
}

/** Gate GitHub-originated intake too; its author can correct the version field. */
export async function checkReportVersion(env: Env, issue: GhIssue): Promise<boolean> {
  const value =
    parseSections(issue.body)
      .find((section) => section.heading.toLowerCase() === "sakuracord version")
      ?.text.trim() ?? "";
  const key = `report:release:${issue.number}`;
  const accepted = await getJsonState<ReportRelease | null>(env.DB, key, null);
  if (accepted && normalizeVersion(accepted.version) === normalizeVersion(value)) return true;
  const releases = await reportReleases(env);
  const release = matchingRelease(value, releases);
  if (release) {
    await setState(env.DB, key, JSON.stringify(release));
    return true;
  }
  const github = new GitHub(env);
  const labels = issue.labels.map((label) => (typeof label === "string" ? label : label.name));
  if (!labels.includes("status: needs info"))
    await github.request("PATCH", github.repo(`/issues/${issue.number}`), {
      labels: [...labels.filter((label) => !label.startsWith("status: ")), "status: needs info"],
    });
  const noticeKey = `report:version-notice:${issue.number}`;
  if ((await getState(env.DB, noticeKey)) !== value) {
    await github.request("POST", github.repo(`/issues/${issue.number}/comments`), {
      body: `Please update and retest on ${releases.map((r) => `[${r.version} (${r.channel})](${r.url})`).join(" or ")}, then edit the **SakuraCord version** field in this issue. Only the latest published nightly and regular releases are supported. Assessment will start after the version is corrected. A regular-release user does not need to switch to nightly.`,
    });
    await setState(env.DB, noticeKey, value);
  }
  return false;
}
