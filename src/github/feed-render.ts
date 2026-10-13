import { escapeDiscord, githubToDiscord, plural, truncate } from "../util/text";
import type { CheckState, FeedEmoji } from "./feed-emoji";

// Pure renderers for the GitHub updates channel. Every card is one embed with
// at most one link button; the feed module decides when a card pings.

export interface Actor {
  login: string;
  avatar?: string;
  url?: string;
}

export interface Embed {
  title: string;
  description?: string;
  url?: string;
  color: number;
  timestamp?: string;
  author?: { name: string; icon_url?: string; url?: string };
  footer: { text: string };
}

export interface Card {
  embed: Embed;
  button?: { label: string; url: string };
}

interface Repository {
  repo: string;
  repoUrl: string;
}

export interface PushCommit {
  sha: string;
  headline: string;
  url: string;
  author?: string;
  /** A merge commit's PR title, from the paragraph after its headline. */
  subject?: string;
}

export interface PushItem extends Repository {
  branch: string;
  after: string;
  compare: string;
  forced: boolean;
  created: boolean;
  total: number;
  commits: PushCommit[];
  actor: Actor;
  at?: string;
}

export interface PullItem extends Repository {
  number: number;
  title: string;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  head: string;
  base: string;
  commits?: number;
  additions?: number;
  deletions?: number;
  files?: number;
  body: string;
  author: Actor;
  closedBy?: string;
  createdAt?: string;
}

export interface RunItem extends Repository {
  id: number;
  name: string;
  event: string;
  branch: string;
  sha: string;
  attempt: number;
  status: string;
  conclusion: string | null;
  url: string;
  startedAt?: string;
  updatedAt?: string;
  title: string;
  pr?: number;
  actor?: Actor;
}

export interface JobItem {
  id: number;
  runId: number;
  attempt: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt?: string;
  completedAt?: string;
  url: string;
  failedStep?: string;
}

export interface NoteItem extends Repository {
  kind: "comment" | "review" | "issue" | "discussion";
  title: string;
  url: string;
  body?: string;
  color: number;
  actor: Actor;
  at?: string;
  button: string;
}

export const COLORS = {
  sakura: 0xd9578b,
  open: 0x2da44e,
  draft: 0x8b949e,
  merged: 0x8957e5,
  closed: 0xcf222e,
  running: 0xd29922,
  success: 0x2da44e,
  failure: 0xcf222e,
  neutral: 0x8b949e,
  comment: 0x1f6feb,
} as const;

const MAX_COMMITS = 8;
const MAX_JOB_LINES = 20;

// ---------------------------------------------------------------------------
// Pushes: one card per pushed head commit, shared by every branch it reached.

export function renderPush(refs: PushItem[]): Card | null {
  if (!refs.length) return null;
  const first = refs[0]!;
  const seen = new Set<string>();
  const commits: PushCommit[] = [];
  for (const commit of refs.flatMap((ref) => ref.commits)) {
    if (seen.has(commit.sha)) continue;
    seen.add(commit.sha);
    commits.push(commit);
  }
  if (!commits.length) return null;
  const branches = refs.map((ref) => ref.branch);
  const total = Math.max(commits.length, ...refs.map((ref) => ref.total));
  const merge = /^Merge pull request #(\d+) from \S+/.exec(commits.at(-1)!.headline);
  const listed = (merge ? commits.slice(0, -1) : commits).slice().reverse();
  const verb = refs.some((ref) => ref.forced)
    ? "Force-pushed"
    : refs.some((ref) => ref.created)
      ? "Created"
      : "Pushed";
  const title = merge
    ? `Merged #${merge[1]} into ${branches.join(", ")}`
    : verb === "Created"
      ? `Created ${branches.join(", ")} · ${plural(total, "commit")}`
      : `${verb} ${plural(total, "commit")} to ${branches.join(", ")}`;
  const lines = listed.slice(0, MAX_COMMITS).map((commit) => {
    const author =
      commit.author && commit.author !== first.actor.login
        ? ` — ${escapeDiscord(commit.author)}`
        : "";
    return `[\`${commit.sha.slice(0, 7)}\`](${commit.url}) ${linkIssues(commit.headline, first.repoUrl)}${author}`;
  });
  const hidden = total - Math.min(listed.length, MAX_COMMITS) - (merge ? 1 : 0);
  if (hidden > 0) lines.push(`-# … and ${plural(hidden, "older commit")}`);
  const mergeTitle = merge ? commits.at(-1)!.subject : null;
  return {
    embed: {
      title: truncate(title, 256),
      url: first.compare,
      color: COLORS.sakura,
      description: [mergeTitle ? `**${escapeDiscord(mergeTitle)}**` : null, lines.join("\n")]
        .filter(Boolean)
        .join("\n"),
      author: author(first.actor),
      footer: { text: first.repo },
      ...(validTime(first.at) ? { timestamp: first.at } : {}),
    },
    button: { label: refs.length > 1 ? "Compare" : "Compare changes", url: first.compare },
  };
}

// ---------------------------------------------------------------------------
// Pull requests: announced once, then edited as they change.

const PULL_STATE: Record<PullItem["state"], { label: string; color: number }> = {
  open: { label: "Open", color: COLORS.open },
  draft: { label: "Draft", color: COLORS.draft },
  merged: { label: "Merged", color: COLORS.merged },
  closed: { label: "Closed", color: COLORS.closed },
};

export function renderPull(pull: PullItem): Card {
  const state = PULL_STATE[pull.state];
  const status =
    pull.state === "merged" && pull.closedBy
      ? `**Merged** by ${escapeDiscord(pull.closedBy)}`
      : pull.state === "closed" && pull.closedBy
        ? `**Closed** by ${escapeDiscord(pull.closedBy)}`
        : `**${state.label}**`;
  const stats = [
    pull.commits !== undefined ? plural(pull.commits, "commit") : null,
    pull.files !== undefined ? plural(pull.files, "file") : null,
    pull.additions !== undefined && pull.deletions !== undefined
      ? `+${pull.additions} −${pull.deletions}`
      : null,
  ].filter(Boolean);
  const body = excerpt(pull.body, 280, 4, pull.repoUrl);
  return {
    embed: {
      title: truncate(`#${pull.number} · ${pull.title}`, 256),
      url: pull.url,
      color: state.color,
      description: [
        `${status} · \`${escapeCode(pull.head)}\` → \`${escapeCode(pull.base)}\``,
        stats.length ? `-# ${stats.join(" · ")}` : null,
        body ? `\n${body}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      author: author(pull.author),
      footer: { text: pull.repo },
      ...(validTime(pull.createdAt) ? { timestamp: pull.createdAt } : {}),
    },
    button: { label: "Open pull request", url: pull.url },
  };
}

// ---------------------------------------------------------------------------
// Checks: every workflow run for one commit, edited live from webhook data.

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const STATUS_ORDER: Record<CheckState, number> = {
  failure: 4,
  running: 3,
  queued: 2,
  success: 1,
  skipped: 0,
};

export function checkState(status: string, conclusion: string | null): CheckState {
  if (status === "completed") {
    if (conclusion === "success") return "success";
    if (conclusion && FAILED.has(conclusion)) return "failure";
    if (conclusion === "action_required") return "queued";
    return "skipped";
  }
  return status === "in_progress" ? "running" : "queued";
}

interface JobLine {
  name: string;
  state: CheckState;
  conclusion: string | null;
  startedAt?: string;
  completedAt?: string;
  failedStep?: string;
  branches: string[];
}

interface WorkflowGroup {
  name: string;
  runs: RunItem[];
  jobs: JobLine[];
}

/** True once a runner has picked up real work; skipped-only runs never post. */
export function checksStarted(runs: RunItem[], jobs: JobItem[]): boolean {
  return (
    jobs.some(
      (job) =>
        job.status === "in_progress" ||
        (job.status === "completed" && job.conclusion !== "skipped"),
    ) || runs.some((run) => run.status === "completed" && FAILED.has(run.conclusion ?? ""))
  );
}

export function renderChecks(
  runs: RunItem[],
  jobs: JobItem[],
  emoji: FeedEmoji,
  now = Date.now(),
): Card | null {
  const visible = runs.filter(
    (run) => !(run.status === "completed" && run.conclusion === "skipped"),
  );
  if (!visible.length || !checksStarted(visible, jobs)) return null;
  const groups = groupWorkflows(visible, jobs);
  const states = groups.flatMap((group) => [
    ...group.jobs.map((job) => job.state),
    ...group.runs.map((run) => checkState(run.status, run.conclusion)),
  ]);
  const running = states.some((state) => state === "running" || state === "queued");
  const failed = states.includes("failure");
  const allJobs = groups.flatMap((group) => group.jobs);
  const start = earliest(visible.map((run) => run.startedAt));
  const end = latest([
    ...allJobs.map((job) => job.completedAt),
    ...visible.map((run) => (run.status === "completed" ? run.updatedAt : undefined)),
  ]);
  const elapsed = start && end ? duration(end - start) : null;
  let status: string;
  let color: number;
  if (running) {
    const done = allJobs.filter((job) => job.state !== "running" && job.state !== "queued").length;
    status = `${emoji.running} **Running** · ${done}/${allJobs.length} jobs${start ? ` · started ${relative(Math.min(start, now))}` : ""}`;
    if (failed) status += ` · ${emoji.failure} ${plural(countFailed(allJobs), "failure")} so far`;
    color = failed ? COLORS.failure : COLORS.running;
  } else if (failed) {
    const count = countFailed(allJobs);
    status = `${emoji.failure} **Failed** · ${count ? `${plural(count, "job")} failed` : "workflow failed"}${elapsed ? ` · ${elapsed}` : ""}`;
    color = COLORS.failure;
  } else if (states.includes("success")) {
    status = `${emoji.success} **Passed**${elapsed ? ` in ${elapsed}` : ""}`;
    color = COLORS.success;
  } else {
    status = `${emoji.skipped} **Cancelled**`;
    color = COLORS.neutral;
  }

  const first = visible[0]!;
  const branches = [...new Set(visible.map((run) => run.branch))];
  const pr = visible.find((run) => run.pr)?.pr;
  const commitUrl = `${first.repoUrl}/commit/${first.sha}`;
  const subject = pr
    ? `[#${pr}](${first.repoUrl}/pull/${pr}) · \`${escapeCode(first.branch)}\``
    : `[\`${first.sha.slice(0, 7)}\`](${commitUrl}) on ${branches.map((b) => `\`${escapeCode(b)}\``).join(", ")}`;

  const sections: string[] = [];
  let budget = MAX_JOB_LINES;
  for (const group of groups) {
    const run = group.runs[0]!;
    const groupBranches = [...new Set(group.runs.map((r) => r.branch))];
    const header =
      `**[${escapeDiscord(group.name)}](${run.url})**` +
      (branches.length > 1
        ? ` · ${groupBranches.map((b) => `\`${escapeCode(b)}\``).join(", ")}`
        : "") +
      (run.attempt > 1 ? ` · attempt ${run.attempt}` : "");
    const lines = [header];
    if (!group.jobs.length) {
      const state = checkState(run.status, run.conclusion);
      lines.push(
        `${emoji[state]} ${state === "failure" ? "Workflow failed to start" : "Waiting for jobs"}`,
      );
    }
    const shown = group.jobs.slice(0, Math.max(budget, 0));
    for (const job of shown) lines.push(jobLine(job, emoji, branches.length > 1, now));
    budget -= shown.length;
    const rest = group.jobs.length - shown.length;
    if (rest > 0) lines.push(`-# … and ${plural(rest, "more job")}`);
    sections.push(lines.join("\n"));
  }

  return {
    embed: {
      title: truncate(first.title || first.name, 256),
      url: pr ? `${first.repoUrl}/pull/${pr}` : commitUrl,
      color,
      description: truncate([status, subject, "", sections.join("\n\n")].join("\n"), 4000),
      ...(first.actor ? { author: author(first.actor) } : {}),
      footer: { text: first.repo },
      ...(validTime(first.startedAt) ? { timestamp: first.startedAt } : {}),
    },
    button: {
      label: "View checks",
      url: visible.length === 1 ? first.url : pr ? `${first.repoUrl}/pull/${pr}/checks` : commitUrl,
    },
  };
}

function groupWorkflows(runs: RunItem[], jobs: JobItem[]): WorkflowGroup[] {
  const groups = new Map<string, WorkflowGroup>();
  for (const run of [...runs].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)) {
    const group = groups.get(run.name) ?? { name: run.name, runs: [], jobs: [] };
    groups.set(run.name, group);
    group.runs.push(run);
    // A rerun's jobs can arrive before its run event; follow the newest attempt seen.
    const runJobs = jobs.filter((job) => job.runId === run.id);
    const attempt = Math.max(run.attempt, ...runJobs.map((job) => job.attempt));
    for (const job of runJobs.filter((job) => job.attempt === attempt)) {
      const state = checkState(job.status, job.conclusion);
      const existing = group.jobs.find((line) => line.name === job.name);
      if (!existing) {
        group.jobs.push({
          name: job.name,
          state,
          conclusion: job.conclusion,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          failedStep: job.failedStep,
          branches: state === "failure" ? [run.branch] : [],
        });
        continue;
      }
      // The same job on several branches collapses into its most urgent state.
      if (state === "failure") existing.branches.push(run.branch);
      if (STATUS_ORDER[state] > STATUS_ORDER[existing.state]) {
        Object.assign(existing, {
          state,
          conclusion: job.conclusion,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          failedStep: job.failedStep ?? existing.failedStep,
        });
      } else if (state === existing.state && job.completedAt && existing.completedAt) {
        existing.completedAt = latestIso(existing.completedAt, job.completedAt);
        existing.startedAt = earliestIso(existing.startedAt, job.startedAt);
      }
    }
    // Like GitHub's checks list: what needs attention first, then alphabetical.
    group.jobs.sort(
      (a, b) => STATUS_ORDER[b.state] - STATUS_ORDER[a.state] || a.name.localeCompare(b.name),
    );
  }
  return [...groups.values()];
}

function jobLine(job: JobLine, emoji: FeedEmoji, multiBranch: boolean, now: number): string {
  const name = escapeDiscord(job.name);
  const started = time(job.startedAt);
  const took =
    started !== null && time(job.completedAt) !== null
      ? duration(time(job.completedAt)! - started)
      : null;
  switch (job.state) {
    case "running":
      // Clamp runner clock skew so a timer never reads "in a few seconds".
      return `${emoji.running} ${name}${started !== null ? ` · started ${relative(Math.min(started, now))}` : ""}`;
    case "queued":
      return `${emoji.queued} ${name} · ${job.conclusion === "action_required" ? "needs approval" : "queued"}`;
    case "success":
      return `${emoji.success} ${name}${took ? ` · ${took}` : ""}`;
    case "failure": {
      const where = job.failedStep ? ` at **${escapeDiscord(job.failedStep)}**` : "";
      const branch = multiBranch && job.branches.length ? ` on ${job.branches.join(", ")}` : "";
      const reason = job.conclusion === "timed_out" ? "timed out" : "failed";
      return `${emoji.failure} ${name} · ${reason}${where}${branch}${took ? ` · ${took}` : ""}`;
    }
    default:
      return `${emoji.skipped} ${name} · ${job.conclusion === "cancelled" ? "cancelled" : "skipped"}`;
  }
}

const countFailed = (jobs: JobLine[]) => jobs.filter((job) => job.state === "failure").length;

// ---------------------------------------------------------------------------
// Comments, reviews, issues and discussions: posted once.

export function renderNote(note: NoteItem): Card {
  const body = note.body ? excerpt(note.body, 350, 6, note.repoUrl) : "";
  return {
    embed: {
      title: truncate(note.title, 256),
      url: note.url,
      color: note.color,
      ...(body ? { description: body } : {}),
      author: author(note.actor),
      footer: { text: note.repo },
      ...(validTime(note.at) ? { timestamp: note.at } : {}),
    },
    button: { label: note.button, url: note.url },
  };
}

// ---------------------------------------------------------------------------

/** First paragraphs of GitHub markdown, without quotes, code fences or images. */
export function excerpt(
  markdown: string,
  maximum: number,
  maxLines: number,
  repoUrl: string,
): string {
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/g, "")
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
  const converted = githubToDiscord(text, maximum * 2);
  const lines = converted
    .split("\n")
    .filter((line, index, all) => line.trim() || all[index - 1]?.trim());
  return linkReferences(truncate(lines.slice(0, maxLines).join("\n"), maximum), repoUrl);
}

const linkIssues = (text: string, repoUrl: string) => linkReferences(escapeDiscord(text), repoUrl);

/** Discord does not autolink `#123`; GitHub redirects /issues/N to a PR when needed. */
function linkReferences(text: string, repoUrl: string): string {
  return text.replace(
    /(^|[\s(])#(\d+)\b/g,
    (_, lead: string, number: string) => `${lead}[#${number}](${repoUrl}/issues/${number})`,
  );
}

const escapeCode = (value: string) => value.replaceAll("`", "ˋ");

function author(actor: Actor): Embed["author"] {
  return {
    name: actor.login,
    ...(actor.avatar ? { icon_url: actor.avatar } : {}),
    ...(actor.url ? { url: actor.url } : {}),
  };
}

const validTime = (value: string | undefined): value is string =>
  Boolean(value && !Number.isNaN(Date.parse(value)));

function time(value: string | undefined): number | null {
  return validTime(value) ? Date.parse(value) : null;
}

const relative = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

function earliest(values: Array<string | undefined>): number | null {
  const times = values.map(time).filter((value): value is number => value !== null);
  return times.length ? Math.min(...times) : null;
}

function latest(values: Array<string | undefined>): number | null {
  const times = values.map(time).filter((value): value is number => value !== null);
  return times.length ? Math.max(...times) : null;
}

const earliestIso = (a: string | undefined, b: string | undefined) =>
  (time(a) ?? Infinity) <= (time(b) ?? Infinity) ? a : b;
const latestIso = (a: string, b: string) => ((time(a) ?? 0) >= (time(b) ?? 0) ? a : b);

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
