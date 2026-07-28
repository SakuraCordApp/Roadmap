import { describe, expect, it } from "vitest";
import {
  CreateRoadmapItemSchema,
  EvidenceReferenceSchema,
  RoadmapItemSchema,
  RoadmapPatchSchema,
} from "./schema.js";

describe("strict roadmap schemas", () => {
  it("rejects removed planning fields instead of silently retaining them", () => {
    const base = {
      title: "Streamlined report",
      description: "Only report-supported fields belong in canonical data.",
      type: "bug",
      area: "visual",
      status: "planned",
      priority: "low",
    };
    for (const field of [
      "difficulty",
      "confidence",
      "progress",
      "proposedImplementation",
      "affectedComponents",
      "dependencies",
      "risks",
      "requiredResearch",
      "verificationResults",
      "benchmarks",
      "relatedCommits",
      "relatedPullRequests",
      "milestone",
      "communityReactionCount",
      "duplicateReportCount",
    ]) {
      expect(CreateRoadmapItemSchema.safeParse({ ...base, [field]: "legacy" }).success).toBe(false);
    }
  });

  it("rejects malformed Discord snowflakes and unstable IDs", () => {
    const result = RoadmapItemSchema.safeParse({
      id: "not-stable",
      linkedDiscordThreads: [{ threadId: "42" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts only HTTP(S) links in user-visible evidence", () => {
    const reference = { kind: "manual", label: "Report attachment" } as const;
    expect(
      EvidenceReferenceSchema.safeParse({ ...reference, url: "https://example.com/report" })
        .success,
    ).toBe(true);
    expect(
      EvidenceReferenceSchema.safeParse({ ...reference, url: "javascript:alert(1)" }).success,
    ).toBe(false);
    expect(
      EvidenceReferenceSchema.safeParse({ ...reference, url: "data:text/html,unsafe" }).success,
    ).toBe(false);
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
      labels: ["visual"],
    });
    expect(created.labels).toEqual(["visual"]);
    expect(RoadmapPatchSchema.parse({ priority: "high" })).toEqual({ priority: "high" });
  });
});
