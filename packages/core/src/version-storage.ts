import type { Actor } from "./schema.js";
import type { RoadmapVersion, RoadmapVersionHistoryEntry, RoadmapVersionState } from "./version.js";

export interface ListVersionsQuery {
  states?: RoadmapVersionState[];
  limit?: number;
}

export interface AtomicVersionMutation {
  version: RoadmapVersion;
  expectedRevision: number | null;
  mutationId: string;
  action: RoadmapVersionHistoryEntry["action"];
  actor: Actor;
  overrideReason?: string;
}

export interface VersionMutationResult {
  before: RoadmapVersion | null;
  after: RoadmapVersion;
  replayed: boolean;
}

export interface RoadmapVersionStorage {
  listVersions(query: ListVersionsQuery): Promise<RoadmapVersion[]>;
  getVersion(id: string): Promise<RoadmapVersion | null>;
  mutateVersion(mutation: AtomicVersionMutation): Promise<VersionMutationResult>;
  versionHistory(
    versionId?: string,
    since?: string,
    limit?: number,
  ): Promise<RoadmapVersionHistoryEntry[]>;
}
