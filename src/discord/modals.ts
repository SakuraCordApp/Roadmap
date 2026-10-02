import type { ReportRelease } from "../releases";
import type { IssueKind } from "../config";
import {
  REPORT_KINDS,
  TITLE_MAX_LENGTH,
  fieldsForPage,
  type ReportField,
  type ReportValues,
} from "../report/schema";
import { truncate } from "../util/text";

function fieldComponent(field: ReportField, prefill: ReportValues, versions: string[]) {
  const value = prefill[field.id];
  switch (field.kind) {
    case "short":
    case "paragraph":
      return {
        type: 4,
        custom_id: field.id,
        style: field.kind === "short" ? 1 : 2,
        required: field.required,
        ...(field.maxLength ? { max_length: field.maxLength } : {}),
        ...(field.placeholder ? { placeholder: truncate(field.placeholder, 100) } : {}),
        ...(value ? { value: truncate(value, field.maxLength ?? 4000) } : {}),
      };
    case "choice":
      return {
        type: 21,
        custom_id: field.id,
        required: field.required,
        options: field.options!.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.value === value ? { default: true } : {}),
        })),
      };
    case "version": {
      const choices = [...new Set(versions)].slice(0, 2);
      return {
        type: 3,
        custom_id: field.id,
        required: field.required,
        placeholder: "Pick the version you're using",
        options: choices.map((choice) => ({
          label: choice,
          value: choice,
          ...(choice === value ? { default: true } : {}),
        })),
      };
    }
    case "area":
      return {
        type: 3,
        custom_id: field.id,
        required: field.required,
        min_values: field.required ? 1 : 0,
        max_values: 1,
        placeholder: "Pick an area (optional)",
        options: field.options!.map((option) => ({
          label: option.label,
          value: option.value,
          ...(option.description ? { description: option.description } : {}),
          ...(option.value === value ? { default: true } : {}),
        })),
      };
    case "files":
      return {
        type: 19,
        custom_id: field.id,
        required: false,
        min_values: 0,
        max_values: 5,
      };
  }
}

function labelled(field: ReportField, component: unknown) {
  return {
    type: 18,
    label: field.label,
    ...(field.description ? { description: truncate(field.description, 100) } : {}),
    component,
  };
}

export function reportModal(
  kind: IssueKind,
  page: 1 | 2,
  customId: string,
  prefill: ReportValues,
  versions: string[],
) {
  const definition = REPORT_KINDS[kind];
  const components: unknown[] = [];
  if (page === 1) {
    components.push({
      type: 18,
      label: "Title",
      description: "A short summary",
      component: {
        type: 4,
        custom_id: "title",
        style: 1,
        required: true,
        min_length: 4,
        max_length: TITLE_MAX_LENGTH,
        placeholder: definition.titlePlaceholder,
        ...(prefill.title ? { value: prefill.title } : {}),
      },
    });
  }
  for (const field of fieldsForPage(kind, page)) {
    components.push(labelled(field, fieldComponent(field, prefill, versions)));
  }
  return {
    type: 9,
    data: {
      custom_id: customId,
      title: page === 1 ? definition.title : definition.detailsLabel,
      components: components.slice(0, 5),
    },
  };
}

export function detailsModal(number: number) {
  return {
    type: 9,
    data: {
      custom_id: `m3:${number}`,
      title: truncate(`Add details to #${number}`, 45),
      components: [
        {
          type: 18,
          label: "What would you like to add?",
          component: {
            type: 4,
            custom_id: "text",
            style: 2,
            required: false,
            max_length: 3000,
            placeholder: "New details, answers to questions, when it happens…",
          },
        },
        {
          type: 18,
          label: "Screenshots or recordings",
          description: "Up to 5 files",
          component: {
            type: 19,
            custom_id: "files",
            required: false,
            min_values: 0,
            max_values: 5,
          },
        },
      ],
    },
  };
}

export interface ModalSubmission {
  values: Record<string, string>;
  multi: Record<string, string[]>;
  attachments: Array<{
    id: string;
    url: string;
    filename: string;
    content_type?: string;
    size?: number;
  }>;
}

/** Flatten a MODAL_SUBMIT payload (labels nest their component). */
export function parseModal(data: any): ModalSubmission {
  const values: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  const attachmentIds: string[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node.custom_id === "string") {
      if (node.type === 19 && Array.isArray(node.values)) attachmentIds.push(...node.values);
      else if (Array.isArray(node.values)) {
        multi[node.custom_id] = node.values;
        if (node.values[0] !== undefined) values[node.custom_id] = String(node.values[0]);
      } else if (typeof node.value === "string") values[node.custom_id] = node.value;
      else if (typeof node.value === "boolean") values[node.custom_id] = node.value ? "true" : "";
    }
    visit(node.component);
    visit(node.components);
  };
  visit(data?.components);
  const resolved = data?.resolved?.attachments ?? {};
  const attachments = attachmentIds
    .map((id) => resolved[id])
    .filter(Boolean)
    .map((attachment: any) => ({
      id: attachment.id,
      url: attachment.url,
      filename: attachment.filename,
      content_type: attachment.content_type,
      size: attachment.size,
    }));
  return { values, multi, attachments };
}

export function fixedModal(number: number, kind: IssueKind | null, releases: ReportRelease[]) {
  return {
    type: 9,
    data: {
      custom_id: `ma:mark_fixed:${number}`,
      title: truncate(`Mark ${kind === "feature" ? "implemented" : "fixed"} · #${number}`, 45),
      components: [
        {
          type: 18,
          label: "Where is the fix available?",
          component: {
            type: 3,
            custom_id: "release",
            required: true,
            options: [
              { label: "In code — not released yet", value: "unreleased" },
              ...releases
                .slice(0, 2)
                .map((r) => ({ label: `${r.version} (${r.channel})`, value: r.tag })),
              { label: "Another published release…", value: "other" },
            ],
          },
        },
        {
          type: 18,
          label: "Commit, PR, or other release",
          description:
            "Required for unreleased fixes or another release. Paste a link, SHA, PR number, or release tag.",
          component: {
            type: 4,
            custom_id: "reference",
            style: 1,
            required: false,
            max_length: 300,
          },
        },
        {
          type: 18,
          label: "Note for the reporter",
          component: {
            type: 4,
            custom_id: "note",
            style: 2,
            required: false,
            max_length: 1500,
          },
        },
      ],
    },
  };
}
