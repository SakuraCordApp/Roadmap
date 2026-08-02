import { ulid } from "ulid";
import type { RoadmapConfig } from "./config.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import type { MutationContext } from "./engine.js";
import {
  CreateRoadmapVersionSchema,
  RoadmapVersionPatchSchema,
  RoadmapVersionSchema,
  type CreateRoadmapVersion,
  type RoadmapVersion,
  type RoadmapVersionPatch,
  type RoadmapVersionState,
} from "./version.js";
import type {
  ListVersionsQuery,
  RoadmapVersionStorage,
  VersionMutationResult,
} from "./version-storage.js";

const TRANSITIONS: Record<RoadmapVersionState, RoadmapVersionState[]> = {
  draft: ["planned", "cancelled"],
  planned: ["draft", "released", "cancelled"],
  released: ["planned"],
  cancelled: ["draft", "planned"],
};

export class RoadmapVersionEngine {
  constructor(
    private readonly storage: RoadmapVersionStorage,
    private readonly config: RoadmapConfig,
  ) {}

  list(query: ListVersionsQuery = {}) {
    return this.storage.listVersions(query);
  }

  async get(id: string): Promise<RoadmapVersion> {
    const version = await this.storage.getVersion(id);
    if (!version) throw new NotFoundError(`Roadmap version ${id}`);
    return version;
  }

  history(versionId?: string, since?: string, limit?: number) {
    return this.storage.versionHistory(versionId, since, limit);
  }

  async create(
    input: CreateRoadmapVersion,
    context: MutationContext,
  ): Promise<VersionMutationResult> {
    const parsed = CreateRoadmapVersionSchema.parse(input);
    if (parsed.state === "planned" && parsed.highlights.length === 0 && !context.overrideReason) {
      throw new ValidationError(
        "Publishing a roadmap version requires at least one public highlight.",
      );
    }
    const now = new Date().toISOString();
    const version = RoadmapVersionSchema.parse({
      ...parsed,
      id: `${this.config.project.idPrefix}V-${ulid()}`,
      highlights: parsed.highlights.map((highlight) => ({
        ...highlight,
        id: crypto.randomUUID(),
      })),
      createdAt: now,
      updatedAt: now,
      revision: 1,
    });
    return this.storage.mutateVersion({
      version,
      expectedRevision: null,
      mutationId: context.mutationId,
      action: "create",
      actor: context.actor,
      overrideReason: context.overrideReason,
    });
  }

  async update(
    id: string,
    patch: RoadmapVersionPatch,
    expectedRevision: number,
    context: MutationContext,
  ): Promise<VersionMutationResult> {
    const before = await this.get(id);
    this.assertRevision(before, expectedRevision);
    const safePatch = RoadmapVersionPatchSchema.parse(patch);
    const after = RoadmapVersionSchema.parse({
      ...before,
      ...safePatch,
      id: before.id,
      state: before.state,
      createdAt: before.createdAt,
      updatedAt: new Date().toISOString(),
      revision: before.revision + 1,
    });
    return this.storage.mutateVersion({
      version: after,
      expectedRevision,
      mutationId: context.mutationId,
      action: "update",
      actor: context.actor,
      overrideReason: context.overrideReason,
    });
  }

  async transition(
    id: string,
    to: RoadmapVersionState,
    expectedRevision: number,
    context: MutationContext,
    release?: { releaseUrl?: string; releasedAt?: string },
  ): Promise<VersionMutationResult> {
    const before = await this.get(id);
    this.assertRevision(before, expectedRevision);
    if (!TRANSITIONS[before.state].includes(to) && !context.overrideReason) {
      throw new ValidationError(
        `Transition ${before.state} -> ${to} is not allowed without an override reason.`,
      );
    }
    if (to === "planned" && before.highlights.length === 0 && !context.overrideReason) {
      throw new ValidationError(
        "Publishing a roadmap version requires at least one public highlight.",
      );
    }
    const now = new Date().toISOString();
    const after = RoadmapVersionSchema.parse({
      ...before,
      state: to,
      releaseUrl:
        to === "released" ? (release?.releaseUrl ?? before.releaseUrl) : before.releaseUrl,
      releasedAt:
        to === "released"
          ? (release?.releasedAt ?? now)
          : to === "planned"
            ? undefined
            : before.releasedAt,
      updatedAt: now,
      revision: before.revision + 1,
    });
    return this.storage.mutateVersion({
      version: after,
      expectedRevision,
      mutationId: context.mutationId,
      action: "transition",
      actor: context.actor,
      overrideReason: context.overrideReason,
    });
  }

  private assertRevision(version: RoadmapVersion, expectedRevision: number) {
    if (version.revision !== expectedRevision) {
      throw new ConflictError(`Expected revision ${expectedRevision}, found ${version.revision}.`, {
        current: version,
      });
    }
  }
}
