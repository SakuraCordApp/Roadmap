---
name: roadmap-management
description: Manage a canonical self-hosted engineering roadmap through revision-safe MCP tools, Discord reconciliation, audit history, and optional read-only inspection of a separately configured application repository. Use when creating, updating, transitioning, validating, reconciling, or reviewing roadmap items.
---

# Roadmap Management

Use the roadmap MCP server as the source of truth. Roadmap state lives in the
deployed instance database, never in the application repository and never in
Git commits created for individual roadmap changes.

## Read before write

Before any mutation:

1. Call `roadmap_get` for the stable item ID, or `roadmap_search` to resolve it.
2. Read the current `revision`, acceptance criteria, verification, linked
   Discord threads, and unresolved research.
3. Use that exact revision as `expectedRevision`.
4. If the server returns a conflict, read the item again, explain the concurrent
   change, and reapply only the intended fields.

Never retry a conflict by guessing the latest revision.

## Creating items

Use `roadmap_create` only after distinguishing a maintainer commitment from a
community suggestion. New Discord forum submissions belong in the review inbox
until an authorized maintainer accepts or links them.

Choose type, area, lifecycle, priority, and difficulty from the instance
configuration. Write a concrete description and proposed implementation when
the available evidence supports one. Record unknowns under required research.

## Progress and completion

Do not estimate progress from intuition. A progress change must cite acceptance
criteria, tests, commits, pull requests, benchmarks, or an explicit manual
assessment with a rationale.

Use `roadmap_record_verification` for actual verification evidence. A normal
transition to `done` requires:

- at least one acceptance criterion;
- every acceptance criterion satisfied; and
- at least one passing verification result.

Use an override only when the user explicitly authorizes it. The override reason
must explain why the normal gate is being bypassed and will be stored in history.

## Discord

Use `roadmap_link_discord_thread` to connect a forum post to an existing item.
Use `roadmap_generate_discord_view` to inspect the simplified projection without
publishing. Use `roadmap_sync_status` before `roadmap_reconcile` when diagnosing
drift.

Reactions and duplicate counts are community signals. Never translate them
directly into priority or acceptance.

## Application repository inspection

Only inspect the separately configured application repository when the user
explicitly asks for codebase comparison, affected components, implementation
evidence, or outdated roadmap state.

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
- any remaining validation or verification gap.

Use `roadmap_history` for "what changed" questions instead of Git history.
