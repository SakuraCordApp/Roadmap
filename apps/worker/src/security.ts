import nacl from "tweetnacl";
import type { Actor } from "@roadmap/core";
import { AuthorizationError, RoadmapError } from "@roadmap/core";
import type { Env } from "./env.js";

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let mismatch = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    mismatch |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return mismatch === 0;
}

export async function authenticateMaintainer(request: Request, env: Env): Promise<Actor> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) throw new AuthorizationError();
  const token = authorization.slice(7);
  if (token.length < 24) throw new AuthorizationError("The maintainer token is malformed.");
  if (env.ROADMAP_ADMIN_TOKEN && (await constantTimeEqual(token, env.ROADMAP_ADMIN_TOKEN))) {
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
  if (
    !/^\d{1,20}$/.test(timestamp) ||
    !/^[0-9a-f]{128}$/i.test(signature) ||
    !/^[0-9a-f]{64}$/i.test(publicKey)
  ) {
    throw new RoadmapError("INVALID_SIGNATURE", "Malformed Discord signature headers.", 401);
  }
  const age = Math.abs(Date.now() - Number(timestamp) * 1_000);
  if (!Number.isFinite(age) || age > 5 * 60_000) {
    throw new RoadmapError("STALE_INTERACTION", "Discord interaction timestamp is stale.", 401);
  }
  let verified: boolean;
  try {
    verified = nacl.sign.detached.verify(
      new TextEncoder().encode(timestamp + body),
      fromHex(signature),
      fromHex(publicKey),
    );
  } catch {
    throw new RoadmapError("INVALID_SIGNATURE", "Malformed Discord signature.", 401);
  }
  if (!verified) throw new RoadmapError("INVALID_SIGNATURE", "Invalid Discord signature.", 401);
}

export async function enforceRateLimit(
  env: Env,
  bucket: string,
  limit: number,
  windowSeconds: number,
  binding?: RateLimit,
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  const windowStart = now - (now % windowSeconds);
  if (binding) {
    const outcome = await binding.limit({ key: bucket });
    if (!outcome.success) {
      throw new RoadmapError("RATE_LIMITED", "Too many requests. Try again later.", 429, {
        retryAfterSeconds: windowSeconds - (now - windowStart),
      });
    }
    return;
  }
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
  return new Uint8Array(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}
