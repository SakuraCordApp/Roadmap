import { describe, expect, it } from "vitest";
import {
  CreateRoadmapItemSchema,
  ProgressSchema,
  RoadmapItemSchema,
  RoadmapPatchSchema,
} from "./schema.js";

describe("strict roadmap schemas", () => {
  it("rejects evidence-free non-manual progress", () => {
    const result = ProgressSchema.safeParse({
      value: 50,
      basis: "tests",
      evidence: [],
      assessedAt: "2026-07-24T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects manual progress without a rationale", () => {
    const result = ProgressSchema.safeParse({
      value: 50,
      basis: "manual",
      evidence: [],
      assessedAt: "2026-07-24T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed Discord snowflakes and unstable IDs", () => {
    const result = RoadmapItemSchema.safeParse({
      id: "not-stable",
      linkedDiscordThreads: [{ threadId: "42" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields and does not synthesize omitted patch defaults", () => {
    expect(RoadmapPatchSchema.safeParse({ unexpected: true }).success).toBe(false);
    const parsed = RoadmapPatchSchema.parse({ description: "Only this changes." });
    expect(parsed).toEqual({ description: "Only this changes." });
  });

  it("accepts classification labels without synthesizing them into unrelated patches", () => {
    const created = CreateRoadmapItemSchema.parse({
      title: "Rounded tag icons",
      description: "Use the SakuraCord gradient for Discord forum tag icons.",
      type: "feature",
      area: "visual",
      status: "inbox",
      priority: "low",
      difficulty: "small",
      labels: ["visual"],
    });
    expect(created.labels).toEqual(["visual"]);
    expect(RoadmapPatchSchema.parse({ priority: "high" })).toEqual({ priority: "high" });
  });
});
