import { z } from "zod";

const NonEmpty = z.string().trim().min(1);
const Url = z.url();

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

export const VerificationResultSchema = z
  .object({
    id: NonEmpty.max(64),
    result: z.enum(["passed", "failed", "partial", "not_run"]),
    summary: NonEmpty.max(5_000),
    environment: z.string().max(1_000).optional(),
    evidence: z.array(EvidenceReferenceSchema).max(100).default([]),
    verifiedAt: z.iso.datetime(),
    actor: ActorSchema,
  })
  .strict();

export const BenchmarkSchema = z
  .object({
    name: NonEmpty.max(256),
    metric: NonEmpty.max(128),
    value: z.number().finite(),
    unit: NonEmpty.max(32),
    baseline: z.number().finite().optional(),
    measuredAt: z.iso.datetime(),
    evidenceUrl: Url.optional(),
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

export const ProgressSchema = z
  .object({
    value: z.number().int().min(0).max(100),
    basis: z.enum(["criteria", "tests", "commits", "benchmarks", "manual"]),
    evidence: z.array(EvidenceReferenceSchema).max(100),
    rationale: z.string().trim().max(2_000).optional(),
    assessedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((progress, ctx) => {
    if (progress.evidence.length === 0 && progress.basis !== "manual") {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "Progress must reference evidence unless it is an explicit manual assessment.",
      });
    }
    if (progress.basis === "manual" && !progress.rationale) {
      ctx.addIssue({
        code: "custom",
        path: ["rationale"],
        message: "Manual progress assessments require a rationale.",
      });
    }
  });

export const RoadmapItemSchema = z
  .object({
    id: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-[0-9A-HJKMNP-TV-Z]{26}$/),
    title: NonEmpty.max(180),
    description: NonEmpty.max(20_000),
    type: NonEmpty.max(64),
    area: NonEmpty.max(64),
    status: NonEmpty.max(64),
    priority: NonEmpty.max(64),
    difficulty: NonEmpty.max(64),
    confidence: z.number().int().min(0).max(100),
    progress: ProgressSchema,
    proposedImplementation: z.string().max(30_000).default(""),
    labels: z.array(NonEmpty.max(64)).max(50).default([]),
    affectedComponents: z.array(NonEmpty.max(256)).max(100).default([]),
    dependencies: z.array(z.string()).max(100).default([]),
    risks: z.array(NonEmpty.max(2_000)).max(100).default([]),
    requiredResearch: z.array(NonEmpty.max(2_000)).max(100).default([]),
    references: z.array(EvidenceReferenceSchema).max(200).default([]),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).max(200).default([]),
    verificationResults: z.array(VerificationResultSchema).max(200).default([]),
    benchmarks: z.array(BenchmarkSchema).max(100).default([]),
    relatedCommits: z.array(NonEmpty.max(256)).max(200).default([]),
    relatedPullRequests: z.array(NonEmpty.max(256)).max(200).default([]),
    linkedDiscordThreads: z.array(DiscordThreadLinkSchema).max(200).default([]),
    communityReactionCount: z.number().int().nonnegative().default(0),
    duplicateReportCount: z.number().int().nonnegative().default(0),
    milestone: z.string().trim().max(128).optional(),
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
  proposedImplementation: true,
  labels: true,
  affectedComponents: true,
  dependencies: true,
  risks: true,
  requiredResearch: true,
  references: true,
  acceptanceCriteria: true,
  verificationResults: true,
  benchmarks: true,
  relatedCommits: true,
  relatedPullRequests: true,
  linkedDiscordThreads: true,
  communityReactionCount: true,
  duplicateReportCount: true,
  progress: true,
  confidence: true,
});

export const RoadmapPatchSchema = z
  .object({
    title: RoadmapItemSchema.shape.title.optional(),
    description: RoadmapItemSchema.shape.description.optional(),
    type: RoadmapItemSchema.shape.type.optional(),
    area: RoadmapItemSchema.shape.area.optional(),
    status: RoadmapItemSchema.shape.status.optional(),
    priority: RoadmapItemSchema.shape.priority.optional(),
    difficulty: RoadmapItemSchema.shape.difficulty.optional(),
    confidence: RoadmapItemSchema.shape.confidence.optional(),
    progress: RoadmapItemSchema.shape.progress.optional(),
    proposedImplementation: RoadmapItemSchema.shape.proposedImplementation
      .removeDefault()
      .optional(),
    labels: RoadmapItemSchema.shape.labels.removeDefault().optional(),
    affectedComponents: RoadmapItemSchema.shape.affectedComponents.removeDefault().optional(),
    dependencies: RoadmapItemSchema.shape.dependencies.removeDefault().optional(),
    risks: RoadmapItemSchema.shape.risks.removeDefault().optional(),
    requiredResearch: RoadmapItemSchema.shape.requiredResearch.removeDefault().optional(),
    references: RoadmapItemSchema.shape.references.removeDefault().optional(),
    acceptanceCriteria: RoadmapItemSchema.shape.acceptanceCriteria.removeDefault().optional(),
    verificationResults: RoadmapItemSchema.shape.verificationResults.removeDefault().optional(),
    benchmarks: RoadmapItemSchema.shape.benchmarks.removeDefault().optional(),
    relatedCommits: RoadmapItemSchema.shape.relatedCommits.removeDefault().optional(),
    relatedPullRequests: RoadmapItemSchema.shape.relatedPullRequests.removeDefault().optional(),
    linkedDiscordThreads: RoadmapItemSchema.shape.linkedDiscordThreads.removeDefault().optional(),
    communityReactionCount: RoadmapItemSchema.shape.communityReactionCount
      .removeDefault()
      .optional(),
    duplicateReportCount: RoadmapItemSchema.shape.duplicateReportCount.removeDefault().optional(),
    milestone: RoadmapItemSchema.shape.milestone.optional(),
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
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
export type DiscordThreadLink = z.infer<typeof DiscordThreadLinkSchema>;
export type RoadmapItem = z.infer<typeof RoadmapItemSchema>;
export type CreateRoadmapItem = z.infer<typeof CreateRoadmapItemSchema>;
export type RoadmapPatch = z.infer<typeof RoadmapPatchSchema>;
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
