import {
  defineRoadmapConfig,
  mergeRoadmapConfig,
  type DeepPartial,
  type RoadmapConfig,
} from "@roadmap/core";
import instanceOverrides from "./roadmap.instance.json" with { type: "json" };

/**
 * The single project-specific configuration surface.
 *
 * Forks should customize this file and public assets. Core engine behavior does
 * not depend on SakuraCord names, lifecycle labels, or Discord channel IDs.
 */
const defaults = defineRoadmapConfig({
  project: {
    name: "SakuraCord",
    slug: "sakuracord",
    idPrefix: "SCR",
    description:
      "Engineering roadmap for SakuraCord, a native Swift and SwiftUI macOS Discord client.",
    publicUrl: "https://roadmap.sakuracord.app",
    applicationRepository: "/Users/super_original/Developer/My Own Projects/SakuraCord",
    contributionUrl: "https://github.com/SakuraCordApp/SakuraCord",
  },
  branding: {
    logoUrl: "/brand/app-icon.webp",
    mobileLogoUrl: "/brand/mobile-logo.webp",
    mobileLogoWidth: 1200,
    mobileLogoHeight: 600,
    iconUrl: "/brand/icon.png",
    primaryColor: "#F3A6C8",
    accentColor: "#D9578B",
    backgroundColor: "#0E0C13",
    fontFamily: '"Avenir Next", "SF Pro Text", system-ui, sans-serif',
  },
  areas: [
    { id: "chat", label: "Chat & Messages", color: "#F3A6C8" },
    { id: "communication", label: "Communication", color: "#A78BFA" },
    { id: "servers", label: "Servers & Roles", color: "#60A5FA" },
    { id: "personalization", label: "Personalization", color: "#F59E0B" },
    { id: "plugins", label: "Plugins", color: "#34D399" },
    { id: "platform", label: "Platform", color: "#94A3B8" },
  ],
  itemTypes: [
    { id: "feature", label: "New Features", color: "#A78BFA" },
    { id: "bug", label: "Bug Tracking", color: "#F87171" },
  ],
  lifecycle: [
    {
      id: "planned",
      label: "Planned",
      color: "#60A5FA",
      transitionsTo: ["in_progress", "declined", "duplicate"],
    },
    {
      id: "in_progress",
      label: "In Progress",
      color: "#A78BFA",
      transitionsTo: ["planned", "polishing", "declined"],
    },
    {
      id: "polishing",
      label: "Polishing",
      color: "#F3A6C8",
      transitionsTo: ["in_progress", "done"],
    },
    {
      id: "declined",
      label: "Declined",
      color: "#F87171",
      terminal: true,
      transitionsTo: ["planned"],
    },
    {
      id: "duplicate",
      label: "Duplicate",
      color: "#F59E0B",
      terminal: true,
      transitionsTo: ["planned"],
    },
    {
      id: "done",
      label: "Done",
      color: "#34D399",
      terminal: true,
      completionGate: true,
      transitionsTo: ["in_progress", "polishing"],
    },
  ],
  priorities: [
    { id: "critical", label: "Critical", color: "#EF4444" },
    { id: "high", label: "High", color: "#F97316" },
    { id: "medium", label: "Medium", color: "#EAB308" },
    { id: "low", label: "Low", color: "#22C55E" },
  ],
  difficulties: [
    { id: "small", label: "Small", color: "#34D399" },
    { id: "medium", label: "Medium", color: "#60A5FA" },
    { id: "large", label: "Large", color: "#A78BFA" },
    { id: "epic", label: "Epic", color: "#F87171" },
  ],
  publicSections: [
    { id: "planned", label: "Planned", statuses: ["planned"] },
    { id: "in_progress", label: "In Progress", statuses: ["in_progress"] },
    { id: "polishing", label: "Polishing", statuses: ["polishing"] },
    {
      id: "recently_done",
      label: "Done",
      statuses: ["done"],
    },
  ],
  discord: {
    maintainerRoleIds: [],
    statusTagMappings: {},
    enableComponentsV2: true,
  },
  releases: {
    enabled: false,
    aiModel: "gpt-5.6-sol",
    reasoningEffort: "medium",
    maxCommits: 2_000,
  },
  auth: {
    tokenIssuer: "sakuracord-roadmap",
    allowedOrigins: ["https://roadmap.sakuracord.app", "http://localhost:5173"],
  },
  deployment: {
    provider: "cloudflare",
    workerName: "sakuracord-roadmap",
    d1DatabaseName: "sakuracord-roadmap",
    gatewayProvider: "cloudflare",
  },
});

// JSON imports widen string literals, so preserve the typed merge boundary
// while relying on mergeRoadmapConfig's strict runtime schema validation.
export default mergeRoadmapConfig(defaults, instanceOverrides as DeepPartial<RoadmapConfig>);
