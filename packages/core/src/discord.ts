import { z } from "zod";

export const DiscordAttachmentSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    content_type: z.string().optional(),
    size: z.number().int().nonnegative(),
    url: z.url(),
    proxy_url: z.url().optional(),
    description: z.string().optional(),
  })
  .strict();

export const DiscordGatewayEventSchema = z
  .object({
    eventId: z.string().min(1).max(200),
    sequence: z.number().int().nullable(),
    type: z.enum([
      "THREAD_CREATE",
      "THREAD_UPDATE",
      "THREAD_DELETE",
      "THREAD_LIST_SYNC",
      "MESSAGE_CREATE",
      "MESSAGE_UPDATE",
      "MESSAGE_DELETE",
      "MESSAGE_REACTION_ADD",
      "MESSAGE_REACTION_REMOVE",
      "MESSAGE_REACTION_REMOVE_ALL",
    ]),
    occurredAt: z.iso.datetime(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export type DiscordGatewayEvent = z.infer<typeof DiscordGatewayEventSchema>;

export interface GatewayEventProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ connected: boolean; sessionId?: string; lastSequence?: number }>;
}

export interface DiscordPublisher {
  publishRoadmap(force?: boolean): Promise<{ changed: boolean; hash: string; messageId?: string }>;
  syncItem(itemId: string): Promise<void>;
  reconcile(): Promise<{ threads: number; messages: number; errors: string[] }>;
}
