import type { RoadmapVersion } from "@roadmap/core";
import { useEffect, useMemo, useState } from "react";
import { fetchVersions, type PublicConfig, watchVersions } from "./api.js";
import { type LoadState, toMessage } from "./load-state.js";
import { InlineError } from "./ui.js";

export function RoadmapTimeline({ config }: { config: PublicConfig }) {
  const [versions, setVersions] = useState<LoadState<RoadmapVersion[]>>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    const applyVersions = (value: RoadmapVersion[]) => {
      if (!stopped) setVersions({ state: "ready", value });
    };
    const refresh = () =>
      fetchVersions(controller.signal)
        .then(applyVersions)
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setVersions((current) =>
              current.state === "loading" ? { state: "error", message: toMessage(error) } : current,
            );
          }
        });

    void refresh();
    const stopWatching = watchVersions(applyVersions);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("online", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      stopped = true;
      stopWatching();
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener("online", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      controller.abort();
    };
  }, []);

  const visibleVersions = useMemo(
    () => (versions.state === "ready" ? selectPublicVersions(versions.value) : []),
    [versions],
  );

  return (
    <>
      <section id="versions" className="version-section" aria-labelledby="roadmap-title">
        <div className="page-shell">
          <h1 id="roadmap-title" className="roadmap-heading">
            Roadmap
          </h1>
          {versions.state === "loading" ? <VersionTimelineSkeleton /> : null}
          {versions.state === "error" ? <InlineError message={versions.message} /> : null}
          {versions.state === "ready" && visibleVersions.length === 0 ? (
            <div className="version-empty">
              <h3>The next version plan is being prepared.</h3>
              <p>Major plans will appear here as soon as they are ready to share.</p>
            </div>
          ) : null}
          {visibleVersions.length ? <VersionTimeline versions={visibleVersions} /> : null}
        </div>
      </section>

      <section className="tracker-handoff" aria-labelledby="tracker-handoff-title">
        <div className="page-shell tracker-handoff__frame">
          <div className="tracker-handoff__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <rect x="5" y="4" width="14" height="16" rx="2" />
              <path d="M9 9h6M9 13h6M9 17h4" />
            </svg>
          </div>
          <div className="tracker-handoff__copy">
            <h2 id="tracker-handoff-title">Want the full details?</h2>
            <p>See every task, idea, and improvement in the SakuraCord Tracker.</p>
          </div>
          <a href={config.project.trackerUrl ?? "/tracker"}>
            Open the tracker
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <path d="M3.5 12.5 12.5 3.5M6 3.5h6.5V10" />
            </svg>
          </a>
        </div>
      </section>
    </>
  );
}

function VersionTimeline({ versions }: { versions: RoadmapVersion[] }) {
  return (
    <div className="version-timeline">
      {versions.map((version) => (
        <article className="version-entry" key={version.id}>
          <div className="version-entry__rail" aria-hidden="true">
            <span />
          </div>
          <div className="version-entry__content">
            <header className="version-entry__header">
              <strong translate="no">v{version.version}</strong>
              <span className="version-entry__dash" aria-hidden="true">
                —
              </span>
              <h3>{version.title}</h3>
            </header>
            {version.highlights.length ? (
              <ul>
                {version.highlights.map((highlight) => (
                  <li key={highlight.id}>
                    <span>{highlight.title}</span>
                    {highlight.description ? <small>{highlight.description}</small> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="version-entry__empty">Highlights are being prepared.</p>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function VersionTimelineSkeleton() {
  return (
    <div
      className="version-timeline version-timeline--loading"
      aria-busy="true"
      aria-label="Loading version roadmap"
    >
      {[0, 1, 2].map((index) => (
        <div className="version-entry" key={index}>
          <div className="version-entry__rail" aria-hidden="true">
            <span />
          </div>
          <div className="version-entry__content">
            <span className="skeleton-line skeleton-line--title" />
            <span className="skeleton-line" />
            <span className="skeleton-line skeleton-line--short" />
          </div>
        </div>
      ))}
    </div>
  );
}

function selectPublicVersions(versions: RoadmapVersion[]): RoadmapVersion[] {
  return versions
    .filter((version) => version.state === "planned")
    .sort(
      (left, right) => left.position - right.position || compareSemver(left.version, right.version),
    );
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split("-", 1)[0]!.split(".").map(Number);
  const rightParts = right.split("-", 1)[0]!.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  return left.localeCompare(right);
}
