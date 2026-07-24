import { ulid } from "ulid";
import type { RoadmapConfig } from "./config.js";
import { validateItemAgainstConfig } from "./config.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import {
  CreateRoadmapItemSchema,
  RoadmapItemSchema,
  RoadmapPatchSchema,
  type Actor,
  type CreateRoadmapItem,
  type RoadmapItem,
  type RoadmapPatch,
} from "./schema.js";
import type { ListItemsQuery, MutationResult, RoadmapStorage } from "./storage.js";

export interface MutationContext {
  actor: Actor;
  mutationId: string;
  overrideReason?: string;
}

export class RoadmapEngine {
  constructor(
    private readonly storage: RoadmapStorage,
    private readonly config: RoadmapConfig,
  ) {}

  list(query: ListItemsQuery) {
    return this.storage.list(query);
  }

  async get(id: string): Promise<RoadmapItem> {
    const item = await this.storage.get(id);
    if (!item) throw new NotFoundError(`Roadmap item ${id}`);
    return item;
  }

  history(itemId?: string, since?: string, limit?: number) {
    return this.storage.history(itemId, since, limit);
  }

  syncStatus() {
    return this.storage.syncStatus();
  }

  async create(input: CreateRoadmapItem, context: MutationContext): Promise<MutationResult> {
    const parsed = CreateRoadmapItemSchema.parse(input);
    const now = new Date().toISOString();
    const item: RoadmapItem = {
      ...parsed,
      id: `${this.config.project.idPrefix}-${ulid()}`,
      confidence: parsed.confidence ?? 50,
      progress: parsed.progress ?? {
        value: 0,
        basis: "manual",
        evidence: [],
        rationale: "Initial assessment at roadmap item creation.",
        assessedAt: now,
      },
      proposedImplementation: parsed.proposedImplementation ?? "",
      labels: parsed.labels ?? [],
      affectedComponents: parsed.affectedComponents ?? [],
      dependencies: parsed.dependencies ?? [],
      risks: parsed.risks ?? [],
      requiredResearch: parsed.requiredResearch ?? [],
      references: parsed.references ?? [],
      acceptanceCriteria: parsed.acceptanceCriteria ?? [],
      verificationResults: parsed.verificationResults ?? [],
      benchmarks: parsed.benchmarks ?? [],
      relatedCommits: parsed.relatedCommits ?? [],
      relatedPullRequests: parsed.relatedPullRequests ?? [],
      linkedDiscordThreads: parsed.linkedDiscordThreads ?? [],
      communityReactionCount: parsed.communityReactionCount ?? 0,
      duplicateReportCount: parsed.duplicateReportCount ?? 0,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    this.validate(item);
    return this.storage.mutate({
      item,
      expectedRevision: null,
      mutationId: context.mutationId,
      action: "create",
      actor: context.actor,
      overrideReason: context.overrideReason,
    });
  }

  async update(
    id: string,
    patch: RoadmapPatch,
    expectedRevision: number,
    context: MutationContext,
  ): Promise<MutationResult> {
    const before = await this.get(id);
    if (before.revision !== expectedRevision) {
      throw new ConflictError(`Expected revision ${expectedRevision}, found ${before.revision}.`, {
        current: before,
      });
    }
    const safePatch = RoadmapPatchSchema.parse(patch);
    if (safePatch.status && safePatch.status !== before.status) {
      throw new ValidationError("Use the transition operation to change lifecycle state.");
    }
    const after = RoadmapItemSchema.parse({
      ...before,
      ...safePatch,
      id: before.id,
      createdAt: before.createdAt,
      updatedAt: new Date().toISOString(),
      revision: before.revision + 1,
    });
    this.validate(after);
    return this.storage.mutate({
      item: after,
      expectedRevision,
      mutationId: context.mutationId,
      action: "update",
      actor: context.actor,
      overrideReason: context.overrideReason,
    });
  }

  async transition(
    id: string,
    to: string,
    expectedRevision: number,
    context: MutationContext,
  ): Promise<MutationResult> {
    const before = await this.get(id);
    if (before.revision !== expectedRevision) {
      throw new ConflictError(`Expected revision ${expectedRevision}, found ${before.revision}.`, {
        current: before,
      });
    }
    const fromState = this.config.lifecycle.find((state) => state.id === before.status);
    const toState = this.config.lifecycle.find((state) => state.id === to);
    if (!fromState || !toState) throw new ValidationError(`Unknown lifecycle state: ${to}`);
    if (!fromState.transitionsTo.includes(to) && !context.overrideReason) {
      throw new ValidationError(
        `Transition ${before.status} → ${to} is not allowed without an override reason.`,
      );
    }
    if (toState.completionGate) {
      const criteriaSatisfied =
        before.acceptanceCriteria.length > 0 &&
        before.acceptanceCriteria.every((criterion) => criterion.satisfied);
      const verified = before.verificationResults.some((result) => result.result === "passed");
      if ((!criteriaSatisfied || !verified) && !context.overrideReason) {
        throw new ValidationError(
          "Moving an item to done requires satisfied acceptance criteria and a passing verification. Provide an explicit override reason if necessary.",
          { criteriaSatisfied, verified },
        );
      }
    }
    const now = new Date().toISOString();
    const after = RoadmapItemSchema.parse({
      ...before,
      status: to,
      completedAt: to === "done" ? now : undefined,
      updatedAt: now,
      revision: before.revision + 1,
    });
    this.validate(after);
    return this.storage.mutate({
      item: after,
      expectedRevision,
      mutationId: context.mutationId,
      action: "transition",
      actor: context.actor,
      overrideReason: context.overrideReason,
    });
  }

  private validate(item: RoadmapItem): void {
    const errors = validateItemAgainstConfig(item, this.config);
    for (const dependency of item.dependencies) {
      if (dependency === item.id) errors.push("An item cannot depend on itself.");
    }
    if (errors.length > 0) throw new ValidationError("Roadmap item is invalid.", errors);
  }
}
