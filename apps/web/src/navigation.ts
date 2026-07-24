import type { PublicConfig } from "./api.js";

export interface NavigationLink {
  label: string;
  href: string;
  external: boolean;
}

export type NavigationSurface = "overview" | "detail";

export const knownBrokenNavigationTargets = new Set([
  "https://github.com/SakuraCord/SakuraCord",
  "https://github.com/SakuraCord/SakuraCord/tree/main/docs",
]);

export function buildPrimaryNavigation(
  config: PublicConfig,
  surface: NavigationSurface,
): NavigationLink[] {
  const links: NavigationLink[] = [
    {
      label: "Browse",
      href: surface === "overview" ? "#browse" : "/#browse",
      external: false,
    },
  ];
  pushExternal(links, "Docs", config.project.documentationUrl, config.project.publicUrl);
  pushExternal(links, "Source code", config.project.contributionUrl, config.project.publicUrl);
  return links;
}

export function auditNavigationTargets(config: PublicConfig, surface: NavigationSurface): string[] {
  const links = buildPrimaryNavigation(config, surface);
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const link of links) {
    if (seen.has(link.href)) issues.push(`Duplicate navigation target: ${link.href}`);
    seen.add(link.href);
    if (link.external && !isUsableExternalUrl(link.href, config.project.publicUrl)) {
      issues.push(`Unusable external navigation target: ${link.href}`);
    }
    if (!link.external && !["#browse", "/#browse"].includes(link.href)) {
      issues.push(`Unknown internal navigation target: ${link.href}`);
    }
  }

  return issues;
}

function pushExternal(
  links: NavigationLink[],
  label: string,
  candidate: string | undefined,
  publicUrl: string,
) {
  if (!candidate || !isUsableExternalUrl(candidate, publicUrl)) return;
  links.push({ label, href: candidate, external: true });
}

function isUsableExternalUrl(candidate: string, publicUrl: string): boolean {
  if (knownBrokenNavigationTargets.has(stripTrailingSlash(candidate))) return false;
  try {
    const url = new URL(candidate);
    const site = new URL(publicUrl);
    const placeholder =
      url.hostname === "example.com" ||
      url.hostname.endsWith(".example.com") ||
      url.hostname === "localhost";
    const selfLink =
      stripTrailingSlash(url.href) === stripTrailingSlash(site.href) ||
      url.hostname === site.hostname;
    return ["http:", "https:"].includes(url.protocol) && !placeholder && !selfLink;
  } catch {
    return false;
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
