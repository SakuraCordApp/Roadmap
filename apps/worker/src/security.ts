import nacl from "tweetnacl";
import type { Actor } from "@roadmap/core";
import { AuthorizationError, RoadmapError } from "@roadmap/core";
import type { Env } from "./env.js";

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index++) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

export async function authenticateMaintainer(request: Request, env: Env): Promise<Actor> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) throw new AuthorizationError();
  const token = authorization.slice(7);
  if (token.length < 24) throw new AuthorizationError("The maintainer token is malformed.");
  if (env.ROADMAP_ADMIN_TOKEN && constantTimeEqual(token, env.ROADMAP_ADMIN_TOKEN)) {
    return {
      id: "bootstrap-admin",
      displayName: "Bootstrap administrator",
      kind: "maintainer",
    };
  }
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT id, display_name FROM maintainer_tokens
     WHERE token_hash=? AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  )
    .bind(hash)
    .first<{ id: string; display_name: string }>();
  if (!row) throw new AuthorizationError("The maintainer token is invalid or expired.");
  return { id: row.id, displayName: row.display_name, kind: "maintainer" };
}

export function assertMutationOrigin(request: Request, allowedOrigins: string[]): void {
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigins.includes(origin)) {
    throw new AuthorizationError("This request origin is not allowed.");
  }
  if (request.headers.has("Cookie")) {
    throw new RoadmapError(
      "COOKIE_AUTH_DISABLED",
      "Mutation endpoints only accept bearer authentication; cookies are rejected.",
      400,
    );
  }
}

export async function verifyDiscordInteraction(
  request: Request,
  publicKey: string,
  body: string,
): Promise<void> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) {
    throw new RoadmapError("INVALID_SIGNATURE", "Missing Discord signature headers.", 401);
  }
  const age = Math.abs(Date.now() - Number(timestamp) * 1_000);
  if (!Number.isFinite(age) || age > 5 * 60_000) {
    throw new RoadmapError("STALE_INTERACTION", "Discord interaction timestamp is stale.", 401);
  }
  const verified = nacl.sign.detached.verify(
    new TextEncoder().encode(timestamp + body),
    fromHex(signature),
    fromHex(publicKey),
  );
  if (!verified) throw new RoadmapError("INVALID_SIGNATURE", "Invalid Discord signature.", 401);
}

export async function verifyGatewaySignature(
  request: Request,
  secret: string,
  body: string,
): Promise<string> {
  const timestamp = request.headers.get("X-Roadmap-Timestamp");
  const nonce = request.headers.get("X-Roadmap-Nonce");
  const signature = request.headers.get("X-Roadmap-Signature");
  if (!timestamp || !nonce || !signature) {
    throw new RoadmapError("INVALID_GATEWAY_SIGNATURE", "Missing gateway signature headers.", 401);
  }
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) {
    throw new RoadmapError("STALE_GATEWAY_EVENT", "Gateway event timestamp is stale.", 401);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${nonce}.${body}`),
  );
  const expectedHex = [...new Uint8Array(expected)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (!constantTimeEqual(expectedHex, signature)) {
    throw new RoadmapError("INVALID_GATEWAY_SIGNATURE", "Invalid gateway signature.", 401);
  }
  return nonce;
}

export async function consumeReplayNonce(env: Env, nonce: string, ttlSeconds = 600): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO replay_nonces(nonce, expires_at)
       VALUES (?, datetime('now', ?))`,
    )
      .bind(nonce, `+${ttlSeconds} seconds`)
      .run();
  } catch {
    throw new RoadmapError("REPLAYED_REQUEST", "This signed request was already processed.", 409);
  }
}

export async function enforceRateLimit(
  env: Env,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  const windowStart = now - (now % windowSeconds);
  await env.DB.prepare(
    `INSERT INTO rate_limit_windows(bucket, window_start, count) VALUES(?,?,1)
     ON CONFLICT(bucket, window_start) DO UPDATE SET count=count+1`,
  )
    .bind(bucket, windowStart)
    .run();
  const row = await env.DB.prepare(
    "SELECT count FROM rate_limit_windows WHERE bucket=? AND window_start=?",
  )
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > limit) {
    throw new RoadmapError("RATE_LIMITED", "Too many requests. Try again later.", 429, {
      retryAfterSeconds: windowSeconds - (now - windowStart),
    });
  }
}

export function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bot\s+[A-Za-z0-9._-]+/gi, "Bot [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/[A-Fa-f0-9]{64,}/g, "[REDACTED]");
}

function fromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return new Uint8Array();
  return new Uint8Array(value.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}
