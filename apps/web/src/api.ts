import {
  RoadmapConfigSchema,
  RoadmapItemSchema,
  RoadmapVersionSchema,
  type RoadmapConfig,
  type RoadmapItem,
  type RoadmapVersion,
} from "@roadmap/core";
import { z } from "zod";

const PublicConfigSchema = RoadmapConfigSchema.omit({
  discord: true,
  auth: true,
  deployment: true,
});

export type PublicConfig = z.infer<typeof PublicConfigSchema>;

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export async function fetchConfig(signal?: AbortSignal): Promise<PublicConfig> {
  const value = await request<unknown>("/api/v1/config", signal);
  return PublicConfigSchema.parse(value);
}

export async function fetchItems(
  filters: Record<string, string>,
  signal?: AbortSignal,
): Promise<RoadmapItem[]> {
  const items: RoadmapItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams(filters);
    query.set("limit", "250");
    if (cursor) query.set("cursor", cursor);
    const value = await request<{ data: unknown[]; nextCursor?: string }>(
      `/api/v1/items?${query}`,
      signal,
    );
    items.push(...z.array(RoadmapItemSchema).parse(value.data));
    cursor = value.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error("The roadmap API returned a repeated cursor.");
      seenCursors.add(cursor);
    }
  } while (cursor);
  return items;
}

export async function fetchItem(id: string, signal?: AbortSignal): Promise<RoadmapItem> {
  const value = await request<{ data: unknown }>(`/api/v1/items/${encodeURIComponent(id)}`, signal);
  return RoadmapItemSchema.parse(value.data);
}

export async function fetchVersions(signal?: AbortSignal): Promise<RoadmapVersion[]> {
  const value = await request<{ data: unknown[] }>("/api/v1/versions", signal);
  return z.array(RoadmapVersionSchema).parse(value.data);
}

export function watchVersions(onVersions: (versions: RoadmapVersion[]) => void): () => void {
  if (typeof EventSource === "undefined") {
    const interval = window.setInterval(() => {
      void fetchVersions()
        .then(onVersions)
        .catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(interval);
  }

  const source = new EventSource("/api/v1/versions/events");
  const receiveVersions = (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as { data?: unknown };
      onVersions(z.array(RoadmapVersionSchema).parse(payload.data));
    } catch {
      // Keep the last valid snapshot and let EventSource reconnect.
    }
  };
  source.addEventListener("versions", receiveVersions as EventListener);
  return () => source.close();
}

async function request<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    throw new Error(body.error?.message ?? `Request failed with status ${response.status}.`);
  }
  return (await response.json()) as T;
}

export type { RoadmapConfig };
