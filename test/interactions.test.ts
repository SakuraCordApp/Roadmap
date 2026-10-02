import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleInteraction } from "../src/discord/interactions";
import { DISCORD } from "../src/config";
import type { Env } from "../src/env";

const mocks = vi.hoisted(() => ({ action: vi.fn(), sync: vi.fn(), reply: vi.fn() }));
vi.mock("../src/actions", () => ({ performAction: mocks.action }));
vi.mock("../src/discord/threads", () => ({
  discordClient: () => ({ editInteractionResponse: mocks.reply }),
}));

const keys = generateKeyPairSync("ed25519");
const env = {
  DISCORD_PUBLIC_KEY: Buffer.from(
    keys.publicKey.export({ format: "jwk" }).x!,
    "base64url",
  ).toString("hex"),
} as Env;

async function submit(permissions = "32") {
  const body = JSON.stringify({
    type: 5,
    guild_id: DISCORD.guildId,
    token: "test-interaction",
    member: { roles: [], permissions, user: { id: "123", username: "maintainer" } },
    data: {
      custom_id: "ma:mark_fixed:165",
      components: [{ type: 3, custom_id: "release", values: ["v0.1.5"] }],
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const tasks: Promise<unknown>[] = [];
  const response = await handleInteraction(
    new Request("https://hub.test/interactions/discord", {
      method: "POST",
      body,
      headers: {
        "X-Signature-Timestamp": timestamp,
        "X-Signature-Ed25519": Buffer.from(
          sign(null, Buffer.from(timestamp + body), keys.privateKey),
        ).toString("hex"),
      },
    }),
    env,
    {
      waitUntil: (task: Promise<unknown>) => tasks.push(task),
      exports: { ReportSync: { run: mocks.sync } },
    } as unknown as ExecutionContext,
  );
  return { response: await response.json(), tasks };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.action.mockResolvedValue("Marked fixed in v0.1.5 and closed as shipped.");
  mocks.reply.mockResolvedValue(undefined);
});

describe("immediate Manage actions", () => {
  it("waits for the selected report's Discord sync before confirming success", async () => {
    let start!: () => void;
    let finish!: (result: { status: string; last_error: null }) => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const finished = new Promise<{ status: string; last_error: null }>((resolve) => {
      finish = resolve;
    });
    mocks.sync.mockImplementation(() => {
      start();
      return finished;
    });
    const { response, tasks } = await submit();
    expect(response).toEqual({ type: 6 });
    await started;
    expect(mocks.sync).toHaveBeenCalledWith(165);
    expect(mocks.reply).not.toHaveBeenCalled();
    finish({ status: "done", last_error: null });
    await Promise.all(tasks);
    expect(mocks.reply).toHaveBeenCalledWith(
      "test-interaction",
      expect.objectContaining({ content: "✅ Marked fixed in v0.1.5 and closed as shipped." }),
    );
  });

  it("reports partial completion when Discord synchronization fails", async () => {
    mocks.sync.mockResolvedValue({ status: "pending", last_error: "Discord unavailable" });
    const { tasks } = await submit();
    await Promise.all(tasks);
    expect(mocks.reply).toHaveBeenCalledWith(
      "test-interaction",
      expect.objectContaining({
        content: expect.stringContaining("Saved on GitHub, but Discord has not finished updating"),
      }),
    );
    expect(mocks.reply.mock.calls[0]![1].content).not.toContain("✅");
  });

  it("does not mutate or sync reports for an unauthorized modal submission", async () => {
    const { response, tasks } = await submit("0");
    await Promise.all(tasks);
    expect(response).toMatchObject({ type: 4, data: { content: expect.stringContaining("Only") } });
    expect(mocks.action).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
