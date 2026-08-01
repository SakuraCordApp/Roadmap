UPDATE sync_jobs
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
  );

UPDATE sync_jobs
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
);

UPDATE sync_jobs
SET status = 'pending',
    attempts = 0,
    available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    locked_at = NULL,
    completed_at = NULL,
    last_error = NULL
WHERE kind = 'sync_item'
  AND status = 'failed'
  AND last_error LIKE 'Discord GET % failed with 404.%';

UPDATE discord_report_jobs
SET status = 'pending',
    attempts = 0,
    available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    locked_at = NULL,
    completed_at = NULL,
    last_error = NULL,
    rerun_requested = 0
WHERE linked_item_id IS NULL
  AND status = 'failed'
  AND attempts >= 10;

INSERT OR REPLACE INTO schema_metadata(key, value) VALUES ('schema_version', '7');
