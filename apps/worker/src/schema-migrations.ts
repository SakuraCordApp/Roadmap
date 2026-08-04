const CURRENT_SCHEMA_VERSION = "9";
const STREAMLINE_MIGRATION_NAME = "0006_streamline_roadmap_items.sql";
const RECOVERY_MIGRATION_NAME = "0007_recover_automation_jobs.sql";
const VERSION_ROADMAP_MIGRATION_NAME = "0008_version_roadmap.sql";
const AI_REPORT_RECOVERY_MIGRATION_NAME = "0009_recover_ai_report_jobs.sql";

export const STREAMLINE_MIGRATION_STATEMENTS = [
  "DROP INDEX IF EXISTS idx_roadmap_items_difficulty",
  "ALTER TABLE roadmap_items DROP COLUMN difficulty",
  `UPDATE roadmap_items
SET document = json_remove(
  document,
  '$.difficulty',
  '$.confidence',
  '$.progress',
  '$.proposedImplementation',
  '$.affectedComponents',
  '$.dependencies',
  '$.risks',
  '$.requiredResearch',
  '$.verificationResults',
  '$.benchmarks',
  '$.relatedCommits',
  '$.relatedPullRequests',
  '$.milestone',
  '$.communityReactionCount',
  '$.duplicateReportCount'
)`,
  `UPDATE audit_history
SET before_json = json_remove(
  before_json,
  '$.difficulty',
  '$.confidence',
  '$.progress',
  '$.proposedImplementation',
  '$.affectedComponents',
  '$.dependencies',
  '$.risks',
  '$.requiredResearch',
  '$.verificationResults',
  '$.benchmarks',
  '$.relatedCommits',
  '$.relatedPullRequests',
  '$.milestone',
  '$.communityReactionCount',
  '$.duplicateReportCount'
)
WHERE before_json IS NOT NULL`,
  `UPDATE audit_history
SET after_json = json_remove(
  after_json,
  '$.difficulty',
  '$.confidence',
  '$.progress',
  '$.proposedImplementation',
  '$.affectedComponents',
  '$.dependencies',
  '$.risks',
  '$.requiredResearch',
  '$.verificationResults',
  '$.benchmarks',
  '$.relatedCommits',
  '$.relatedPullRequests',
  '$.milestone',
  '$.communityReactionCount',
  '$.duplicateReportCount'
)`,
  "INSERT OR REPLACE INTO schema_metadata(key, value) VALUES ('schema_version', '6')",
] as const;

export const RECOVERY_MIGRATION_STATEMENTS = [
  `UPDATE sync_jobs
SET status = 'complete',
    completed_at = datetime('now'),
    locked_at = NULL,
    last_error = NULL
WHERE kind = 'publish_roadmap'
  AND status != 'complete'
  AND id < (
    SELECT COALESCE(MAX(id), 0)
    FROM sync_jobs
    WHERE kind = 'publish_roadmap'
      AND status != 'complete'
  )`,
  `UPDATE sync_jobs
SET status = 'pending',
    attempts = 0,
    available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    locked_at = NULL,
    completed_at = NULL,
    last_error = NULL
WHERE id = (
  SELECT MAX(id)
  FROM sync_jobs
  WHERE kind = 'publish_roadmap'
    AND status != 'complete'
)`,
  `UPDATE sync_jobs
SET status = 'pending',
    attempts = 0,
    available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    locked_at = NULL,
    completed_at = NULL,
    last_error = NULL
WHERE kind = 'sync_item'
  AND status = 'failed'
  AND last_error LIKE 'Discord GET % failed with 404.%'`,
  `UPDATE discord_report_jobs
SET status = 'pending',
    attempts = 0,
    available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    locked_at = NULL,
    completed_at = NULL,
    last_error = NULL,
    rerun_requested = 0
WHERE linked_item_id IS NULL
  AND status = 'failed'
  AND attempts >= 10`,
  "INSERT OR REPLACE INTO schema_metadata(key, value) VALUES ('schema_version', '7')",
] as const;

export const VERSION_ROADMAP_MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS roadmap_versions (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
    state TEXT NOT NULL CHECK(state IN ('draft','planned','released','cancelled')),
    position INTEGER NOT NULL CHECK(position >= 0),
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    released_at TEXT,
    document TEXT NOT NULL CHECK(json_valid(document)),
    actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
    mutation_id TEXT NOT NULL,
    mutation_action TEXT NOT NULL CHECK(mutation_action IN ('create','update','transition')),
    override_reason TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_roadmap_versions_public_order
    ON roadmap_versions(state, position, version)`,
  `CREATE TABLE IF NOT EXISTS roadmap_version_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    mutation_id TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL CHECK(action IN ('create','update','transition')),
    actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
    before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
    after_json TEXT NOT NULL CHECK(json_valid(after_json)),
    override_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(version_id) REFERENCES roadmap_versions(id) ON DELETE CASCADE,
    UNIQUE(version_id, revision)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_roadmap_version_history_version_revision
    ON roadmap_version_history(version_id, revision DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_roadmap_version_history_created
    ON roadmap_version_history(created_at DESC)`,
  "INSERT OR REPLACE INTO schema_metadata(key, value) VALUES ('schema_version', '8')",
] as const;

export const AI_REPORT_RECOVERY_MIGRATION_STATEMENTS = [
  `UPDATE discord_report_jobs
SET status = 'pending',
    attempts = 0,
    available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    locked_at = NULL,
    completed_at = NULL,
    last_error = NULL,
    rerun_requested = 0
WHERE linked_item_id IS NULL
  AND status = 'failed'
  AND attempts >= 10
  AND last_error = 'ChatGPT report analysis failed with HTTP 403.'`,
  "INSERT OR REPLACE INTO schema_metadata(key, value) VALUES ('schema_version', '9')",
] as const;

const schemaChecks = new WeakMap<D1Database, Promise<void>>();

export function ensureCurrentSchema(db: D1Database): Promise<void> {
  const existing = schemaChecks.get(db);
  if (existing) return existing;

  const pending = migrateToCurrentSchema(db).catch((error: unknown) => {
    schemaChecks.delete(db);
    throw error;
  });
  schemaChecks.set(db, pending);
  return pending;
}

async function migrateToCurrentSchema(db: D1Database): Promise<void> {
  const current = await readSchemaVersion(db);
  if (current === CURRENT_SCHEMA_VERSION) return;
  if (current !== "5" && current !== "6" && current !== "7" && current !== "8") {
    throw new Error(
      `Unsupported roadmap schema version ${current ?? "missing"}; expected 5, 6, 7, 8, or ${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  const statements: D1PreparedStatement[] = [];
  if (current === "5") {
    statements.push(
      ...STREAMLINE_MIGRATION_STATEMENTS.map((statement) => db.prepare(statement)),
      db
        .prepare(
          `INSERT INTO d1_migrations(name)
           SELECT ?1
           WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?1)`,
        )
        .bind(STREAMLINE_MIGRATION_NAME),
    );
  }
  if (current === "5" || current === "6") {
    statements.push(
      ...RECOVERY_MIGRATION_STATEMENTS.map((statement) => db.prepare(statement)),
      db
        .prepare(
          `INSERT INTO d1_migrations(name)
           SELECT ?1
           WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?1)`,
        )
        .bind(RECOVERY_MIGRATION_NAME),
    );
  }
  if (current !== "8") {
    statements.push(
      ...VERSION_ROADMAP_MIGRATION_STATEMENTS.map((statement) => db.prepare(statement)),
      db
        .prepare(
          `INSERT INTO d1_migrations(name)
           SELECT ?1
           WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?1)`,
        )
        .bind(VERSION_ROADMAP_MIGRATION_NAME),
    );
  }
  statements.push(
    ...AI_REPORT_RECOVERY_MIGRATION_STATEMENTS.map((statement) => db.prepare(statement)),
    db
      .prepare(
        `INSERT INTO d1_migrations(name)
         SELECT ?1
         WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?1)`,
      )
      .bind(AI_REPORT_RECOVERY_MIGRATION_NAME),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    // Another isolate may have completed the same transactional migration
    // while this request was waiting on D1's write serialization.
    if ((await readSchemaVersion(db)) === CURRENT_SCHEMA_VERSION) return;
    throw error;
  }

  const migrated = await readSchemaVersion(db);
  if (migrated !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Roadmap schema migration completed without reaching version ${CURRENT_SCHEMA_VERSION}.`,
    );
  }
}

async function readSchemaVersion(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM schema_metadata WHERE key='schema_version'")
    .first<{ value: string }>();
  return row?.value ?? null;
}
