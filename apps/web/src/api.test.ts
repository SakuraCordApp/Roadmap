import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchItems } from "./api.js";

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
});
