import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importRoadmap } from "./operations.js";

let temporaryRoot = "";
let originalFetch: typeof fetch;
let stdoutWrite: { mockRestore(): void };

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "roadmap-import-test-"));
  originalFetch = globalThis.fetch;
  stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  stdoutWrite.mockRestore();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("resumable imports", () => {
  it("uses the same durable idempotency key when setup imports the same item again", async () => {
    const importFile = path.join(temporaryRoot, "initial.json");
    const fixture = {
      title: "Test import",
      description: "A test-local change used only to verify resumable imports.",
      type: "behaviour",
      area: "platform",
      status: "planned",
      priority: "medium",
    };
    await writeFile(importFile, `${JSON.stringify([fixture], null, 2)}\n`);

    const keys: string[] = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      const headers = new Headers(init?.headers);
      keys.push(headers.get("Idempotency-Key") ?? "");
      return Response.json({
        data: {
          after: { id: "SCR-01ARZ3NDEKTSV4RRFFQ69G5FAV" },
        },
      });
    }) as typeof fetch;

    const context = { root: temporaryRoot, json: false, verbose: false };
    const options = {
      file: importFile,
      apiUrl: "https://roadmap.example.com",
      token: "maintainer-token",
      provider: "native" as const,
    };
    await importRoadmap(context, options);
    await importRoadmap(context, options);

    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^roadmap-import-[a-f0-9]{40}$/);
    expect(keys[1]).toBe(keys[0]);
  });
});
