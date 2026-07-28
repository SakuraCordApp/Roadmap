import type {
  AcceptanceCriterion,
  CreateRoadmapItem,
  DiscordThreadLink,
  RoadmapPatch,
} from "@roadmap/core";

export class RoadmapApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  list(filters: Record<string, string | number | undefined> = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) query.set(key, String(value));
    }
    return this.request(`/api/v1/items?${query}`);
  }

  get(id: string) {
    return this.request(`/api/v1/items/${encodeURIComponent(id)}`);
  }

  search(query: string, filters: Record<string, string | undefined> = {}) {
    return this.list({ ...filters, search: query });
  }

  create(item: CreateRoadmapItem) {
    return this.request("/api/v1/items", {
      method: "POST",
      body: item,
      mutation: true,
    });
  }

  update(id: string, expectedRevision: number, patch: RoadmapPatch, overrideReason?: string) {
    return this.request(`/api/v1/items/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { expectedRevision, patch, ...(overrideReason ? { overrideReason } : {}) },
      mutation: true,
    });
  }

  transition(id: string, expectedRevision: number, to: string, overrideReason?: string) {
    return this.request(`/api/v1/items/${encodeURIComponent(id)}/transition`, {
      method: "POST",
      body: { expectedRevision, to, ...(overrideReason ? { overrideReason } : {}) },
      mutation: true,
    });
  }

  linkDiscord(id: string, expectedRevision: number, thread: DiscordThreadLink) {
    return this.request(`/api/v1/items/${encodeURIComponent(id)}/link-discord`, {
      method: "POST",
      body: { expectedRevision, thread },
      mutation: true,
    });
  }

  addCriterion(
    id: string,
    expectedRevision: number,
    criterion: Omit<AcceptanceCriterion, "id" | "updatedAt">,
  ) {
    return this.request(`/api/v1/items/${encodeURIComponent(id)}/acceptance-criteria`, {
      method: "POST",
      body: { expectedRevision, criterion },
      mutation: true,
    });
  }

  projection() {
    return this.request("/api/v1/discord/projection");
  }

  validate(item: unknown) {
    return this.request("/api/v1/validate", { method: "POST", body: item });
  }

  syncStatus() {
    return this.request("/api/v1/sync/status");
  }

  reconcile() {
    return this.request("/api/v1/reconcile", { method: "POST", mutation: true, body: {} });
  }

  history(itemId?: string, since?: string, limit = 100) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (itemId) query.set("itemId", itemId);
    if (since) query.set("since", since);
    return this.request(`/api/v1/history?${query}`);
  }

  private async request(
    path: string,
    options: { method?: string; body?: unknown; mutation?: boolean } = {},
  ): Promise<unknown> {
    if (options.mutation && !this.token) {
      throw new Error("ROADMAP_TOKEN is required for roadmap mutations.");
    }
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(options.mutation ? { "Idempotency-Key": `mcp-${crypto.randomUUID()}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; details?: unknown };
    };
    if (!response.ok) {
      throw new Error(
        `${payload.error?.message ?? `Roadmap API returned HTTP ${response.status}`}${
          payload.error?.details ? ` ${JSON.stringify(payload.error.details)}` : ""
        }`,
      );
    }
    return payload;
  }
}
