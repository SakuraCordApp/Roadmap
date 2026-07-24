import { describe, expect, it } from "vitest";
import roadmapConfig from "../../../roadmap.config.js";
import { aiResponseModelOptions } from "./ai-request.js";

describe("AI response model options", () => {
  it("uses GPT-5.6 Sol with medium reasoning for every configured AI request", () => {
    expect(aiResponseModelOptions(roadmapConfig)).toEqual({
      model: "gpt-5.6-sol",
      reasoning: { effort: "medium" },
    });
  });
});
