import { z } from "zod";

const NonEmpty = z.string().trim().min(1);
const Url = z.httpUrl();

export const ActorSchema = z
  .object({
    id: NonEmpty.max(128),
    displayName: NonEmpty.max(128),
    kind: z.enum(["maintainer", "discord", "mcp", "cli", "system"]),
  })
  .strict();

export const EvidenceReferenceSchema = z
  .object({
    kind: z.enum(["test", "commit", "pull_request", "benchmark", "research", "manual"]),
    label: NonEmpty.max(256),
    url: Url.optional(),
    value: z.string().max(10_000).optional(),
  })
  .strict();

export const AcceptanceCriterionSchema = z
  .object({
    id: NonEmpty.max(64),
    statement: NonEmpty.max(2_000),
    satisfied: z.boolean().default(false),
    evidence: z.array(EvidenceReferenceSchema).max(50).default([]),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const DiscordThreadLinkSchema = z
  .object({
    threadId: z.string().regex(/^\d{17,20}$/),
    forumId: z.string().regex(/^\d{17,20}$/),
    guildId: z.string().regex(/^\d{17,20}$/),
    kind: z.enum(["feature_request", "bug_report"]),
    url: Url,
    title: NonEmpty.max(100),
    linkedAt: z.iso.datetime(),
  })
  .strict();

export const RoadmapItemSchema = z
  .object({
    id: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-[0-9A-HJKMNP-TV-Z]{26}$/),
    title: NonEmpty.max(180),
    description: NonEmpty.max(20_000),
    type: NonEmpty.max(64),
    area: NonEmpty.max(64),
    status: NonEmpty.max(64),
    priority: NonEmpty.max(64),
    labels: z.array(NonEmpty.max(64)).max(50).default([]),
    references: z.array(EvidenceReferenceSchema).max(200).default([]),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).max(200).default([]),
    linkedDiscordThreads: z.array(DiscordThreadLinkSchema).max(200).default([]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    revision: z.number().int().positive(),
  })
  .strict();

export const CreateRoadmapItemSchema = RoadmapItemSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  revision: true,
  completedAt: true,
}).partial({
  labels: true,
  references: true,
  acceptanceCriteria: true,
  linkedDiscordThreads: true,
});

export const RoadmapPatchSchema = z
  .object({
    title: RoadmapItemSchema.shape.title.optional(),
    description: RoadmapItemSchema.shape.description.optional(),
    type: RoadmapItemSchema.shape.type.optional(),
    area: RoadmapItemSchema.shape.area.optional(),
    status: RoadmapItemSchema.shape.status.optional(),
    priority: RoadmapItemSchema.shape.priority.optional(),
    labels: RoadmapItemSchema.shape.labels.removeDefault().optional(),
    references: RoadmapItemSchema.shape.references.removeDefault().optional(),
    acceptanceCriteria: RoadmapItemSchema.shape.acceptanceCriteria.removeDefault().optional(),
    linkedDiscordThreads: RoadmapItemSchema.shape.linkedDiscordThreads.removeDefault().optional(),
  })
  .strict();

export const MutationRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    patch: RoadmapPatchSchema,
    overrideReason: z.string().trim().min(10).max(2_000).optional(),
  })
  .strict();

export const TransitionRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    to: NonEmpty.max(64),
    overrideReason: z.string().trim().min(10).max(2_000).optional(),
  })
  .strict();

export const HistoryEntrySchema = z
  .object({
    id: z.string(),
    itemId: z.string(),
    revision: z.number().int().positive(),
    mutationId: z.string(),
    action: z.enum(["create", "update", "transition", "link", "import"]),
    actor: ActorSchema,
    before: RoadmapItemSchema.nullable(),
    after: RoadmapItemSchema,
    overrideReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type Actor = z.infer<typeof ActorSchema>;
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type DiscordThreadLink = z.infer<typeof DiscordThreadLinkSchema>;
export type RoadmapItem = z.infer<typeof RoadmapItemSchema>;
export type CreateRoadmapItem = z.infer<typeof CreateRoadmapItemSchema>;
export type RoadmapPatch = z.infer<typeof RoadmapPatchSchema>;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
