import { NIGHTLY_BRANCH, REPOSITORY_SLUG, REPOSITORY_URL } from "./config";
import { getIssue, patchIssue, setPendingNote, type FixRef } from "./db/store";
import type { Env } from "./env";
import { GitHub } from "./github/client";
import type { GhIssue, GhPull, GhRelease } from "./github/types";
import { labelNames } from "./github/types";
import { enqueueMany } from "./jobs/queue";
import { statusGithubLabel } from "./lifecycle";
import { reportReleases } from "./releases";
import { neutralizeUserText } from "./report/body";
import { recordShipment } from "./sync/activity";
import { NO_MIRROR } from "./sync/markers";

function repositoryPath(value: string): string | null {
  if (!/^https?:/i.test(value)) return null;
  const url = new URL(value);
  const prefix = `/${REPOSITORY_SLUG}/`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    !url.pathname.toLowerCase().startsWith(prefix.toLowerCase())
  )
    throw new Error("Use a link from the SakuraCordApp/SakuraCord repository.");
  return decodeURIComponent(url.pathname.slice(prefix.length)).replace(/\/$/, "");
}

async function resolveFix(github: GitHub, value: string): Promise<FixRef> {
  const reference = value.trim();
  const path = repositoryPath(reference);
  const pr = path?.match(/^pull\/(\d+)$/)?.[1] ?? reference.match(/^#?(\d{1,6})$/)?.[1];
  if (pr) {
    const pull = await github.request<GhPull>("GET", github.repo(`/pulls/${pr}`));
    if (!pull.merged || !pull.merge_commit_sha)
      throw new Error("That pull request is not merged yet. Use Mark in progress instead.");
    return {
      kind: "pr",
      number: pull.number,
      sha: pull.merge_commit_sha,
      url: pull.html_url,
      title: pull.title,
      state: "merged",
      base: pull.base.ref,
    };
  }
  const sha =
    path?.match(/^commit\/([a-f0-9]{7,40})$/i)?.[1] ??
    (/^[a-f0-9]{7,40}$/i.test(reference) ? reference : null);
  if (!sha)
    throw new Error("Enter a SakuraCord commit link/SHA or a merged pull request link/number.");
  const commit = await github.request<{ sha: string }>("GET", github.repo(`/commits/${sha}`));
  return {
    kind: "commit",
    sha: commit.sha,
    url: `${REPOSITORY_URL}/commit/${commit.sha}`,
    state: "merged",
    base: NIGHTLY_BRANCH,
  };
}

function releaseTag(value: string): string {
  const reference = value.trim();
  const path = repositoryPath(reference);
  const tag = path ? path.match(/^releases\/tag\/(.+)$/)?.[1] : reference;
  if (!tag || !/^v?\d+\.\d+\.\d+(?:[- ]Beta[- ]\d+)?$/i.test(tag))
    throw new Error("Enter a release tag such as v0.1.6-Beta-3, or its GitHub release link.");
  return `v${tag.replace(/^v/i, "").replace(/[- ]beta[- ]/i, "-Beta-")}`;
}

/** Explicit maintainer confirmation; GitHub receives the public decision. */
export async function markFixed(
  env: Env,
  current: GhIssue,
  actor: string,
  input: { release?: string; reference?: string; note?: string },
): Promise<string> {
  if (current.state !== "open")
    throw new Error("This report is closed. Reopen it before changing its resolution.");
  const issue = await getIssue(env.DB, current.number);
  if (!issue) throw new Error("This report has not synced yet. Try again shortly.");
  const github = new GitHub(env);
  const note = input.note?.trim();
  const attribution = `${note ? `\n\n${neutralizeUserText(note)}` : ""}\n\n<sub>— ${neutralizeUserText(actor)} via Discord</sub>`;
  // Fetch once before changing anything; used to catch fixes already in a release
  // and to follow a nightly confirmation through to the regular channel.
  const releases = await reportReleases(env);
  let message: string;
  if (input.release === "unreleased") {
    const fix = await resolveFix(github, input.reference ?? "");
    const comparison = await github.request<{ status: string }>(
      "GET",
      github.repo(`/compare/${fix.sha}...${NIGHTLY_BRANCH}`),
    );
    if (!["ahead", "identical"].includes(comparison.status))
      throw new Error("That fix has not landed on nightly yet. Use Mark in progress instead.");
    await github.request("POST", github.repo(`/issues/${issue.number}/comments`), {
      body: `${NO_MIRROR}\nA maintainer confirmed this is fixed in the code by ${fix.url}. Published releases will be checked for this fix.${attribution}`,
    });
    await patchIssue(env.DB, issue.number, {
      shippedIn: null,
      shippedStableIn: null,
      fixes: issue.shippedIn
        ? [fix]
        : [
            ...issue.fixes.filter(
              (existing) =>
                existing.sha !== fix.sha &&
                !(fix.kind === "pr" && existing.kind === "pr" && existing.number === fix.number),
            ),
            fix,
          ],
    });
    if (note) await setPendingNote(env.DB, issue.number, "in_nightly", note, actor);
    await github.request("PATCH", github.repo(`/issues/${issue.number}`), {
      labels: [
        ...labelNames(current).filter((name) => !name.startsWith("status: ")),
        statusGithubLabel("in_nightly")!,
      ],
    });
    message =
      "Fix recorded. The report stays open until a published release contains it; current releases are being checked.";
  } else {
    const tag = releaseTag(
      input.release === "other" ? (input.reference ?? "") : (input.release ?? ""),
    );
    const release = await github.request<GhRelease>(
      "GET",
      github.repo(`/releases/tags/${encodeURIComponent(tag)}`),
    );
    if (release.draft || !release.published_at)
      throw new Error("Choose a published release, not a draft.");
    if (note) await setPendingNote(env.DB, issue.number, "shipped", note, actor);
    await recordShipment(
      env,
      { ...issue, state: current.state },
      { tag: release.tag_name, url: release.html_url },
      release.prerelease,
      `A maintainer confirmed the fix is available in this release.${attribution}`,
    );
    message = `Marked fixed in ${release.tag_name} and closed as shipped.`;
  }
  await enqueueMany(
    env,
    releases.map((release) => ({
      kind: "ship" as const,
      key: `${issue.number}:${release.tag}`,
      payload: { number: issue.number, tag: release.tag, url: release.url },
    })),
  );
  return message;
}
