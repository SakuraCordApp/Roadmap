// Generate SakuraCordApp/SakuraCord's GitHub issue forms from the shared report
// schema, so GitHub asks exactly what Discord and the website ask.
//
//   npm run issue-forms -- ../SakuraCord/.github/ISSUE_TEMPLATE

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { REPORT_KINDS, type ReportField } from "../src/report/schema";
import { DISCORD } from "../src/config";

const output = process.argv[2] ?? "dist/issue-forms";

function formField(field: ReportField) {
  const attributes: Record<string, unknown> = {
    label: field.label,
    ...(field.description ? { description: field.description } : {}),
  };
  switch (field.kind) {
    case "short":
    case "version":
      return {
        type: "input",
        id: field.id,
        attributes: {
          ...attributes,
          ...(field.placeholder ? { placeholder: field.placeholder } : {}),
        },
        validations: { required: field.required },
      };
    case "paragraph":
      return {
        type: "textarea",
        id: field.id,
        attributes: {
          ...attributes,
          ...(field.placeholder ? { placeholder: field.placeholder } : {}),
        },
        validations: { required: field.required },
      };
    case "files":
      return {
        type: "textarea",
        id: field.id,
        attributes: { ...attributes, description: "Drag images or videos here." },
        validations: { required: false },
      };
    case "choice":
    case "area":
      return {
        type: "dropdown",
        id: field.id,
        attributes: { ...attributes, options: field.options!.map((option) => option.label) },
        validations: { required: field.required },
      };
  }
}

function form(kind: "bug" | "feature") {
  const definition = REPORT_KINDS[kind];
  const bug = kind === "bug";
  return {
    name: bug ? "🐞 Bug report" : "✨ Feature suggestion",
    description: bug ? "Something in SakuraCord is broken" : "An idea for SakuraCord",
    type: bug ? "Bug" : "Feature",
    labels: ["status: new"],
    body: [
      {
        type: "markdown",
        attributes: {
          value: `${bug ? "Thanks for reporting a bug!" : "Thanks for the idea!"} Every report also gets a post in our [Discord](${DISCORD.inviteUrl}) and appears on [sakuracord.app/tracker](https://sakuracord.app/tracker). Please [search existing reports](https://sakuracord.app/tracker) first — a 👍 on an existing issue helps more than a duplicate.\n\n<!-- Generated from SakuraCordApp/Roadmap src/report/schema.ts. Edit there, then run npm run issue-forms. -->`,
        },
      },
      ...definition.fields.map(formField),
    ],
  };
}

await mkdir(output, { recursive: true });
await writeFile(path.join(output, "bug.yml"), stringify(form("bug"), { lineWidth: 0 }));
await writeFile(path.join(output, "feature.yml"), stringify(form("feature"), { lineWidth: 0 }));
await writeFile(
  path.join(output, "config.yml"),
  stringify(
    {
      blank_issues_enabled: false,
      contact_links: [
        {
          name: "💬 Report from Discord",
          url: DISCORD.inviteUrl,
          about:
            "Use /bug or /suggest in the SakuraCord server — same report, plus live updates there.",
        },
        {
          name: "🌐 Report on sakuracord.app",
          url: "https://sakuracord.app/report",
          about: "Sign in with Discord and file a report without a GitHub account.",
        },
      ],
    },
    { lineWidth: 0 },
  ),
);
console.log(`Wrote issue forms to ${output}`);
