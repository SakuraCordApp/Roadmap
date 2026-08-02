# Upgrading

Review release notes and the plan before applying:

```sh
roadmap upgrade --dry-run
roadmap export --safe-config --api-url "$ROADMAP_API_URL" \
  --file pre-upgrade-public-export.json
npx wrangler d1 export sakuracord-roadmap --remote \
  --output pre-upgrade-d1.sql
roadmap upgrade --api-url "$ROADMAP_API_URL"
```

The upgrade command installs locked dependencies, applies ordered D1
migrations, runs the complete local gate, deploys, and verifies health.

Migration `0002_release_automation.sql` advances schema metadata to version 2
and adds encrypted OAuth state plus idempotent release jobs. Existing roadmap
and Discord data are unchanged.

Migration `0003_report_automation.sql` advances schema metadata to version 3
and adds resumable Discord report-analysis jobs. Existing roadmap items and
Discord submission records are unchanged.

Migration `0004_reliable_jobs.sql` advances schema metadata to version 4, adds
recoverable Discord interaction jobs, and allows report jobs to request a rerun
when forum content changes during processing.

Migration `0005_report_job_recovery.sql` advances schema metadata to version 5
and safely requeues unlinked report-analysis jobs that exhausted the earlier
stale-lock retry loop.

Migration `0006_streamline_roadmap_items.sql` advances schema metadata to version
6, removes the obsolete difficulty column, and strips legacy planning fields
from current items and audit history.

Migration `0007_recover_automation_jobs.sql` advances schema metadata to version
7 and safely recovers stale Discord publication and report-analysis work.

Migration `0008_version_roadmap.sql` advances schema metadata to version 8 and
adds the separate version roadmap plus its immutable revision history. Existing
Tracker items, Discord submissions, and forum synchronization remain unchanged.

## Schema policy

- Never edit an already-applied migration.
- Add the next numbered migration.
- Prefer additive columns/tables and backfill before enforcing a new constraint.
- Preserve stable item IDs, revisions, mutation IDs, and audit history.
- Make data transformations resumable and idempotent.
- Update `schema_metadata.schema_version` only after the migration completes.

## Configuration compatibility

Typed config parsing fails early when a new required value is missing. Add a
default for backwards-compatible options. For breaking taxonomy changes,
migrate stored item values before removing an ID from configuration.

## Rollback

Worker code can be rolled back to a compatible deployment. D1 migrations are
forward-only; restore the pre-upgrade database into a new D1 instance when a
schema rollback is required. Never attempt an untested destructive down
migration against the only production database.
