CREATE TABLE IF NOT EXISTS ai_oauth_requests (
  state_hash TEXT PRIMARY KEY,
  encrypted_verifier TEXT NOT NULL,
  iv TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_oauth_requests_expiry
  ON ai_oauth_requests(expires_at);

CREATE TABLE IF NOT EXISTS ai_oauth_session (
  id TEXT PRIMARY KEY CHECK(id = 'primary'),
  encrypted_session TEXT NOT NULL,
  iv TEXT NOT NULL,
  account_id_hash TEXT NOT NULL,
  expires_at TEXT,
  refresh_lock_id TEXT,
  refresh_locked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS release_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL,
  release_id INTEGER NOT NULL,
  tag_name TEXT NOT NULL,
  release_name TEXT,
  release_url TEXT NOT NULL,
  target_commitish TEXT NOT NULL,
  published_at TEXT NOT NULL,
  previous_tag TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  generated_json TEXT CHECK(generated_json IS NULL OR json_valid(generated_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','complete','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  locked_at TEXT,
  github_updated_at TEXT,
  discord_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  UNIQUE(repository, release_id)
);

CREATE INDEX IF NOT EXISTS idx_release_jobs_ready
  ON release_jobs(status, available_at);

INSERT OR REPLACE INTO schema_metadata(key, value) VALUES ('schema_version', '2');
