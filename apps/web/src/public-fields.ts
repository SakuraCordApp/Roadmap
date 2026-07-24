import type { RoadmapItem } from "@roadmap/core";

export type PublicPriority = "critical" | "high" | "medium" | "low";
export type PublicKind = "feature" | "bug";

export function publicPriority(value: string): PublicPriority {
  if (value === "critical") return "critical";
  if (value === "high") return "high";
  if (value === "medium") return "medium";
  return "low";
}

export function priorityLabel(value: string): "Critical" | "High" | "Medium" | "Low" {
  const priority = publicPriority(value);
  if (priority === "critical") return "Critical";
  if (priority === "high") return "High";
  return priority === "medium" ? "Medium" : "Low";
}

export function publicKind(value: string): PublicKind {
  return value === "bug" ? "bug" : "feature";
}

export function kindLabel(value: string): "New Feature" | "Bug" {
  return publicKind(value) === "bug" ? "Bug" : "New Feature";
}

export function filterPublicRoadmapItems(
  items: RoadmapItem[],
  search: string,
  priority: PublicPriority | "",
  kind: PublicKind | "",
  status: string,
): RoadmapItem[] {
  const query = search.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (priority && publicPriority(item.priority) !== priority) return false;
    if (kind && publicKind(item.type) !== kind) return false;
    if (status && item.status !== status) return false;
    if (!query) return true;
    return `${item.title} ${item.description}`.toLocaleLowerCase().includes(query);
  });
}
