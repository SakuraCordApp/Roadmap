import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ContextModule from "./context.js";

const harness = vi.hoisted(() => ({
  events: [] as string[],
}));

vi.mock("./context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ContextModule>();
  return {
    ...actual,
    output: vi.fn(),
    run: vi.fn(
      async (
        _context: unknown,
        command: string,
        args: string[],
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
        const joined = `${command} ${args.join(" ")}`;
        if (joined === "npx wrangler whoami --json") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              loggedIn: true,
              accounts: [{ id: "account-id", name: "Test account" }],
            }),
            stderr: "",
          };
        }
        if (joined === "npx wrangler d1 list --json") {
          return { exitCode: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("wrangler d1 create")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
            stderr: "",
          };
        }
        if (joined === "npx wrangler deploy") harness.events.push("worker:deploy");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    ),
  };
});

vi.mock("./discord.js", () => ({
  configureDiscord: vi.fn(async () => {
    harness.events.push("discord:configure");
    return {
      botToken: "discord-token",
      applicationId: "11111111111111111",
      guildId: "22222222222222222",
      featureForumId: "33333333333333333",
      bugForumId: "44444444444444444",
      roadmapChannelId: "55555555555555555",
      releaseAnnouncementChannelId: "55555555555555556",
    };
  }),
  verifyDiscord: vi.fn(async () => {
    harness.events.push("discord:verify");
  }),
  getDiscordBotToken: vi.fn(async () => {
    harness.events.push("discord:token");
    return "discord-token";
  }),
}));

vi.mock("./operations.js", () => ({
  importRoadmap: vi.fn(),
  installCodex: vi.fn(),
  installMcp: vi.fn(),
}));

vi.mock("./releases.js", () => ({
  configureAiInfrastructure: vi.fn(async () => {
    harness.events.push("ai:configure");
  }),
  configureReleaseAutomation: vi.fn(async () => {
    harness.events.push("release:configure");
  }),
  connectReleaseAi: vi.fn(async () => {
    harness.events.push("release:connect-ai");
  }),
}));

import { setup } from "./setup.js";

let temporaryRoot = "";
let originalFetch: typeof fetch;
let originalCloudflareAccountId: string | undefined;
let stdoutWrite: { mockRestore(): void };

beforeEach(async () => {
  harness.events.length = 0;
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "roadmap-orchestration-test-"));
  await writeFile(path.join(temporaryRoot, "roadmap.instance.json"), "{}\n");
  await writeFile(
    path.join(temporaryRoot, "wrangler.jsonc"),
    `{
      // JSONC is valid setup input.
      "name": "example-roadmap",
      "d1_databases": [{
        "binding": "DB",
        "database_name": "example-roadmap",
        "database_id": "REPLACE_WITH_D1_DATABASE_ID",
      }],
      "vars": {},
    }\n`,
  );
  process.env.ROADMAP_ADMIN_TOKEN = "admin-token";
  originalCloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_ACCOUNT_ID = "account-id";
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/healthz") {
      harness.events.push("worker:health");
      return Response.json({ ok: true });
    }
    harness.events.push(`api:${pathname}`);
    if (pathname === "/api/v1/discord/forums/configure") {
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
    if (pathname === "/api/v1/discord/roadmap-emojis/configure") {
      return Response.json({
        data: [
          { key: "line", id: "77777777777777771", name: "sakura_roadmap_line" },
          { key: "dot", id: "77777777777777772", name: "sakura_roadmap_dot" },
        ],
      });
    }
    if (pathname === "/api/v1/discord/publish") {
      return Response.json({ data: { messageId: "88888888888888888", changed: true } });
    }
    if (pathname === "/api/v1/reconcile") {
      return Response.json({ data: { threads: 0, messages: 0, errors: [] } });
    }
    if (pathname === "/api/v1/discord/gateway/start") {
      return Response.json({ data: { started: true } });
    }
    if (pathname === "/api/v1/discord/gateway/status") {
      return Response.json({ data: { connected: true, sessionId: "session-ready" } });
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;
  stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  stdoutWrite.mockRestore();
  delete process.env.ROADMAP_ADMIN_TOKEN;
  if (originalCloudflareAccountId === undefined) {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
  } else {
    process.env.CLOUDFLARE_ACCOUNT_ID = originalCloudflareAccountId;
  }
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("complete setup orchestration", () => {
  it("keeps dry-run free of setup-state and answer-cache writes", async () => {
    await setup(
      { root: temporaryRoot, json: false, verbose: false },
      {
        dryRun: true,
        nonInteractive: true,
        projectName: "SakuraCord",
        slug: "sakuracord",
        description: "Public engineering roadmap",
        applicationRepository: "/tmp/SakuraCord",
        publicUrl: "https://roadmap.example.com",
        idPrefix: "SCR",
        gatewayProvider: "cloudflare",
        initialData: "empty",
        mcpMode: "local",
      },
    );

    await expect(access(path.join(temporaryRoot, ".roadmap"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(harness.events).toEqual([]);
  });

  it("deploys before Discord registration, redeploys mappings, verifies, publishes, reconciles, and starts Gateway", async () => {
    await setup(
      { root: temporaryRoot, json: false, verbose: false },
      {
        nonInteractive: true,
        yes: true,
        projectName: "SakuraCord",
        slug: "sakuracord",
        description: "Public engineering roadmap",
        applicationRepository: "/tmp/SakuraCord",
        publicUrl: "https://roadmap.example.com",
        idPrefix: "SCR",
        gatewayProvider: "cloudflare",
        initialData: "empty",
        mcpMode: "local",
        priorities: "critical,high,medium,low",
        priorityColors: "#EF4444,#F97316,#EAB308,#22C55E",
        lifecycle: "inbox,planned,in_progress,polishing,done",
        lifecycleColors: "#94A3B8,#60A5FA,#A78BFA,#F3A6C8,#34D399",
        aiModel: "gpt-5.6-sol",
        aiReasoningEffort: "medium",
        skipCodex: true,
        discordApplicationId: "11111111111111111",
        discordPublicKey: "a".repeat(64),
        discordGuildId: "22222222222222222",
        discordFeatureForumId: "33333333333333333",
        discordBugForumId: "44444444444444444",
        discordRoadmapChannelId: "55555555555555555",
        discordMaintainerRoleIds: "66666666666666666",
      },
    );

    expect(harness.events).toEqual([
      "worker:deploy",
      "worker:health",
      "discord:configure",
      "worker:deploy",
      "worker:health",
      "discord:verify",
      "ai:configure",
      "release:connect-ai",
      "api:/api/v1/discord/forums/configure",
      "api:/api/v1/discord/roadmap-emojis/configure",
      "api:/api/v1/discord/publish",
      "api:/api/v1/reconcile",
      "api:/api/v1/discord/gateway/start",
      "api:/api/v1/discord/gateway/status",
    ]);
    const wranglerConfiguration = JSON.parse(
      await readFile(path.join(temporaryRoot, "wrangler.jsonc"), "utf8"),
    );
    expect(wranglerConfiguration.account_id).toBe("account-id");
    const instance = JSON.parse(
      await readFile(path.join(temporaryRoot, "roadmap.instance.json"), "utf8"),
    );
    expect(instance.releases).toMatchObject({
      enabled: false,
      aiModel: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
    expect(instance.priorities.map((priority: { color: string }) => priority.color)).toEqual([
      "#EF4444",
      "#F97316",
      "#EAB308",
      "#22C55E",
    ]);
    const setupState = JSON.parse(
      await readFile(path.join(temporaryRoot, ".roadmap/setup-state.json"), "utf8"),
    );
    expect(setupState.ai_connection.status).toBe("complete");
    expect(setupState.discord_forum_taxonomy.status).toBe("complete");
  });

  it("resumes after Cloudflare without repeating project prompts, D1, migrations, secrets, or deployment", async () => {
    await writeFile(
      path.join(temporaryRoot, "roadmap.instance.json"),
      JSON.stringify({
        project: {
          name: "SakuraCord",
          slug: "sakuracord",
          description: "Public engineering roadmap",
          applicationRepository: "/tmp/SakuraCord",
          publicUrl: "https://roadmap.example.com",
          idPrefix: "SCR",
        },
        branding: {
          primaryColor: "#F3A6C8",
          accentColor: "#D9578B",
          backgroundColor: "#0E0C13",
          logoUrl: "/brand/logo.png",
          iconUrl: "/brand/icon.png",
        },
        deployment: { gatewayProvider: "cloudflare" },
      }),
    );
    const roadmapDirectory = path.join(temporaryRoot, ".roadmap");
    await mkdir(roadmapDirectory, { recursive: true });
    await writeFile(
      path.join(roadmapDirectory, "setup-state.json"),
      JSON.stringify({
        project_configuration: {
          status: "complete",
          detail: "roadmap.instance.json",
          updatedAt: new Date().toISOString(),
        },
        cloudflare_deploy: {
          status: "complete",
          detail: "Deployment and health check verified",
          updatedAt: new Date().toISOString(),
        },
        d1_migrations: {
          status: "complete",
          detail: "Remote migrations applied through schema 4",
          updatedAt: new Date().toISOString(),
        },
      }),
    );
    await writeFile(
      path.join(roadmapDirectory, "setup-answers.json"),
      JSON.stringify({
        setup: {
          initialData: "empty",
          mcpMode: "local",
          installCodex: false,
        },
        discord: {
          applicationId: "11111111111111111",
          publicKey: "a".repeat(64),
          guildId: "22222222222222222",
          featureForumId: "33333333333333333",
          bugForumId: "44444444444444444",
          roadmapChannelId: "55555555555555555",
          releaseAnnouncementChannelId: "55555555555555556",
          maintainerRoleIds: "66666666666666666",
          publicUrl: "https://roadmap.example.com",
        },
      }),
    );

    await setup(
      { root: temporaryRoot, json: false, verbose: false },
      {
        nonInteractive: true,
        skipCodex: true,
      },
    );

    expect(harness.events).toEqual([
      "discord:configure",
      "worker:deploy",
      "worker:health",
      "discord:verify",
      "ai:configure",
      "release:connect-ai",
      "api:/api/v1/discord/forums/configure",
      "api:/api/v1/discord/roadmap-emojis/configure",
      "api:/api/v1/discord/publish",
      "api:/api/v1/reconcile",
      "api:/api/v1/discord/gateway/start",
      "api:/api/v1/discord/gateway/status",
    ]);
  });

  it("redeploys a Worker fix without asking for the Discord token again", async () => {
    await writeFile(
      path.join(temporaryRoot, "roadmap.instance.json"),
      JSON.stringify({
        project: {
          name: "SakuraCord",
          slug: "sakuracord",
          description: "Public engineering roadmap",
          applicationRepository: "/tmp/SakuraCord",
          publicUrl: "https://roadmap.example.com",
          idPrefix: "SCR",
        },
        branding: {
          primaryColor: "#F3A6C8",
          accentColor: "#D9578B",
          backgroundColor: "#0E0C13",
          logoUrl: "/brand/logo.png",
          iconUrl: "/brand/icon.png",
        },
        deployment: { gatewayProvider: "cloudflare" },
      }),
    );
    const roadmapDirectory = path.join(temporaryRoot, ".roadmap");
    await mkdir(roadmapDirectory, { recursive: true });
    const complete = (detail: string) => ({
      status: "complete",
      detail,
      updatedAt: new Date().toISOString(),
    });
    await writeFile(
      path.join(roadmapDirectory, "setup-state.json"),
      JSON.stringify({
        project_configuration: complete("configured"),
        d1_migrations: complete("Remote migrations applied through schema 4"),
        cloudflare_deploy: complete("deployed"),
        discord_configuration: complete("configured"),
        discord_deployment: {
          status: "failed",
          detail: "runtime fix pending",
          updatedAt: new Date().toISOString(),
        },
        discord_verification: complete("verified"),
        mcp_configuration: complete("configured"),
        codex_installation: complete("installed"),
      }),
    );
    await writeFile(
      path.join(roadmapDirectory, "setup-answers.json"),
      JSON.stringify({
        setup: {
          initialData: "empty",
          mcpMode: "local",
          installCodex: true,
        },
        discord: {
          applicationId: "11111111111111111",
          publicKey: "a".repeat(64),
          guildId: "22222222222222222",
          featureForumId: "33333333333333333",
          bugForumId: "44444444444444444",
          roadmapChannelId: "55555555555555555",
          releaseAnnouncementChannelId: "55555555555555556",
          maintainerRoleIds: "66666666666666666",
          publicUrl: "https://roadmap.example.com",
        },
      }),
    );

    await setup(
      { root: temporaryRoot, json: false, verbose: false },
      {
        nonInteractive: true,
        skipCodex: false,
      },
    );

    expect(harness.events).toEqual([
      "worker:deploy",
      "worker:health",
      "ai:configure",
      "release:connect-ai",
      "api:/api/v1/discord/forums/configure",
      "api:/api/v1/discord/roadmap-emojis/configure",
      "api:/api/v1/discord/publish",
      "api:/api/v1/reconcile",
      "api:/api/v1/discord/gateway/start",
      "api:/api/v1/discord/gateway/status",
    ]);
  });

  it("resumes a failed ChatGPT connection without repeating release infrastructure", async () => {
    await writeFile(
      path.join(temporaryRoot, "roadmap.instance.json"),
      JSON.stringify({
        project: {
          name: "SakuraCord",
          slug: "sakuracord",
          description: "Public engineering roadmap",
          applicationRepository: "/tmp/SakuraCord",
          publicUrl: "https://roadmap.example.com",
          idPrefix: "SCR",
        },
        branding: {
          primaryColor: "#F3A6C8",
          accentColor: "#D9578B",
          backgroundColor: "#0E0C13",
          logoUrl: "/brand/logo.png",
          iconUrl: "/brand/icon.png",
        },
        deployment: { gatewayProvider: "disabled" },
        releases: {
          enabled: true,
          githubRepository: "SakuraCordApp/SakuraCord",
          aiModel: "gpt-5.4-mini",
        },
      }),
    );
    const roadmapDirectory = path.join(temporaryRoot, ".roadmap");
    await mkdir(roadmapDirectory, { recursive: true });
    const complete = (detail: string) => ({
      status: "complete",
      detail,
      updatedAt: new Date().toISOString(),
    });
    await writeFile(
      path.join(roadmapDirectory, "setup-state.json"),
      JSON.stringify({
        project_configuration: complete("configured"),
        d1_migrations: complete("Remote migrations applied through schema 4"),
        cloudflare_deploy: complete("deployed"),
        release_infrastructure: complete("webhook and secrets configured"),
        release_ai: {
          status: "failed",
          detail: "Invalid authorize request",
          updatedAt: new Date().toISOString(),
        },
      }),
    );
    await writeFile(
      path.join(roadmapDirectory, "setup-answers.json"),
      JSON.stringify({
        setup: {
          initialData: "empty",
          mcpMode: "local",
          installCodex: false,
          enableReleases: true,
          githubRepository: "SakuraCordApp/SakuraCord",
          releaseAiModel: "gpt-5.4-mini",
        },
      }),
    );

    await setup(
      { root: temporaryRoot, json: false, verbose: false },
      {
        nonInteractive: true,
        skipCloudflare: true,
        skipDiscord: true,
        skipCodex: true,
      },
    );

    expect(harness.events).toEqual(["release:connect-ai"]);
    const state = JSON.parse(
      await readFile(path.join(roadmapDirectory, "setup-state.json"), "utf8"),
    );
    expect(state.release_infrastructure.status).toBe("complete");
    expect(state.release_ai.status).toBe("complete");
    expect(state.release_automation.status).toBe("complete");
  });
});
