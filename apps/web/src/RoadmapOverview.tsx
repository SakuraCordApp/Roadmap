import type { RoadmapItem } from "@roadmap/core";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { fetchItems, type PublicConfig } from "./api.js";
import { type LoadState, toMessage } from "./load-state.js";
import {
  filterPublicRoadmapItems,
  priorityLabel,
  type PublicKind,
  type PublicPriority,
} from "./public-fields.js";
import { InlineError, RoadmapSkeleton } from "./ui.js";

export function RoadmapOverview({ config }: { config: PublicConfig }) {
  const [items, setItems] = useState<LoadState<RoadmapItem[]>>({ state: "loading" });
  const [initialFilters] = useState(() => readFiltersFromUrl(config));
  const [search, setSearch] = useState(initialFilters.search);
  const [priority, setPriority] = useState<PublicPriority | "">(initialFilters.priority);
  const [kind, setKind] = useState<PublicKind | "">(initialFilters.kind);
  const [status, setStatus] = useState(initialFilters.status);
  const deferredSearch = useDeferredValue(search);
  const publicStatuses = useMemo(() => {
    const visibleStatuses = new Set(config.publicSections.flatMap((section) => section.statuses));
    return config.lifecycle.filter((state) => visibleStatuses.has(state.id));
  }, [config.lifecycle, config.publicSections]);

  useEffect(() => {
    const controller = new AbortController();
    fetchItems({}, controller.signal)
      .then((value) => setItems({ state: "ready", value }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setItems({ state: "error", message: toMessage(error) });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const query = new URLSearchParams();
    if (search.trim()) query.set("search", search.trim());
    if (priority) query.set("priority", priority);
    if (kind) query.set("kind", kind);
    if (status) query.set("status", status);
    const suffix = query.size ? `?${query.toString()}` : "";
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${suffix}${window.location.hash}`,
    );
  }, [search, priority, kind, status]);

  const allItems = items.state === "ready" ? items.value : [];
  const filteredItems = useMemo(
    () => filterPublicRoadmapItems(allItems, deferredSearch, priority, kind, status),
    [allItems, deferredSearch, priority, kind, status],
  );
  const hasFilters = Boolean(search.trim() || priority || kind || status);

  const clearFilters = () => {
    setSearch("");
    setPriority("");
    setKind("");
    setStatus("");
  };

  return (
    <>
      <section className="overview-hero" aria-labelledby="roadmap-title">
        <div className="overview-hero__copy">
          <h1 id="roadmap-title">
            <span translate="no">{config.project.name}</span> Roadmap
          </h1>
          <p>
            A clear view of new reports, planned work, active development, and completed changes.
          </p>
          <a className="primary-action" href="#browse">
            Browse changes <span aria-hidden="true">↓</span>
          </a>
        </div>
        <div className="overview-hero__mark">
          <img
            src={config.branding.logoUrl}
            width="1024"
            height="1024"
            fetchPriority="high"
            alt={`${config.project.name} logo`}
          />
        </div>
      </section>

      <section id="browse" className="browse-section" aria-labelledby="browse-heading">
        <header className="browse-heading">
          <h2 id="browse-heading">Roadmap</h2>
        </header>

        <form className="filters" role="search" onSubmit={(event) => event.preventDefault()}>
          <label className="filter-control filter-control--search">
            <span>Search changes</span>
            <input
              name="search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search the roadmap…"
              autoComplete="off"
            />
          </label>
          <label className="filter-control">
            <span>Priority</span>
            <select
              name="priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value as PublicPriority | "")}
            >
              <option value="">All priorities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <label className="filter-control">
            <span>Category</span>
            <select
              name="kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as PublicKind | "")}
            >
              <option value="">All categories</option>
              <option value="feature">New Features</option>
              <option value="bug">Bug Tracking</option>
            </select>
          </label>
          <label className="filter-control filter-control--status">
            <span>Status</span>
            <select
              name="status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">All statuses</option>
              {publicStatuses.map((state) => (
                <option key={state.id} value={state.id}>
                  {state.label}
                </option>
              ))}
            </select>
          </label>
          {hasFilters ? (
            <button className="clear-filters" type="button" onClick={clearFilters}>
              Clear
            </button>
          ) : null}
        </form>

        {items.state === "ready" ? (
          <p className="result-summary" aria-live="polite">
            {filteredItems.length} {filteredItems.length === 1 ? "change" : "changes"}
          </p>
        ) : null}

        {items.state === "loading" ? <RoadmapSkeleton /> : null}
        {items.state === "error" ? <InlineError message={items.message} /> : null}
        {items.state === "ready" ? (
          <RoadmapBoard
            items={filteredItems}
            config={config}
            filtered={hasFilters}
            statusFilter={status}
            onClearFilters={clearFilters}
          />
        ) : null}
      </section>
    </>
  );
}

function RoadmapBoard({
  items,
  config,
  filtered,
  statusFilter,
  onClearFilters,
}: {
  items: RoadmapItem[];
  config: PublicConfig;
  filtered: boolean;
  statusFilter: string;
  onClearFilters: () => void;
}) {
  const groups = config.itemTypes
    .map((type) => ({
      ...type,
      items: items.filter((item) => item.type === type.id),
      sections: config.publicSections
        .filter((section) => !statusFilter || section.statuses.includes(statusFilter))
        .map((section) => ({
          ...section,
          color: config.lifecycle.find((state) => section.statuses.includes(state.id))?.color,
          items: items.filter(
            (item) => item.type === type.id && section.statuses.includes(item.status),
          ),
        })),
    }))
    .filter((group) => group.items.length > 0);

  if (items.length === 0) {
    return (
      <div className="inline-message inline-message--empty">
        <h3>{filtered ? "No changes match." : "No changes yet."}</h3>
        <p>
          {filtered
            ? "Try another search or clear the filters."
            : "The roadmap is empty. Published changes will appear here."}
        </p>
        {filtered ? (
          <button type="button" onClick={onClearFilters}>
            Clear filters
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {groups.map((group) => (
        <section
          className="roadmap-category"
          key={group.id}
          aria-labelledby={`category-${group.id}`}
        >
          <header className="category-header">
            <h3 id={`category-${group.id}`}>{group.label}</h3>
            <strong>{group.items.length}</strong>
          </header>
          <nav className="status-index" aria-label={`${group.label} statuses`}>
            {group.sections.map((section) => (
              <a key={section.id} href={`#${group.id}-status-${section.id}`}>
                <span>{section.label}</span>
                <strong aria-label={`${section.items.length} items`}>{section.items.length}</strong>
              </a>
            ))}
          </nav>
          <div className="roadmap-board">
            {group.sections.map((section) => (
              <section
                id={`${group.id}-status-${section.id}`}
                className="roadmap-lane"
                key={section.id}
                aria-labelledby={`${group.id}-section-${section.id}`}
                style={{ "--status-color": section.color } as React.CSSProperties}
              >
                <header className="lane-header">
                  <h4 id={`${group.id}-section-${section.id}`}>{section.label}</h4>
                  <strong aria-label={`${section.items.length} items`}>
                    {section.items.length}
                  </strong>
                </header>
                <div className="lane-items">
                  {section.items.length ? (
                    section.items.map((item) => <RoadmapItemRow key={item.id} item={item} />)
                  ) : (
                    <p className="lane-empty">No changes here.</p>
                  )}
                </div>
              </section>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function RoadmapItemRow({ item }: { item: RoadmapItem }) {
  const priority = priorityLabel(item.priority);
  return (
    <article className={`roadmap-item roadmap-item--${item.priority}`}>
      <img
        className="roadmap-item__priority-icon"
        src={`/brand/priority/${item.priority}.svg`}
        width="64"
        height="64"
        alt={`${priority} priority`}
        title={`${priority} priority`}
      />
      <h4>{item.title}</h4>
    </article>
  );
}

function readFiltersFromUrl(config: PublicConfig): {
  search: string;
  priority: PublicPriority | "";
  kind: PublicKind | "";
  status: string;
} {
  const query = new URLSearchParams(window.location.search);
  const priority = query.get("priority");
  const kind = query.get("kind");
  const status = query.get("status");
  const publicStatuses = new Set(config.publicSections.flatMap((section) => section.statuses));
  return {
    search: query.get("search") ?? "",
    priority:
      priority === "critical" || priority === "high" || priority === "medium" || priority === "low"
        ? priority
        : "",
    kind: kind === "feature" || kind === "bug" ? kind : "",
    status: status && publicStatuses.has(status) ? status : "",
  };
}
