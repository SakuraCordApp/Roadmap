export function LoadingPage() {
  return (
    <main
      id="main-content"
      className="state-page"
      aria-busy="true"
      aria-label="Loading SakuraCord plans"
    >
      <img src="/brand/favicon.png" width="128" height="128" fetchPriority="high" alt="" />
      <p>Loading SakuraCord plans…</p>
      <span>Fetching the published changes.</span>
    </main>
  );
}

export function RoadmapSkeleton() {
  return (
    <div
      className="roadmap-board skeleton-board"
      aria-busy="true"
      aria-label="Loading roadmap items"
    >
      {[1, 2, 3, 4].map((column) => (
        <div className="roadmap-lane" key={column}>
          <div className="lane-header">
            <div className="skeleton skeleton-title" />
          </div>
          <div className="lane-items">
            <div className="skeleton skeleton-item" />
            <div className="skeleton skeleton-item" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ErrorPage({ message }: { message: string }) {
  return (
    <main id="main-content" className="state-page state-page--error">
      <span className="state-code">ROADMAP_UNAVAILABLE</span>
      <h1>This page could not be loaded.</h1>
      <p>{message}</p>
      <button type="button" onClick={() => window.location.reload()}>
        Try again
      </button>
    </main>
  );
}

export function InlineError({ message }: { message: string }) {
  return (
    <div className="inline-message inline-message--error" role="alert">
      <strong>Changes could not be loaded.</strong>
      <span>{message}</span>
    </div>
  );
}
