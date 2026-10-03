import { sha256 } from "../util/crypto";

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/SakuraCordApp/Roadmap, 1.0)";

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface UploadFile {
  name: string;
  contentType?: string | null;
  data: Blob | ArrayBuffer;
}

interface RequestOptions {
  body?: unknown;
  files?: UploadFile[];
  reason?: string;
  /** Deterministic message nonce so retries never duplicate a message. */
  nonceKey?: string;
  /** Webhook token routes authenticate through the URL instead of the bot token. */
  noAuth?: boolean;
}

export class Discord {
  constructor(
    private readonly token: string,
    private readonly applicationId?: string,
  ) {}

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    let body = options.body;
    if (options.nonceKey && body && typeof body === "object") {
      body = {
        ...(body as Record<string, unknown>),
        nonce: (await sha256(options.nonceKey)).slice(0, 25),
        enforce_nonce: true,
      };
    }
    for (let attempt = 1; ; attempt += 1) {
      const headers: Record<string, string> = { "User-Agent": USER_AGENT };
      if (!options.noAuth) headers.Authorization = `Bot ${this.token}`;
      if (options.reason)
        headers["X-Audit-Log-Reason"] = encodeURIComponent(options.reason.slice(0, 400));
      let payload: BodyInit | undefined;
      if (options.files?.length) {
        const form = new FormData();
        form.append("payload_json", JSON.stringify(body ?? {}));
        options.files.forEach((file, index) => {
          const blob =
            file.data instanceof Blob
              ? file.data
              : new Blob([file.data], { type: file.contentType ?? "application/octet-stream" });
          form.append(`files[${index}]`, blob, file.name);
        });
        payload = form;
      } else if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const response = await fetch(`${API}${path}`, { method, headers, body: payload });
      if (response.status === 429 && attempt < 5) {
        const data = (await response.json().catch(() => ({}))) as { retry_after?: number };
        await sleep(Math.min(Math.ceil((data.retry_after ?? 1) * 1000) + 50, 15_000));
        continue;
      }
      if (response.status >= 500 && attempt < 4) {
        await sleep(300 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        const text = await response.text();
        let code: number | undefined;
        try {
          code = (JSON.parse(text) as { code?: number }).code;
        } catch {
          code = undefined;
        }
        throw new DiscordError(
          response.status,
          code,
          `Discord ${method} ${path} failed with ${response.status}: ${text.slice(0, 600)}`,
        );
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown, options: Omit<RequestOptions, "body"> = {}) {
    return this.request<T>("POST", path, { ...options, body });
  }
  patch<T>(path: string, body: unknown, options: Omit<RequestOptions, "body"> = {}) {
    return this.request<T>("PATCH", path, { ...options, body });
  }
  put<T>(path: string, body?: unknown, options: Omit<RequestOptions, "body"> = {}) {
    return this.request<T>("PUT", path, { ...options, body });
  }
  delete<T>(path: string, options: Omit<RequestOptions, "body"> = {}) {
    return this.request<T>("DELETE", path, options);
  }

  /** Edit the original response or a follow-up of an interaction. */
  async editInteractionResponse(token: string, body: unknown, messageId = "@original") {
    return this.request("PATCH", `/webhooks/${this.applicationId}/${token}/messages/${messageId}`, {
      body,
    });
  }

  async followUp(token: string, body: unknown) {
    return this.request("POST", `/webhooks/${this.applicationId}/${token}`, { body });
  }
}

export interface WebhookRef {
  id: string;
  token: string;
}

export interface WebhookMessage {
  content: string;
  username: string;
  avatar_url?: string | null;
}

/** Post, edit, or delete a webhook message inside a forum thread. */
export async function webhookRequest<T>(
  discord: Discord,
  method: "POST" | "PATCH" | "DELETE",
  webhook: WebhookRef,
  threadId: string,
  body?: WebhookMessage | Record<string, unknown>,
  messageId?: string,
): Promise<T> {
  const base = `/webhooks/${webhook.id}/${webhook.token}${messageId ? `/messages/${messageId}` : ""}`;
  const query = `?thread_id=${threadId}${method === "POST" ? "&wait=true" : ""}`;
  return discord.request<T>(method, `${base}${query}`, {
    ...(body ? { body: { allowed_mentions: { parse: [] }, ...body } } : {}),
    noAuth: true,
  });
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const noMentions = { parse: [] as string[], replied_user: false };

export function mentionUsers(userIds: string[]) {
  return { parse: [] as string[], users: [...new Set(userIds)].slice(0, 100), replied_user: false };
}

export function isDiscordStatus(error: unknown, status: number): boolean {
  return error instanceof DiscordError && error.status === status;
}

/** Run a Discord write against a thread that may be archived or locked. */
export async function withWritableThread<T>(
  discord: Discord,
  threadId: string,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof DiscordError) || ![50083, 50001, 160005].includes(error.code ?? 0)) {
      throw error;
    }
    const thread = await discord.get<{
      thread_metadata?: { archived?: boolean; locked?: boolean };
    }>(`/channels/${threadId}`);
    await discord.patch(`/channels/${threadId}`, { archived: false, locked: false });
    try {
      return await write();
    } finally {
      await discord.patch(`/channels/${threadId}`, {
        archived: Boolean(thread.thread_metadata?.archived),
        locked: Boolean(thread.thread_metadata?.locked),
      });
    }
  }
}
