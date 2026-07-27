import { z } from "zod";
import type { RoadmapItem } from "./schema.js";

const OptionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().trim().min(1).max(64),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    description: z.string().trim().max(500).optional(),
  })
  .strict();

const LifecycleSchema = OptionSchema.extend({
  terminal: z.boolean().default(false),
  publicSection: z.boolean().default(true),
  completionGate: z.boolean().default(false),
  transitionsTo: z.array(z.string()).default([]),
});

export const RoadmapConfigSchema = z
  .object({
    project: z
      .object({
        name: z.string().trim().min(1).max(100),
        slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        idPrefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
        description: z.string().trim().min(1).max(2_000),
        publicUrl: z.url(),
        applicationRepository: z.string().trim().min(1),
        documentationUrl: z.url().optional(),
        contributionUrl: z.url().optional(),
      })
      .strict(),
    branding: z
      .object({
        logoUrl: z.string().trim().min(1),
        mobileLogoUrl: z.string().trim().min(1).optional(),
        mobileLogoWidth: z.number().int().positive().max(4_096).optional(),
        mobileLogoHeight: z.number().int().positive().max(4_096).optional(),
        iconUrl: z.string().trim().min(1),
        primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        fontFamily: z.string().trim().min(1).max(200),
      })
      .strict(),
    areas: z.array(OptionSchema).min(1),
    itemTypes: z.array(OptionSchema).min(1),
    lifecycle: z.array(LifecycleSchema).min(2),
    priorities: z.array(OptionSchema).min(1),
    difficulties: z.array(OptionSchema).min(1),
    publicSections: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          statuses: z.array(z.string()).min(1),
          recentlyCompletedDays: z.number().int().positive().optional(),
        })
        .strict(),
    ),
    discord: z
      .object({
        guildId: z
          .string()
          .regex(/^\d{17,20}$/)
          .optional(),
        featureRequestsForumId: z
          .string()
          .regex(/^\d{17,20}$/)
          .optional(),
        bugReportsForumId: z
          .string()
          .regex(/^\d{17,20}$/)
          .optional(),
        roadmapChannelId: z
          .string()
          .regex(/^\d{17,20}$/)
          .optional(),
        roadmapMessageId: z
          .string()
          .regex(/^\d{17,20}$/)
          .optional(),
        maintainerRoleIds: z.array(z.string().regex(/^\d{17,20}$/)).default([]),
        updatesRoleId: z
          .string()
          .regex(/^\d{17,20}$/)
          .optional(),
        releaseAnnouncementChannelId: z
          .string()
          .regex(/^\d{17,20}$/)
          .optional(),
        statusTagMappings: z.record(z.string(), z.string().regex(/^\d{17,20}$/)).default({}),
        enableComponentsV2: z.boolean().default(true),
      })
      .strict(),
    releases: z
      .object({
        enabled: z.boolean().default(false),
        githubRepository: z
          .string()
          .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
          .optional(),
        aiModel: z.string().trim().min(1).max(100).default("gpt-5.6-sol"),
        reasoningEffort: z
          .enum(["none", "low", "medium", "high", "xhigh", "max"])
          .default("medium"),
        maxCommits: z.number().int().min(1).max(5_000).default(2_000),
      })
      .strict()
      .default({
        enabled: false,
        aiModel: "gpt-5.6-sol",
        reasoningEffort: "medium",
        maxCommits: 2_000,
      }),
    auth: z
      .object({
        tokenIssuer: z.string().trim().min(1),
        allowedOrigins: z.array(z.url()),
      })
      .strict(),
    deployment: z
      .object({
        provider: z.literal("cloudflare"),
        workerName: z.string().regex(/^[a-z0-9-]+$/),
        d1DatabaseName: z.string().regex(/^[a-z0-9-]+$/),
        gatewayProvider: z.enum(["cloudflare", "disabled"]),
      })
      .strict(),
  })
  .strict();

export type RoadmapConfig = z.infer<typeof RoadmapConfigSchema>;
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export function defineRoadmapConfig(input: z.input<typeof RoadmapConfigSchema>): RoadmapConfig {
  const config = RoadmapConfigSchema.parse(input);
  const uniqueGroups: Array<[string, Array<{ id: string }>]> = [
    ["areas", config.areas],
    ["itemTypes", config.itemTypes],
    ["lifecycle", config.lifecycle],
    ["priorities", config.priorities],
    ["difficulties", config.difficulties],
  ];
  for (const [name, values] of uniqueGroups) {
    const ids = values.map((value) => value.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(`${name} contains duplicate IDs.`);
    }
  }
  const statuses = new Set(config.lifecycle.map((state) => state.id));
  for (const state of config.lifecycle) {
    for (const target of state.transitionsTo) {
      if (!statuses.has(target)) throw new Error(`Unknown transition target: ${target}`);
    }
  }
  for (const section of config.publicSections) {
    for (const status of section.statuses) {
      if (!statuses.has(status))
        throw new Error(`Public section references unknown status: ${status}`);
    }
  }
  return Object.freeze(config);
}

export function mergeRoadmapConfig(
  base: RoadmapConfig,
  override: DeepPartial<RoadmapConfig>,
): RoadmapConfig {
  const merge = (left: unknown, right: unknown): unknown => {
    if (right === undefined) return left;
    if (Array.isArray(right)) return right;
    if (
      right !== null &&
      typeof right === "object" &&
      left !== null &&
      typeof left === "object" &&
      !Array.isArray(left)
    ) {
      const output = { ...(left as Record<string, unknown>) };
      for (const [key, value] of Object.entries(right as Record<string, unknown>)) {
        output[key] = merge(output[key], value);
      }
      return output;
    }
    return right;
  };
  return defineRoadmapConfig(merge(base, override) as RoadmapConfig);
}

export function validateItemAgainstConfig(item: RoadmapItem, config: RoadmapConfig): string[] {
  const errors: string[] = [];
  const contains = (values: Array<{ id: string }>, value: string): boolean =>
    values.some((candidate) => candidate.id === value);
  if (!contains(config.itemTypes, item.type)) errors.push(`Unknown item type: ${item.type}`);
  if (!contains(config.areas, item.area)) errors.push(`Unknown area: ${item.area}`);
  if (!contains(config.lifecycle, item.status)) errors.push(`Unknown status: ${item.status}`);
  if (!contains(config.priorities, item.priority))
    errors.push(`Unknown priority: ${item.priority}`);
  if (!contains(config.difficulties, item.difficulty)) {
    errors.push(`Unknown difficulty: ${item.difficulty}`);
  }
  if (!item.id.startsWith(`${config.project.idPrefix}-`)) {
    errors.push(`Item ID must start with ${config.project.idPrefix}-.`);
  }
  return errors;
}
