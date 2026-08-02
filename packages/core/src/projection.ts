import type { RoadmapConfig } from "./config.js";
import type { RoadmapItem } from "./schema.js";
import type { RoadmapVersion } from "./version.js";

export interface DiscordRoadmapSection {
  id: string;
  label: string;
  items: Array<{
    id: string;
    title: string;
    priority: string;
    area?: string;
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
      items: section.items.map(({ id, title, priority, area }) => ({
        id,
        title,
        priority,
        area,
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

export interface VersionRoadmapProjection {
  versions: Array<{
    id: string;
    version: string;
    title: string;
    summary: string;
    state: "planned" | "released";
    highlights: Array<{ id: string; title: string; description?: string }>;
    releaseUrl?: string;
  }>;
  generatedAt: string;
  hashInput: string;
}

export async function generateVersionRoadmapProjection(
  versions: RoadmapVersion[],
  now = new Date(),
): Promise<VersionRoadmapProjection & { hash: string }> {
  const planned = versions
    .filter(
      (version): version is RoadmapVersion & { state: "planned" } => version.state === "planned",
    )
    .sort((left, right) => left.position - right.position || compareVersions(left, right));
  const projected = planned.map((version) => ({
    id: version.id,
    version: version.version,
    title: version.title,
    summary: version.summary,
    state: version.state,
    highlights: version.highlights.map(({ id, title, description }) => ({
      id,
      title,
      ...(description ? { description } : {}),
    })),
    ...(version.releaseUrl ? { releaseUrl: version.releaseUrl } : {}),
  }));
  const hashInput = JSON.stringify(projected);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hashInput));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { versions: projected, generatedAt: now.toISOString(), hashInput, hash };
}

export function renderVersionDiscordText(projection: VersionRoadmapProjection): string {
  const versions = projection.versions.map((version) => {
    const highlights = version.highlights.map((highlight) => `│ ${escapeDiscord(highlight.title)}`);
    return `## ◉ v${escapeDiscord(version.version)} — ${escapeDiscord(version.title)}\n${
      highlights.length ? highlights.join("\n") : "_Highlights are being prepared._"
    }`;
  });
  return `# SakuraCord Roadmap\n\n${
    versions.length ? versions.join("\n\n") : "_The next version plan is being prepared._"
  }`;
}

function compareVersions(left: RoadmapVersion, right: RoadmapVersion): number {
  const parse = (value: string) => value.split("-", 1)[0]!.split(".").map(Number);
  const leftParts = parse(left.version);
  const rightParts = parse(right.version);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  return left.version.localeCompare(right.version);
}
