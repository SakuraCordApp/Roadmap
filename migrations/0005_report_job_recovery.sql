UPDATE discord_report_jobs
SET status = 'pending',
    attempts = 0,
    available_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    locked_at = NULL,
    last_error = NULL,
    completed_at = NULL,
    rerun_requested = 0
WHERE linked_item_id IS NULL
  AND (
    attempts >= 10
    OR (
      status = 'processing'
      AND unixepoch(locked_at) <= unixepoch('now') - 300
    )
  );

INSERT OR REPLACE INTO schema_metadata(key, value) VALUES ('schema_version', '5');
