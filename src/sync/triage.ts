import { issueEmbeddingText, similarTo } from "../ai/embeddings";
import { triageIssue, type TriageCandidate } from "../ai/triage";
import { AGENT_LABELS, ISSUE_TYPES, areaLabel, priorityLabel } from "../config";
import { getIssue, patchIssue, primaryThread } from "../db/store";
import { issueUrl, threadUrl } from "../discord/cards";
import { noMentions } from "../discord/rest";
import { postInThread } from "../discord/threads";
import type { Env } from "../env";
import { GitHub } from "../github/client";
import { appBotLogin } from "../github/identity";
import { labelNames, type GhIssue } from "../github/types";
import { enqueue } from "../jobs/queue";
import { statusGithubLabel } from "../lifecycle";
import { DISCORD } from "../config";
import { valuesFromBody } from "../report/body";
import { NO_MIRROR } from "./markers";
import { escapeDiscord, nowIso, truncate } from "../util/text";

const DUPLICATE_CONFIDENCE = 0.75;

export async function runTriage(env: Env, payload: { number: number }): Promise<void> {
  const issue = await getIssue(env.DB, payload.number);
  if (!issue || issue.state !== "open" || issue.status !== "new" || issue.triagedAt) return;

  const similar = await similarTo(env, issueEmbeddingText(issue), {
    topK: 8,
    exclude: issue.number,
  }).catch(() => []);
  const candidates: TriageCandidate[] = [];
  for (const match of similar) {
    const record = await getIssue(env.DB, match.number);
    if (record) {
      candidates.push({
        number: record.number,
        title: record.title,
        summary: record.summary,
        status: record.status,
        kind: record.kind,
        score: match.score,
      });
    }
  }
  const result = await triageIssue(env, issue, candidates);
  await patchIssue(env.DB, issue.number, {
    summary: result.summary,
    triage: result,
    triagedAt: nowIso(),
  });

  const github = new GitHub(env);
  const current = await github.request<GhIssue>("GET", github.repo(`/issues/${issue.number}`));
  if (current.state !== "open") return;
  const labels = new Set(labelNames(current));
  if (![...labels].some((name) => name.startsWith("area: "))) {
    const chosen = valuesFromBody(result.kind, issue.body).area;
    labels.add(areaLabel(chosen ?? result.area));
  }
  for (const name of [...labels]) if (name.startsWith("priority: ")) labels.delete(name);
  labels.add(priorityLabel(result.priority));

  const duplicate =
    result.duplicateOf && result.duplicateConfidence >= DUPLICATE_CONFIDENCE
      ? result.duplicateOf
      : null;
  const askQuestions = result.needsInformation && result.kind === "bug" && !duplicate;
  if (askQuestions) {
    labels.delete(statusGithubLabel("new")!);
    labels.add(statusGithubLabel("needs_info")!);
  }
  if (result.kind === "bug" && !askQuestions && !duplicate && env.OPENAI_API_KEY) {
    labels.add(AGENT_LABELS.investigate.name);
  }

  const bot = await appBotLogin(env);
  const filedByHub = Boolean(bot && current.user?.login === bot);
  const patch: Record<string, unknown> = { labels: [...labels] };
  if (current.type?.name !== ISSUE_TYPES[result.kind].githubType) {
    patch.type = ISSUE_TYPES[result.kind].githubType;
  }
  if (filedByHub && result.title && result.title !== current.title) patch.title = result.title;
  await github.request("PATCH", github.repo(`/issues/${issue.number}`), patch);

  if (askQuestions) {
    const mention =
      issue.reporter?.githubLogin && issue.reporter.source === "github"
        ? `@${issue.reporter.githubLogin} `
        : "";
    await github.request("POST", github.repo(`/issues/${issue.number}/comments`), {
      body: `${NO_MIRROR}\n${mention}Thanks for the report! A few details would help us look into it:\n\n${result.questions
        .map((question) => `- ${question}`)
        .join("\n")}`,
    });
  }

  if (duplicate) {
    const target = await getIssue(env.DB, duplicate);
    const targetThread = await primaryThread(env.DB, duplicate);
    await github.request("POST", github.repo(`/issues/${issue.number}/comments`), {
      body: `${NO_MIRROR}\n🤖 This looks like a possible duplicate of #${duplicate}. ${result.duplicateReason}\n\nMaintainers: close this as a duplicate of #${duplicate} if that's right — followers move over automatically.`,
    });
    const thread = await primaryThread(env.DB, issue.number);
    if (thread && target) {
      await postInThread(
        env,
        thread.threadId,
        {
          content: `🤖 **This might already be reported:** [#${duplicate} — ${escapeDiscord(truncate(target.title, 120))}](${
            targetThread ? threadUrl(DISCORD.guildId, targetThread.threadId) : issueUrl(duplicate)
          })\n-# If it's the same issue, press 👍 **Me too** there. A maintainer will merge the two.`,
          allowed_mentions: noMentions,
          flags: 1 << 2,
        },
        { nonceKey: `dup-suggest:${issue.number}:${duplicate}` },
      );
    }
  }
  await enqueue(env, "sync-issue", String(issue.number), { number: issue.number });
}
