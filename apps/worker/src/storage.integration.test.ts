import { readFile } from "node:fs/promises";
import path from "node:path";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unstable_splitSqlQuery as splitSqlQuery } from "wrangler";
import { RoadmapEngine } from "@roadmap/core";
import roadmapConfig from "../../../roadmap.config.js";
import { D1RoadmapStorage } from "./storage.js";

describe("D1 canonical storage", () => {
  let miniflare: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["DB"],
    });
    db = (await miniflare.getD1Database("DB")) as unknown as D1Database;
    const migration = await readFile(path.resolve("migrations/0001_initial.sql"), "utf8");
    for (const statement of migration
      .split(/;\n\n/)
      .map((value) => value.trim())
      .filter(Boolean)) {
      await db.prepare(statement).run();
    }
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it("keeps the migration compatible with Wrangler's remote statement parser", async () => {
    const migration = await readFile(path.resolve("migrations/0001_initial.sql"), "utf8");
    const statements = splitSqlQuery(migration);
    const triggers = statements.filter((statement) => statement.startsWith("CREATE TRIGGER"));

    expect(triggers).toHaveLength(0);
    expect(
      statements.some((statement) =>
        statement.includes("CREATE TABLE IF NOT EXISTS schema_metadata"),
      ),
    ).toBe(true);
    expect(statements.at(-1)).toContain("INSERT OR REPLACE INTO schema_metadata");
  });

  it("records create/update history and synchronization work in the mutation batch", async () => {
    const storage = new D1RoadmapStorage(db);
    const engine = new RoadmapEngine(storage, roadmapConfig);
    const actor = { id: "test", displayName: "Test", kind: "maintainer" as const };
    const created = await engine.create(
      {
        title: "D1 history",
        description: "Verify mutation triggers and canonical JSON.",
        type: "feature",
        area: "platform",
        status: "planned",
        priority: "medium",
        difficulty: "medium",
      },
      { actor, mutationId: "d1-create-history" },
    );
    const updated = await engine.update(created.after.id, { confidence: 90 }, 1, {
      actor,
      mutationId: "d1-update-history",
    });
    expect(updated.after.revision).toBe(2);
    const history = await storage.history(created.after.id);
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.revision)).toEqual([2, 1]);
    expect(history[0]?.before?.confidence).toBe(50);
    expect(history[0]?.after.confidence).toBe(90);
    const jobs = await db
      .prepare("SELECT count(*) AS count FROM sync_jobs")
      .first<{ count: number }>();
    expect(jobs?.count).toBeGreaterThanOrEqual(3);
  });

  it("replays the same idempotency key and rejects concurrent stale updates", async () => {
    const storage = new D1RoadmapStorage(db);
    const engine = new RoadmapEngine(storage, roadmapConfig);
    const actor = { id: "test", displayName: "Test", kind: "maintainer" as const };
    const input = {
      title: "Idempotent item",
      description: "Create only once for a repeated request.",
      type: "feature",
      area: "platform",
      status: "planned",
      priority: "medium",
      difficulty: "medium",
    };
    const first = await engine.create(input, { actor, mutationId: "idempotent-create" });
    const replay = await engine.create(input, { actor, mutationId: "idempotent-create" });
    expect(replay.replayed).toBe(true);
    expect(replay.after.id).toBe(first.after.id);
    await engine.update(first.after.id, { title: "Winner" }, 1, {
      actor,
      mutationId: "winner-update",
    });
    await expect(
      engine.update(first.after.id, { title: "Loser" }, 1, {
        actor,
        mutationId: "loser-update",
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect((await storage.get(first.after.id))?.title).toBe("Winner");
    const history = await storage.history(first.after.id);
    expect(history.map((entry) => entry.mutationId)).toEqual([
      "winner-update",
      "idempotent-create",
    ]);
  });
});
