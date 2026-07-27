interface SecretBindings {
  ROADMAP_ADMIN_TOKEN?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  ROADMAP_OAUTH_ENCRYPTION_KEY?: string;
  GITHUB_RELEASE_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}

type RuntimeOverrides = {
  ROADMAP_PUBLIC_URL?: string;
  ROADMAP_ALLOWED_ORIGINS?: string;
  ROADMAP_GATEWAY_PROVIDER?: "cloudflare" | "disabled";
  PUBLIC_RATE_LIMITER?: RateLimit;
  MUTATION_RATE_LIMITER?: RateLimit;
};

export type Env = Omit<
  Cloudflare.Env,
  | "ROADMAP_PUBLIC_URL"
  | "ROADMAP_ALLOWED_ORIGINS"
  | "ROADMAP_GATEWAY_PROVIDER"
  | "PUBLIC_RATE_LIMITER"
  | "MUTATION_RATE_LIMITER"
> &
  RuntimeOverrides &
  SecretBindings;
