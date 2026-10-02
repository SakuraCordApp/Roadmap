import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseTriageResult, TRIAGE_MARKER } from "../src/ai/triage";
import { applyTriageResult, runTriage } from "../src/sync/triage";
import { sha256 } from "../src/util/crypto";
import type { Env } from "../src/env";

const state = vi.hoisted(() => ({
  issue: {} as any,
  current: {} as any,
  comment: {} as any,
  values: new Map<string, string>(),
  request: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock("../src/github/client", () => ({
  GitHub: class {
    repo(path: string) {
      return path;
    }
    request(...args: unknown[]) {
      return state.request(...args);
    }
  },
}));
vi.mock("../src/github/identity", () => ({ appBotLogin: async () => "sakuracord-bot[bot]" }));
vi.mock("../src/db/store", () => ({
  getIssue: async () => state.issue,
  getState: async (_db: unknown, key: string) => state.values.get(key) ?? null,
  setState: async (_db: unknown, key: string, value: string) => {
    state.values.set(key, value);
  },
  patchIssue: async (_db: unknown, _number: number, patch: object) => {
    Object.assign(state.issue, patch);
  },
}));
vi.mock("../src/jobs/queue", () => ({ enqueue: (...args: unknown[]) => state.enqueue(...args) }));
const env = { DB: {} } as Env;
let result: any;
const refreshComment = () => {
  state.comment.body = `${TRIAGE_MARKER}${JSON.stringify(result)} -->`;
};

beforeEach(async () => {
  vi.clearAllMocks();
  state.values.clear();
  state.issue = {
    number: 51,
    title: "Original report",
    body: "Report details",
    kind: "bug",
    state: "open",
    status: "new",
    triagedAt: null,
  };
  state.current = {
    ...state.issue,
    labels: ["status: new", "priority: low", "agent: investigate"],
    user: { login: "sakuracord-bot[bot]" },
    type: { name: "Bug" },
  };
  result = {
    version: 1,
    number: 51,
    sourceTitle: state.issue.title,
    bodyHash: await sha256(state.issue.body),
    candidates: [52],
    model: "gpt-6-luna",
    triage: {
      kind: "bug",
      area: "platform",
      priority: "high",
      title: "Corrected report title",
      summary: "A code-grounded summary.",
      duplicateOf: null,
      duplicateConfidence: 0,
      duplicateReason: "",
      needsInformation: true,
      questions: ["Which version shows this?"],
    },
  };
  state.comment = { id: 10, user: { login: "github-actions[bot]", type: "Bot" } };
  refreshComment();
  state.request.mockImplementation(async (method: string, path: string, body?: any) => {
    if (method === "GET") return path.includes("/comments/") ? state.comment : state.current;
    if (method === "PATCH") Object.assign(state.current, body);
    if (method === "POST") state.current.labels.push(...body.labels);
    if (method === "DELETE")
      state.current.labels = state.current.labels.filter(
        (label: string) => label !== "agent: investigate",
      );
    return {};
  });
});

describe("combined assessment", () => {
  it("accepts only a valid Actions result for this issue and supplied duplicate candidates", () => {
    expect(parseTriageResult(state.comment, 51)).not.toBeNull();
    expect(
      parseTriageResult({ ...state.comment, user: { login: "reporter", type: "User" } }, 51),
    ).toBeNull();
    expect(parseTriageResult(state.comment, 99)).toBeNull();
    result.triage.duplicateOf = 100;
    refreshComment();
    expect(parseTriageResult(state.comment, 51)).toBeNull();
    result.triage.duplicateOf = null;
    result.triage.area = "invented";
    refreshComment();
    expect(parseTriageResult(state.comment, 51)).toBeNull();
  });

  it("starts one code-aware run for a feature request and does not duplicate its active label", async () => {
    state.issue.kind = "feature";
    state.current.labels = ["status: new"];
    await runTriage(env, { number: 51 });
    await runTriage(env, { number: 51 });
    expect(state.request.mock.calls.filter(([method]) => method === "POST")).toEqual([
      ["POST", "/issues/51/labels", { labels: ["agent: investigate"] }],
    ]);
  });

  it("retries a failed metadata write, applies questions, and ignores repeated result delivery", async () => {
    const request = state.request.getMockImplementation()!;
    let fail = true;
    state.request.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "PATCH" && fail) {
        fail = false;
        throw new Error("GitHub unavailable");
      }
      return request(...args);
    });
    await expect(applyTriageResult(env, { number: 51, commentId: 10 })).rejects.toThrow(
      "GitHub unavailable",
    );
    expect(state.issue.triagedAt).not.toBeNull();
    await applyTriageResult(env, { number: 51, commentId: 10 });
    expect(state.current.title).toBe("Corrected report title");
    expect(state.current.labels).toEqual(
      expect.arrayContaining(["status: needs info", "priority: high"]),
    );
    expect(state.current.labels).not.toContain("agent: investigate");
    const patches = state.request.mock.calls.filter(([method]) => method === "PATCH").length;
    await applyTriageResult(env, { number: 51, commentId: 10 });
    expect(state.request.mock.calls.filter(([method]) => method === "PATCH")).toHaveLength(patches);
  });

  it("preserves a maintainer's status and priority while applying the assessment", async () => {
    state.current.labels = ["status: planned", "priority: low", "agent: investigate"];
    state.current.title = "Maintainer's title";
    await applyTriageResult(env, { number: 51, commentId: 10 });
    expect(state.current.labels).toEqual(
      expect.arrayContaining(["status: planned", "priority: low"]),
    );
    expect(state.current.labels).not.toContain("status: needs info");
    expect(state.current.title).toBe("Maintainer's title");
  });

  it("reassesses an edited report instead of applying a stale result", async () => {
    state.current.body = "Updated report details";
    await applyTriageResult(env, { number: 51, commentId: 10 });
    expect(state.request.mock.calls.some(([method]) => method === "PATCH")).toBe(false);
    expect(state.enqueue).toHaveBeenCalledWith(env, "triage", "51", { number: 51, force: true });
    expect(state.issue.triagedAt).toBeNull();
  });
});
