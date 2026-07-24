#!/usr/bin/env node
import { Command, Option } from "commander";
import { createContext } from "./context.js";
import { configureDiscord, verifyDiscord } from "./discord.js";
import {
  deploy,
  doctor,
  exportRoadmap,
  importRoadmap,
  installCodex,
  installMcp,
  migrate,
  reconcile,
  upgrade,
} from "./operations.js";
import { setup } from "./setup.js";
import { configureReleaseAutomation, connectReleaseAi, releaseStatus } from "./releases.js";

const program = new Command()
  .name("roadmap")
  .description("Set up, operate, verify, and upgrade a self-hosted roadmap platform")
  .version("0.1.0")
  .option("--root <path>", "repository root")
  .option("--json", "machine-readable output")
  .option("--verbose", "show invoked commands");

program
  .command("setup")
  .description("Run the resumable interactive setup wizard")
  .option("--dry-run", "print the complete change plan without applying it")
  .option("--non-interactive", "require all values from flags")
  .option("--yes", "approve the printed plan")
  .option("--repair", "repair missing resources while preserving valid configuration")
  .option("--project-name <name>")
  .option("--slug <slug>")
  .option("--description <description>")
  .option("--application-repository <path>")
  .option("--public-url <url>")
  .option("--id-prefix <prefix>")
  .addOption(
    new Option("--gateway-provider <provider>").choices(["cloudflare", "node", "disabled"]),
  )
  .option("--skip-cloudflare")
  .option("--skip-discord")
  .option("--skip-codex")
  .option("--skip-ai", "do not configure ChatGPT report analysis")
  .addOption(new Option("--initial-data <mode>").choices(["empty", "file"]))
  .option("--import-file <path>")
  .addOption(new Option("--mcp-mode <mode>").choices(["local", "remote"]))
  .option("--areas <ids>", "comma-separated area IDs")
  .option("--item-types <ids>", "comma-separated item type IDs")
  .option("--lifecycle <ids>", "ordered comma-separated lifecycle state IDs")
  .option("--lifecycle-colors <hexes>", "comma-separated colors matching lifecycle IDs")
  .option("--priorities <ids>", "comma-separated priority IDs")
  .option("--priority-colors <hexes>", "comma-separated colors matching priority IDs")
  .option("--difficulties <ids>", "comma-separated difficulty IDs")
  .option("--primary-color <hex>")
  .option("--accent-color <hex>")
  .option("--background-color <hex>")
  .option("--logo-url <url-or-path>")
  .option("--icon-url <url-or-path>")
  .option("--cloudflare-account-id <id>")
  .option("--discord-application-id <id>")
  .option("--discord-public-key <key>")
  .option("--discord-guild-id <id>")
  .option("--discord-feature-forum-id <id>")
  .option("--discord-bug-forum-id <id>")
  .option("--discord-roadmap-channel-id <id>")
  .option("--discord-release-channel-id <id>")
  .option("--discord-updates-role-id <id>")
  .option("--discord-maintainer-role-ids <ids>", "comma-separated authorized role IDs")
  .option("--skip-releases")
  .option("--github-repository <owner/name>")
  .option("--ai-model <model>", "model for report analysis and release writing")
  .addOption(
    new Option("--ai-reasoning-effort <effort>").choices([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
  )
  .option("--release-ai-model <model>")
  .addOption(
    new Option("--release-reasoning-effort <effort>").choices([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
  )
  .action(withContext(setup));

program
  .command("doctor")
  .description("Verify local configuration and an optional deployed instance")
  .option("--api-url <url>", "deployed public URL", process.env.ROADMAP_API_URL)
  .option("--token <token>", "maintainer token", process.env.ROADMAP_TOKEN)
  .action(withContext(doctor));

program
  .command("deploy")
  .description("Run all checks, deploy to Cloudflare, and verify health")
  .option("--dry-run")
  .option("--api-url <url>", "URL to verify after deployment", process.env.ROADMAP_API_URL)
  .action(withContext(deploy));

program
  .command("migrate")
  .description("Apply D1 migrations")
  .option("--local", "migrate local D1 rather than remote")
  .option("--database <name>", "D1 database name")
  .option("--dry-run")
  .action(withContext(migrate));

const discord = program.command("discord").description("Configure and verify Discord integration");
discord
  .command("configure")
  .option("--application-id <id>")
  .option("--public-key <key>")
  .option("--guild-id <id>")
  .option("--feature-forum-id <id>")
  .option("--bug-forum-id <id>")
  .option("--roadmap-channel-id <id>")
  .option("--release-announcement-channel-id <id>")
  .option("--updates-role-id <id>", "role toggled by the Subscribe button")
  .option("--maintainer-role-ids <ids>", "comma-separated role IDs authorized for controls")
  .option("--public-url <url>", undefined, process.env.ROADMAP_PUBLIC_URL)
  .option(
    "--token-env <name>",
    "environment variable containing the bot token",
    "DISCORD_BOT_TOKEN",
  )
  .option("--store-secret", "store bot token and public application values with Wrangler")
  .option("--create-missing-tags", "create missing moderated tags; requires MANAGE_CHANNELS")
  .option("--non-interactive")
  .action(withContext(configureDiscord));
discord
  .command("verify")
  .option("--application-id <id>")
  .option("--guild-id <id>")
  .option("--feature-forum-id <id>")
  .option("--bug-forum-id <id>")
  .option("--roadmap-channel-id <id>")
  .option("--release-announcement-channel-id <id>")
  .option("--updates-role-id <id>")
  .option(
    "--token-env <name>",
    "environment variable containing the bot token",
    "DISCORD_BOT_TOKEN",
  )
  .option("--write-test", "create and immediately delete a permission-test message")
  .option("--non-interactive")
  .action(withContext(verifyDiscord));

const releases = program
  .command("releases")
  .description("Configure and operate AI-generated release announcements");
releases
  .command("configure")
  .option("--repository <owner/name>")
  .option("--api-url <url>", undefined, process.env.ROADMAP_API_URL)
  .option("--roadmap-token <token>", undefined, process.env.ROADMAP_TOKEN)
  .option("--github-token-env <name>", undefined, "GITHUB_RELEASE_TOKEN")
  .option("--updates-role-id <id>")
  .option("--channel-id <id>")
  .option("--ai-model <model>")
  .addOption(
    new Option("--reasoning-effort <effort>").choices([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
  )
  .option("--skip-ai-connect")
  .option("--skip-deploy")
  .option("--non-interactive")
  .action(withContext(configureReleaseAutomation));
releases
  .command("connect-ai")
  .option("--api-url <url>", undefined, process.env.ROADMAP_API_URL)
  .option("--roadmap-token <token>", undefined, process.env.ROADMAP_TOKEN)
  .option("--non-interactive")
  .action(withContext(connectReleaseAi));
releases
  .command("status")
  .option("--api-url <url>", undefined, process.env.ROADMAP_API_URL)
  .option("--roadmap-token <token>", undefined, process.env.ROADMAP_TOKEN)
  .option("--non-interactive")
  .action(withContext(releaseStatus));

program
  .command("import")
  .description("Validate and import native JSON/YAML or supported provider exports")
  .requiredOption("--file <path>")
  .requiredOption("--api-url <url>", undefined, process.env.ROADMAP_API_URL)
  .option("--token <token>", "maintainer token", process.env.ROADMAP_TOKEN)
  .addOption(
    new Option("--provider <provider>").choices(["native", "github", "linear"]).default("native"),
  )
  .option("--default-area <area>", "area for provider imports", "platform")
  .option("--dry-run")
  .action(withContext(importRoadmap));

program
  .command("export")
  .description("Export public roadmap data and/or safe non-secret instance configuration")
  .requiredOption("--file <path>")
  .option("--api-url <url>", undefined, process.env.ROADMAP_API_URL)
  .option("--safe-config")
  .action(withContext(exportRoadmap));

program
  .command("reconcile")
  .description("Run Discord reconciliation")
  .requiredOption("--api-url <url>", undefined, process.env.ROADMAP_API_URL)
  .option("--token <token>", "maintainer token", process.env.ROADMAP_TOKEN)
  .action(withContext(reconcile));

const mcp = program.command("mcp").description("Configure the MCP server");
mcp
  .command("install")
  .requiredOption("--api-url <url>", undefined, process.env.ROADMAP_API_URL)
  .option("--repository <path>", "application repository for read-only inspection")
  .option("--remote", "configure Streamable HTTP instead of local stdio")
  .option("--remote-url <url>")
  .option("--test", "start the local server and verify required tools")
  .action(withContext(installMcp));

program
  .command("codex")
  .description("Codex integration")
  .command("install")
  .description("Register the local marketplace and install the plugin")
  .action(withContext(async (context) => installCodex(context)));

program
  .command("upgrade")
  .description("Install dependencies, apply migrations, check, deploy, and verify")
  .option("--database <name>")
  .option("--api-url <url>", undefined, process.env.ROADMAP_API_URL)
  .option("--dry-run")
  .action(withContext(upgrade));

await program.parseAsync(process.argv);

function withContext<T extends Record<string, unknown>>(
  handler: (context: Awaited<ReturnType<typeof createContext>>, options: T) => Promise<unknown>,
) {
  return async (options: T, command: Command) => {
    const globals = command.optsWithGlobals<{ root?: string; json?: boolean; verbose?: boolean }>();
    const context = await createContext(globals);
    try {
      await handler(context, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (context.json) process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      else process.stderr.write(`Error: ${message}\n`);
      process.exitCode = 1;
    }
  };
}
