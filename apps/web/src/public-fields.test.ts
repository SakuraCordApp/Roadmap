import { describe, expect, it } from "vitest";
import type { RoadmapItem } from "@roadmap/core";
import {
  filterPublicRoadmapItems,
  kindLabel,
  priorityLabel,
  publicKind,
  publicPriority,
} from "./public-fields.js";

describe("public roadmap fields", () => {
  it("shows high as a distinct priority below critical", () => {
    expect(publicPriority("high")).toBe("high");
    expect(priorityLabel("high")).toBe("High");
    expect(priorityLabel("medium")).toBe("Medium");
    expect(priorityLabel("low")).toBe("Low");
  });

  it("separates new features from bugs", () => {
    expect(publicKind("feature")).toBe("feature");
    expect(kindLabel("feature")).toBe("New Feature");
    expect(publicKind("bug")).toBe("bug");
    expect(kindLabel("bug")).toBe("Bug");
  });

  it("searches only the public feature text and filters by public fields", () => {
    const feature = {
      title: "Compact server rail",
      description: "Tighten the visual hierarchy.",
      type: "feature",
      priority: "low",
    } as RoadmapItem;
    const bug = {
      title: "Native notifications",
      description: "Open the correct conversation.",
      type: "bug",
      priority: "high",
    } as RoadmapItem;

    expect(filterPublicRoadmapItems([feature, bug], "conversation", "", "", "")).toEqual([bug]);
    expect(filterPublicRoadmapItems([feature, bug], "", "high", "bug", "")).toEqual([bug]);
  });

  it("filters by the published roadmap status", () => {
    const planned = { title: "Planned", status: "planned" } as RoadmapItem;
    const done = { title: "Done", status: "done" } as RoadmapItem;

    expect(filterPublicRoadmapItems([planned, done], "", "", "", "done")).toEqual([done]);
  });
});
