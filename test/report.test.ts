import { describe, expect, it } from "vitest";
import {
  parseMeta,
  parseSections,
  renderIssueBody,
  valuesFromBody,
  withFooter,
} from "../src/report/body";
import { derivedPriority } from "../src/report/schema";
import { parseModal } from "../src/discord/modals";

describe("issue body", () => {
  const values = {
    title: "Images stay grey",
    what_happened: "Images in threads never load.\n### Not a heading\n@octocat please help",
    steps: "1. Open a thread",
    impact: "blocks",
    version: "0.1.6 Beta 3",
    area: "chat",
  };
  const body = renderIssueBody({
    kind: "bug",
    values,
    reporter: { source: "discord", name: "Sakura", discordId: "123456789012345678" },
    attachments: [
      {
        name: "shot.png",
        url: "https://roadmap.sakuracord.app/attachments/1/2/3/shot.png",
        contentType: "image/png",
      },
    ],
  });

  it("round-trips structured values", () => {
    const parsed = valuesFromBody("bug", body);
    expect(parsed).toMatchObject({
      what_happened: values.what_happened,
      impact: "blocks",
      area: "chat",
      version: "0.1.6 Beta 3",
    });
  });
  it("neutralizes mentions and forged headings in the rendered body", () => {
    expect(body).not.toMatch(/^### Not a heading$/m);
    expect(body).not.toContain("@octocat");
  });
  it("stores reporter metadata and keeps it when the footer changes", () => {
    const updated = withFooter(body, {
      kind: "bug",
      reporter: parseMeta(body)!.reporter,
      threadUrl: "https://discord.com/channels/1/2",
    });
    expect(parseMeta(updated)).toMatchObject({
      kind: "bug",
      thread: "https://discord.com/channels/1/2",
    });
    expect(parseSections(updated).map((section) => section.heading)).toContain(
      "Screenshots or recordings",
    );
  });
  it("parses GitHub issue-form bodies", () => {
    const form =
      "### What happened?\n\nIt crashed\n\n### Steps to reproduce\n\n_No response_\n\n### Impact\n\nCrash, data loss, or I can't use SakuraCord\n";
    expect(valuesFromBody("bug", form)).toEqual({ what_happened: "It crashed", impact: "crash" });
  });
  it("derives priority from impact", () => {
    expect(derivedPriority("bug", { impact: "crash" })).toBe("critical");
    expect(derivedPriority("feature", { importance: "nice" })).toBe("low");
  });
});

describe("parseModal", () => {
  it("flattens label-wrapped components and resolves uploads", () => {
    const parsed = parseModal({
      components: [
        { type: 18, component: { type: 4, custom_id: "title", value: "Crash" } },
        { type: 18, component: { type: 21, custom_id: "impact", value: "crash" } },
        { type: 18, component: { type: 3, custom_id: "version", values: ["0.1.6"] } },
        { type: 18, component: { type: 19, custom_id: "attachments", values: ["99"] } },
      ],
      resolved: {
        attachments: { "99": { id: "99", url: "https://cdn/x.png", filename: "x.png" } },
      },
    });
    expect(parsed.values).toEqual({ title: "Crash", impact: "crash", version: "0.1.6" });
    expect(parsed.attachments).toEqual([expect.objectContaining({ id: "99", filename: "x.png" })]);
  });
});
