import { beforeEach, describe, expect, it, vi } from "vitest";
import { performAction, actionOptions } from "../src/actions";
import { handleRelease, shipIssue } from "../src/sync/activity";
import { fixedModal, parseModal } from "../src/discord/modals";
import type { Env } from "../src/env";

const state = vi.hoisted(() => ({
  issue: {} as any,
  current: {} as any,
  values: new Map<string, string>(),
  request: vi.fn(),
  enqueue: vi.fn(),
  enqueueMany: vi.fn(),
  note: vi.fn(),
}));
const sha = "a".repeat(40);
const nightly = {
  tag: "v0.1.6-Beta-3",
  version: "0.1.6 Beta 3",
  channel: "nightly",
  url: "https://github.com/SakuraCordApp/SakuraCord/releases/tag/v0.1.6-Beta-3",
  publishedAt: "2026-10-01",
} as const;
vi.mock("../src/releases", () => ({ reportReleases: async () => [nightly] }));
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
vi.mock("../src/db/store", () => ({
  getIssue: async () => state.issue,
  listIssues: async () => [state.issue],
  getState: async (_db: unknown, key: string) => state.values.get(key) ?? null,
  setState: async (_db: unknown, key: string, value: string) => {
    state.values.set(key, value);
  },
  patchIssue: async (_db: unknown, _number: number, patch: object) => {
    Object.assign(state.issue, patch);
  },
  setPendingNote: (...args: unknown[]) => state.note(...args),
  addEvent: vi.fn(),
  primaryThread: async () => null,
}));
vi.mock("../src/jobs/queue", () => ({
  enqueue: (...args: unknown[]) => state.enqueue(...args),
  enqueueMany: (...args: unknown[]) => state.enqueueMany(...args),
}));
const env = { DB: {} } as Env;
beforeEach(() => {
  vi.clearAllMocks();
  state.values.clear();
  state.issue = {
    number: 51,
    state: "open",
    status: "confirmed",
    kind: "bug",
    fixes: [],
    shippedIn: null,
    shippedStableIn: null,
  };
  state.current = {
    ...state.issue,
    labels: ["status: confirmed", "area: chat"],
    milestone: { number: 1 },
  };
  state.request.mockImplementation(async (method: string, path: string, body?: any) => {
    if (method === "PATCH") {
      Object.assign(state.current, body);
      return state.current;
    }
    if (method !== "GET") return {};
    if (path.startsWith("/releases/tags/"))
      return {
        tag_name: nightly.tag,
        html_url: nightly.url,
        prerelease: true,
        draft: false,
        published_at: nightly.publishedAt,
      };
    if (path.startsWith("/commits/")) return { sha };
    if (path.startsWith("/compare/")) return { status: "ahead" };
    if (path.startsWith("/pulls/")) return { number: 9, merged: false, merge_commit_sha: null };
    return state.current;
  });
});
describe("maintainer fix confirmation", () => {
  it("offers one modal for published releases and unreleased fixes", () => {
    expect(actionOptions("confirmed", "bug").find((o) => o.value === "mark_fixed")?.label).toBe(
      "Mark as fixed…",
    );
    const modal = fixedModal(51, "bug", [nightly]);
    expect(modal.data.custom_id).toBe("ma:mark_fixed:51");
    expect(
      parseModal({
        components: [
          { type: 18, component: { type: 3, custom_id: "release", values: [nightly.tag] } },
        ],
      }).values.release,
    ).toBe(nightly.tag);
  });
  it("records an unreleased commit on nightly and schedules release checks without closing", async () => {
    await performAction(env, 51, "mark_fixed", "maintainer", {
      release: "unreleased",
      reference: sha,
      note: "Verified locally",
    });
    expect(state.current.state).toBe("open");
    expect(state.current.labels).toContain("status: in nightly");
    expect(state.issue.fixes[0].sha).toBe(sha);
    expect(state.enqueueMany).toHaveBeenCalledWith(env, [
      expect.objectContaining({
        kind: "ship",
        payload: { number: 51, tag: nightly.tag, url: nightly.url },
      }),
    ]);
  });
  it("rejects foreign links, unmerged PRs, and fixes absent from nightly before writing", async () => {
    for (const reference of ["https://github.com/other/repo/commit/" + sha, "#9"]) {
      await expect(
        performAction(env, 51, "mark_fixed", "maintainer", { release: "unreleased", reference }),
      ).rejects.toThrow();
    }
    const original = state.request.getMockImplementation()!;
    state.request.mockImplementation((method, path, body) =>
      path.startsWith("/compare/") ? { status: "diverged" } : original(method, path, body),
    );
    await expect(
      performAction(env, 51, "mark_fixed", "maintainer", { release: "unreleased", reference: sha }),
    ).rejects.toThrow("not landed");
    expect(state.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("closes a maintainer-confirmed published nightly and tracks its later regular release without a fix SHA", async () => {
    await performAction(env, 51, "mark_fixed", "maintainer", { release: nightly.tag });
    expect(state.current.state).toBe("closed");
    expect(state.current.labels).toContain("status: shipped");
    expect(state.issue.shippedIn).toBe(nightly.version);
    expect(state.issue.shippedStableIn).toBeNull();
    expect(state.issue.fixes).toEqual([]);
    state.issue.state = "closed";
    state.issue.status = "shipped";
    await handleRelease(env, {
      tag: "v0.1.6",
      url: "https://github.com/SakuraCordApp/SakuraCord/releases/tag/v0.1.6",
    });
    expect(state.enqueueMany).toHaveBeenLastCalledWith(env, [
      expect.objectContaining({ kind: "ship" }),
    ]);
    await shipIssue(env, {
      number: 51,
      tag: "v0.1.6",
      url: "https://github.com/SakuraCordApp/SakuraCord/releases/tag/v0.1.6",
    });
    expect(state.request).toHaveBeenCalledWith("GET", "/compare/v0.1.6-Beta-3...v0.1.6");
    expect(state.issue.shippedStableIn).toBe("0.1.6");
  });
  it("rejects unpublished releases and accepts a published release link", async () => {
    const original = state.request.getMockImplementation()!;
    state.request.mockImplementation((method, path, body) =>
      path.startsWith("/releases/tags/")
        ? { draft: true, published_at: null }
        : original(method, path, body),
    );
    await expect(
      performAction(env, 51, "mark_fixed", "maintainer", { release: nightly.tag }),
    ).rejects.toThrow("published release");
    expect(state.current.state).toBe("open");
    state.request.mockImplementation(original);
    await performAction(env, 51, "mark_fixed", "maintainer", {
      release: "other",
      reference: nightly.url,
    });
    expect(state.current.state).toBe("closed");
  });
  it("retries closure after a GitHub failure without treating cached release metadata as completion", async () => {
    const original = state.request.getMockImplementation()!;
    let fail = true;
    state.request.mockImplementation((method, path, body) => {
      if (method === "PATCH" && fail) {
        fail = false;
        throw new Error("GitHub unavailable");
      }
      return original(method, path, body);
    });
    await expect(
      performAction(env, 51, "mark_fixed", "maintainer", { release: nightly.tag }),
    ).rejects.toThrow("GitHub unavailable");
    expect(state.current.state).toBe("open");
    await shipIssue(env, { number: 51, tag: nightly.tag, url: nightly.url });
    expect(state.current.state).toBe("closed");
  });
});
