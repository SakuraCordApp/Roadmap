import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import roadmapConfig from "../../roadmap.config.js";

const publicConfig = {
  project: roadmapConfig.project,
  branding: roadmapConfig.branding,
  areas: roadmapConfig.areas,
  itemTypes: roadmapConfig.itemTypes,
  lifecycle: roadmapConfig.lifecycle,
  priorities: roadmapConfig.priorities,
  publicSections: roadmapConfig.publicSections,
  releases: roadmapConfig.releases,
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function prebootNavigationLink(
  label: string,
  href: string | undefined,
  icon: string,
  options: { newTab?: boolean; primary?: boolean } = {},
): string {
  if (!href) return "";
  const attributes = [
    `href="${escapeHtml(href)}"`,
    options.primary ? 'class="nav-download"' : "",
    options.newTab ? 'target="_blank" rel="noreferrer"' : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<a ${attributes}>${icon}<span>${escapeHtml(label)}</span></a>`;
}

const prebootIcons = {
  roadmap:
    '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M228.92 49.69a8 8 0 0 0-6.86-1.45l-61.13 15.28-61.35-30.68a8 8 0 0 0-5.52-.6l-64 16A8 8 0 0 0 24 56v144a8 8 0 0 0 9.94 7.76l61.13-15.28 61.35 30.68a8.15 8.15 0 0 0 3.58.84 8 8 0 0 0 1.94-.24l64-16A8 8 0 0 0 232 200V56a8 8 0 0 0-3.08-6.31ZM104 52.94l48 24v126.12l-48-24ZM40 62.25l48-12v127.5l-48 12Zm176 131.5-48 12V78.25l48-12Z" /></svg>',
  tracker:
    '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M224 128a8 8 0 0 1-8 8h-88a8 8 0 0 1 0-16h88a8 8 0 0 1 8 8ZM128 72h88a8 8 0 0 0 0-16h-88a8 8 0 0 0 0 16Zm88 112h-88a8 8 0 0 0 0 16h88a8 8 0 0 0 0-16ZM82.34 42.34 56 68.69 45.66 58.34a8 8 0 0 0-11.32 11.32l16 16a8 8 0 0 0 11.32 0l32-32a8 8 0 0 0-11.32-11.32Zm0 64L56 132.69l-10.34-10.35a8 8 0 0 0-11.32 11.32l16 16a8 8 0 0 0 11.32 0l32-32a8 8 0 0 0-11.32-11.32Zm0 64L56 196.69l-10.34-10.35a8 8 0 0 0-11.32 11.32l16 16a8 8 0 0 0 11.32 0l32-32a8 8 0 0 0-11.32-11.32Z" /></svg>',
  discord:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.445.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.618-1.25.077.077 0 0 0-.078-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.028C.533 9.046-.319 13.58.1 18.058a.082.082 0 0 0 .031.056c2.053 1.508 4.041 2.423 5.993 3.03a.078.078 0 0 0 .084-.028c.462-.63.873-1.295 1.226-1.994a.076.076 0 0 0-.042-.106 12.3 12.3 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.011c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.01c.12.099.246.199.373.292a.077.077 0 0 1-.007.128 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.029c1.961-.607 3.95-1.522 6.002-3.03a.077.077 0 0 0 .031-.055c.5-5.177-.838-9.674-3.548-13.66a.061.061 0 0 0-.031-.029ZM8.02 15.331c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.419 0 1.333-.956 2.419-2.157 2.419Zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.419 0 1.333-.946 2.157-2.157 2.419Z" /></svg>',
  github:
    '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M216 104v8a56.06 56.06 0 0 1-48.44 55.47A39.8 39.8 0 0 1 176 192v40a8 8 0 0 1-8 8h-64a8 8 0 0 1-8-8v-16H72a40 40 0 0 1-40-40 24 24 0 0 0-24-24 8 8 0 0 1 0-16 40 40 0 0 1 40 40 24 24 0 0 0 24 24h24v-8a39.8 39.8 0 0 1 8.44-24.53A56.06 56.06 0 0 1 56 112v-8a58.14 58.14 0 0 1 7.69-28.32A59.78 59.78 0 0 1 69.07 28 8 8 0 0 1 76 24a59.75 59.75 0 0 1 48 24h24a59.75 59.75 0 0 1 48-24 8 8 0 0 1 6.93 4 59.74 59.74 0 0 1 5.37 47.68A58 58 0 0 1 216 104Z" /></svg>',
  download:
    '<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M228 144v64a12 12 0 0 1-12 12H40a12 12 0 0 1-12-12v-64a12 12 0 0 1 24 0v52h152v-52a12 12 0 0 1 24 0Zm-108.49 8.49a12 12 0 0 0 17 0l40-40a12 12 0 0 0-17-17L140 115V32a12 12 0 0 0-24 0v83L96.49 95.51a12 12 0 0 0-17 17Z" /></svg>',
} as const;

function renderPrebootHeader(): string {
  const { project, branding } = publicConfig;
  const homeUrl = project.homeUrl ?? project.publicUrl;
  const navigation = [
    prebootNavigationLink("Roadmap", project.publicUrl, prebootIcons.roadmap),
    prebootNavigationLink("Tracker", project.trackerUrl ?? "/tracker", prebootIcons.tracker),
    prebootNavigationLink("Discord", project.discordUrl, prebootIcons.discord, { newTab: true }),
    prebootNavigationLink("GitHub", project.contributionUrl, prebootIcons.github, { newTab: true }),
    prebootNavigationLink("Download", project.downloadUrl, prebootIcons.download, {
      primary: true,
    }),
  ].join("");

  return `<header class="site-header" aria-label="Primary navigation">
      <div class="header-inner">
        <a class="site-brand" href="${escapeHtml(homeUrl)}" aria-label="${escapeHtml(project.name)} home">
          <img src="${escapeHtml(branding.iconUrl)}" width="30" height="30" fetchpriority="high" alt="" />
          <span translate="no">${escapeHtml(project.name)}</span>
        </a>
        <button class="menu-button" type="button" aria-expanded="false" aria-controls="primary-navigation" aria-label="Open navigation">
          <svg aria-hidden="true" viewBox="0 0 256 256"><path d="M228 128a12 12 0 0 1-12 12H40a12 12 0 0 1 0-24h176a12 12 0 0 1 12 12ZM40 76h176a12 12 0 0 0 0-24H40a12 12 0 0 0 0 24Zm176 104H40a12 12 0 0 0 0 24h176a12 12 0 0 0 0-24Z" /></svg>
        </button>
        <nav id="primary-navigation" class="primary-navigation" aria-label="${escapeHtml(project.name)} links">${navigation}</nav>
      </div>
    </header>`;
}

export default defineConfig({
  plugins: [
    {
      name: "roadmap-preboot-shell",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          return html
            .replace("<!-- roadmap-preboot-header -->", renderPrebootHeader())
            .replaceAll(
              "__ROADMAP_BACKGROUND__",
              escapeHtml(publicConfig.branding.backgroundColor),
            );
        },
      },
    },
    react(),
  ],
  define: {
    __ROADMAP_PUBLIC_CONFIG__: JSON.stringify(publicConfig),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
