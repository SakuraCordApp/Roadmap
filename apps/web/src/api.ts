import {
  RoadmapConfigSchema,
  RoadmapItemSchema,
  type RoadmapConfig,
  type RoadmapItem,
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
  const query = new URLSearchParams(filters);
  query.set("limit", "250");
  const value = await request<{ data: unknown[] }>(`/api/v1/items?${query}`, signal);
  return z.array(RoadmapItemSchema).parse(value.data);
}

export async function fetchItem(id: string, signal?: AbortSignal): Promise<RoadmapItem> {
  const value = await request<{ data: unknown }>(`/api/v1/items/${encodeURIComponent(id)}`, signal);
  return RoadmapItemSchema.parse(value.data);
}

async function request<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal,
    cache: "no-cache",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    throw new Error(body.error?.message ?? `Request failed with status ${response.status}.`);
  }
  return (await response.json()) as T;
}

export type { RoadmapConfig };
