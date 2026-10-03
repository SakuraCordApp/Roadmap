export type AgentKind = "investigate" | "fix";

export interface AgentRun {
  number: number;
  kind: AgentKind;
  runId: number;
  attempt: number;
}

export interface WorkflowRun {
  id: number;
  run_attempt: number;
  path: string;
  event: string;
  display_title: string;
  status: string;
  conclusion: string | null;
  run_started_at: string;
}

/** Only the issue agents' explicit run names identify a report, never its title. */
export function identifyAgentRun(run: WorkflowRun): AgentRun | null {
  const match = /^Agent · (Triage|Fix) · #([1-9]\d*)$/.exec(run.display_title ?? "");
  if (!match || run.event !== "issues") return null;
  const kind = match[1] === "Triage" ? "investigate" : "fix";
  if (run.path !== `.github/workflows/agent-${kind}.yml`) return null;
  const number = Number(match[2]);
  if (![number, run.id, run.run_attempt].every((n) => Number.isSafeInteger(n) && n > 0))
    return null;
  return { number, kind, runId: run.id, attempt: run.run_attempt };
}

/** This marker is accepted only on an Actions-authored issue comment. */
export function commentAgentRun(body: string, number: number): AgentRun | null {
  const match = /<!-- sakuracord:agent-run (investigate|fix) (\d+) (\d+) -->/.exec(body);
  if (!match) return null;
  const runId = Number(match[2]);
  const attempt = Number(match[3]);
  if (![runId, attempt].every((n) => Number.isSafeInteger(n) && n > 0)) return null;
  return { number, kind: match[1] as AgentKind, runId, attempt };
}
