import { REPOSITORY } from "../config";
import { primaryThread } from "../db/store";
import { agentCard, type WorkflowJob } from "../discord/agent-card";
import { DiscordError, withWritableThread } from "../discord/rest";
import { discordClient } from "../discord/threads";
import type { Env } from "../env";
import {
  identifyAgentRun,
  type AgentKind,
  type AgentRun,
  type WorkflowRun,
} from "../github/agent-runs";
import { GitHub } from "../github/client";
import { enqueue, enqueueMany } from "../jobs/queue";
import { sha256 } from "../util/crypto";
import { nowIso } from "../util/text";

interface RunRow {
  issue_number: number;
  kind: AgentKind;
  run_id: number;
  attempt: number;
  thread_id: string | null;
  message_id: string | null;
  content_hash: string | null;
  result_text: string | null;
}

/** Preserve the message across reruns; late events cannot replace a newer run. */
export async function trackAgentRun(env: Env, run: AgentRun, result?: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_runs(issue_number,kind,run_id,attempt) VALUES(?,?,?,?)
     ON CONFLICT(issue_number,kind) DO UPDATE SET
       run_id=excluded.run_id,attempt=excluded.attempt,active=1,
       result_text=CASE WHEN agent_runs.run_id=excluded.run_id AND agent_runs.attempt=excluded.attempt
                        THEN agent_runs.result_text ELSE NULL END
     WHERE excluded.run_id>agent_runs.run_id
        OR (excluded.run_id=agent_runs.run_id AND excluded.attempt>=agent_runs.attempt)`,
  )
    .bind(run.number, run.kind, run.runId, run.attempt)
    .run();
  if (result !== undefined) {
    await env.DB.prepare(
      `UPDATE agent_runs SET result_text=? WHERE issue_number=? AND kind=? AND run_id=? AND attempt=?`,
    )
      .bind(result, run.number, run.kind, run.runId, run.attempt)
      .run();
  }
  await enqueue(env, "agent-status", `${run.number}:${run.kind}`, {
    number: run.number,
    kind: run.kind,
  });
}

/** One bounded batch per cron tick; completed runs stop polling. */
export async function pollAgentRuns(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT issue_number,kind FROM agent_runs WHERE active=1 ORDER BY checked_at LIMIT 20`,
  ).all<Pick<RunRow, "issue_number" | "kind">>();
  if (results.length)
    await enqueueMany(
      env,
      results.map((row) => ({
        kind: "agent-status",
        key: `${row.issue_number}:${row.kind}`,
        payload: { number: row.issue_number, kind: row.kind },
      })),
    );
  return results.map((row) => ({ number: row.issue_number, kind: row.kind }));
}

export async function syncAgentStatus(
  env: Env,
  payload: { number: number; kind: AgentKind },
): Promise<void> {
  const row = await env.DB.prepare("SELECT * FROM agent_runs WHERE issue_number=? AND kind=?")
    .bind(payload.number, payload.kind)
    .first<RunRow>();
  if (!row) return;
  const github = new GitHub(env);
  const run = await github.request<WorkflowRun>("GET", github.repo(`/actions/runs/${row.run_id}`));
  const identity = identifyAgentRun(run);
  if (!identity || identity.number !== row.issue_number || identity.kind !== row.kind) {
    throw new Error("Agent workflow does not match the report");
  }
  if (run.run_attempt < row.attempt) throw new Error("Agent run attempt is not available yet");
  if (run.run_attempt > row.attempt) {
    await trackAgentRun(env, identity);
    return;
  }
  const { jobs } = await github.request<{ jobs: WorkflowJob[] }>(
    "GET",
    github.repo(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`),
  );
  let pull: { number: number; html_url: string } | undefined;
  if (row.kind === "fix" && run.conclusion === "success") {
    const pulls = await github.request<
      Array<{ number: number; html_url: string; updated_at: string }>
    >(
      "GET",
      github.repo(
        `/pulls?state=all&head=${REPOSITORY.owner}:agent/issue-${row.issue_number}&per_page=10`,
      ),
    );
    pull = pulls.find((p) => Date.parse(p.updated_at) >= Date.parse(run.run_started_at));
  }
  const thread = await primaryThread(env.DB, row.issue_number);
  if (!thread) {
    await enqueue(env, "sync-issue", String(row.issue_number), { number: row.issue_number });
    throw new Error("Waiting for the report's Discord thread");
  }
  // Webhooks may arrive while the API requests above are in flight.
  const latest = await env.DB.prepare("SELECT * FROM agent_runs WHERE issue_number=? AND kind=?")
    .bind(row.issue_number, row.kind)
    .first<RunRow>();
  if (!latest || latest.run_id !== row.run_id || latest.attempt !== row.attempt) return;
  const card = agentCard(row.kind, run, jobs, latest.result_text, pull);
  const hash = await sha256(JSON.stringify(card));
  let messageId = latest.thread_id === thread.threadId ? latest.message_id : null;
  const discord = discordClient(env);
  if (messageId && latest.content_hash !== hash) {
    try {
      await withWritableThread(discord, thread.threadId, () =>
        discord.patch(`/channels/${thread.threadId}/messages/${messageId}`, card),
      );
    } catch (error) {
      if (!(error instanceof DiscordError) || error.code !== 10008) throw error;
      messageId = null;
    }
  }
  if (!messageId) {
    const posted = await withWritableThread(discord, thread.threadId, () =>
      discord.post<{ id: string }>(`/channels/${thread.threadId}/messages`, card, {
        nonceKey: `agent:${row.issue_number}:${row.kind}:${thread.threadId}:${latest.message_id ?? "first"}`,
      }),
    );
    messageId = posted.id;
  }
  // Persist the delivered message even if a new run arrived while Discord was writing.
  // The keyed job reruns afterwards and replaces its contents with that newer run.
  await env.DB.prepare(
    `UPDATE agent_runs SET thread_id=?,message_id=?,content_hash=?,checked_at=?,
       active=CASE WHEN run_id=? AND attempt=? THEN ? ELSE active END
     WHERE issue_number=? AND kind=?`,
  )
    .bind(
      thread.threadId,
      messageId,
      hash,
      nowIso(),
      run.id,
      run.run_attempt,
      run.status === "completed" ? 0 : 1,
      row.issue_number,
      row.kind,
    )
    .run();
}
