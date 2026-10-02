import { getState, setState } from "../db/store";
import type { Env } from "../env";
import { appJwt } from "./client";

/** The bot login of our GitHub App (e.g. "sakuracord-bot[bot]"). */
export async function appBotLogin(env: Env): Promise<string | null> {
  const cached = await getState(env.DB, "github:app-slug");
  if (cached) return `${cached}[bot]`;
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return null;
  const response = await fetch("https://api.github.com/app", {
    headers: {
      Authorization: `Bearer ${await appJwt(env)}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "SakuraCord-Hub",
    },
  });
  if (!response.ok) return null;
  const app = (await response.json()) as { slug: string };
  await setState(env.DB, "github:app-slug", app.slug);
  return `${app.slug}[bot]`;
}

export const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
