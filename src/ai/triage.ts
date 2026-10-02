import { z } from "zod";
import { AREAS, PRIORITIES } from "../config";
import type { GhComment } from "../github/types";

// The Actions agent publishes a validated result in its own GitHub comment.
// User-authored markers must never be allowed to change report metadata.
export const TRIAGE_MARKER = "<!-- sakuracord:triage-result ";
const resultSchema = z.object({
  version: z.literal(1),
  number: z.number().int().positive(),
  sourceTitle: z.string().max(256),
  bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  candidates: z.array(z.number().int().positive()).max(12),
  model: z.string().min(1).max(100),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  triage: z.object({
    kind: z.enum(["bug", "feature"]),
    area: z.string().refine((id) => AREAS.some((area) => area.id === id)),
    priority: z.string().refine((id) => PRIORITIES.some((priority) => priority.id === id)),
    title: z.string().min(4).max(100),
    summary: z.string().min(1).max(240),
    duplicateOf: z.number().int().positive().nullable(),
    duplicateConfidence: z.number().min(0).max(1),
    duplicateReason: z.string().max(400),
    needsInformation: z.boolean(),
    questions: z.array(z.string().min(1).max(300)).max(3),
    resolution: z
      .object({
        state: z.enum([
          "unresolved",
          "possible_regression",
          "fixed_unreleased",
          "fixed_nightly",
          "fixed_regular",
        ]),
        commit: z
          .string()
          .regex(/^[a-f0-9]{40}$/)
          .nullable(),
        releaseTag: z.string().max(100).nullable(),
        explanation: z.string().max(1000),
      })
      .optional(),
  }),
});

export function parseTriageResult(comment: Pick<GhComment, "body" | "user">, number: number) {
  if (comment.user?.login !== "github-actions[bot]" || comment.user.type !== "Bot") return null;
  const start = comment.body.indexOf(TRIAGE_MARKER);
  if (start < 0) return null;
  const end = comment.body.indexOf(" -->", start);
  if (end < 0) return null;
  try {
    const parsed = resultSchema.parse(
      JSON.parse(comment.body.slice(start + TRIAGE_MARKER.length, end)),
    );
    if (parsed.number !== number) return null;
    if (
      parsed.triage.duplicateOf &&
      (!parsed.candidates.includes(parsed.triage.duplicateOf) ||
        parsed.triage.duplicateOf === number)
    )
      return null;
    if (parsed.triage.needsInformation && !parsed.triage.questions.length) return null;
    return parsed;
  } catch {
    return null;
  }
}
