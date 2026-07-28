import { describe, expect, it } from "vitest";
import { defineRoadmapConfig } from "./config.js";
import { ConflictError, ValidationError } from "./errors.js";
import { RoadmapEngine } from "./engine.js";
import { generateDiscordProjection, renderDiscordText } from "./projection.js";
import type { Actor, HistoryEntry, RoadmapItem } from "./schema.js";
import type { AtomicMutation, MutationResult, RoadmapStorage } from "./storage.js";

const config = defineRoadmapConfig({
  project: {
    name: "Test",
    slug: "test",
    idPrefix: "TST",
    description: "Test project",
    publicUrl: "https://roadmap.example.com",
    applicationRepository: "/tmp/application",
  },
  branding: {
    logoUrl: "/logo",
    iconUrl: "/icon",
    primaryColor: "#FF0000",
    accentColor: "#00FF00",
    backgroundColor: "#000000",
    fontFamily: "system-ui",
  },
  areas: [{ id: "app", label: "App", color: "#FF0000" }],
  itemTypes: [{ id: "feature", label: "Feature", color: "#00FF00" }],
  lifecycle: [
    {
      id: "inbox",
      label: "Inbox",
      color: "#999999",
      transitionsTo: ["planned"],
    },
    {
      id: "planned",
      label: "Planned",
      color: "#0000FF",
      transitionsTo: ["done"],
    },
    {
      id: "done",
      label: "Done",
      color: "#00FF00",
      terminal: true,
      completionGate: true,
      transitionsTo: ["planned"],
    },
  ],
  priorities: [{ id: "medium", label: "Medium", color: "#FFFF00" }],
  publicSections: [
    { id: "planned", label: "Planned", statuses: ["planned"] },
    { id: "done", label: "Recently Done", statuses: ["done"], recentlyCompletedDays: 30 },
  ],
  discord: { maintainerRoleIds: [], statusTagMappings: {}, enableComponentsV2: true },
  auth: { tokenIssuer: "test", allowedOrigins: ["https://roadmap.example.com"] },
  deployment: {
    provider: "cloudflare",
    workerName: "test-roadmap",
    d1DatabaseName: "test-roadmap",
    gatewayProvider: "disabled",
  },
});

const actor: Actor = { id: "maintainer-1", displayName: "Maintainer", kind: "maintainer" };

describe("RoadmapEngine", () => {
  it("creates a valid streamlined item with a stable ID and revision", async () => {
    const storage = new MemoryStorage();
    const engine = new RoadmapEngine(storage, config);
    const result = await engine.create(
      {
        title: "Full polls support",
        description: "Implement complete native polls support.",
        type: "feature",
        area: "app",
        status: "planned",
        priority: "medium",
      },
      { actor, mutationId: "create-polls" },
    );
    expect(result.after.id).toMatch(/^TST-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.after.revision).toBe(1);
    expect(Object.keys(result.after)).not.toContain("difficulty");
    expect(Object.keys(result.after)).not.toContain("proposedImplementation");
  });

  it("rejects unknown configurable values", async () => {
    const engine = new RoadmapEngine(new MemoryStorage(), config);
    await expect(
      engine.create(
        {
          title: "Invalid area",
          description: "This area is not configured.",
          type: "feature",
          area: "missing",
          status: "planned",
          priority: "medium",
        },
        { actor, mutationId: "invalid-area" },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("requires objective done-state gates and records explicit overrides", async () => {
    const storage = new MemoryStorage();
    const engine = new RoadmapEngine(storage, config);
    const created = await engine.create(
      {
        title: "Done gate",
        description: "Exercise completion validation.",
        type: "feature",
        area: "app",
        status: "planned",
        priority: "medium",
      },
      { actor, mutationId: "done-gate-create" },
    );
    await expect(
      engine.transition(created.after.id, "done", 1, {
        actor,
        mutationId: "done-gate-transition",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const overridden = await engine.transition(created.after.id, "done", 1, {
      actor,
      mutationId: "done-gate-override",
      overrideReason: "Maintainer explicitly accepts missing historical acceptance evidence.",
    });
    expect(overridden.after.status).toBe("done");
    expect(storage.mutations.at(-1)?.overrideReason).toContain("historical");
  });

  it("rejects stale revisions without overwriting current state", async () => {
    const storage = new MemoryStorage();
    const engine = new RoadmapEngine(storage, config);
    const created = await engine.create(
      {
        title: "Concurrent item",
        description: "Exercise revision conflict handling.",
        type: "feature",
        area: "app",
        status: "planned",
        priority: "medium",
      },
      { actor, mutationId: "conflict-create" },
    );
    await engine.update(created.after.id, { title: "Updated once" }, 1, {
      actor,
      mutationId: "conflict-update-1",
    });
    await expect(
      engine.update(created.after.id, { title: "Stale update" }, 1, {
        actor,
        mutationId: "conflict-update-2",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await engine.get(created.after.id)).title).toBe("Updated once");
  });

  it("preserves report-supported fields during a partial update", async () => {
    const storage = new MemoryStorage();
    const engine = new RoadmapEngine(storage, config);
    const created = await engine.create(
      {
        title: "Partial update",
        description: "Original description.",
        type: "feature",
        area: "app",
        status: "planned",
        priority: "medium",
        labels: ["functionality"],
        references: [{ kind: "research", label: "Report source" }],
      },
      { actor, mutationId: "partial-create" },
    );
    const updated = await engine.update(
      created.after.id,
      { description: "Only this field changes." },
      1,
      { actor, mutationId: "partial-update" },
    );
    expect(updated.after.description).toBe("Only this field changes.");
    expect(updated.after.labels).toEqual(["functionality"]);
    expect(updated.after.references).toEqual([{ kind: "research", label: "Report source" }]);
  });

  it("does not allow general update to bypass transition validation", async () => {
    const storage = new MemoryStorage();
    const engine = new RoadmapEngine(storage, config);
    const created = await engine.create(
      {
        title: "Status safety",
        description: "Status changes use transitions.",
        type: "feature",
        area: "app",
        status: "planned",
        priority: "medium",
      },
      { actor, mutationId: "status-create" },
    );
    await expect(
      engine.update(created.after.id, { status: "done" }, 1, {
        actor,
        mutationId: "status-patch",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("Discord projection", () => {
  it("hashes only the visible feature-name projection and produces expected sections", async () => {
    const first = sampleItem("TST-01ARZ3NDEKTSV4RRFFQ69G5FAV", "Polls", "planned");
    const original = await generateDiscordProjection(
      [first],
      config,
      new Date("2026-07-24T00:00:00Z"),
    );
    const detailedChange = {
      ...first,
      references: [{ kind: "research" as const, label: "Changed non-projected report source" }],
    };
    const changed = await generateDiscordProjection(
      [detailedChange],
      config,
      new Date("2026-07-24T00:00:00Z"),
    );
    expect(changed.hash).toBe(original.hash);
    expect(renderDiscordText(original)).toContain("# Feature");
    expect(renderDiscordText(original)).toContain("## Planned");
    expect(renderDiscordText(original)).toContain("**Polls**");
    expect(renderDiscordText(original)).not.toContain("implementation");
    expect(renderDiscordText(original)).not.toContain("/items/");
  });
});

class MemoryStorage implements RoadmapStorage {
  readonly items = new Map<string, RoadmapItem>();
  readonly mutations: AtomicMutation[] = [];
  readonly entries: HistoryEntry[] = [];

  async list() {
    return { data: [...this.items.values()] };
  }
  async get(id: string) {
    return this.items.get(id) ?? null;
  }
  async mutate(mutation: AtomicMutation): Promise<MutationResult> {
    const replay = this.mutations.find((candidate) => candidate.mutationId === mutation.mutationId);
    if (replay) {
      return {
        before: null,
        after: this.items.get(replay.item.id)!,
        replayed: true,
      };
    }
    const before = this.items.get(mutation.item.id) ?? null;
    if (mutation.expectedRevision !== null && before?.revision !== mutation.expectedRevision) {
      throw new ConflictError("stale");
    }
    this.items.set(mutation.item.id, mutation.item);
    this.mutations.push(mutation);
    return { before, after: mutation.item, replayed: false };
  }
  async history() {
    return this.entries;
  }
  async syncStatus() {
    return { pending: 0, processing: 0, failed: 0, lastSuccessfulAt: null };
  }
}

function sampleItem(id: string, title: string, status: string): RoadmapItem {
  return {
    id,
    title,
    description: `${title} description`,
    type: "feature",
    area: "app",
    status,
    priority: "medium",
    references: [],
    acceptanceCriteria: [],
    linkedDiscordThreads: [],
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    revision: 1,
  };
}
