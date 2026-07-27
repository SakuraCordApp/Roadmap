import { RoadmapError } from "@roadmap/core";

const API_BASE = "https://discord.com/api/v10";

export interface DiscordRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  auditReason?: string;
  idempotencyKey?: string;
}

export class DiscordRestClient {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async request<T>(path: string, options: DiscordRequestOptions = {}): Promise<T> {
    const body = options.idempotencyKey
      ? await withMessageIdempotency(options.body, options.idempotencyKey)
      : options.body;
    let attempt = 0;
    while (attempt < 5) {
      attempt += 1;
      // Cloudflare native functions reject being invoked as arbitrary object
      // methods because that changes their `this` receiver.
      const fetcher = this.fetcher;
      const response = await fetcher(`${API_BASE}${path}`, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bot ${this.token}`,
          "User-Agent": "SakuraCordRoadmap (https://github.com/SakuraCord/roadmap, 0.1.0)",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.auditReason
            ? { "X-Audit-Log-Reason": encodeURIComponent(options.auditReason.slice(0, 512)) }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 429) {
        const payload = (await response.json().catch(() => ({}))) as { retry_after?: number };
        const retryMs = Math.ceil((payload.retry_after ?? 1) * 1_000);
        await new Promise((resolve) => setTimeout(resolve, Math.min(retryMs, 30_000)));
        continue;
      }
      if (response.status >= 500 && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        continue;
      }
      if (!response.ok) {
        const text = await response.text();
        throw new RoadmapError(
          "DISCORD_API_ERROR",
          `Discord ${options.method ?? "GET"} ${path} failed with ${response.status}.`,
          502,
          { status: response.status, response: text.slice(0, 2_000) },
        );
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
    throw new RoadmapError("DISCORD_RETRY_EXHAUSTED", "Discord retry budget was exhausted.", 502);
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  patch<T>(path: string, body: unknown, auditReason?: string): Promise<T> {
    return this.request<T>(path, {
      method: "PATCH",
      body,
      ...(auditReason ? { auditReason } : {}),
    });
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: "PUT", ...(body === undefined ? {} : { body }) });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }
}

export function safeAllowedMentions() {
  return { parse: [] as string[], replied_user: false };
}

async function withMessageIdempotency(
  body: unknown,
  key: string,
): Promise<Record<string, unknown>> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RoadmapError(
      "DISCORD_IDEMPOTENCY_INVALID",
      "Discord message idempotency requires an object request body.",
      500,
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const nonce = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 25);
  return {
    ...(body as Record<string, unknown>),
    nonce,
    enforce_nonce: true,
  };
}
