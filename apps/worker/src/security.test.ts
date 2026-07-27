import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { verifyDiscordInteraction } from "./security.js";

describe("signed ingress security", () => {
  it("verifies current Discord Ed25519 requests and rejects tampering", async () => {
    const pair = nacl.sign.keyPair();
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const body = JSON.stringify({ type: 1 });
    const signature = nacl.sign.detached(
      new TextEncoder().encode(timestamp + body),
      pair.secretKey,
    );
    const request = new Request("https://example.com/interactions/discord", {
      method: "POST",
      headers: {
        "X-Signature-Timestamp": timestamp,
        "X-Signature-Ed25519": hex(signature),
      },
      body,
    });
    await expect(
      verifyDiscordInteraction(request, hex(pair.publicKey), body),
    ).resolves.toBeUndefined();
    await expect(
      verifyDiscordInteraction(request, hex(pair.publicKey), `${body} `),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
  });

  it("rejects malformed Discord signatures as authentication failures", async () => {
    const request = new Request("https://example.com/interactions/discord", {
      method: "POST",
      headers: {
        "X-Signature-Timestamp": String(Math.floor(Date.now() / 1_000)),
        "X-Signature-Ed25519": "00",
      },
      body: "{}",
    });
    await expect(verifyDiscordInteraction(request, "00".repeat(32), "{}")).rejects.toMatchObject({
      code: "INVALID_SIGNATURE",
      status: 401,
    });
  });
});

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
