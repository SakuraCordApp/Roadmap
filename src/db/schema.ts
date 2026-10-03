// Runtime schema management. Deployments go through Cloudflare Workers Builds,
// so the Worker applies pending schema versions itself before handling work.

const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS issues (
      number INTEGER PRIMARY KEY,
      github_id INTEGER,
      node_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      kind TEXT,
      state TEXT NOT NULL,
      state_reason TEXT,
      status TEXT NOT NULL,
      area TEXT,
      priority TEXT,
      labels_json TEXT NOT NULL DEFAULT '[]',
      milestone_number INTEGER,
      milestone_title TEXT,
      author_login TEXT,
      author_type TEXT,
      reporter_json TEXT,
      summary TEXT,
      reactions_up INTEGER NOT NULL DEFAULT 0,
      comments_count INTEGER NOT NULL DEFAULT 0,
      duplicate_of INTEGER,
      fixes_json TEXT NOT NULL DEFAULT '[]',
      shipped_in TEXT,
      shipped_stable_in TEXT,
      triage_json TEXT,
      triaged_at TEXT,
      embedded_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      synced_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status)`,
    `CREATE INDEX IF NOT EXISTS idx_issues_updated ON issues(updated_at)`,
    `CREATE TABLE IF NOT EXISTS threads (
      thread_id TEXT PRIMARY KEY,
      issue_number INTEGER NOT NULL,
      forum_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('primary','merged')),
      card_message_id TEXT,
      card_hash TEXT,
      state_hash TEXT,
      last_message_id TEXT,
      watch_until TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_threads_issue ON threads(issue_number)`,
    `CREATE TABLE IF NOT EXISTS subscribers (
      issue_number INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('reporter','vote')),
      created_at TEXT NOT NULL,
      PRIMARY KEY(issue_number, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      user_json TEXT NOT NULL,
      values_json TEXT NOT NULL DEFAULT '{}',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      candidates_json TEXT NOT NULL DEFAULT '[]',
      issue_number INTEGER,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','running','done','failed')),
      rerun INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      run_after TEXT NOT NULL,
      locked_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(status, run_after)`,
    `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_number INTEGER NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_number, created_at)`,
    `CREATE TABLE IF NOT EXISTS comment_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_number INTEGER NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('github','discord','website')),
      github_comment_id INTEGER UNIQUE,
      discord_message_id TEXT UNIQUE,
      discord_via TEXT,
      thread_id TEXT,
      content_hash TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_comment_links_thread ON comment_links(thread_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS legacy_ids (
      legacy_id TEXT PRIMARY KEY,
      issue_number INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS milestones (
      number INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      due_on TEXT,
      closed_at TEXT,
      open_issues INTEGER NOT NULL DEFAULT 0,
      closed_issues INTEGER NOT NULL DEFAULT 0,
      html_url TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS pending_notes (
      issue_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      text TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(issue_number, status)
    )`,
    `CREATE TABLE IF NOT EXISTS attachment_cache (
      attachment_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      url TEXT NOT NULL,
      content_type TEXT,
      expires_at TEXT NOT NULL
    )`,
  ],
  [`ALTER TABLE jobs ADD COLUMN wake_after TEXT`],
  [
    `CREATE VIRTUAL TABLE IF NOT EXISTS issue_search USING fts5(title,summary,body,content='issues',content_rowid='number')`,
    `CREATE TRIGGER IF NOT EXISTS issue_search_insert AFTER INSERT ON issues BEGIN
      INSERT INTO issue_search(rowid,title,summary,body) VALUES(new.number,new.title,new.summary,new.body); END`,
    `CREATE TRIGGER IF NOT EXISTS issue_search_delete AFTER DELETE ON issues BEGIN
      INSERT INTO issue_search(issue_search,rowid,title,summary,body) VALUES('delete',old.number,old.title,old.summary,old.body); END`,
    `CREATE TRIGGER IF NOT EXISTS issue_search_update AFTER UPDATE OF title,summary,body ON issues
      WHEN old.title IS NOT new.title OR old.summary IS NOT new.summary OR old.body IS NOT new.body BEGIN
      INSERT INTO issue_search(issue_search,rowid,title,summary,body) VALUES('delete',old.number,old.title,old.summary,old.body);
      INSERT INTO issue_search(rowid,title,summary,body) VALUES(new.number,new.title,new.summary,new.body); END`,
    `INSERT INTO issue_search(issue_search) VALUES('rebuild')`,
  ],
  [
    `CREATE TABLE agent_runs (
      issue_number INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('investigate','fix')),
      run_id INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      thread_id TEXT,
      message_id TEXT,
      content_hash TEXT,
      result_text TEXT,
      checked_at TEXT,
      PRIMARY KEY(issue_number,kind)
    )`,
  ],
];

export const SCHEMA_VERSION = MIGRATIONS.length;

let ready: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  ready ??= migrate(db).catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}

async function migrate(db: D1Database): Promise<void> {
  await db.prepare("CREATE TABLE IF NOT EXISTS hub_schema (version INTEGER NOT NULL)").run();
  const row = await db.prepare("SELECT MAX(version) AS version FROM hub_schema").first<{
    version: number | null;
  }>();
  const current = row?.version ?? 0;
  for (let version = current + 1; version <= MIGRATIONS.length; version += 1) {
    const statements = MIGRATIONS[version - 1]!.map((sql) => db.prepare(sql));
    statements.push(db.prepare("INSERT INTO hub_schema(version) VALUES(?)").bind(version));
    await db.batch(statements);
  }
}
