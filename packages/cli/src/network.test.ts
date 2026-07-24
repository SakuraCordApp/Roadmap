import { describe, expect, it, vi } from "vitest";
import { isDnsResolutionError, resilientFetch } from "./network.js";

describe("resilient CLI networking", () => {
  it("recognizes nested resolver failures", () => {
    expect(
      isDnsResolutionError(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("not found"), { code: "ENOTFOUND" }),
        }),
      ),
    ).toBe(true);
    expect(isDnsResolutionError(new Error("HTTP 500"))).toBe(false);
  });

  it("uses public DNS only after the system resolver fails", async () => {
    const dnsFailure = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("not found"), { code: "ENOTFOUND" }),
    });
    const directFetch = vi.fn(async () => {
      throw dnsFailure;
    });
    const resolvePublicIpv4 = vi.fn(async () => ["104.21.46.27"]);
    const resolvedFetch = vi.fn(async () => Response.json({ ok: true, schemaVersion: "1" }));

    const response = await resilientFetch("https://roadmap.example.com/healthz", undefined, {
      directFetch,
      resolvePublicIpv4,
      resolvedFetch,
    });

    expect(await response.json()).toMatchObject({ ok: true });
    expect(resolvePublicIpv4).toHaveBeenCalledWith("roadmap.example.com");
    expect(resolvedFetch).toHaveBeenCalledWith(
      new URL("https://roadmap.example.com/healthz"),
      undefined,
      "104.21.46.27",
    );
  });
});
