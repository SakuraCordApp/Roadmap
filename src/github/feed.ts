import { DISCORD } from "../config";
import { discordClient } from "../discord/threads";
import type { Env } from "../env";

// GitHub activity cards for the Discord updates channel (formerly the separate
// DiscordBot Worker). Bot-generated issue traffic is filtered out so issue sync
// and migrations never flood the channel.

type JsonObject = Record<string, unknown>;
const MAX_COMMITS = 45;

export const FEED_EVENTS = new Set([
  "push",
  "create",
  "delete",
  "workflow_run",
  "pull_request",
  "pull_request_review",
  "issues",
  "issue_comment",
  "discussion",
  "discussion_comment",
  "deployment_status",
]);

interface Embed {
  title: string;
  description?: string;
  url?: string;
  color: number;
  timestamp?: string;
  author?: { name: string; icon_url?: string; url?: string };
  footer: { text: string };
}

export interface FeedUpdate {
  embed: Embed;
  button?: { label: string; url: string };
}

/** Decide whether a webhook belongs in the feed at all. */
export function feedWorthy(event: string, payload: JsonObject, botLogin: string | null): boolean {
  if (!FEED_EVENTS.has(event)) return false;
  const sender = asObject(payload.sender);
  const login = str(sender.login);
  if (login && (login === botLogin || (str(sender.type) === "Bot" && event !== "workflow_run"))) {
    return false;
  }
  const action = str(payload.action);
  if (event === "issues") return ["opened", "closed", "reopened"].includes(action ?? "");
  if (event === "issue_comment" || event === "discussion_comment") return action === "created";
  if (event === "pull_request") {
    return ["opened", "closed", "reopened", "ready_for_review"].includes(action ?? "");
  }
  if (event === "pull_request_review") return action === "submitted";
  if (event === "workflow_run") return action === "completed";
  return true;
}

export function renderFeed(event: string, payload: JsonObject): FeedUpdate[] {
  const repository = asObject(payload.repository);
  const repositoryName = str(repository.full_name);
  const repositoryUrl = url(repository.html_url);
  if (!repositoryName || !repositoryUrl) return [];
  const sender = asObject(payload.sender);
  const author = str(sender.login)
    ? {
        name: str(sender.login)!,
        ...(url(sender.avatar_url) ? { icon_url: url(sender.avatar_url) } : {}),
        ...(url(sender.html_url) ? { url: url(sender.html_url) } : {}),
      }
    : undefined;
  const base = {
    color: colorFor(event, payload),
    ...(author ? { author } : {}),
    footer: { text: `${repositoryName} · ${event.replaceAll("_", " ")}` },
  };
  if (event === "push") return renderPush(payload, repositoryName, repositoryUrl, base);
  const detail = renderDetail(event, payload, repositoryUrl);
  return [
    {
      embed: {
        ...base,
        title: truncate(detail.title, 256),
        ...(detail.description ? { description: truncate(detail.description, 320) } : {}),
        ...(detail.url ? { url: detail.url } : {}),
        ...(validTimestamp(detail.timestamp) ? { timestamp: detail.timestamp } : {}),
      },
      ...(detail.url ? { button: { label: detail.buttonLabel, url: detail.url } } : {}),
    },
  ];
}

function renderPush(
  payload: JsonObject,
  repositoryName: string,
  repositoryUrl: string,
  base: Omit<Embed, "title">,
): FeedUpdate[] {
  const commits = array(payload.commits).map(asObject);
  const visible = commits.slice(0, MAX_COMMITS);
  const ref = str(payload.ref)?.replace(/^refs\/(heads|tags)\//, "") ?? "unknown";
  const refKind = str(payload.ref)?.startsWith("refs/tags/") ? "tag" : "branch";
  const pusher = str(asObject(payload.pusher).name) ?? "Someone";
  const compareUrl = url(payload.compare) ?? repositoryUrl;
  const omitted = commits.length - visible.length;
  if (!commits.length && !payload.deleted) return [];
  const summary: FeedUpdate = {
    embed: {
      ...base,
      title: truncate(
        payload.deleted
          ? `${capitalize(refKind)} deleted · ${ref}`
          : `Push · ${repositoryName}/${ref}`,
        256,
      ),
      description: payload.deleted
        ? `${pusher} deleted this ${refKind}.`
        : `${pusher} pushed ${commits.length} commit${commits.length === 1 ? "" : "s"}.${
            omitted > 0 ? ` ${omitted} additional commits are available in GitHub.` : ""
          }`,
      url: compareUrl,
      ...(validTimestamp(str(asObject(payload.head_commit).timestamp))
        ? { timestamp: str(asObject(payload.head_commit).timestamp) }
        : {}),
    },
    button: { label: "Compare changes", url: compareUrl },
  };
  return [
    summary,
    ...visible.map((commit) => {
      const sha = (str(commit.id) ?? "").slice(0, 7) || "unknown";
      const message = (str(commit.message) ?? "No commit message").split(/\r?\n/, 1)[0]!;
      const commitUrl = url(commit.url) ?? compareUrl;
      const commitAuthor =
        str(asObject(commit.author).username) ??
        str(asObject(commit.author).name) ??
        "Unknown author";
      return {
        embed: {
          ...base,
          title: `Commit · ${sha}`,
          description: truncate(message, 280),
          url: commitUrl,
          footer: { text: `${repositoryName}/${ref} · ${commitAuthor}` },
          ...(validTimestamp(str(commit.timestamp)) ? { timestamp: str(commit.timestamp) } : {}),
        },
        button: { label: "Open commit", url: commitUrl },
      };
    }),
  ];
}

function renderDetail(event: string, payload: JsonObject, repositoryUrl: string) {
  const action = (str(payload.action) ?? "updated").replaceAll("_", " ");
  if (event === "workflow_run") {
    const run = asObject(payload.workflow_run);
    return {
      title: `Action ${str(run.conclusion) ?? str(run.status) ?? action} · ${str(run.name) ?? "workflow"}`,
      description: `Run #${str(run.run_number) ?? "?"} · \`${str(run.head_branch) ?? "unknown"}\``,
      url: url(run.html_url),
      timestamp: str(run.updated_at),
      buttonLabel: "Open action",
    };
  }
  if (event === "pull_request") {
    const pull = asObject(payload.pull_request);
    const merged = action === "closed" && pull.merged === true;
    return {
      title: `PR ${merged ? "merged" : action} · #${str(pull.number) ?? "?"}`,
      description: str(pull.title),
      url: url(pull.html_url),
      timestamp: str(pull.updated_at),
      buttonLabel: "Open pull request",
    };
  }
  if (event === "pull_request_review") {
    const review = asObject(payload.review);
    const pull = asObject(payload.pull_request);
    return {
      title: `Review ${action} · #${str(pull.number) ?? "?"}`,
      description: `${str(pull.title) ?? "Pull request"} · ${str(review.state)?.toLowerCase() ?? "updated"}`,
      url: url(review.html_url) ?? url(pull.html_url),
      timestamp: str(review.submitted_at) ?? str(pull.updated_at),
      buttonLabel: "Open review",
    };
  }
  if (event === "issues") {
    const issue = asObject(payload.issue);
    return {
      title: `Issue ${action} · #${str(issue.number) ?? "?"}`,
      description: str(issue.title),
      url: url(issue.html_url),
      timestamp: str(issue.updated_at),
      buttonLabel: "Open issue",
    };
  }
  if (event === "issue_comment" || event === "discussion_comment") {
    const subject = asObject(payload.issue ?? payload.discussion);
    const comment = asObject(payload.comment);
    return {
      title: `${event === "issue_comment" ? "Issue" : "Discussion"} comment ${action}`,
      description: str(subject.title) ?? str(comment.body),
      url: url(comment.html_url) ?? url(subject.html_url),
      timestamp: str(comment.updated_at),
      buttonLabel: "Open comment",
    };
  }
  if (event === "discussion") {
    const discussion = asObject(payload.discussion);
    return {
      title: `Discussion ${action}`,
      description: str(discussion.title),
      url: url(discussion.html_url),
      timestamp: str(discussion.updated_at),
      buttonLabel: "Open discussion",
    };
  }
  if (event === "create" || event === "delete") {
    return {
      title: `${capitalize(str(payload.ref_type) ?? "ref")} ${event === "create" ? "created" : "deleted"} · ${str(payload.ref) ?? "unknown"}`,
      url: repositoryUrl,
      buttonLabel: "Open repository",
    };
  }
  if (event === "deployment_status") {
    const status = asObject(payload.deployment_status);
    return {
      title: `Deployment ${str(status.state) ?? action}`,
      description: str(status.environment) ?? str(asObject(payload.deployment).environment),
      url: url(status.environment_url) ?? url(status.log_url) ?? repositoryUrl,
      timestamp: str(status.updated_at),
      buttonLabel: "Open deployment",
    };
  }
  return {
    title: `${capitalize(event.replaceAll("_", " "))} ${action}`,
    description: "Repository activity",
    url: repositoryUrl,
    buttonLabel: "Open repository",
  };
}

export async function deliverFeed(env: Env, payload: { delivery: string; updates: FeedUpdate[] }) {
  const discord = discordClient(env);
  for (const [index, update] of payload.updates.entries()) {
    await discord.post(
      `/channels/${DISCORD.githubUpdatesChannelId}/messages`,
      {
        ...(index === 0 ? { content: `<@&${DISCORD.githubUpdatesRoleId}>` } : {}),
        embeds: [update.embed],
        ...(update.button
          ? {
              components: [
                {
                  type: 1,
                  components: [
                    { type: 2, style: 5, label: update.button.label, url: update.button.url },
                  ],
                },
              ],
            }
          : {}),
        allowed_mentions: { parse: [], roles: [DISCORD.githubUpdatesRoleId] },
      },
      { nonceKey: `github:${payload.delivery}:${index}` },
    );
  }
}

function colorFor(event: string, payload: JsonObject): number {
  if (event === "workflow_run") {
    const conclusion = str(asObject(payload.workflow_run).conclusion);
    if (conclusion === "success") return 0x2da44e;
    if (
      conclusion &&
      ["failure", "timed_out", "cancelled", "action_required"].includes(conclusion)
    ) {
      return 0xcf222e;
    }
    return 0xbf8700;
  }
  if (event === "deployment_status") {
    return str(asObject(payload.deployment_status).state) === "success" ? 0x2da44e : 0x0969da;
  }
  if (["issues", "pull_request", "pull_request_review"].includes(event)) return 0x1f6feb;
  return 0xd9578b;
}

const asObject = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : undefined;
const url = (value: unknown) => {
  const text = str(value);
  return text && /^https:\/\//.test(text) ? text : undefined;
};
const validTimestamp = (value: string | undefined): value is string =>
  Boolean(value && !Number.isNaN(Date.parse(value)));
const capitalize = (value: string) =>
  value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
const truncate = (value: string, maximum: number) =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
