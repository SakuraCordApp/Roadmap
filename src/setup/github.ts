import { AGENT_LABELS, AREAS, PRIORITIES, STATUSES, areaLabel, priorityLabel } from "../config";
import type { Env } from "../env";
import { GitHub } from "../github/client";
import type { GhLabel } from "../github/types";

const RETIRED_LABELS = ["bug", "enhancement", "duplicate", "invalid", "question", "wontfix"];

export function desiredLabels(): Array<Required<Pick<GhLabel, "name" | "color" | "description">>> {
  return [
    ...STATUSES.filter((status) => status.githubLabel).map((status) => ({
      name: status.githubLabel!,
      color: status.color.toLowerCase(),
      description: status.description,
    })),
    ...AREAS.map((area) => ({
      name: areaLabel(area.id),
      color: area.color.toLowerCase(),
      description: `${area.label}: ${area.description}`.slice(0, 100),
    })),
    ...PRIORITIES.map((priority) => ({
      name: priorityLabel(priority.id),
      color: priority.color.toLowerCase(),
      description: priority.description,
    })),
    ...Object.values(AGENT_LABELS).map((label) => ({
      name: label.name,
      color: label.color.toLowerCase(),
      description: label.description,
    })),
  ];
}

export async function setupGithub(env: Env) {
  const github = new GitHub(env);
  const existing = await github.list<GhLabel>(github.repo("/labels"));
  const byName = new Map(existing.map((label) => [label.name.toLowerCase(), label]));
  const report = { created: [] as string[], updated: [] as string[], removed: [] as string[] };
  for (const label of desiredLabels()) {
    const current = byName.get(label.name.toLowerCase());
    if (!current) {
      await github.request("POST", github.repo("/labels"), label);
      report.created.push(label.name);
    } else if (current.color !== label.color || current.description !== label.description) {
      await github.request("PATCH", github.repo(`/labels/${encodeURIComponent(current.name)}`), {
        new_name: label.name,
        color: label.color,
        description: label.description,
      });
      report.updated.push(label.name);
    }
  }
  for (const name of RETIRED_LABELS) {
    if (byName.has(name)) {
      await github.request(
        "DELETE",
        github.repo(`/labels/${encodeURIComponent(byName.get(name)!.name)}`),
      );
      report.removed.push(name);
    }
  }
  return report;
}
