import { AREAS, type IssueKind, type PriorityId } from "../config";

// The single definition of a SakuraCord report. Discord modals, GitHub issue
// forms, the website form, and the canonical issue body are all generated from
// it, so the three surfaces cannot drift apart.

export type FieldKind = "short" | "paragraph" | "choice" | "version" | "area" | "files";

export interface FieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface ReportField {
  id: string;
  /** Discord label and issue-form label. Discord limits labels to 45 characters. */
  label: string;
  /** Section heading in the canonical issue body. */
  heading: string;
  description?: string;
  placeholder?: string;
  kind: FieldKind;
  required: boolean;
  maxLength?: number;
  options?: FieldOption[];
  /** Discord modal page. Page 2 is offered as "Add screenshots & details". */
  page: 1 | 2;
  /** Filled automatically when the report comes from the SakuraCord app. */
  diagnostic?: boolean;
}

export interface ReportKindDefinition {
  kind: IssueKind;
  title: string;
  submitLabel: string;
  detailsLabel: string;
  titlePlaceholder: string;
  fields: ReportField[];
}

export const IMPACT_OPTIONS: Array<FieldOption & { priority: PriorityId }> = [
  {
    value: "crash",
    label: "Crash, data loss, or I can't use SakuraCord",
    priority: "critical",
  },
  { value: "blocks", label: "Blocks something I need to do", priority: "high" },
  { value: "workaround", label: "Annoying, but there's a workaround", priority: "medium" },
  { value: "minor", label: "Minor or cosmetic", priority: "low" },
];

export const IMPORTANCE_OPTIONS: Array<FieldOption & { priority: PriorityId }> = [
  { value: "essential", label: "I can't switch to SakuraCord without it", priority: "high" },
  { value: "daily", label: "I'd use it every day", priority: "medium" },
  { value: "nice", label: "Nice to have", priority: "low" },
];

export const AREA_OPTIONS: FieldOption[] = AREAS.map((area) => ({
  value: area.id,
  label: area.label,
  description: area.description.slice(0, 100),
}));

const ANYTHING_ELSE: ReportField = {
  id: "extra",
  label: "Anything else?",
  heading: "Anything else?",
  placeholder: "Logs, links, how often it happens, workarounds…",
  kind: "paragraph",
  required: false,
  maxLength: 3000,
  page: 2,
};

export const REPORT_KINDS: Record<IssueKind, ReportKindDefinition> = {
  bug: {
    kind: "bug",
    title: "Report a bug",
    submitLabel: "Submit bug report",
    detailsLabel: "Add screenshots & system info",
    titlePlaceholder: "e.g. Images in threads never finish loading",
    fields: [
      {
        id: "what_happened",
        label: "What happened?",
        heading: "What happened?",
        description: "What you did, what happened, and what you expected instead",
        placeholder: "I opened a thread with images and they stayed as grey boxes…",
        kind: "paragraph",
        required: true,
        maxLength: 4000,
        page: 1,
      },
      {
        id: "steps",
        label: "Steps to reproduce",
        heading: "Steps to reproduce",
        placeholder: "1. Open a server\n2. Click a thread with images\n3. …",
        kind: "paragraph",
        required: false,
        maxLength: 2000,
        page: 1,
      },
      {
        id: "impact",
        label: "How much does this affect you?",
        heading: "Impact",
        kind: "choice",
        required: true,
        options: IMPACT_OPTIONS,
        page: 1,
      },
      {
        id: "version",
        label: "SakuraCord version",
        heading: "SakuraCord version",
        description: "Only the latest nightly or regular release. Update and retest first.",
        placeholder: "e.g. 0.1.6 Beta 3",
        kind: "version",
        required: true,
        maxLength: 80,
        page: 1,
        diagnostic: true,
      },
      {
        id: "attachments",
        label: "Screenshots or recordings",
        heading: "Screenshots or recordings",
        description: "Up to 5 images or short videos",
        kind: "files",
        required: false,
        page: 2,
      },
      {
        id: "macos",
        label: "macOS version",
        heading: "macOS version",
        placeholder: "e.g. macOS 27.0 beta 3 (27A5300)",
        kind: "short",
        required: false,
        maxLength: 80,
        page: 2,
        diagnostic: true,
      },
      {
        id: "mac",
        label: "Mac model",
        heading: "Mac model",
        placeholder: "e.g. MacBook Pro (M3, 2023)",
        kind: "short",
        required: false,
        maxLength: 80,
        page: 2,
        diagnostic: true,
      },
      {
        id: "area",
        label: "Area",
        heading: "Area",
        description: "Optional. We'll pick one if you're unsure",
        kind: "area",
        required: false,
        options: AREA_OPTIONS,
        page: 2,
      },
      ANYTHING_ELSE,
    ],
  },
  feature: {
    kind: "feature",
    title: "Suggest a feature",
    submitLabel: "Submit suggestion",
    detailsLabel: "Add mockups & details",
    titlePlaceholder: "e.g. Custom notification sounds per server",
    fields: [
      {
        id: "request",
        label: "What would you like?",
        heading: "What would you like?",
        description: "Describe the feature or change",
        placeholder: "Let me pick a different notification sound for each server…",
        kind: "paragraph",
        required: true,
        maxLength: 4000,
        page: 1,
      },
      {
        id: "problem",
        label: "Why do you want it?",
        heading: "Why do you want it?",
        description: "The problem it solves or how you'd use it",
        kind: "paragraph",
        required: false,
        maxLength: 2000,
        page: 1,
      },
      {
        id: "importance",
        label: "How important is it to you?",
        heading: "Importance",
        kind: "choice",
        required: true,
        options: IMPORTANCE_OPTIONS,
        page: 1,
      },
      {
        id: "version",
        label: "SakuraCord version",
        heading: "SakuraCord version",
        description: "Only the latest nightly or regular release. Update and retest first.",
        placeholder: "e.g. 0.1.6 Beta 3",
        kind: "version",
        required: true,
        maxLength: 80,
        page: 1,
        diagnostic: true,
      },
      {
        id: "area",
        label: "Area",
        heading: "Area",
        description: "Optional. We'll pick one if you're unsure",
        kind: "area",
        required: false,
        options: AREA_OPTIONS,
        page: 2,
      },
      {
        id: "attachments",
        label: "Mockups or examples",
        heading: "Mockups or examples",
        description: "Up to 5 images or short videos",
        kind: "files",
        required: false,
        page: 2,
      },
      ANYTHING_ELSE,
    ],
  },
};

export const TITLE_MAX_LENGTH = 100;

export function fieldsForPage(kind: IssueKind, page: 1 | 2): ReportField[] {
  return REPORT_KINDS[kind].fields.filter((field) => field.page === page);
}

/** Values keyed by field id. Choice fields hold the option value. */
export type ReportValues = Record<string, string>;

export function derivedPriority(kind: IssueKind, values: ReportValues): PriorityId {
  const options = kind === "bug" ? IMPACT_OPTIONS : IMPORTANCE_OPTIONS;
  const key = kind === "bug" ? values.impact : values.importance;
  return options.find((option) => option.value === key)?.priority ?? "medium";
}

export function optionLabel(field: ReportField, value: string): string {
  if (field.kind === "area") return AREAS.find((area) => area.id === value)?.label ?? value;
  return field.options?.find((option) => option.value === value)?.label ?? value;
}

export function optionValue(field: ReportField, label: string): string | undefined {
  const normalized = label.trim().toLowerCase();
  if (field.kind === "area") {
    return AREAS.find((area) => area.label.toLowerCase() === normalized || area.id === normalized)
      ?.id;
  }
  return field.options?.find(
    (option) => option.label.toLowerCase() === normalized || option.value === normalized,
  )?.value;
}
