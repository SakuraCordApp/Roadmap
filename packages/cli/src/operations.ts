import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CreateRoadmapItemSchema, RoadmapConfigSchema } from "@roadmap/core";
import YAML from "yaml";
import { CliApiClient } from "./api.js";
import {
  commandExists,
  fileExists,
  output,
  readJson,
  run,
  writeJsonAtomic,
  type CliContext,
} from "./context.js";

export async function doctor(
  context: CliContext,
  options: { apiUrl?: string; token?: string },
): Promise<void> {
  const checks: Array<{ check: string; status: "ok" | "warning" | "failed"; detail: string }> = [];
  const configResult = await run(context, "npx", ["tsx", "scripts/print-config.ts"], {
    reject: false,
  });
  if (configResult.exitCode === 0) {
    try {
      RoadmapConfigSchema.parse(JSON.parse(configResult.stdout));
      checks.push({
        check: "configuration",
        status: "ok",
        detail: "Typed configuration is valid.",
      });
    } catch (error) {
      checks.push({ check: "configuration", status: "failed", detail: String(error) });
    }
  } else {
    checks.push({
      check: "configuration",
      status: "failed",
      detail: configResult.stderr.slice(0, 1_000),
    });
  }
  const sqliteAvailable = await commandExists("sqlite3");
  if (sqliteAvailable) {
    const temp = await mkdtemp(path.join(os.tmpdir(), "roadmap-doctor-"));
    try {
      const migration = (
        await Promise.all(
          [
            "0001_initial.sql",
            "0002_release_automation.sql",
            "0003_report_automation.sql",
            "0004_reliable_jobs.sql",
            "0005_report_job_recovery.sql",
          ].map((name) => readFile(path.join(context.root, "migrations", name), "utf8")),
        )
      ).join("\n");
      const result = await run(context, "sqlite3", [path.join(temp, "doctor.sqlite")], {
        input: `${migration}\nSELECT value FROM schema_metadata WHERE key='schema_version';\n`,
        reject: false,
      });
      checks.push({
        check: "migration",
        status: result.exitCode === 0 && result.stdout.trim().endsWith("6") ? "ok" : "failed",
        detail:
          result.exitCode === 0
            ? "Fresh SQLite migration and schema metadata verified."
            : result.stderr.slice(0, 1_000),
      });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } else {
    checks.push({
      check: "migration",
      status: "warning",
      detail: "sqlite3 is unavailable; migration syntax was not tested locally.",
    });
  }
  const pluginValidator = await run(
    context,
    "node",
    ["scripts/validate-plugin.mjs", path.join(context.root, "plugins/roadmap-management")],
    { reject: false },
  );
  checks.push({
    check: "codex_plugin",
    status: pluginValidator.exitCode === 0 ? "ok" : "failed",
    detail:
      pluginValidator.exitCode === 0
        ? "Codex plugin manifest and referenced components are valid."
        : pluginValidator.stderr.slice(0, 1_000),
  });
  const sourceSecrets = await run(
    context,
    "rg",
    [
      "-n",
      "--hidden",
      "--glob",
      "!.git/**",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!dist/**",
      "--glob",
      "!dist-types/**",
      "(DISCORD_BOT_TOKEN|ROADMAP_ADMIN_TOKEN|GITHUB_RELEASE_TOKEN|GITHUB_WEBHOOK_SECRET|ROADMAP_OAUTH_ENCRYPTION_KEY)=[A-Za-z0-9_./+-]{16,}",
      ".",
    ],
    { reject: false },
  );
  checks.push({
    check: "source_secrets",
    status: sourceSecrets.exitCode === 1 ? "ok" : "failed",
    detail:
      sourceSecrets.exitCode === 1
        ? "No populated token assignments found in repository source files."
        : sourceSecrets.stdout.slice(0, 1_000) || sourceSecrets.stderr.slice(0, 1_000),
  });
  const cloudflare = await run(context, "npx", ["wrangler", "whoami"], { reject: false });
  checks.push({
    check: "cloudflare_auth",
    status: cloudflare.exitCode === 0 ? "ok" : "warning",
    detail:
      cloudflare.exitCode === 0
        ? "Wrangler authentication is active."
        : "Not authenticated; run `npx wrangler login` before deployment.",
  });
  if (options.apiUrl) {
    try {
      const health = await new CliApiClient(options.apiUrl, options.token).get("/healthz");
      checks.push({
        check: "deployment",
        status: health.ok ? "ok" : "failed",
        detail: `Health response schema=${health.schemaVersion ?? "unknown"}.`,
      });
      const sync = await new CliApiClient(options.apiUrl, options.token).get("/api/v1/sync/status");
      checks.push({
        check: "synchronization",
        status: sync.data?.failed > 0 ? "warning" : "ok",
        detail: JSON.stringify(sync.data),
      });
    } catch (error) {
      checks.push({ check: "deployment", status: "failed", detail: safeMessage(error) });
    }
  } else {
    checks.push({
      check: "deployment",
      status: "warning",
      detail: "Pass --api-url to verify a deployed instance.",
    });
  }
  output(context, { healthy: checks.every((check) => check.status !== "failed"), checks });
  if (checks.some((check) => check.status === "failed")) process.exitCode = 1;
}

export async function deploy(
  context: CliContext,
  options: { dryRun?: boolean; apiUrl?: string },
): Promise<void> {
  if (options.dryRun) {
    output(context, {
      plan: [
        "run complete local checks",
        "deploy Worker/assets",
        "verify health endpoint and schema version",
      ],
    });
    return;
  }
  await run(context, "npm", ["run", "check"], { stdout: "inherit", stderr: "inherit" });
  const deployed = await run(context, "npx", ["wrangler", "deploy"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (deployed.exitCode !== 0) throw new Error("Wrangler deployment failed.");
  if (options.apiUrl) {
    const health = await new CliApiClient(options.apiUrl).get("/healthz");
    if (!health.ok) throw new Error("Deployment health check did not confirm the migrated schema.");
  }
  output(context, "Deployment command completed and configured health check passed.");
}

export async function migrate(
  context: CliContext,
  options: { local?: boolean; database?: string; dryRun?: boolean },
): Promise<void> {
  const database = options.database ?? "sakuracord-roadmap";
  const args = [
    "wrangler",
    "d1",
    "migrations",
    "apply",
    database,
    options.local ? "--local" : "--remote",
  ];
  if (options.dryRun) {
    output(context, { command: `npx ${args.join(" ")}` });
    return;
  }
  await run(context, "npx", args, { stdout: "inherit", stderr: "inherit" });
}

export async function importRoadmap(
  context: CliContext,
  options: {
    file: string;
    apiUrl: string;
    token?: string;
    provider?: "native" | "github" | "linear";
    dryRun?: boolean;
    defaultArea?: string;
  },
): Promise<void> {
  const absolute = path.resolve(options.file);
  const text = await readFile(absolute, "utf8");
  const raw =
    absolute.endsWith(".yaml") || absolute.endsWith(".yml") ? YAML.parse(text) : JSON.parse(text);
  const records = adaptProvider(
    raw,
    options.provider ?? "native",
    options.defaultArea ?? "platform",
  );
  const parsed = records.map((record, index) => {
    const result = CreateRoadmapItemSchema.safeParse(record);
    if (!result.success) {
      throw new Error(
        `Import record ${index + 1} is invalid: ${JSON.stringify(result.error.issues)}`,
      );
    }
    return result.data;
  });
  if (options.dryRun) {
    output(context, {
      valid: true,
      count: parsed.length,
      titles: parsed.map((item) => item.title),
    });
    return;
  }
  const api = new CliApiClient(options.apiUrl, options.token);
  const results = [];
  for (const item of parsed) {
    results.push(
      await api.post(
        "/api/v1/items",
        item,
        `roadmap-import-${createHash("sha256")
          .update(JSON.stringify(item))
          .digest("hex")
          .slice(0, 40)}`,
      ),
    );
  }
  output(context, {
    imported: results.length,
    items: results.map((result) => result.data.after.id),
  });
}

export async function exportRoadmap(
  context: CliContext,
  options: { file: string; apiUrl?: string; safeConfig?: boolean },
): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (options.safeConfig) {
    payload.configuration = await readJson(path.join(context.root, "roadmap.instance.json"), {});
  }
  if (options.apiUrl) {
    const page = await new CliApiClient(options.apiUrl).get("/api/v1/items?limit=250");
    payload.items = page.data;
  }
  if (!options.safeConfig && !options.apiUrl) {
    throw new Error("Choose --safe-config and/or --api-url.");
  }
  await writeJsonAtomic(path.resolve(options.file), payload);
  output(context, `Exported non-secret data to ${path.resolve(options.file)}.`);
}

export async function reconcile(
  context: CliContext,
  options: { apiUrl: string; token?: string },
): Promise<void> {
  const result = await new CliApiClient(options.apiUrl, options.token).post("/api/v1/reconcile");
  output(context, result);
}

export async function installMcp(
  context: CliContext,
  options: {
    apiUrl: string;
    repository?: string;
    remote?: boolean;
    remoteUrl?: string;
    test?: boolean;
  },
): Promise<void> {
  const file = path.join(context.root, "plugins/roadmap-management/.mcp.json");
  const value = options.remote
    ? {
        mcpServers: {
          roadmap: {
            type: "http",
            url: options.remoteUrl ?? `${options.apiUrl.replace(/\/$/, "")}/mcp`,
          },
        },
      }
    : {
        mcpServers: {
          roadmap: {
            command: "node",
            args: [path.join(context.root, "packages/mcp/dist/index.js")],
            env: {
              ROADMAP_API_URL: options.apiUrl,
              ...(options.repository
                ? { ROADMAP_APP_REPOSITORY: path.resolve(options.repository) }
                : {}),
            },
          },
        },
      };
  await writeJsonAtomic(file, value);
  await run(context, "npm", ["run", "build", "--workspace", "@roadmap/mcp"]);
  if (options.test && !options.remote) {
    const test = await run(context, "npx", ["tsx", "scripts/test-mcp.ts"], {
      env: {
        ...process.env,
        ROADMAP_API_URL: options.apiUrl,
        ...(options.repository ? { ROADMAP_APP_REPOSITORY: path.resolve(options.repository) } : {}),
      },
      reject: false,
    });
    if (test.exitCode !== 0) throw new Error(`MCP self-test failed: ${test.stderr}`);
  }
  output(
    context,
    "MCP configuration installed without embedding credentials. Set ROADMAP_TOKEN in the launching environment or configure remote bearer authentication.",
  );
}

export async function installCodex(context: CliContext): Promise<void> {
  const marketplace = path.join(context.root, ".agents/plugins/marketplace.json");
  if (!(await fileExists(marketplace)))
    throw new Error("Repo-local marketplace manifest is missing.");
  const addMarketplace = await run(
    context,
    "codex",
    ["plugin", "marketplace", "add", context.root],
    {
      reject: false,
    },
  );
  if (addMarketplace.exitCode !== 0 && !/already/i.test(addMarketplace.stderr)) {
    throw new Error(`Could not register the local marketplace: ${addMarketplace.stderr}`);
  }
  const addPlugin = await run(context, "codex", ["plugin", "add", "roadmap-management@personal"], {
    reject: false,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (addPlugin.exitCode !== 0 && !/already/i.test(addPlugin.stderr)) {
    throw new Error(`Could not install the roadmap plugin: ${addPlugin.stderr}`);
  }
  output(
    context,
    "Codex plugin installed. Start a new Codex task so it loads the skill and MCP tools.",
  );
}

export async function upgrade(
  context: CliContext,
  options: { database?: string; apiUrl?: string; dryRun?: boolean },
): Promise<void> {
  if (options.dryRun) {
    output(context, {
      plan: [
        "npm install",
        "validate plugin",
        "apply D1 migrations",
        "run full checks",
        "deploy",
        "health verify",
      ],
    });
    return;
  }
  await run(context, "npm", ["install"], { stdout: "inherit", stderr: "inherit" });
  await migrate(context, { database: options.database });
  await deploy(context, { apiUrl: options.apiUrl });
}

function adaptProvider(
  raw: unknown,
  provider: "native" | "github" | "linear",
  defaultArea: string,
): unknown[] {
  if (provider === "native") {
    if (!Array.isArray(raw)) throw new Error("Native import must be an array.");
    return raw;
  }
  const records = Array.isArray(raw) ? raw : ((raw as any)?.items ?? (raw as any)?.issues);
  if (!Array.isArray(records))
    throw new Error(`${provider} import must contain an items/issues array.`);
  return records.map((record: any) => ({
    title: record.title ?? record.name,
    description: record.body ?? record.description ?? record.title,
    type: provider === "github" && record.pull_request ? "feature" : "feature",
    area: defaultArea,
    status: ["closed", "completed", "done"].includes(
      String(record.state ?? record.status).toLowerCase(),
    )
      ? "done"
      : "planned",
    priority: "medium",
    references: record.html_url
      ? [{ kind: "research", label: `${provider} source`, url: record.html_url }]
      : [],
  }));
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
