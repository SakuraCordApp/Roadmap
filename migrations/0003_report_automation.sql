CREATE TABLE IF NOT EXISTS discord_report_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','complete','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  locked_at TEXT,
  analysis_json TEXT CHECK(analysis_json IS NULL OR json_valid(analysis_json)),
  linked_item_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  FOREIGN KEY(thread_id) REFERENCES discord_submissions(thread_id) ON DELETE CASCADE,
  FOREIGN KEY(linked_item_id) REFERENCES roadmap_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_discord_report_jobs_ready
  ON discord_report_jobs(status, available_at);

INSERT OR REPLACE INTO schema_metadata(key, value) VALUES ('schema_version', '3');
