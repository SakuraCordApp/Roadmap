import { describe, expect, it } from "vitest";
import roadmapConfig from "../../../roadmap.config.js";
import { ConflictError, ValidationError } from "./errors.js";
import { generateVersionRoadmapProjection, renderVersionDiscordText } from "./projection.js";
import { RoadmapVersionEngine } from "./version-engine.js";
import type {
  AtomicVersionMutation,
  ListVersionsQuery,
  RoadmapVersionStorage,
  VersionMutationResult,
} from "./version-storage.js";
import type { RoadmapVersion, RoadmapVersionHistoryEntry } from "./version.js";

const actor = { id: "test", displayName: "Test", kind: "maintainer" as const };

describe("RoadmapVersionEngine", () => {
  it("requires a curated highlight before a version becomes public", async () => {
    const engine = new RoadmapVersionEngine(new MemoryVersionStorage(), roadmapConfig);
    await expect(
      engine.create(
        {
          version: "0.1.0",
          title: "A faster foundation",
          summary: "A focused release plan.",
          state: "planned",
          position: 10,
          highlights: [],
        },
        { actor, mutationId: "create-empty-plan" },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("uses exact revisions for updates and transitions", async () => {
    const storage = new MemoryVersionStorage();
    const engine = new RoadmapVersionEngine(storage, roadmapConfig);
    const created = await engine.create(
      {
        version: "0.1.0",
        title: "A faster foundation",
        summary: "A focused release plan.",
        state: "draft",
        position: 10,
        highlights: [{ title: "Rewrite the timeline", linkedTrackerItemIds: [] }],
      },
      { actor, mutationId: "create-plan" },
    );
    const planned = await engine.transition(created.after.id, "planned", 1, {
      actor,
      mutationId: "publish-plan",
    });
    expect(planned.after).toMatchObject({ state: "planned", revision: 2 });
    await expect(
      engine.update(created.after.id, { title: "Stale title" }, 1, {
        actor,
        mutationId: "stale-plan",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("version roadmap projection", () => {
  it("keeps released versions out and renders the planned timeline", async () => {
    const versions = [
      sampleVersion("0.0.8", "released", 0),
      sampleVersion("0.0.9", "released", 0),
      sampleVersion("0.1.1", "planned", 20),
      sampleVersion("0.1.0", "planned", 10),
    ];
    const projection = await generateVersionRoadmapProjection(versions);
    expect(projection.versions.map(({ version }) => version)).toEqual(["0.1.0", "0.1.1"]);
    const text = renderVersionDiscordText(projection);
    expect(text).not.toContain("Current release");
    expect(text).not.toContain("Up next");
    expect(text).toContain("◉ v0\\.1\\.0");
    expect(text).toContain("│ **Timeline improvements**");
  });
});

class MemoryVersionStorage implements RoadmapVersionStorage {
  private readonly versions = new Map<string, RoadmapVersion>();

  listVersions(query: ListVersionsQuery): Promise<RoadmapVersion[]> {
    return Promise.resolve(
      [...this.versions.values()].filter(
        (version) => !query.states?.length || query.states.includes(version.state),
      ),
    );
  }

  getVersion(id: string): Promise<RoadmapVersion | null> {
    return Promise.resolve(this.versions.get(id) ?? null);
  }

  mutateVersion(mutation: AtomicVersionMutation): Promise<VersionMutationResult> {
    const before = this.versions.get(mutation.version.id) ?? null;
    this.versions.set(mutation.version.id, mutation.version);
    return Promise.resolve({ before, after: mutation.version, replayed: false });
  }

  versionHistory(): Promise<RoadmapVersionHistoryEntry[]> {
    return Promise.resolve([]);
  }
}

function sampleVersion(
  version: string,
  state: "planned" | "released",
  position: number,
): RoadmapVersion {
  return {
    id: `SCRV-01K0000000000000000000000${version.replaceAll(".", "").slice(-1)}`,
    version,
    title: `SakuraCord ${version}`,
    summary: "A focused release plan.",
    state,
    position,
    highlights: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Timeline improvements",
        linkedTrackerItemIds: [],
      },
    ],
    ...(state === "released" ? { releasedAt: "2026-07-24T00:00:00.000Z" } : {}),
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    revision: 1,
  };
}
