import type { IssueKind } from "../config";
import {
  REPORT_KINDS,
  optionLabel,
  optionValue,
  type ReportField,
  type ReportValues,
} from "./schema";

// The canonical issue body uses GitHub issue-form markdown ("### Heading"
// sections), so issues filed on GitHub, Discord, and the website parse alike.

export type ReporterSource = "discord" | "website" | "github" | "legacy";

export interface Reporter {
  source: ReporterSource;
  name: string;
  discordId?: string;
  githubLogin?: string;
}

export interface AttachmentRef {
  name: string;
  url: string;
  contentType?: string | null;
}

export interface IssueMeta {
  v: 1;
  kind?: IssueKind;
  reporter?: Reporter;
  thread?: string;
  legacyId?: string;
}

export interface Section {
  heading: string;
  text: string;
}

const META_PATTERN = /<!--\s*sakuracord:meta\s+(\{[\s\S]*?\})\s*-->/;
const FOOTER_SEPARATOR = "\n\n---\n<sub>";
const NO_RESPONSE = "_No response_";

/** Prevent user text from pinging GitHub users or forging body structure. */
export function neutralizeUserText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/<!--\s*sakuracord/gi, "<!-- user")
    .replace(/^(#{1,6})(\s)/gm, "\\$1$2")
    .replace(/@(?=[A-Za-z0-9-])/g, "@\u200b")
    .trim();
}

function restoreUserText(value: string): string {
  return value.replace(/^\\(#{1,6}\s)/gm, "$1").replace(/@\u200b/g, "@");
}

export function attachmentMarkdown(attachments: AttachmentRef[]): string {
  return attachments
    .map((attachment) => {
      const name = attachment.name.replace(/[[\]]/g, "");
      return attachment.contentType?.startsWith("image/")
        ? `![${name}](${attachment.url})`
        : `[${name}](${attachment.url})`;
    })
    .join("\n");
}

export interface RenderInput {
  kind: IssueKind;
  values: ReportValues;
  attachments?: AttachmentRef[];
  reporter?: Reporter;
  threadUrl?: string;
  trackerUrl?: string;
  legacyId?: string;
  extraSections?: Section[];
}

export function renderIssueBody(input: RenderInput): string {
  const definition = REPORT_KINDS[input.kind];
  const sections: string[] = [];
  for (const field of definition.fields) {
    let text: string;
    if (field.kind === "files") {
      text = attachmentMarkdown(input.attachments ?? []);
    } else {
      const value = input.values[field.id]?.trim();
      if (!value) continue;
      text =
        field.kind === "choice" || field.kind === "area"
          ? optionLabel(field, value)
          : neutralizeUserText(value);
    }
    if (text) sections.push(`### ${field.heading}\n\n${text}`);
  }
  for (const section of input.extraSections ?? []) {
    if (section.text.trim()) sections.push(`### ${section.heading}\n\n${section.text.trim()}`);
  }
  return `${sections.join("\n\n")}${renderFooter(input)}`;
}

export function renderFooter(input: {
  kind?: IssueKind;
  reporter?: Reporter;
  threadUrl?: string;
  trackerUrl?: string;
  legacyId?: string;
}): string {
  const meta: IssueMeta = {
    v: 1,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.reporter ? { reporter: input.reporter } : {}),
    ...(input.threadUrl ? { thread: input.threadUrl } : {}),
    ...(input.legacyId ? { legacyId: input.legacyId } : {}),
  };
  const parts: string[] = [];
  if (input.reporter) {
    const where =
      input.reporter.source === "website"
        ? "on sakuracord.app"
        : input.reporter.source === "github"
          ? "on GitHub"
          : "on Discord";
    const name = input.reporter.name.replace(/[*_`[\]<>]/g, "");
    parts.push(
      input.reporter.source === "legacy"
        ? `Originally reported by **${name}** on Discord`
        : `Reported by **${name}** ${where}`,
    );
  }
  if (input.threadUrl) parts.push(`[Discord discussion](${input.threadUrl})`);
  if (input.trackerUrl) parts.push(`[Tracker](${input.trackerUrl})`);
  const line = parts.length ? parts.join(" · ") : "SakuraCord report";
  return `${FOOTER_SEPARATOR}${line}</sub>\n<!-- sakuracord:meta ${JSON.stringify(meta)} -->`;
}

export function parseMeta(body: string | null | undefined): IssueMeta | null {
  const match = body?.match(META_PATTERN);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!) as IssueMeta;
    return parsed && parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Remove the generated footer so the body can be re-rendered or displayed. */
export function stripFooter(body: string): string {
  const withoutMeta = body.replace(META_PATTERN, "").trimEnd();
  const index = withoutMeta.lastIndexOf("\n---\n<sub>");
  return (index >= 0 ? withoutMeta.slice(0, index) : withoutMeta).trimEnd();
}

/** Replace (or add) the generated footer while keeping every section intact. */
export function withFooter(body: string, footer: Parameters<typeof renderFooter>[0]): string {
  return `${stripFooter(body)}${renderFooter(footer)}`;
}

export function parseSections(body: string | null | undefined): Section[] {
  const content = stripFooter(body ?? "");
  const sections: Section[] = [];
  const pattern = /^###\s+(.+?)\s*$/gm;
  const matches = [...content.matchAll(pattern)];
  if (!matches.length) {
    const text = content.trim();
    return text ? [{ heading: "Description", text: restoreUserText(text) }] : [];
  }
  const preamble = content.slice(0, matches[0]!.index).trim();
  if (preamble) sections.push({ heading: "Description", text: restoreUserText(preamble) });
  matches.forEach((match, index) => {
    const start = match.index! + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1]!.index! : content.length;
    const text = content.slice(start, end).trim();
    if (text && text !== NO_RESPONSE) {
      sections.push({ heading: match[1]!.trim(), text: restoreUserText(text) });
    }
  });
  return sections;
}

function fieldForHeading(kind: IssueKind, heading: string): ReportField | undefined {
  const normalized = heading.toLowerCase();
  return REPORT_KINDS[kind].fields.find(
    (field) =>
      field.heading.toLowerCase() === normalized || field.label.toLowerCase() === normalized,
  );
}

/** Read structured values back out of an issue body (including GitHub issue forms). */
export function valuesFromBody(kind: IssueKind, body: string | null | undefined): ReportValues {
  const values: ReportValues = {};
  for (const section of parseSections(body)) {
    const field = fieldForHeading(kind, section.heading);
    if (!field || field.kind === "files") continue;
    if (field.kind === "choice" || field.kind === "area") {
      const value = optionValue(field, section.text);
      if (value) values[field.id] = value;
    } else {
      values[field.id] = section.text;
    }
  }
  return values;
}

/** Plain text used for embeddings and AI triage. */
export function reportText(title: string, body: string | null | undefined, limit = 6000): string {
  const sections = parseSections(body)
    .filter((section) => !/screenshots|mockups/i.test(section.heading))
    .map((section) => `${section.heading}: ${section.text}`)
    .join("\n");
  return `${title}\n${sections}`.slice(0, limit);
}
