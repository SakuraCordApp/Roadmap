import type { RoadmapItem } from "@roadmap/core";
import { useEffect, useState, type CSSProperties } from "react";
import { fetchItem, type PublicConfig } from "./api.js";
import { type LoadState, toMessage } from "./load-state.js";
import { kindLabel, priorityLabel } from "./public-fields.js";
import { ErrorPage } from "./ui.js";

export function ItemDetail({ config, id }: { config: PublicConfig; id: string }) {
  const [item, setItem] = useState<LoadState<RoadmapItem>>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetchItem(id, controller.signal)
      .then((value) => {
        setItem({ state: "ready", value });
        document.title = `${value.title} | ${config.project.name} Roadmap`;
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setItem({ state: "error", message: toMessage(error) });
      });
    return () => controller.abort();
  }, [config.project.name, id]);

  if (item.state === "loading") return <DetailSkeleton />;
  if (item.state === "error") return <ErrorPage message={item.message} />;

  const value = item.value;
  const status = config.lifecycle.find((candidate) => candidate.id === value.status);
  const priority = priorityLabel(value.priority);

  return (
    <article className="detail-page">
      <a className="back-link" href="/#browse">
        Back to roadmap
      </a>
      <div className="detail-record">
        <header>
          <span
            className="detail-status"
            style={{ "--status-color": status?.color } as CSSProperties}
          >
            {status?.label ?? value.status}
          </span>
          <h1>{value.title}</h1>
          <p>{value.description}</p>
        </header>
        <dl className="detail-fields" aria-label="Change details">
          <div>
            <dt>Priority</dt>
            <dd className={`priority priority--${priority.toLocaleLowerCase()}`}>{priority}</dd>
          </div>
          <div>
            <dt>Kind</dt>
            <dd>{kindLabel(value.type)}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{status?.label ?? value.status}</dd>
          </div>
        </dl>
      </div>
    </article>
  );
}

function DetailSkeleton() {
  return (
    <div className="detail-page detail-skeleton" aria-busy="true" aria-label="Loading change">
      <div className="skeleton detail-skeleton__back" />
      <div className="detail-record">
        <div className="skeleton detail-skeleton__title" />
        <div className="skeleton detail-skeleton__body" />
      </div>
    </div>
  );
}
