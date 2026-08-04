import { readFile } from "node:fs/promises";
import path from "node:path";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unstable_splitSqlQuery as splitSqlQuery } from "wrangler";
import { RoadmapEngine } from "@roadmap/core";
import roadmapConfig from "../../../roadmap.config.js";
import {
  AI_REPORT_RECOVERY_MIGRATION_STATEMENTS,
  ensureCurrentSchema,
  RECOVERY_MIGRATION_STATEMENTS,
  STREAMLINE_MIGRATION_STATEMENTS,
  VERSION_ROADMAP_MIGRATION_STATEMENTS,
} from "./schema-migrations.js";
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
    for (const name of [
      "0001_initial.sql",
      "0002_release_automation.sql",
      "0003_report_automation.sql",
      "0004_reliable_jobs.sql",
      "0005_report_job_recovery.sql",
      "0006_streamline_roadmap_items.sql",
    ]) {
      await applyMigration(db, name);
    }
    await db
      .prepare(
        `CREATE TABLE d1_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
      )
      .run();
  });

  afterEach(async () => {
    await miniflare.dispose();
  });

  it("keeps the migration compatible with Wrangler's remote statement parser", async () => {
    const initialMigration = await readFile(path.resolve("migrations/0001_initial.sql"), "utf8");
    const streamlineMigration = await readFile(
      path.resolve("migrations/0006_streamline_roadmap_items.sql"),
      "utf8",
    );
    const recoveryMigration = await readFile(
      path.resolve("migrations/0007_recover_automation_jobs.sql"),
      "utf8",
    );
    const versionRoadmapMigration = await readFile(
      path.resolve("migrations/0008_version_roadmap.sql"),
      "utf8",
    );
    const aiReportRecoveryMigration = await readFile(
      path.resolve("migrations/0009_recover_ai_report_jobs.sql"),
      "utf8",
    );
    const statements = splitSqlQuery(initialMigration);
    const triggers = statements.filter((statement) => statement.startsWith("CREATE TRIGGER"));

    expect(triggers).toHaveLength(0);
    expect(
      statements.some((statement) =>
        statement.includes("CREATE TABLE IF NOT EXISTS schema_metadata"),
      ),
    ).toBe(true);
    expect(statements.at(-1)).toContain("INSERT OR REPLACE INTO schema_metadata");
    expect(splitSqlQuery(streamlineMigration).map(normalizeSql)).toEqual(
      STREAMLINE_MIGRATION_STATEMENTS.map(normalizeSql),
    );
    expect(splitSqlQuery(recoveryMigration).map(normalizeSql)).toEqual(
      RECOVERY_MIGRATION_STATEMENTS.map(normalizeSql),
    );
    expect(splitSqlQuery(versionRoadmapMigration).map(normalizeSql)).toEqual(
      VERSION_ROADMAP_MIGRATION_STATEMENTS.map(normalizeSql),
    );
    expect(splitSqlQuery(aiReportRecoveryMigration).map(normalizeSql)).toEqual(
      AI_REPORT_RECOVERY_MIGRATION_STATEMENTS.map(normalizeSql),
    );
  });

  it("removes legacy planning data from canonical rows and audit history", async () => {
    const legacyMiniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      d1Databases: ["DB"],
    });
    try {
      const legacyDb = (await legacyMiniflare.getD1Database("DB")) as unknown as D1Database;
      for (const name of [
        "0001_initial.sql",
        "0002_release_automation.sql",
        "0003_report_automation.sql",
        "0004_reliable_jobs.sql",
        "0005_report_job_recovery.sql",
      ]) {
        await applyMigration(legacyDb, name);
      }
      await legacyDb
        .prepare(
          `CREATE TABLE d1_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
        )
        .run();
      const document = JSON.stringify({
        id: "TST-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        title: "Legacy item",
        difficulty: "large",
        confidence: 90,
        progress: { value: 50 },
        proposedImplementation: "Remove me",
        affectedComponents: ["LegacyView"],
        dependencies: ["TST-other"],
        risks: ["Legacy risk"],
        requiredResearch: ["Legacy research"],
        verificationResults: [{ result: "passed" }],
        benchmarks: [{ value: 1 }],
        relatedCommits: ["abc123"],
        relatedPullRequests: ["https://example.com/pr"],
        milestone: "Legacy milestone",
        communityReactionCount: 4,
        duplicateReportCount: 2,
      });
      const actor = JSON.stringify({ id: "test", displayName: "Test", kind: "system" });
      await legacyDb
        .prepare(
          `INSERT INTO roadmap_items (
            id,title,type,area,status,priority,difficulty,revision,created_at,updated_at,
            completed_at,document,actor_json,mutation_id,mutation_action,override_reason
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          "TST-01ARZ3NDEKTSV4RRFFQ69G5FAV",
          "Legacy item",
          "feature",
          "app",
          "planned",
          "medium",
          "large",
          1,
          "2026-07-20T00:00:00.000Z",
          "2026-07-20T00:00:00.000Z",
          null,
          document,
          actor,
          "legacy-create",
          "create",
          null,
        )
        .run();
      await legacyDb
        .prepare(
          `INSERT INTO audit_history (
            item_id,revision,mutation_id,action,actor_json,before_json,after_json,override_reason
          ) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind(
          "TST-01ARZ3NDEKTSV4RRFFQ69G5FAV",
          1,
          "legacy-create",
          "create",
          actor,
          document,
          document,
          null,
        )
        .run();

      await Promise.all([ensureCurrentSchema(legacyDb), ensureCurrentSchema(legacyDb)]);

      const columns = await legacyDb
        .prepare("PRAGMA table_info(roadmap_items)")
        .all<{ name: string }>();
      expect(columns.results.map((column) => column.name)).not.toContain("difficulty");
      const row = await legacyDb
        .prepare("SELECT document FROM roadmap_items")
        .first<{ document: string }>();
      const history = await legacyDb
        .prepare("SELECT before_json,after_json FROM audit_history")
        .first<{ before_json: string; after_json: string }>();
      const removedFields = [
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
      ];
      for (const stored of [row?.document, history?.before_json, history?.after_json]) {
        expect(stored).toBeTruthy();
        const parsed = JSON.parse(stored!);
        expect(removedFields.every((field) => !(field in parsed))).toBe(true);
      }
      const migrations = await legacyDb
        .prepare("SELECT name FROM d1_migrations ORDER BY id")
        .all<{ name: string }>();
      expect(migrations.results.map(({ name }) => name)).toEqual([
        "0006_streamline_roadmap_items.sql",
        "0007_recover_automation_jobs.sql",
        "0008_version_roadmap.sql",
        "0009_recover_ai_report_jobs.sql",
      ]);
    } finally {
      await legacyMiniflare.dispose();
    }
  });

  it("requeues only exhausted report jobs rejected by ChatGPT", async () => {
    await applyMigration(db, "0007_recover_automation_jobs.sql");
    await applyMigration(db, "0008_version_roadmap.sql");
    const now = "2026-08-03T04:02:09.005Z";
    await db
      .prepare(
        `INSERT INTO discord_submissions(
           thread_id,forum_id,guild_id,kind,title,created_at,updated_at
         ) VALUES
           ('chatgpt-403','bug-forum','guild','bug_report','Rejected report',?1,?1),
           ('other-failure','bug-forum','guild','bug_report','Other failure',?1,?1)`,
      )
      .bind(now)
      .run();
    await db
      .prepare(
        `INSERT INTO discord_report_jobs(thread_id,status,attempts,last_error)
         VALUES
           ('chatgpt-403','failed',10,'ChatGPT report analysis failed with HTTP 403.'),
           ('other-failure','failed',10,'Discord POST failed with 403.')`,
      )
      .run();

    await ensureCurrentSchema(db);

    const jobs = await db
      .prepare(
        `SELECT thread_id,status,attempts,last_error
         FROM discord_report_jobs ORDER BY thread_id`,
      )
      .all<{
        thread_id: string;
        status: string;
        attempts: number;
        last_error: string | null;
      }>();
    expect(jobs.results).toEqual([
      { thread_id: "chatgpt-403", status: "pending", attempts: 0, last_error: null },
      {
        thread_id: "other-failure",
        status: "failed",
        attempts: 10,
        last_error: "Discord POST failed with 403.",
      },
    ]);
  });

  it("coalesces publishes and requeues recoverable Discord automation once", async () => {
    await db
      .prepare(
        `INSERT INTO sync_jobs(job_key,kind,status,attempts,last_error)
         VALUES
           ('publish-1','publish_roadmap','failed',10,'Discord POST failed with 400.'),
           ('publish-2','publish_roadmap','failed',10,'Discord POST failed with 400.'),
           ('publish-3','publish_roadmap','failed',10,'Discord POST failed with 400.'),
           ('sync-deleted','sync_item','failed',128,'Discord GET /channels/deleted failed with 404.')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO discord_submissions(
           thread_id,forum_id,guild_id,kind,title,created_at,updated_at
         ) VALUES ('bug-thread','bug-forum','guild','bug_report','Bug report',?1,?1)`,
      )
      .bind("2026-08-01T00:00:00.000Z")
      .run();
    await db
      .prepare(
        `INSERT INTO discord_report_jobs(
           thread_id,status,attempts,last_error,completed_at,rerun_requested
         ) VALUES ('bug-thread','failed',10,'Report analysis exceeded its retry budget.',?1,1)`,
      )
      .bind("2026-08-01T01:00:00.000Z")
      .run();

    await ensureCurrentSchema(db);

    const jobs = await db
      .prepare("SELECT id,kind,status,attempts,last_error FROM sync_jobs ORDER BY id")
      .all<{
        id: number;
        kind: string;
        status: string;
        attempts: number;
        last_error: string | null;
      }>();
    expect(jobs.results).toEqual([
      { id: 1, kind: "publish_roadmap", status: "complete", attempts: 10, last_error: null },
      { id: 2, kind: "publish_roadmap", status: "complete", attempts: 10, last_error: null },
      { id: 3, kind: "publish_roadmap", status: "pending", attempts: 0, last_error: null },
      { id: 4, kind: "sync_item", status: "pending", attempts: 0, last_error: null },
    ]);
    const report = await db
      .prepare(
        `SELECT status,attempts,last_error,completed_at,rerun_requested
         FROM discord_report_jobs WHERE thread_id='bug-thread'`,
      )
      .first<{
        status: string;
        attempts: number;
        last_error: string | null;
        completed_at: string | null;
        rerun_requested: number;
      }>();
    expect(report).toEqual({
      status: "pending",
      attempts: 0,
      last_error: null,
      completed_at: null,
      rerun_requested: 0,
    });
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
      },
      { actor, mutationId: "d1-create-history" },
    );
    const updated = await engine.update(created.after.id, { title: "D1 history updated" }, 1, {
      actor,
      mutationId: "d1-update-history",
    });
    expect(updated.after.revision).toBe(2);
    const history = await storage.history(created.after.id);
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.revision)).toEqual([2, 1]);
    expect(history[0]?.before?.title).toBe("D1 history");
    expect(history[0]?.after.title).toBe("D1 history updated");
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

async function applyMigration(db: D1Database, name: string) {
  const migration = await readFile(path.resolve("migrations", name), "utf8");
  for (const statement of migration
    .split(/;\n\n/)
    .map((value) => value.trim())
    .filter(Boolean)) {
    await db.prepare(statement).run();
  }
}

function normalizeSql(statement: string) {
  return statement.replace(/\s+/g, " ").trim();
}
