# Contributing

Thank you for improving the roadmap platform.

## Principles

- Keep the deployed database canonical.
- Never create roadmap commits for item mutations.
- Keep project-specific values in typed configuration.
- Preserve stable IDs and audit history.
- Keep Discord, MCP, CLI, and web behavior behind shared core contracts.
- Do not add credentials, captured Discord authorization, production database
  exports, or private diagnostics.
- Treat application repositories as read-only evidence unless a separate task
  explicitly authorizes code changes there.

## Workflow

```sh
npm ci
npm run check
```

For a schema change, add a numbered migration and a fresh-database plus upgrade
test. For a new mutation, prove validation, expected revision, idempotency,
audit history, diff output, and synchronization behavior.

For Discord changes, use current official documentation and test rate limits,
pagination, archived threads, replay, mentions, and partial failure. Keep real
service tests explicit and reversible.

For public UI changes, preserve semantic landmarks, labels, keyboard focus,
responsive layout, reduced-motion behavior, and direct item URLs.

## Pull requests

Describe:

- the user-visible outcome;
- schema/API compatibility;
- security and synchronization impact;
- commands/tests run; and
- any live integration behavior that was not verified.

Do not claim a Cloudflare or Discord deployment works from mocked tests alone.
