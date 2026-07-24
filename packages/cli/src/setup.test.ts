import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finishDiscordRuntime,
  parseWranglerConfiguration,
  selectCloudflareAccount,
} from "./setup.js";

let temporaryRoot = "";
let originalFetch: typeof fetch;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "roadmap-setup-test-"));
  await writeFile(
    path.join(temporaryRoot, "roadmap.instance.json"),
    JSON.stringify({
      branding: { primaryColor: "#F3A6C8", accentColor: "#D9578B" },
    }),
  );
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("one-shot Discord runtime completion", () => {
  it("publishes, reconciles, starts Cloudflare synchronization, and verifies health", async () => {
    const requests: Array<{
      path: string;
      authorization: string | null;
      idempotency: string | null;
    }> = [];
    let statusChecks = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      requests.push({
        path: url.pathname,
        authorization: headers.get("Authorization"),
        idempotency: headers.get("Idempotency-Key"),
      });
      if (url.pathname === "/api/v1/discord/forums/configure") {
        return Response.json({
          data: [
            {
              forumName: "Features",
              tags: [{ name: "Visual", emojiId: "emoji-visual" }],
            },
            {
              forumName: "Bugs",
              tags: [{ name: "Visual", emojiId: "emoji-visual" }],
            },
          ],
        });
      }
      if (url.pathname === "/api/v1/discord/publish") {
        return Response.json({ data: { changed: true, messageId: "88888888888888888" } });
      }
      if (url.pathname === "/api/v1/reconcile") {
        return Response.json({ data: { threads: 3, messages: 12, errors: [] } });
      }
      if (url.pathname === "/api/v1/discord/gateway/start") {
        return Response.json({ data: { started: true } });
      }
      if (url.pathname === "/api/v1/discord/gateway/status") {
        statusChecks += 1;
        return Response.json({
          data:
            statusChecks === 1
              ? { connected: false, healthy: false }
              : {
                  connected: false,
                  healthy: true,
                  provider: "cloudflare-scheduled-reconciliation",
                },
        });
      }
      return new Response("unexpected request", { status: 500 });
    }) as typeof fetch;

    await finishDiscordRuntime(
      { root: temporaryRoot, json: false, verbose: false },
      { publicUrl: "https://roadmap.example.com", gatewayProvider: "cloudflare" },
      "maintainer-token",
    );

    expect(requests.map((request) => request.path)).toEqual([
      "/api/v1/discord/forums/configure",
      "/api/v1/discord/publish",
      "/api/v1/reconcile",
      "/api/v1/discord/gateway/start",
      "/api/v1/discord/gateway/status",
      "/api/v1/discord/gateway/status",
    ]);
    expect(requests.every((request) => request.authorization === "Bearer maintainer-token")).toBe(
      true,
    );
    expect(requests.every((request) => request.idempotency)).toBe(true);

    const state = JSON.parse(
      await readFile(path.join(temporaryRoot, ".roadmap/setup-state.json"), "utf8"),
    );
    expect(state.discord_projection.status).toBe("complete");
    expect(state.discord_reconciliation.detail).toContain("3 threads");
    expect(state.discord_gateway.detail).toContain("cloudflare-scheduled-reconciliation");
  });

  it("fails rather than claiming success when reconciliation is partial", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/discord/forums/configure") {
        return Response.json({
          data: [
            {
              forumName: "Features",
              tags: [{ name: "Visual", emojiId: "emoji-visual" }],
            },
          ],
        });
      }
      if (path === "/api/v1/discord/publish") {
        return Response.json({ data: { changed: true, messageId: "88888888888888888" } });
      }
      if (path === "/api/v1/reconcile") {
        return Response.json({
          data: { threads: 1, messages: 0, errors: ["thread: missing permission"] },
        });
      }
      return new Response("unexpected request", { status: 500 });
    }) as typeof fetch;

    await expect(
      finishDiscordRuntime(
        { root: temporaryRoot, json: false, verbose: false },
        { publicUrl: "https://roadmap.example.com", gatewayProvider: "cloudflare" },
        "maintainer-token",
      ),
    ).rejects.toThrow("Discord reconciliation reported errors");
  });
});

describe("Wrangler setup configuration", () => {
  it("requires an explicit account for non-interactive multi-account setup", async () => {
    const accounts = [
      { id: "account-a", name: "Account A" },
      { id: "account-b", name: "Account B" },
    ];

    await expect(selectCloudflareAccount(accounts, undefined, true)).rejects.toThrow(
      "--cloudflare-account-id",
    );
    await expect(selectCloudflareAccount(accounts, "account-b", true)).resolves.toEqual(
      accounts[1],
    );
  });

  it("accepts the repository's JSONC comments and trailing commas", () => {
    const parsed = parseWranglerConfiguration(`{
      // setup preserves JSONC input
      "name": "example-roadmap",
      "vars": {
        "ROADMAP_GATEWAY_PROVIDER": "cloudflare",
      },
    }`);
    expect(parsed.name).toBe("example-roadmap");
    expect(parsed.vars.ROADMAP_GATEWAY_PROVIDER).toBe("cloudflare");
  });

  it("rejects malformed JSONC with an actionable error", () => {
    expect(() => parseWranglerConfiguration(`{"name": }`)).toThrow("wrangler.jsonc is invalid");
  });
});
