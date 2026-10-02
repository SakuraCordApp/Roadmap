export interface Env extends Cloudflare.Env {
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  GITHUB_APP_ID?: string;
  /** PKCS#8 PEM. GitHub issues PKCS#1 keys; setup converts them once. */
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  ROADMAP_ADMIN_TOKEN: string;
}
