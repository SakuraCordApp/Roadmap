import { getJsonState, setState } from "../db/store";
import { discordClient } from "../discord/threads";
import type { Env } from "../env";
import { errorMessage } from "../util/http";
import { FEED_EMOJI_IMAGES } from "./feed-emoji-assets";

// CI status marks are application emoji, so the bot can use them in any
// channel without spending server emoji slots. Missing ones are uploaded from
// the bundled images the first time a card needs them.

export type CheckState = "success" | "failure" | "skipped" | "queued" | "running";
export type FeedEmoji = Record<CheckState, string>;

const CACHE_KEY = "discord:feed-emoji:v1";

export const FALLBACK_EMOJI: FeedEmoji = {
  success: "✅",
  failure: "❌",
  skipped: "⚪",
  queued: "🕓",
  running: "🟡",
};

export async function feedEmoji(env: Env): Promise<FeedEmoji> {
  const cached = await getJsonState<FeedEmoji | null>(env.DB, CACHE_KEY, null);
  if (cached) return cached;
  try {
    const discord = discordClient(env);
    const path = `/applications/${env.DISCORD_APPLICATION_ID}/emojis`;
    const { items } = await discord.get<{
      items: Array<{ id: string; name: string; animated?: boolean }>;
    }>(path);
    const byName = new Map(items.map((emoji) => [emoji.name, emoji]));
    const result = { ...FALLBACK_EMOJI };
    for (const [name, image] of Object.entries(FEED_EMOJI_IMAGES)) {
      const emoji =
        byName.get(name) ??
        (await discord.post<{ id: string; name: string; animated?: boolean }>(path, {
          name,
          image,
        }));
      result[name.slice(3) as CheckState] =
        `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
    }
    await setState(env.DB, CACHE_KEY, JSON.stringify(result));
    return result;
  } catch (error) {
    console.error("Feed emoji unavailable; using fallbacks", errorMessage(error));
    return FALLBACK_EMOJI;
  }
}
