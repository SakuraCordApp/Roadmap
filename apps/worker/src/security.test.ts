import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { verifyDiscordInteraction, verifyGatewaySignature } from "./security.js";

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

  it("verifies HMAC gateway ingress and rejects stale timestamps", async () => {
    const secret = "a".repeat(40);
    const body = JSON.stringify({ event: "THREAD_CREATE" });
    const timestamp = String(Date.now());
    const nonce = "nonce-123";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${nonce}.${body}`),
    );
    const request = new Request("https://example.com/api/internal/discord/events", {
      method: "POST",
      headers: {
        "X-Roadmap-Timestamp": timestamp,
        "X-Roadmap-Nonce": nonce,
        "X-Roadmap-Signature": hex(new Uint8Array(signature)),
      },
      body,
    });
    await expect(verifyGatewaySignature(request, secret, body)).resolves.toBe(nonce);
    const stale = new Request(request.url, {
      method: "POST",
      headers: {
        "X-Roadmap-Timestamp": "1",
        "X-Roadmap-Nonce": nonce,
        "X-Roadmap-Signature": "00".repeat(32),
      },
      body,
    });
    await expect(verifyGatewaySignature(stale, secret, body)).rejects.toMatchObject({
      code: "STALE_GATEWAY_EVENT",
    });
  });
});

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
