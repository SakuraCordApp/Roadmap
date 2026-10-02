import { describe, expect, it } from "vitest";
import { deriveStatus, planLabels, referencedIssues } from "../src/lifecycle";

const issue = (overrides: Record<string, unknown> = {}) => ({
  state: "open" as const,
  state_reason: null,
  labels: [] as Array<{ name: string }>,
  milestone: null as null | { number: number },
  ...overrides,
});
const labels = (...names: string[]) => names.map((name) => ({ name }));

describe("deriveStatus", () => {
  it("defaults open issues without a status label to new", () => {
    expect(deriveStatus(issue())).toBe("new");
  });
  it("prefers the most advanced open status", () => {
    expect(deriveStatus(issue({ labels: labels("status: confirmed", "status: in nightly") }))).toBe(
      "in_nightly",
    );
  });
  it("maps close reasons", () => {
    expect(deriveStatus(issue({ state: "closed", state_reason: "duplicate" }))).toBe("duplicate");
    expect(deriveStatus(issue({ state: "closed", state_reason: "not_planned" }))).toBe("declined");
    expect(
      deriveStatus(
        issue({
          state: "closed",
          state_reason: "not_planned",
          labels: labels("status: can't reproduce"),
        }),
      ),
    ).toBe("cant_reproduce");
    expect(deriveStatus(issue({ state: "closed", state_reason: "completed" }))).toBe("done");
    expect(
      deriveStatus(
        issue({ state: "closed", state_reason: "completed", labels: labels("status: shipped") }),
      ),
    ).toBe("shipped");
  });
});

describe("planLabels", () => {
  it("adds status: new to unlabelled open issues", () => {
    expect(planLabels(issue())).toEqual({ add: ["status: new"], remove: [] });
  });
  it("keeps the label a person just added and drops the others", () => {
    const plan = planLabels(issue({ labels: labels("status: new", "status: confirmed") }), {
      addedLabel: "status: confirmed",
    });
    expect(plan).toEqual({ add: [], remove: ["status: new"] });
  });
  it("turns confirmed into planned when a milestone is set, and back", () => {
    expect(
      planLabels(issue({ labels: labels("status: confirmed"), milestone: { number: 3 } })),
    ).toEqual({
      add: ["status: planned"],
      remove: ["status: confirmed"],
    });
    expect(planLabels(issue({ labels: labels("status: planned") }))).toEqual({
      add: ["status: confirmed"],
      remove: ["status: planned"],
    });
  });
  it("clears open statuses on close and labels declined issues", () => {
    expect(
      planLabels(
        issue({
          state: "closed",
          state_reason: "not_planned",
          labels: labels("status: confirmed"),
        }),
      ),
    ).toEqual({ add: ["status: declined"], remove: ["status: confirmed"] });
  });
  it("reopened issues come back as confirmed", () => {
    expect(planLabels(issue({ labels: labels("status: shipped") }), { reopened: true })).toEqual({
      add: ["status: confirmed"],
      remove: ["status: shipped"],
    });
  });
  it("keeps a single area and priority", () => {
    const plan = planLabels(
      issue({ labels: labels("status: new", "area: chat", "area: servers", "priority: low") }),
      { addedLabel: "area: chat" },
    );
    expect(plan.remove).toEqual(["area: servers"]);
  });
});

describe("referencedIssues", () => {
  it("finds GitHub closing keywords", () => {
    expect(
      referencedIssues(
        "Fix thread images\n\nFixes #12, closes #13 and resolves SakuraCordApp/SakuraCord#14",
      ),
    ).toEqual([12, 13, 14]);
    expect(referencedIssues("Mentions #15 without a keyword")).toEqual([]);
  });
});
