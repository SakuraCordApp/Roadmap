import { describe, expect, it } from "vitest";
import roadmapConfig from "../roadmap.config.js";
import {
  auditNavigationTargets,
  buildPrimaryNavigation,
  knownBrokenNavigationTargets,
} from "../apps/web/src/navigation.js";

describe("SakuraCord public navigation configuration", () => {
  it("publishes only the deliberately small roadmap taxonomy", () => {
    expect(roadmapConfig.priorities.map(({ id }) => id)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
    ]);
    expect(roadmapConfig.itemTypes.map(({ id }) => id)).toEqual(["feature", "bug"]);
    expect(roadmapConfig.publicSections.map(({ id }) => id)).toEqual([
      "planned",
      "in_progress",
      "polishing",
      "recently_done",
    ]);
  });

  it("publishes the verified repository without advertising a docs page", () => {
    expect(roadmapConfig.project.documentationUrl).toBeUndefined();
    expect(roadmapConfig.project.contributionUrl).toBe(
      "https://github.com/SakuraCordApp/SakuraCord",
    );
    expect(buildPrimaryNavigation(roadmapConfig, "overview").map(({ label }) => label)).toEqual([
      "Browse",
      "Source code",
    ]);
  });

  it("contains no self-links, placeholders, or known broken targets", () => {
    const links = buildPrimaryNavigation(roadmapConfig, "overview");
    expect(auditNavigationTargets(roadmapConfig, "overview")).toEqual([]);
    expect(links.some((link) => knownBrokenNavigationTargets.has(link.href))).toBe(false);
    expect(links.some((link) => link.href.includes("example.com") || link.href === "/")).toBe(
      false,
    );
  });
});
