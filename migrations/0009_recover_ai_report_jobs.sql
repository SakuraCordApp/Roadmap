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
  AND attempts >= 10
  AND last_error = 'ChatGPT report analysis failed with HTTP 403.';

INSERT OR REPLACE INTO schema_metadata(key, value) VALUES ('schema_version', '9');
