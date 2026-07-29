import type { AcceptanceCriterion, EvidenceReference, RoadmapItem } from "@roadmap/core";
import { useEffect, useState, type ReactNode } from "react";
import { fetchItem, type PublicConfig } from "./api.js";
import { type LoadState, toMessage } from "./load-state.js";
import { kindLabel, priorityLabel } from "./public-fields.js";
import { ErrorPage } from "./ui.js";

export function ItemDetail({ config, id }: { config: PublicConfig; id: string }) {
  const [item, setItem] = useState<LoadState<RoadmapItem>>({ state: "loading" });
  const [copied, setCopied] = useState(false);

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

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1_800);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  if (item.state === "loading") return <DetailSkeleton />;
  if (item.state === "error") return <ErrorPage message={item.message} />;

  const value = item.value;
  const status = config.lifecycle.find((candidate) => candidate.id === value.status);
  const area = optionLabel(config.areas, value.area);
  const priority = priorityLabel(value.priority);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(value.id);
      setCopied(true);
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      const idElement = document.querySelector(".detail-identity > code");
      if (!idElement) return;
      range.selectNodeContents(idElement);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const copiedWithFallback = document.execCommand("copy");
      selection?.removeAllRanges();
      if (copiedWithFallback) setCopied(true);
    }
  };

  return (
    <article className="detail-page">
      <nav className="detail-breadcrumb" aria-label="Breadcrumb">
        <a className="back-link" href="/#browse">
          <ArrowLeftIcon />
          Roadmap
        </a>
      </nav>

      <main className="detail-layout">
        <header className="detail-masthead">
          <div className="detail-identity">
            <code>{value.id}</code>
            <button
              className="copy-id"
              type="button"
              onClick={() => void copyId()}
              aria-label={copied ? "Roadmap item ID copied" : "Copy roadmap item ID"}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              <span>{copied ? "Copied" : "Copy ID"}</span>
            </button>
            <span className="copy-announcement" aria-live="polite">
              {copied ? "Roadmap item ID copied" : ""}
            </span>
          </div>

          <div className="detail-status">
            <span aria-hidden="true" />
            {status?.label ?? value.status}
          </div>

          <h1>{value.title}</h1>
          <p className="detail-description">{value.description}</p>
        </header>

        <aside className="detail-sidebar" aria-label="Roadmap item details">
          <dl className="detail-fields">
            <DetailFact label="Priority" className={`priority priority--${priority.toLowerCase()}`}>
              {priority}
            </DetailFact>
            <DetailFact label="Kind">{kindLabel(value.type)}</DetailFact>
            <DetailFact label="Area">{area}</DetailFact>
            {value.labels.length > 0 ? (
              <DetailFact label="Type">{classificationLabel(value.labels)}</DetailFact>
            ) : null}
          </dl>
        </aside>

        <DetailSections item={value} />
      </main>
    </article>
  );
}

function DetailSections({ item }: { item: RoadmapItem }) {
  const referenceUrls = new Set(
    item.references.flatMap((reference) => (reference.url ? [reference.url] : [])),
  );
  const reportThreads = item.linkedDiscordThreads.filter(
    (thread) => !referenceUrls.has(thread.url),
  );
  const hasSources = item.references.length > 0 || reportThreads.length > 0;

  if (item.acceptanceCriteria.length === 0 && !hasSources) {
    return null;
  }

  return (
    <div className="detail-sections">
      {item.acceptanceCriteria.length > 0 ? (
        <DetailSection title="Acceptance criteria">
          <AcceptanceCriteria criteria={item.acceptanceCriteria} />
        </DetailSection>
      ) : null}

      {hasSources ? (
        <DetailSection title="Report sources">
          <ReportSources references={item.references} threads={reportThreads} />
        </DetailSection>
      ) : null}
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="detail-section">
      <h2>{title}</h2>
      <div className="detail-section__content">{children}</div>
    </section>
  );
}

function AcceptanceCriteria({ criteria }: { criteria: AcceptanceCriterion[] }) {
  return (
    <ul className="criteria-list">
      {criteria.map((criterion) => (
        <li key={criterion.id} className={criterion.satisfied ? "is-satisfied" : undefined}>
          <span className="criterion-state" aria-hidden="true">
            {criterion.satisfied ? <CheckIcon /> : null}
          </span>
          <div>
            <p>{criterion.statement}</p>
            {criterion.evidence.length > 0 ? (
              <ReferenceList references={criterion.evidence} compact />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ReportSources({
  references,
  threads,
}: {
  references: EvidenceReference[];
  threads: RoadmapItem["linkedDiscordThreads"];
}) {
  return (
    <div className="report-sources">
      {references.length > 0 ? <ReferenceList references={references} /> : null}
      {threads.length > 0 ? (
        <div className="activity-list">
          {threads.map((thread) => (
            <a
              className="activity-row"
              key={thread.threadId}
              href={thread.url}
              target="_blank"
              rel="noreferrer"
            >
              <span>Discord thread</span>
              <strong>{thread.title}</strong>
              <ExternalLinkIcon />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReferenceList({
  references,
  compact = false,
}: {
  references: EvidenceReference[];
  compact?: boolean;
}) {
  return (
    <ul className={compact ? "reference-list reference-list--compact" : "reference-list"}>
      {references.map((reference, index) => (
        <li key={`${reference.kind}-${reference.label}-${index}`}>
          {reference.url ? (
            <a href={reference.url} target="_blank" rel="noreferrer">
              <span>{reference.label}</span>
              <ExternalLinkIcon />
            </a>
          ) : (
            <span>{reference.label}</span>
          )}
          {reference.value ? <code>{reference.value}</code> : null}
        </li>
      ))}
    </ul>
  );
}

function DetailFact({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={className}>{children}</dd>
    </div>
  );
}

function optionLabel(options: Array<{ id: string; label: string }>, value: string) {
  return options.find((option) => option.id === value)?.label ?? value;
}

function classificationLabel(labels: string[]) {
  return labels.map((label) => `${label.charAt(0).toUpperCase()}${label.slice(1)}`).join(", ");
}

function ArrowLeftIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="m10.75 4.25-4.5 4.75 4.5 4.75M6.5 9h7" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="5.25" y="5.25" width="8.5" height="9" rx="1.5" />
      <path d="M11.75 5.25v-1A1.25 1.25 0 0 0 10.5 3H4.25A1.25 1.25 0 0 0 3 4.25v7a1.25 1.25 0 0 0 1.25 1.25h1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="m4 9.25 3.1 3.1L14.25 5.5" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M7 4.25H4.75a1.5 1.5 0 0 0-1.5 1.5v7.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V11M9 3.25h5.75V9M14.5 3.5 8 10" />
    </svg>
  );
}

function DetailSkeleton() {
  return (
    <div className="detail-page detail-skeleton" aria-busy="true" aria-label="Loading change">
      <div className="skeleton detail-skeleton__back" />
      <div className="detail-layout">
        <div className="detail-skeleton__record">
          <div className="skeleton detail-skeleton__id" />
          <div className="skeleton detail-skeleton__title" />
          <div className="skeleton detail-skeleton__body" />
        </div>
        <div className="skeleton detail-skeleton__sidebar" />
      </div>
    </div>
  );
}
