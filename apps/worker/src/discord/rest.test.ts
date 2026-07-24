import { describe, expect, it, vi } from "vitest";
import { DiscordRestClient } from "./rest.js";

describe("Discord REST transport", () => {
  it("invokes a Cloudflare-style fetch function without rebinding its receiver", async () => {
    const fetcher = vi.fn(function (this: unknown) {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(Response.json({ id: "message-id" }));
    }) as unknown as typeof fetch;
    const client = new DiscordRestClient("test-token", fetcher);

    await expect(
      client.post("/channels/channel-id/messages", { content: "Roadmap" }),
    ).resolves.toEqual({ id: "message-id" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not claim an empty DELETE request contains JSON", async () => {
    const fetcher = vi.fn(async (_input, init) => {
      expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
      expect(init?.body).toBeUndefined();
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await new DiscordRestClient("test-token", fetcher).delete("/guilds/guild/emojis/emoji");

    expect(fetcher).toHaveBeenCalledOnce();
  });
});
