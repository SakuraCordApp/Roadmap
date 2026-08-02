import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchItems, watchVersions } from "./api.js";

describe("public API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows every cursor and leaves conditional caching to the browser", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], nextCursor: "cursor-2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchItems({})).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/items?limit=250",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/items?limit=250&cursor=cursor-2",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("applies validated version snapshots from the live event stream", () => {
    class FakeEventSource {
      static instance: FakeEventSource;
      readonly listeners = new Map<string, EventListener>();
      closed = false;

      constructor(readonly url: string) {
        FakeEventSource.instance = this;
      }

      addEventListener(name: string, listener: EventListener) {
        this.listeners.set(name, listener);
      }

      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const snapshots: unknown[] = [];
    const stop = watchVersions((versions) => snapshots.push(versions));
    FakeEventSource.instance.listeners.get("versions")?.(
      new MessageEvent("versions", {
        data: JSON.stringify({
          data: [
            {
              id: "SCRV-01K00000000000000000000001",
              version: "0.1.0",
              title: "Live roadmap",
              summary: "A synchronized release.",
              state: "planned",
              position: 10,
              highlights: [],
              createdAt: "2026-08-02T00:00:00.000Z",
              updatedAt: "2026-08-02T00:00:00.000Z",
              revision: 2,
            },
          ],
        }),
      }),
    );

    expect(FakeEventSource.instance.url).toBe("/api/v1/versions/events");
    expect(snapshots).toEqual([expect.arrayContaining([expect.objectContaining({ revision: 2 })])]);
    stop();
    expect(FakeEventSource.instance.closed).toBe(true);
  });
});
