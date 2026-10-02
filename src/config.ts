// SakuraCord-specific constants. Everything public lives here; secrets live in
// Cloudflare. GitHub Issues in SakuraCordApp/SakuraCord are the canonical record.

export const REPOSITORY = { owner: "SakuraCordApp", name: "SakuraCord" } as const;
export const REPOSITORY_SLUG = `${REPOSITORY.owner}/${REPOSITORY.name}`;
export const REPOSITORY_URL = `https://github.com/${REPOSITORY_SLUG}`;
export const NIGHTLY_BRANCH = "nightly";
export const DEFAULT_BRANCH = "main";

/** Repositories whose activity is posted to the Discord GitHub-updates channel. */
export const FEED_REPOSITORIES = new Set([
  "SakuraCordApp/SakuraCord",
  "SakuraCordApp/Roadmap",
  "SakuraCordApp/Website",
]);

export const DISCORD = {
  guildId: "1528177363563581662",
  bugForumId: "1528179084432248932",
  featureForumId: "1528181068576981103",
  roadmapChannelId: "1528180213912047806",
  updatesRoleId: "1528177363995590795",
  maintainerRoleIds: ["1528177364033474641"],
  githubUpdatesChannelId: "1530350266610880523",
  githubUpdatesRoleId: "1530350339549560985",
  inviteUrl: "https://discord.gg/hWNwFXkUTP",
} as const;

export const BRAND = {
  primary: 0xef9bc4,
  accent: 0xce6096,
} as const;

export type IssueKind = "bug" | "feature";

export const ISSUE_TYPES: Record<IssueKind, { githubType: string; label: string; plural: string }> =
  {
    bug: { githubType: "Bug", label: "Bug", plural: "Bugs" },
    feature: { githubType: "Feature", label: "Feature", plural: "Features" },
  };

export interface Area {
  id: string;
  label: string;
  emoji: string;
  description: string;
  color: string;
}

export const AREAS: Area[] = [
  {
    id: "chat",
    label: "Chat & Messages",
    emoji: "💬",
    description: "Messages, composer, embeds, media, reactions, threads, and forums",
    color: "EF9BC4",
  },
  {
    id: "communication",
    label: "Communication",
    emoji: "📞",
    description: "Calls, screen sharing, direct messages, friends, inbox, and notifications",
    color: "A78BFA",
  },
  {
    id: "servers",
    label: "Servers & Roles",
    emoji: "🏰",
    description: "Server list, channels, members, roles, onboarding, and moderation",
    color: "60A5FA",
  },
  {
    id: "personalization",
    label: "Personalization",
    emoji: "🎨",
    description: "Settings, themes, profiles, and appearance",
    color: "F59E0B",
  },
  {
    id: "plugins",
    label: "Plugins",
    emoji: "🧩",
    description: "Plugins and extensibility",
    color: "34D399",
  },
  {
    id: "platform",
    label: "Platform",
    emoji: "💻",
    description: "Launch, login, updates, performance, accessibility, and macOS integration",
    color: "94A3B8",
  },
];

export const PRIORITIES = [
  {
    id: "critical",
    label: "Critical",
    color: "EF4444",
    description: "Crashes, data loss, or SakuraCord unusable",
  },
  { id: "high", label: "High", color: "F97316", description: "Major impact on daily use" },
  { id: "medium", label: "Medium", color: "EAB308", description: "Bounded but real impact" },
  { id: "low", label: "Low", color: "22C55E", description: "Polish and minor issues" },
] as const;
export type PriorityId = (typeof PRIORITIES)[number]["id"];

export type StatusId =
  | "new"
  | "needs_info"
  | "confirmed"
  | "planned"
  | "in_progress"
  | "in_nightly"
  | "shipped"
  | "done"
  | "duplicate"
  | "declined"
  | "cant_reproduce";

export interface StatusDefinition {
  id: StatusId;
  /** Display label; features may use a different word than bugs. */
  label: string;
  featureLabel?: string;
  /** GitHub label that carries this state, when it is not expressed by close reason alone. */
  githubLabel?: string;
  description: string;
  color: string;
  open: boolean;
  /** Bug-only states are not offered for features. */
  bugOnly?: boolean;
  emoji: string;
}

export const STATUSES: StatusDefinition[] = [
  {
    id: "new",
    label: "New",
    githubLabel: "status: new",
    description: "Waiting for triage by the SakuraCord team",
    color: "F472B6",
    open: true,
    emoji: "🌱",
  },
  {
    id: "needs_info",
    label: "Needs Info",
    githubLabel: "status: needs info",
    description: "Waiting for more information from the reporter",
    color: "FBBF24",
    open: true,
    emoji: "❓",
  },
  {
    id: "confirmed",
    label: "Confirmed",
    featureLabel: "Accepted",
    githubLabel: "status: confirmed",
    description: "Confirmed bug or accepted suggestion, not yet scheduled",
    color: "38BDF8",
    open: true,
    emoji: "✅",
  },
  {
    id: "planned",
    label: "Planned",
    githubLabel: "status: planned",
    description: "Scheduled for a release milestone",
    color: "60A5FA",
    open: true,
    emoji: "🗓️",
  },
  {
    id: "in_progress",
    label: "In Progress",
    githubLabel: "status: in progress",
    description: "Someone is working on it",
    color: "A78BFA",
    open: true,
    emoji: "🛠️",
  },
  {
    id: "in_nightly",
    label: "In Nightly",
    githubLabel: "status: in nightly",
    description: "Merged into nightly; ships with the next build",
    color: "EF9BC4",
    open: true,
    emoji: "🌙",
  },
  {
    id: "shipped",
    label: "Shipped",
    githubLabel: "status: shipped",
    description: "Included in a published release",
    color: "34D399",
    open: false,
    emoji: "🌸",
  },
  {
    id: "done",
    label: "Done",
    description: "Closed as completed",
    color: "10B981",
    open: false,
    emoji: "✔️",
  },
  {
    id: "duplicate",
    label: "Duplicate",
    description: "Tracked in another report",
    color: "F59E0B",
    open: false,
    emoji: "🔁",
  },
  {
    id: "declined",
    label: "Won't Fix",
    featureLabel: "Declined",
    githubLabel: "status: declined",
    description: "Will not be fixed or implemented",
    color: "F87171",
    open: false,
    emoji: "🚫",
  },
  {
    id: "cant_reproduce",
    label: "Can't Reproduce",
    githubLabel: "status: can't reproduce",
    description: "Could not be reproduced with the available information",
    color: "9CA3AF",
    open: false,
    bugOnly: true,
    emoji: "🔍",
  },
];

export const STATUS_BY_ID = new Map(STATUSES.map((status) => [status.id, status]));

export function statusLabel(status: StatusId, kind: IssueKind | null): string {
  const definition = STATUS_BY_ID.get(status)!;
  return kind === "feature" && definition.featureLabel ? definition.featureLabel : definition.label;
}

export const AGENT_LABELS = {
  investigate: {
    name: "agent: investigate",
    color: "8B5CF6",
    description: "Run combined triage and code investigation",
  },
  fix: {
    name: "agent: fix",
    color: "7C3AED",
    description: "Ask the fix agent to open a draft pull request",
  },
} as const;

export const areaLabel = (id: string) => `area: ${id}`;
export const priorityLabel = (id: string) => `priority: ${id}`;

/** Release tags look like v0.1.6 or v0.1.6-Beta-3. */
export function releaseDisplayName(tag: string): string {
  return tag.replace(/^v/, "").replace(/-Beta-(\d+)$/i, " Beta $1");
}

export function releaseMilestoneTitle(tag: string): string {
  return tag.replace(/^v/, "").replace(/-Beta-\d+$/i, "");
}

export function isPrereleaseTag(tag: string): boolean {
  return /-Beta-\d+$/i.test(tag);
}
