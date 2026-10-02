import { describe, expect, it } from "vitest";
import { parseMilestone, renderMilestoneDescription, visibleVersions } from "../src/roadmap";
import { discordToGithub } from "../src/sync/comments";
import { feedWorthy } from "../src/github/feed";

describe("milestones", () => {
  const description = renderMilestoneDescription({
    headline: "Stay connected",
    summary: "A unified inbox.",
    highlights: [
      { text: "Inbox and friends", issues: [51, 52] },
      { text: "Smarter notifications", issues: [] },
    ],
  });
  it("round-trips the description convention", () => {
    const parsed = parseMilestone({
      number: 3,
      title: "0.1.7",
      description,
      state: "open",
      due_on: null,
      closed_at: null,
      open_issues: 4,
      closed_issues: 2,
      html_url: null,
    });
    expect(parsed.headline).toBe("Stay connected");
    expect(parsed.summary).toBe("A unified inbox.");
    expect(parsed.highlights).toEqual([
      { text: "Inbox and friends", issues: [51, 52] },
      { text: "Smarter notifications", issues: [] },
    ]);
  });
  it("shows only open milestones", () => {
    const make = (version: string, state: "open" | "closed") => ({
      number: 1,
      version,
      headline: version,
      summary: "",
      highlights: [],
      state,
      dueOn: null,
      closedAt: null,
      openIssues: 0,
      closedIssues: 0,
      url: null,
    });
    expect(
      visibleVersions([
        make("0.1.4", "closed"),
        make("0.1.5", "closed"),
        make("0.1.6", "open"),
        make("0.1.7", "open"),
      ]).map((v) => v.version),
    ).toEqual(["0.1.6", "0.1.7"]);
    expect(visibleVersions([make("0.1.5", "closed")])).toEqual([]);
  });
});

describe("discordToGithub", () => {
  it("resolves Discord markup without pinging GitHub users", () => {
    const text = discordToGithub({
      id: "1",
      type: 0,
      timestamp: "",
      author: { id: "2", username: "a" },
      content: "hey <@3> see <#4> <:sakura:5> @everyone",
      mentions: [{ id: "3", username: "octocat" }],
    });
    expect(text).toContain("@​octocat");
    expect(text).toContain(":sakura:");
    expect(text).not.toContain("<#4>");
  });
});

describe("feedWorthy", () => {
  it("ignores the hub's own issue traffic and label noise", () => {
    const sender = { login: "sakuracord-bot[bot]", type: "Bot" };
    expect(feedWorthy("issues", { action: "opened", sender }, "sakuracord-bot[bot]")).toBe(false);
    expect(feedWorthy("issues", { action: "labeled", sender: { login: "super" } }, null)).toBe(
      false,
    );
    expect(feedWorthy("issues", { action: "opened", sender: { login: "super" } }, null)).toBe(true);
    expect(feedWorthy("push", { sender: { login: "super" } }, null)).toBe(true);
  });
});
