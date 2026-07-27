ALTER TABLE discord_report_jobs
  ADD COLUMN rerun_requested INTEGER NOT NULL DEFAULT 0 CHECK(rerun_requested IN (0,1));

CREATE TABLE IF NOT EXISTS discord_interaction_jobs (
  interaction_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','complete','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  locked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_discord_interaction_jobs_ready
  ON discord_interaction_jobs(status, available_at);

INSERT OR REPLACE INTO schema_metadata(key, value) VALUES ('schema_version', '4');
