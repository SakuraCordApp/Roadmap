import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sqlite, db } from "./d1";
import { ensureSchema } from "../src/db/schema";
import { searchReports } from "../src/ai/search";
import type { Env } from "../src/env";
const semantic = vi.hoisted(() => vi.fn());
vi.mock("../src/ai/embeddings", () => ({ similarTo: semantic }));
const env = { DB: db } as Env;
beforeAll(() => ensureSchema(db));
beforeEach(() => {
  sqlite.exec("DELETE FROM issues");
  const insert = sqlite.prepare(
    "INSERT INTO issues(number,title,body,kind,state,status,created_at,updated_at,synced_at) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  for (const [number, title, body, kind, state, status] of [
    [
      1,
      "Custom notification sounds",
      "Choose an alert sound per server",
      "feature",
      "closed",
      "shipped",
    ],
    [2, "Voice connection is silent", "No audio when receiving a call", "bug", "open", "confirmed"],
    [3, "Custom notification sounds", "An already merged report", "feature", "closed", "duplicate"],
  ] as const)
    insert.run(number, title, body, kind, state, status, "2026-10-01", "2026-10-01", "2026-10-01");
  semantic.mockReset().mockResolvedValue([]);
});
afterAll(() => sqlite.close());
describe("hybrid duplicate search", () => {
  it("finds closed features during a semantic outage and keeps the text index current", async () => {
    semantic.mockRejectedValue(new Error("AI unavailable"));
    expect(
      (await searchReports(env, "custom notification sounds")).map((r) => r.issue.number),
    ).toEqual([1]);
    sqlite
      .prepare("UPDATE issues SET title=?, body=? WHERE number=1")
      .run("Different topic", "No matching keywords");
    expect((await searchReports(env, "notification")).map((r) => r.issue.number)).toEqual([]);
    sqlite.prepare("DELETE FROM issues WHERE number=1").run();
    expect(
      sqlite.prepare("SELECT rowid FROM issue_search WHERE issue_search MATCH 'Different'").all(),
    ).toEqual([]);
  });
  it("combines semantic paraphrases and keyword candidates without filtering by report category", async () => {
    semantic.mockResolvedValue([{ number: 2, score: 0.9 }]);
    expect(
      new Set((await searchReports(env, "notification sounds")).map((r) => r.issue.number)),
    ).toEqual(new Set([1, 2]));
  });
});
