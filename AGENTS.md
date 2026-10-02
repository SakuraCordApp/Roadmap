# Repository instructions

## Deployment

- Never deploy directly to Cloudflare from a local agent session.
- Do not run `wrangler deploy`, `wrangler d1 migrations apply --remote`, or any equivalent command that mutates the production Cloudflare environment.
- Production deployments must go through the repository's automated GitHub deployment flow.
- When a validated change should be deployed, commit and push it to GitHub instead.
- Cloudflare dry-run builds and local-only migrations are allowed for validation.

## Hub specifics

- GitHub Issues in `SakuraCordApp/SakuraCord` are canonical. D1 only stores
  links, votes, cursors, and a read cache; never treat it as the source of truth.
- Keep every Worker invocation within the Workers Free limits: 50 D1 statements,
  50 subrequests, and 10 ms CPU. Fan bulk work out into jobs (`enqueueMany`).
- One-time production setup that cannot run in Workers Builds (secrets, the
  Vectorize index) is done by the maintainer or with their explicit approval.
