PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roadmap_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
  type TEXT NOT NULL,
  area TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  document TEXT NOT NULL CHECK(json_valid(document)),
  actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
  mutation_id TEXT NOT NULL,
  mutation_action TEXT NOT NULL CHECK(mutation_action IN ('create','update','transition','link','import')),
  override_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_roadmap_items_status_updated
  ON roadmap_items(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_roadmap_items_area ON roadmap_items(area);
CREATE INDEX IF NOT EXISTS idx_roadmap_items_type ON roadmap_items(type);
CREATE INDEX IF NOT EXISTS idx_roadmap_items_priority ON roadmap_items(priority);
CREATE INDEX IF NOT EXISTS idx_roadmap_items_difficulty ON roadmap_items(difficulty);
CREATE INDEX IF NOT EXISTS idx_roadmap_items_completed ON roadmap_items(completed_at DESC);

CREATE TABLE IF NOT EXISTS audit_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL,
  actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
  before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)),
  override_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(item_id) REFERENCES roadmap_items(id) ON DELETE CASCADE,
  UNIQUE(item_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_audit_history_item_revision
  ON audit_history(item_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_audit_history_created
  ON audit_history(created_at DESC);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('publish_roadmap','sync_item','sync_thread','reconcile')),
  item_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','complete','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  locked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  FOREIGN KEY(item_id) REFERENCES roadmap_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_ready
  ON sync_jobs(status, available_at);

CREATE TABLE IF NOT EXISTS maintainer_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  roles_json TEXT NOT NULL DEFAULT '["maintainer"]' CHECK(json_valid(roles_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS discord_submissions (
  thread_id TEXT PRIMARY KEY,
  forum_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('feature_request','bug_report')),
  title TEXT NOT NULL,
  author_id TEXT,
  starter_message_id TEXT,
  content TEXT NOT NULL DEFAULT '',
  attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments_json)),
  structured_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(structured_metadata_json)),
  review_state TEXT NOT NULL DEFAULT 'inbox'
    CHECK(review_state IN ('inbox','accepted','linked','declined','duplicate','needs_information')),
  linked_item_id TEXT,
  duplicate_of_thread_id TEXT,
  decision_reason TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1)),
  applied_tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(applied_tags_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(linked_item_id) REFERENCES roadmap_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_discord_submissions_review
  ON discord_submissions(review_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_discord_submissions_item
  ON discord_submissions(linked_item_id);

CREATE TABLE IF NOT EXISTS discord_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  author_id TEXT,
  content TEXT NOT NULL DEFAULT '',
  attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(thread_id) REFERENCES discord_submissions(thread_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_discord_messages_thread
  ON discord_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS discord_reactions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(message_id, user_id, emoji_key)
);

CREATE INDEX IF NOT EXISTS idx_discord_reactions_thread
  ON discord_reactions(thread_id);

CREATE TABLE IF NOT EXISTS discord_events (
  event_id TEXT PRIMARY KEY,
  sequence INTEGER,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('received','processed','ignored','failed')),
  error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS discord_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS discord_subscriptions (
  user_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS replay_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_replay_nonces_expiry ON replay_nonces(expires_at);

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK(count >= 0),
  PRIMARY KEY(bucket, window_start)
);

CREATE TABLE IF NOT EXISTS setup_state (
  step TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending','complete','failed')),
  detail TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS schema_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR REPLACE INTO schema_metadata(key, value) VALUES ('schema_version', '1');
