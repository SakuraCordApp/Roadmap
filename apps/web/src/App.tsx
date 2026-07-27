import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { fetchConfig, type PublicConfig } from "./api.js";
import { type LoadState, toMessage } from "./load-state.js";
import { buildPrimaryNavigation } from "./navigation.js";
import { ItemDetail } from "./ItemDetail.js";
import { RoadmapOverview } from "./RoadmapOverview.js";
import { ErrorPage, LoadingPage } from "./ui.js";

export function App() {
  const detailMatch = /^\/items\/([^/]+)\/?$/.exec(window.location.pathname);
  const detailId = detailMatch ? decodePathSegment(detailMatch[1]!) : null;
  const [config, setConfig] = useState<LoadState<PublicConfig>>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetchConfig(controller.signal)
      .then((value) => {
        setConfig({ state: "ready", value });
        if (!detailId) document.title = `${value.project.name} Engineering Roadmap`;
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setConfig({ state: "error", message: toMessage(error) });
      });
    return () => controller.abort();
  }, [detailId]);

  if (config.state === "loading") return <LoadingPage />;
  if (config.state === "error") return <ErrorPage message={config.message} />;

  const value = config.value;
  const theme = {
    "--brand-soft": value.branding.primaryColor,
    "--brand-strong": value.branding.accentColor,
    "--canvas": value.branding.backgroundColor,
    "--font-ui": value.branding.fontFamily,
  } as CSSProperties;

  return (
    <div className="app-shell" style={theme}>
      <PageShell config={value} isDetail={Boolean(detailId)}>
        {detailId ? (
          <ItemDetail config={value} id={detailId} />
        ) : (
          <RoadmapOverview config={value} />
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
  isDetail,
  children,
}: {
  config: PublicConfig;
  isDetail: boolean;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigation = buildPrimaryNavigation(config, isDetail ? "detail" : "overview");
  const brandContent = (
    <>
      <img
        className="site-brand__icon"
        src={config.branding.iconUrl}
        width="1024"
        height="1024"
        fetchPriority="high"
        alt=""
      />
      <span translate="no">{config.project.name}</span>
      <span className="site-brand__context">Engineering roadmap</span>
    </>
  );

  return (
    <>
      <header className="site-header">
        {isDetail ? (
          <a className="site-brand" href="/" aria-label={`${config.project.name} roadmap home`}>
            {brandContent}
          </a>
        ) : (
          <div className="site-brand" aria-label={`${config.project.name} engineering roadmap`}>
            {brandContent}
          </div>
        )}
        <button
          className="menu-button"
          type="button"
          aria-expanded={menuOpen}
          aria-controls="primary-navigation"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span aria-hidden="true" />
        </button>
        <nav
          id="primary-navigation"
          className={menuOpen ? "primary-navigation is-open" : "primary-navigation"}
          aria-label="Primary"
        >
          {navigation.map((link) => (
            <a
              key={`${link.label}-${link.href}`}
              href={link.href}
              target={link.external ? "_blank" : undefined}
              rel={link.external ? "noreferrer" : undefined}
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
              {link.external && <span aria-hidden="true"> ↗</span>}
            </a>
          ))}
        </nav>
      </header>
      <main id="main-content">{children}</main>
      <footer className="site-footer">
        <div>
          <strong>{config.project.name}</strong>
          <span>{config.project.description}</span>
        </div>
        <nav aria-label="Roadmap resources">
          <a href="/api/v1/items">Public API</a>
          {navigation
            .filter((link) => link.external)
            .map((link) => (
              <a key={`footer-${link.href}`} href={link.href} target="_blank" rel="noreferrer">
                {link.label}
              </a>
            ))}
        </nav>
      </footer>
    </>
  );
}
