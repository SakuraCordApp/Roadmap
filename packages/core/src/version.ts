import { z } from "zod";

const NonEmpty = z.string().trim().min(1);
const VersionId = z.string().regex(/^[A-Z][A-Z0-9]{1,10}-[0-9A-HJKMNP-TV-Z]{26}$/);
const SemanticVersion = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/);

export const RoadmapVersionStateSchema = z.enum(["draft", "planned", "released", "cancelled"]);

export const RoadmapVersionHighlightSchema = z
  .object({
    id: z.string().uuid(),
    title: NonEmpty.max(180),
    description: z.string().trim().max(2_000).optional(),
    linkedTrackerItemIds: z.array(NonEmpty.max(64)).max(50).default([]),
  })
  .strict();

export const CreateRoadmapVersionHighlightSchema = RoadmapVersionHighlightSchema.omit({ id: true });

export const RoadmapVersionSchema = z
  .object({
    id: VersionId,
    version: SemanticVersion,
    title: NonEmpty.max(180),
    summary: NonEmpty.max(2_000),
    state: RoadmapVersionStateSchema,
    position: z.number().int().min(0).max(10_000),
    highlights: z.array(RoadmapVersionHighlightSchema).max(12).default([]),
    releaseUrl: z.httpUrl().optional(),
    releasedAt: z.iso.datetime().optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    revision: z.number().int().positive(),
  })
  .strict();

export const CreateRoadmapVersionSchema = RoadmapVersionSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  revision: true,
  releaseUrl: true,
  releasedAt: true,
  highlights: true,
}).extend({
  state: z.enum(["draft", "planned"]).default("draft"),
  highlights: z.array(CreateRoadmapVersionHighlightSchema).max(12).default([]),
});

export const RoadmapVersionPatchSchema = z
  .object({
    version: SemanticVersion.optional(),
    title: RoadmapVersionSchema.shape.title.optional(),
    summary: RoadmapVersionSchema.shape.summary.optional(),
    position: RoadmapVersionSchema.shape.position.optional(),
    highlights: RoadmapVersionSchema.shape.highlights.removeDefault().optional(),
    releaseUrl: RoadmapVersionSchema.shape.releaseUrl.optional(),
  })
  .strict();

export const RoadmapVersionTransitionRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    to: RoadmapVersionStateSchema,
    releaseUrl: z.httpUrl().optional(),
    releasedAt: z.iso.datetime().optional(),
    overrideReason: z.string().trim().min(10).max(2_000).optional(),
  })
  .strict();

export const RoadmapVersionHistoryEntrySchema = z
  .object({
    id: z.string(),
    versionId: VersionId,
    revision: z.number().int().positive(),
    mutationId: z.string(),
    action: z.enum(["create", "update", "transition"]),
    actor: z
      .object({
        id: NonEmpty.max(128),
        displayName: NonEmpty.max(128),
        kind: z.enum(["maintainer", "discord", "mcp", "cli", "system"]),
      })
      .strict(),
    before: RoadmapVersionSchema.nullable(),
    after: RoadmapVersionSchema,
    overrideReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type RoadmapVersionState = z.infer<typeof RoadmapVersionStateSchema>;
export type RoadmapVersionHighlight = z.infer<typeof RoadmapVersionHighlightSchema>;
export type CreateRoadmapVersionHighlight = z.infer<typeof CreateRoadmapVersionHighlightSchema>;
export type RoadmapVersion = z.infer<typeof RoadmapVersionSchema>;
export type CreateRoadmapVersion = z.infer<typeof CreateRoadmapVersionSchema>;
export type RoadmapVersionPatch = z.infer<typeof RoadmapVersionPatchSchema>;
export type RoadmapVersionHistoryEntry = z.infer<typeof RoadmapVersionHistoryEntrySchema>;
