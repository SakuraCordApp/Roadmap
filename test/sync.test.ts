import { describe, expect, it } from "vitest";
import { db, sqlite } from "./d1";
import { ensureSchema } from "../src/db/schema";
import {
  dropAssessmentNote,
  editFixes,
  getState,
  issuesReferencedByPull,
  setAssessmentNote,
  setState,
  takeAssessmentNote,
} from "../src/db/store";
import { parseMilestone, renderMilestoneDescription, visibleVersions } from "../src/roadmap";
import { discordToGithub } from "../src/sync/comments";

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

describe("assessment notes", () => {
  it("attribute only the status change they describe, and only once", async () => {
    await ensureSchema(db);
    const note = {
      status: "in_nightly",
      text: "Set by the assessment.",
      author: "Triage",
    } as const;
    await setAssessmentNote(db, 51, note);
    expect(await takeAssessmentNote(db, 51, "in_nightly")).toEqual({
      text: note.text,
      author: note.author,
    });
    expect(await takeAssessmentNote(db, 51, "in_nightly")).toBeNull();
    // A different change announced first drops it, so a later one isn't misattributed.
    await setAssessmentNote(db, 51, note);
    expect(await takeAssessmentNote(db, 51, "confirmed")).toBeNull();
    expect(await takeAssessmentNote(db, 51, "in_nightly")).toBeNull();
  });

  it("are dropped by a sync that announced nothing once their result was applied", async () => {
    await ensureSchema(db);
    const note = {
      status: "in_progress",
      text: "Set by the assessment.",
      author: "Triage",
    } as const;
    await setAssessmentNote(db, 52, note);
    // Synced while the result is still being applied: its change may be on its way.
    await setState(db, "triage:applied:52", "2000-01-01T00:00:00.000Z");
    await dropAssessmentNote(db, 52);
    expect(await getState(db, "assessment:status-note:52")).toContain("in_progress");
    await setState(db, "triage:applied:52", new Date(Date.now() + 1000).toISOString());
    // A maintainer restored the status before the sync, so nothing was announced.
    await dropAssessmentNote(db, 52);
    expect(await takeAssessmentNote(db, 52, "in_progress")).toBeNull();
  });
});

describe("pull request references", () => {
  it("find only unmerged fixes a pull request's own reference recorded", async () => {
    await ensureSchema(db);
    const report = (number: number, fixes: object[]) =>
      db
        .prepare(
          "INSERT INTO issues(number,title,state,status,fixes_json,created_at,updated_at,synced_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(number, "t", "open", "in_progress", JSON.stringify(fixes), "x", "x", "x")
        .run();
    const pr = { kind: "pr", number: 60, url: "" };
    await report(1, [{ ...pr, state: "open", named: true }]);
    await report(2, [{ ...pr, state: "merged", sha: "a", named: true }]);
    await report(3, [{ ...pr, state: "merged", sha: "a" }]);
    await report(4, [{ ...pr, state: "closed", named: true }]);
    expect((await issuesReferencedByPull(db, 60)).sort()).toEqual([1, 4]);
  });
});

describe("fix edits", () => {
  it("keep a merge recorded while another edit was being made", async () => {
    await ensureSchema(db);
    const linked = { kind: "pr", number: 60, url: "", state: "open" };
    const merged = { kind: "pr", number: 61, url: "", state: "merged", sha: "b" };
    await db
      .prepare(
        "INSERT INTO issues(number,title,state,status,fixes_json,created_at,updated_at,synced_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(9, "t", "open", "in_progress", JSON.stringify([linked]), "x", "x", "x")
      .run();
    let merging = true;
    const fixes = await editFixes(db, 9, (current) => {
      // Pull request sync records the other pull request's merge meanwhile.
      if (merging) {
        merging = false;
        sqlite
          .prepare("UPDATE issues SET fixes_json=? WHERE number=9")
          .run(JSON.stringify([linked, merged]));
      }
      return { fixes: current.fixes.filter((fix) => fix.number !== 60) };
    });
    expect(fixes).toEqual([merged]);
  });
});
