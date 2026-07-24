export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ROADMAP_PUBLIC_URL?: string;
  ROADMAP_ALLOWED_ORIGINS?: string;
  ROADMAP_GATEWAY_PROVIDER?: "cloudflare" | "node" | "disabled";
  ROADMAP_DISCORD_BOT_URL?: string;
  ROADMAP_ADMIN_TOKEN?: string;
  ROADMAP_GATEWAY_INGEST_SECRET?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  ROADMAP_OAUTH_ENCRYPTION_KEY?: string;
  GITHUB_RELEASE_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}
