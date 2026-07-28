const CURRENT_SCHEMA_VERSION = "6";
const STREAMLINE_MIGRATION_NAME = "0006_streamline_roadmap_items.sql";

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
  if (current !== "5") {
    throw new Error(
      `Unsupported roadmap schema version ${current ?? "missing"}; expected 5 or ${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  try {
    await db.batch([
      ...STREAMLINE_MIGRATION_STATEMENTS.map((statement) => db.prepare(statement)),
      db
        .prepare(
          `INSERT INTO d1_migrations(name)
           SELECT ?1
           WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?1)`,
        )
        .bind(STREAMLINE_MIGRATION_NAME),
    ]);
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
