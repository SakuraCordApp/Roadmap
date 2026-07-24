import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchItems } from "./api.js";

describe("public API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("revalidates public reads instead of reusing stale browser responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchItems({})).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/items?limit=250",
      expect.objectContaining({
        cache: "no-cache",
        headers: { Accept: "application/json" },
      }),
    );
  });
});
