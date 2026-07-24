import type { RoadmapConfig } from "./config.js";
import type { RoadmapItem } from "./schema.js";

export interface DiscordRoadmapSection {
  id: string;
  label: string;
  items: Array<{
    id: string;
    title: string;
    priority: string;
    area?: string;
    milestone?: string;
    linkedThreadUrls: string[];
  }>;
}

export interface DiscordRoadmapGroup {
  id: string;
  label: string;
  sections: DiscordRoadmapSection[];
}

export interface DiscordRoadmapProjection {
  groups: DiscordRoadmapGroup[];
  generatedAt: string;
  hashInput: string;
}

export async function generateDiscordProjection(
  items: RoadmapItem[],
  config: RoadmapConfig,
  now = new Date(),
): Promise<DiscordRoadmapProjection & { hash: string }> {
  const groups = config.itemTypes.map((type) => ({
    id: type.id,
    label: type.label,
    sections: config.publicSections.map((section) => {
      const cutoff = section.recentlyCompletedDays
        ? now.getTime() - section.recentlyCompletedDays * 86_400_000
        : null;
      const projected = items
        .filter((item) => item.type === type.id && section.statuses.includes(item.status))
        .filter((item) => !cutoff || (item.completedAt && Date.parse(item.completedAt) >= cutoff))
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((item) => ({
          id: item.id,
          title: item.title,
          priority: item.priority,
          area: item.area,
          ...(item.milestone ? { milestone: item.milestone } : {}),
          linkedThreadUrls: item.linkedDiscordThreads.map((thread) => thread.url),
        }));
      return { id: section.id, label: section.label, items: projected };
    }),
  }));
  const visible = groups.map((group) => ({
    id: group.id,
    label: group.label,
    sections: group.sections.map((section) => ({
      id: section.id,
      label: section.label,
      items: section.items.map(({ id, title, priority, area, milestone }) => ({
        id,
        title,
        priority,
        area,
        milestone,
      })),
    })),
  }));
  const hashInput = JSON.stringify(visible);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hashInput));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { groups, generatedAt: now.toISOString(), hashInput, hash };
}

export function renderDiscordText(projection: DiscordRoadmapProjection): string {
  return projection.groups
    .map((group) => {
      const sections = group.sections.map((section) => {
        const lines = section.items.map((item) => `• **${escapeDiscord(item.title)}**`);
        return `## ${escapeDiscord(section.label)}\n${lines.length ? lines.join("\n") : "_No items yet._"}`;
      });
      return `# ${escapeDiscord(group.label)}\n${sections.join("\n\n")}`;
    })
    .join("\n\n");
}

export function escapeDiscord(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>~])/g, "\\$1").replace(/@/g, "@\u200b");
}
