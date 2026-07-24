import type { RoadmapConfig } from "@roadmap/core";

export function aiResponseModelOptions(config: RoadmapConfig): {
  model: string;
  reasoning: { effort: RoadmapConfig["releases"]["reasoningEffort"] };
} {
  return {
    model: config.releases.aiModel,
    reasoning: { effort: config.releases.reasoningEffort },
  };
}
