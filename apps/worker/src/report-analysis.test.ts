import { describe, expect, it } from "vitest";
import roadmapConfig from "../../../roadmap.config.js";
import {
  attachmentReferences,
  buildAcceptanceCriteria,
  reportAnalysisJsonSchema,
} from "./report-analysis.js";

describe("Discord report analysis helpers", () => {
  it("turns analyzer statements into independent unsatisfied acceptance criteria", () => {
    const criteria = buildAcceptanceCriteria(
      ["The media viewer opens.", "Closing the viewer returns focus."],
      "2026-07-24T12:00:00.000Z",
    );

    expect(criteria).toHaveLength(2);
    expect(new Set(criteria.map((criterion) => criterion.id)).size).toBe(2);
    expect(criteria.every((criterion) => !criterion.satisfied)).toBe(true);
    expect(criteria.every((criterion) => criterion.evidence.length === 0)).toBe(true);
  });

  it("retains attachment provenance without embedding files into canonical data", () => {
    expect(
      attachmentReferences([
        {
          filename: "viewer.png",
          content_type: "image/png",
          url: "https://cdn.discordapp.com/attachments/viewer.png",
        },
        { filename: "missing-url.txt", content_type: "text/plain" },
      ]),
    ).toEqual([
      {
        kind: "research",
        label: "Discord attachment: viewer.png",
        url: "https://cdn.discordapp.com/attachments/viewer.png",
        value: "image/png",
      },
    ]);
  });

  it("only asks the intake reviewer for fields supported by report evidence", () => {
    const schema = reportAnalysisJsonSchema(roadmapConfig);
    const fields = Object.keys(schema.properties);

    expect(fields).toEqual([
      "title",
      "description",
      "classification",
      "priority",
      "area",
      "acceptanceCriteria",
      "needsInformation",
      "missingInformation",
      "summary",
      "relevantFollowUpMessageIds",
    ]);
    expect(fields).not.toEqual(
      expect.arrayContaining([
        "difficulty",
        "confidence",
        "proposedImplementation",
        "affectedComponents",
        "risks",
        "requiredResearch",
      ]),
    );
  });
});
