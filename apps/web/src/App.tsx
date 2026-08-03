import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { ListIcon } from "@phosphor-icons/react/dist/csr/List";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { MapTrifoldIcon } from "@phosphor-icons/react/dist/csr/MapTrifold";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { PublicConfig } from "./api.js";
import { DiscordMark } from "./DiscordMark.js";
import { initialPublicConfig } from "./initial-config.js";
import { ItemDetail } from "./ItemDetail.js";
import { RoadmapTimeline } from "./RoadmapTimeline.js";
import { TrackerOverview } from "./RoadmapOverview.js";

export function App() {
  const detailMatch = /^\/items\/([^/]+)\/?$/.exec(window.location.pathname);
  const detailId = detailMatch ? decodePathSegment(detailMatch[1]!) : null;
  const config = initialPublicConfig;
  const surface = resolveSurface(config, detailId);

  useEffect(() => {
    document.title =
      surface === "roadmap"
        ? `${config.project.name} Roadmap`
        : detailId
          ? `${config.project.name} Tracker item`
          : `${config.project.name} Tracker`;
  }, [config.project.name, detailId, surface]);

  const theme = {
    "--brand-soft": config.branding.primaryColor,
    "--brand-strong": config.branding.accentColor,
    "--canvas": config.branding.backgroundColor,
    "--font-fallback": config.branding.fontFamily,
  } as CSSProperties;

  return (
    <div className="app-shell" style={theme}>
      <PageShell config={config} surface={surface}>
        {detailId ? (
          <ItemDetail config={config} id={detailId} />
        ) : surface === "tracker" ? (
          <TrackerOverview config={config} />
        ) : (
          <RoadmapTimeline config={config} />
        )}
      </PageShell>
    </div>
  );
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function PageShell({
  config,
  surface,
  children,
}: {
  config: PublicConfig;
  surface: "roadmap" | "tracker";
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const navigation = buildNavigation(config, surface);

  useEffect(() => {
    if (!menuOpen) return;

    const closeMenuFromOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (
        menuButtonRef.current?.contains(event.target) ||
        navigationRef.current?.contains(event.target)
      ) {
        return;
      }
      setMenuOpen(false);
    };

    const closeMenuWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeMenuFromOutside);
    document.addEventListener("keydown", closeMenuWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeMenuFromOutside);
      document.removeEventListener("keydown", closeMenuWithKeyboard);
    };
  }, [menuOpen]);

  const mainSiteHref = config.project.homeUrl ?? "https://sakuracord.app";
  return (
    <>
      <header className="site-header" aria-label="Primary navigation">
        <div className="header-inner">
          <a className="site-brand" href={mainSiteHref} aria-label={`${config.project.name} home`}>
            <img src={config.branding.iconUrl} width="42" height="42" fetchPriority="high" alt="" />
            <span translate="no">{config.project.name}</span>
          </a>
          <button
            ref={menuButtonRef}
            className="menu-button"
            type="button"
            aria-expanded={menuOpen}
            aria-controls="primary-navigation"
            aria-label={menuOpen ? "Close navigation" : "Open navigation"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <ListIcon aria-hidden="true" weight="bold" />
          </button>
          <nav
            ref={navigationRef}
            id="primary-navigation"
            className={menuOpen ? "primary-navigation is-open" : "primary-navigation"}
            aria-label="SakuraCord links"
          >
            {navigation.map((link) => (
              <a
                key={`${link.label}-${link.href}`}
                href={link.href}
                className={`${link.active ? "is-active" : ""} ${link.primary ? "nav-download" : ""}`.trim()}
                target={link.newTab ? "_blank" : undefined}
                rel={link.newTab ? "noreferrer" : undefined}
                aria-current={link.active ? "page" : undefined}
                onClick={() => setMenuOpen(false)}
              >
                <NavigationIcon label={link.label} />
                <span>{link.label}</span>
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main id="main-content">{children}</main>
      <footer className="site-footer">
        <div>
          <a href={config.project.homeUrl ?? "https://sakuracord.app"}>
            <img src={config.branding.iconUrl} width="28" height="28" loading="lazy" alt="" />
            <strong>
              {config.project.name}
              {surface === "tracker" ? " Tracker" : ""}
            </strong>
          </a>
        </div>
        <nav aria-label="Roadmap resources">
          <a
            href={
              surface === "tracker"
                ? config.project.publicUrl
                : (config.project.trackerUrl ?? "/tracker")
            }
          >
            {surface === "tracker" ? "View the public roadmap" : "Open the tracker"}
          </a>
        </nav>
      </footer>
    </>
  );
}

function NavigationIcon({ label }: { label: string }) {
  switch (label) {
    case "Roadmap":
      return <MapTrifoldIcon aria-hidden="true" weight="regular" />;
    case "Tracker":
      return <ListChecksIcon aria-hidden="true" weight="regular" />;
    case "Discord":
      return <DiscordMark />;
    case "GitHub":
      return <GithubLogoIcon aria-hidden="true" weight="fill" />;
    case "Download":
      return <DownloadSimpleIcon aria-hidden="true" weight="bold" />;
    default:
      return null;
  }
}

interface SiteNavigationLink {
  label: string;
  href: string;
  newTab?: boolean;
  active?: boolean;
  primary?: boolean;
}

function buildNavigation(
  config: PublicConfig,
  surface: "roadmap" | "tracker",
): SiteNavigationLink[] {
  return [
    {
      label: "Roadmap",
      href: config.project.publicUrl,
      active: surface === "roadmap",
    },
    {
      label: "Tracker",
      href: config.project.trackerUrl ?? "/tracker",
      active: surface === "tracker",
    },
    ...(config.project.discordUrl
      ? [{ label: "Discord", href: config.project.discordUrl, newTab: true }]
      : []),
    ...(config.project.contributionUrl
      ? [{ label: "GitHub", href: config.project.contributionUrl, newTab: true }]
      : []),
    ...(config.project.downloadUrl
      ? [
          {
            label: "Download",
            href: config.project.downloadUrl,
            primary: true,
          },
        ]
      : []),
  ];
}

function resolveSurface(config: PublicConfig, detailId: string | null): "roadmap" | "tracker" {
  if (detailId || window.location.pathname === "/tracker") return "tracker";
  if (!config.project.trackerUrl) return "roadmap";
  return window.location.hostname === new URL(config.project.trackerUrl).hostname
    ? "tracker"
    : "roadmap";
}
