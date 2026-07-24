import type { Actor, HistoryEntry, RoadmapItem } from "./schema.js";

export interface ListItemsQuery {
  status?: string[];
  area?: string[];
  type?: string[];
  priority?: string[];
  difficulty?: string[];
  search?: string;
  completedSince?: string;
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  data: T[];
  nextCursor?: string;
}

export interface AtomicMutation {
  item: RoadmapItem;
  expectedRevision: number | null;
  mutationId: string;
  action: HistoryEntry["action"];
  actor: Actor;
  overrideReason?: string;
}

export interface MutationResult {
  before: RoadmapItem | null;
  after: RoadmapItem;
  replayed: boolean;
}

export interface RoadmapStorage {
  list(query: ListItemsQuery): Promise<Page<RoadmapItem>>;
  get(id: string): Promise<RoadmapItem | null>;
  mutate(mutation: AtomicMutation): Promise<MutationResult>;
  history(itemId?: string, since?: string, limit?: number): Promise<HistoryEntry[]>;
  syncStatus(): Promise<{
    pending: number;
    processing: number;
    failed: number;
    lastSuccessfulAt: string | null;
  }>;
}
