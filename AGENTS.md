# Repository instructions

## Deployment

- Never deploy directly to Cloudflare from a local agent session.
- Do not run `wrangler deploy`, `wrangler d1 migrations apply --remote`, or any equivalent command that mutates the production Cloudflare environment.
- Production deployments must go through the repository's automated GitHub deployment flow.
- When a validated change should be deployed, commit and push it to GitHub instead.
- Cloudflare dry-run builds and local-only migrations are allowed for validation.
