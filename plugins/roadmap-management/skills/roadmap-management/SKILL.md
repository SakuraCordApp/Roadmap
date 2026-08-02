---
name: roadmap-management
description: Manage a canonical self-hosted version roadmap and detailed tracker through revision-safe MCP tools, Discord reconciliation, audit history, and optional read-only inspection of a separately configured application repository. Use when creating, updating, transitioning, validating, reconciling, or reviewing roadmap versions and tracker items.
---

# Roadmap Management

Use the roadmap MCP server as the source of truth. Version plans and detailed
Tracker items live in the deployed instance database, never in the application
repository and never in Git commits created for individual roadmap changes.

## Read before write

Before any Tracker item mutation:

1. Call `roadmap_get` for the stable item ID, or `roadmap_search` to resolve it.
2. Read the current `revision`, acceptance criteria, report sources, and linked
   Discord threads.
3. Use that exact revision as `expectedRevision`.
4. If the server returns a conflict, read the item again, explain the concurrent
   change, and reapply only the intended fields.

Never retry a conflict by guessing the latest revision.

For a version mutation, use `roadmap_version_get` first, then pass its exact
current revision to `roadmap_version_update` or `roadmap_version_transition`.
Use `roadmap_version_history` to resolve concurrent editorial changes.

## Version roadmap

Use version records for a small number of major public promises, not for every
tracked task. Keep each version summary short and curate no more highlights than
a visitor can scan comfortably. Link related Tracker IDs when they exist.

Create versions as drafts unless the user explicitly asks to publish them.
Moving a version to `planned` requires at least one public highlight. Moving it
to `released` should include the actual release URL and timestamp; matching
GitHub Release automation normally performs that transition automatically.

## Creating items

Do not create a new roadmap item unless the user explicitly asks you to create
one. Do not infer permission from a feature request, repository finding, Discord
submission, review, reconciliation, or other roadmap-related work. If a new item
seems useful but the user has not requested it, suggest it and wait for explicit
approval before calling `roadmap_create`.

Use `roadmap_create` only after distinguishing a maintainer commitment from a
community suggestion. New Discord forum submissions belong in the review inbox
until an authorized maintainer accepts or links them.

Choose type, area, lifecycle, and priority from the instance configuration.
Keep the title, description, labels, sources, and acceptance criteria grounded
in the submitted report and its attachments.

## Completion

A normal transition to `done` requires:

- at least one acceptance criterion;
- every acceptance criterion satisfied.

Use an override only when the user explicitly authorizes it. The override reason
must explain why the normal gate is being bypassed and will be stored in history.

## Discord

Use `roadmap_link_discord_thread` to connect a forum post to an existing item.
Use `roadmap_generate_discord_view` to inspect the version projection without
publishing. Published version mutations update the live website and enqueue an
update to the same canonical Discord message. Use `roadmap_version_publish`
only when an immediate forced publish or repair is requested. Use
`roadmap_sync_status` before `roadmap_reconcile` when
diagnosing drift in detailed forum-backed Tracker items.

## Application repository inspection

Only inspect the separately configured application repository when the user
explicitly asks for codebase comparison or outdated roadmap state. Repository
findings are not stored as additional planning fields on roadmap items.

`roadmap_inspect_repository` and `roadmap_repository_changes` are read-only.
Never write roadmap files, roadmap data, commits, branches, or configuration
into that repository. A code match is evidence to review, not proof that an item
is complete.

## Reporting

For mutations, report:

- stable item ID;
- before and after revision;
- material field changes;
- synchronization implications; and
- any remaining acceptance-criteria gap.

Use `roadmap_history` for "what changed" questions instead of Git history.
Use `roadmap_version_history` for version-plan history.
