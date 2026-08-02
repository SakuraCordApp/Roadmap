import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoadmapMcpServer } from "./server.js";

describe("protocol-native MCP server", () => {
  afterEach(() => vi.restoreAllMocks());

  it("negotiates the stable protocol and exposes every required tool deterministically", async () => {
    const server = createRoadmapMcpServer({ apiUrl: "https://roadmap.example.com" });
    const initialized = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    expect((initialized?.result as any).protocolVersion).toBe("2025-11-25");
    expect((initialized?.result as any).capabilities.tools.listChanged).toBe(false);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = (response?.result as any).tools as Array<{ name: string; inputSchema: unknown }>;
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "roadmap_list",
        "roadmap_get",
        "roadmap_search",
        "roadmap_create",
        "roadmap_update",
        "roadmap_transition",
        "roadmap_link_discord_thread",
        "roadmap_add_acceptance_criterion",
        "roadmap_generate_discord_view",
        "roadmap_version_publish",
        "roadmap_validate",
        "roadmap_sync_status",
        "roadmap_reconcile",
        "roadmap_history",
        "roadmap_version_list",
        "roadmap_version_get",
        "roadmap_version_create",
        "roadmap_version_update",
        "roadmap_version_transition",
        "roadmap_version_history",
      ]),
    );
    expect(tools.every((tool) => tool.inputSchema)).toBe(true);
  });

  it("validates tool arguments and returns API results as structured content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const server = createRoadmapMcpServer({ apiUrl: "https://roadmap.example.com" });
    const invalid = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "roadmap_get", arguments: { id: "" } },
    });
    expect((invalid?.error as any).code).toBe(-32602);
    const called = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "roadmap_list", arguments: { limit: 25 } },
    });
    expect((called?.result as any).structuredContent).toEqual({ data: [] });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/items?limit=25"),
      expect.any(Object),
    );
  });

  it("returns 202-compatible null for notifications", async () => {
    const server = createRoadmapMcpServer({ apiUrl: "https://roadmap.example.com" });
    await expect(
      server.handle({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ).resolves.toBeNull();
  });
});
