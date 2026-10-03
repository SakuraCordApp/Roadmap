import { BRAND, REPOSITORY_URL } from "../config";
import type { AgentKind, WorkflowRun } from "../github/agent-runs";
import { escapeDiscord, truncate } from "../util/text";
import { COMPONENTS_V2 } from "./cards";
import { noMentions } from "./rest";

export interface WorkflowJob {
  status: string;
  conclusion: string | null;
  steps?: Array<{ name: string; status: string; conclusion: string | null }>;
}

export function agentCard(
  kind: AgentKind,
  run: WorkflowRun,
  jobs: WorkflowJob[],
  result: string | null,
  pull?: { number: number; html_url: string },
) {
  const done = run.status === "completed";
  const success = done && run.conclusion === "success";
  const current = jobs.flatMap((job) => job.steps ?? []).find((s) => s.status === "in_progress");
  let status: string;
  if (done) {
    status =
      {
        success: "✅ Completed",
        failure: "❌ Failed",
        cancelled: "⏹️ Cancelled",
        timed_out: "⌛ Timed out",
        skipped: "Skipped",
        neutral: "Finished",
        action_required: "⚠️ Action required",
        stale: "Stopped",
      }[run.conclusion ?? ""] ?? "Stopped";
  } else if (current) {
    status = `⏳ ${escapeDiscord(current.name)}`;
  } else {
    status = jobs.some((job) => job.status === "in_progress")
      ? "⏳ Running"
      : "🕓 Queued — waiting for a runner";
  }
  const started = Math.floor(Date.parse(run.run_started_at) / 1000);
  const blocks: unknown[] = [
    {
      type: 10,
      content: `### ${kind === "investigate" ? "🔎 Triage & investigation" : "🛠️ Fix agent"}\n**${status}**`,
    },
  ];
  if (result) blocks.push({ type: 10, content: truncate(result, 2600) });
  if (success && pull)
    blocks.push({ type: 10, content: `Draft fix: [PR #${pull.number}](${pull.html_url})` });
  if (Number.isFinite(started))
    blocks.push({ type: 10, content: `-# Started <t:${started}:R> · Attempt ${run.run_attempt}` });
  blocks.push({
    type: 1,
    components: [
      {
        type: 2,
        style: 5,
        label: "View run",
        url: `${REPOSITORY_URL}/actions/runs/${run.id}/attempts/${run.run_attempt}`,
      },
    ],
  });
  return {
    flags: COMPONENTS_V2,
    allowed_mentions: noMentions,
    components: [
      {
        type: 17,
        accent_color: done ? (success ? 0x57f287 : 0xed4245) : BRAND.primary,
        components: blocks,
      },
    ],
  };
}
