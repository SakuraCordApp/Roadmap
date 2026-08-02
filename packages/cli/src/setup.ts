import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import prompts from "prompts";
import { CliApiClient } from "./api.js";
import { deepMerge, output, readJson, run, writeJsonAtomic, type CliContext } from "./context.js";
import {
  configureDiscord,
  getDiscordBotToken,
  verifyDiscord,
  type ConfiguredDiscord,
  type DiscordSetupAnswers,
} from "./discord.js";
import { resilientFetch } from "./network.js";
import { importRoadmap, installCodex, installMcp } from "./operations.js";
import {
  configureAiInfrastructure,
  configureReleaseAutomation,
  connectReleaseAi,
} from "./releases.js";
import {
  generateRoadmapTimelineEmojiPayloads,
  generateTagIconPayloads,
  loadTagIconTheme,
} from "./tag-icons.js";

interface SetupOptions {
  dryRun?: boolean;
  nonInteractive?: boolean;
  yes?: boolean;
  repair?: boolean;
  projectName?: string;
  slug?: string;
  description?: string;
  applicationRepository?: string;
  publicUrl?: string;
  idPrefix?: string;
  gatewayProvider?: "cloudflare" | "disabled";
  skipCloudflare?: boolean;
  skipDiscord?: boolean;
  skipCodex?: boolean;
  skipAi?: boolean;
  initialData?: "empty" | "file";
  importFile?: string;
  mcpMode?: "local" | "remote";
  areas?: string;
  itemTypes?: string;
  lifecycle?: string;
  lifecycleColors?: string;
  priorities?: string;
  priorityColors?: string;
  primaryColor?: string;
  accentColor?: string;
  backgroundColor?: string;
  logoUrl?: string;
  iconUrl?: string;
  cloudflareAccountId?: string;
  discordApplicationId?: string;
  discordPublicKey?: string;
  discordGuildId?: string;
  discordFeatureForumId?: string;
  discordBugForumId?: string;
  discordRoadmapChannelId?: string;
  discordReleaseChannelId?: string;
  discordUpdatesRoleId?: string;
  discordMaintainerRoleIds?: string;
  skipReleases?: boolean;
  githubRepository?: string;
  aiModel?: string;
  aiReasoningEffort?: string;
  releaseAiModel?: string;
  releaseReasoningEffort?: string;
}

interface SetupAnswers {
  projectName: string;
  slug: string;
  description: string;
  applicationRepository: string;
  publicUrl: string;
  idPrefix: string;
  gatewayProvider: "cloudflare" | "disabled";
  initialData: "empty" | "file";
  importFile?: string;
  mcpMode: "local" | "remote";
  installCodex: boolean;
  enableAi: boolean;
  enableReleases: boolean;
  githubRepository?: string;
  releaseAiModel: string;
  releaseReasoningEffort: string;
  areas?: string[];
  itemTypes?: string[];
  lifecycle?: string[];
  lifecycleColors?: string[];
  priorities?: string[];
  priorityColors?: string[];
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  logoUrl: string;
  iconUrl: string;
}

export interface SetupStep {
  status: "complete" | "failed";
  detail: string;
  updatedAt: string;
}

export type SetupState = Record<string, SetupStep>;

interface SetupResumeData {
  setup?: Partial<SetupAnswers>;
  discord?: Partial<DiscordSetupAnswers>;
}

export async function setup(context: CliContext, options: SetupOptions): Promise<void> {
  const state = await readSetupState(context);
  const resuming = Object.keys(state).length > 0;
  const resumeData = await readSetupResumeData(context);
  const answers = await gatherAnswers(context, options, state, resumeData);
  const configuredInstance = await readJson<any>(
    path.join(context.root, "roadmap.instance.json"),
    {},
  );
  const plan = [
    { action: "write", target: "roadmap.instance.json", external: false },
    { action: "validate", target: "typed project configuration", external: false },
    ...(!options.skipCloudflare
      ? [
          { action: "authenticate", target: "Cloudflare account via Wrangler", external: true },
          { action: "create-or-reuse", target: "Cloudflare D1 database", external: true },
          { action: "migrate", target: "Cloudflare D1 schema", external: true },
          { action: "store", target: "Cloudflare Worker secrets", external: true },
          { action: "deploy-and-verify", target: "Cloudflare Worker", external: true },
        ]
      : []),
    ...(!options.skipDiscord
      ? [
          {
            action: "store-configure-and-verify",
            target: "Discord secrets, application resources, tags, and permissions",
            external: true,
          },
          ...(!options.skipCloudflare
            ? [
                {
                  action: "redeploy-and-verify",
                  target: "Discord-aware Cloudflare Worker configuration",
                  external: true,
                },
              ]
            : []),
          {
            action: "read-write-verify",
            target:
              "Discord channels, active/archive threads, and roadmap/release message permissions",
            external: true,
          },
        ]
      : []),
    ...(answers.enableAi
      ? [
          {
            action:
              (stepComplete(state, "ai_infrastructure") ||
                stepComplete(state, "release_infrastructure")) &&
              !(stepComplete(state, "ai_connection") || stepComplete(state, "release_ai")) &&
              !options.repair
                ? "connect-and-verify"
                : "configure-connect-and-verify",
            target: "encrypted ChatGPT OAuth for report analysis",
            external: true,
          },
        ]
      : []),
    ...(answers.enableReleases && !options.skipReleases
      ? [
          {
            action:
              stepComplete(state, "release_infrastructure") &&
              !stepComplete(state, "release_ai") &&
              !options.repair
                ? "connect-and-verify"
                : "configure-connect-and-verify",
            target: "GitHub release webhook, encrypted ChatGPT OAuth, and Discord announcements",
            external: true,
          },
        ]
      : []),
    ...(!options.skipCodex
      ? [
          {
            action: "configure-and-test",
            target: "Codex plugin and MCP transport",
            external: false,
          },
          { action: "install", target: "Codex local marketplace plugin", external: true },
        ]
      : []),
    ...(answers.initialData !== "empty"
      ? [{ action: "validate-and-import", target: "initial roadmap data", external: true }]
      : []),
    ...(!options.skipDiscord
      ? [
          {
            action: "generate-and-provision",
            target: "Discord forum taxonomy and color-derived emojis",
            external: true,
          },
          {
            action: "publish-reconcile-and-start",
            target: "Discord roadmap message, forum state, and selected Gateway",
            external: true,
          },
        ]
      : []),
  ];
  const remainingPlan = resuming
    ? plan.filter((entry) => !planEntryComplete(state, entry.target))
    : plan;
  output(
    context,
    context.json
      ? { plan: remainingPlan, resume: resuming, completedSteps: completedStepNames(state) }
      : renderPlan(remainingPlan, state, resuming),
  );
  if (options.dryRun) return;
  if (!resuming && !options.yes && !options.nonInteractive) {
    const confirmation = await prompts({
      type: "confirm",
      name: "proceed",
      message: "Apply this setup plan?",
      initial: false,
    });
    if (!confirmation.proceed) throw new Error("Setup cancelled before making changes.");
    await markStep(context, "plan_approval", "complete", "Setup plan approved");
  }
  if (!resuming && options.nonInteractive && !options.yes) {
    throw new Error("Non-interactive setup requires --yes after reviewing --dry-run output.");
  }
  await saveSetupResumeData(context, { ...resumeData, setup: answers });

  if (!stepComplete(state, "project_configuration") || hasProjectOverrides(options)) {
    const instancePath = path.join(context.root, "roadmap.instance.json");
    const existing = await readJson<Record<string, unknown>>(instancePath, {});
    const override = {
      project: {
        name: answers.projectName,
        slug: answers.slug,
        idPrefix: answers.idPrefix,
        description: answers.description,
        publicUrl: answers.publicUrl,
        applicationRepository: answers.applicationRepository,
      },
      branding: {
        primaryColor: answers.primaryColor,
        accentColor: answers.accentColor,
        backgroundColor: answers.backgroundColor,
        logoUrl: answers.logoUrl,
        iconUrl: answers.iconUrl,
      },
      deployment: {
        workerName: `${answers.slug}-roadmap`,
        d1DatabaseName: `${answers.slug}-roadmap`,
        gatewayProvider: answers.gatewayProvider,
      },
      releases: {
        enabled: answers.enableReleases,
        aiModel: answers.releaseAiModel,
        reasoningEffort: answers.releaseReasoningEffort,
      },
      ...(answers.areas ? { areas: makeOptions(answers.areas) } : {}),
      ...(answers.itemTypes ? { itemTypes: makeOptions(answers.itemTypes) } : {}),
      ...(answers.priorities
        ? { priorities: makeOptions(answers.priorities, answers.priorityColors) }
        : {}),
      ...(answers.lifecycle
        ? {
            lifecycle: makeLifecycle(answers.lifecycle, answers.lifecycleColors),
            publicSections: answers.lifecycle.map((id, index) => ({
              id,
              label: makeOptions([id])[0]!.label,
              statuses: [id],
              ...(index === answers.lifecycle!.length - 1 ? { recentlyCompletedDays: 45 } : {}),
            })),
          }
        : {}),
    };
    await writeJsonAtomic(instancePath, deepMerge(existing, override));
    await markStep(context, "project_configuration", "complete", "roadmap.instance.json");
    await run(context, "npx", ["tsx", "scripts/print-config.ts"], {
      stdout: context.verbose ? "inherit" : "ignore",
    });
  } else {
    output(context, "✓ Resuming after completed project configuration");
  }

  const cloudflare = !options.skipCloudflare
    ? await configureCloudflare(
        context,
        answers,
        Boolean(options.nonInteractive),
        options.cloudflareAccountId,
        state,
        Boolean(options.repair),
      )
    : null;
  let discord: ConfiguredDiscord | null = null;
  if (!options.skipDiscord) {
    const discordOptions = {
      applicationId: options.discordApplicationId ?? resumeData.discord?.applicationId,
      publicKey: options.discordPublicKey ?? resumeData.discord?.publicKey,
      guildId: options.discordGuildId ?? resumeData.discord?.guildId,
      featureForumId: options.discordFeatureForumId ?? resumeData.discord?.featureForumId,
      bugForumId: options.discordBugForumId ?? resumeData.discord?.bugForumId,
      roadmapChannelId: options.discordRoadmapChannelId ?? resumeData.discord?.roadmapChannelId,
      releaseAnnouncementChannelId:
        options.discordReleaseChannelId ??
        resumeData.discord?.releaseAnnouncementChannelId ??
        configuredInstance.discord?.releaseAnnouncementChannelId,
      updatesRoleId:
        options.discordUpdatesRoleId ??
        resumeData.discord?.updatesRoleId ??
        (stepComplete(state, "discord_configuration")
          ? configuredInstance.discord?.updatesRoleId
          : undefined),
      maintainerRoleIds: options.discordMaintainerRoleIds ?? resumeData.discord?.maintainerRoleIds,
      publicUrl: answers.publicUrl,
      storeSecret: !options.skipCloudflare,
      createMissingTags: true,
      nonInteractive: options.nonInteractive,
      onAnswers: async (discordAnswers: DiscordSetupAnswers) => {
        await saveSetupResumeData(context, {
          ...(await readSetupResumeData(context)),
          discord: discordAnswers,
        });
      },
    };
    if (!stepComplete(state, "discord_configuration") || options.repair) {
      try {
        discord = await configureDiscord(context, discordOptions);
        await markStep(
          context,
          "discord_configuration",
          "complete",
          "Discord secrets, resources, tags, command, and interaction endpoint configured",
        );
      } catch (error) {
        await markStep(context, "discord_configuration", "failed", errorMessage(error));
        throw error;
      }
    } else {
      discord = await resumeConfiguredDiscord(
        discordOptions,
        !stepComplete(state, "discord_verification") || Boolean(options.repair),
      );
      output(context, "✓ Resuming after completed Discord application configuration");
    }
    if (!options.skipCloudflare && (!stepComplete(state, "discord_deployment") || options.repair)) {
      await deployAndVerify(context, answers.publicUrl);
      await markStep(
        context,
        "discord_deployment",
        "complete",
        "Discord IDs and forum-tag mappings deployed and health-checked",
      );
    }
    if (!stepComplete(state, "discord_verification") || options.repair) {
      await verifyDiscord(context, {
        botToken: discord.botToken,
        applicationId: discord.applicationId,
        guildId: discord.guildId,
        featureForumId: discord.featureForumId,
        bugForumId: discord.bugForumId,
        roadmapChannelId: discord.roadmapChannelId,
        releaseAnnouncementChannelId: discord.releaseAnnouncementChannelId,
        updatesRoleId: discord.updatesRoleId,
        createMissingTags: true,
        writeTest: true,
      });
      await markStep(
        context,
        "discord_verification",
        "complete",
        "Discord active/archive reads and create/delete permission test passed",
      );
    }
  }
  if (!options.skipCodex && (!stepComplete(state, "mcp_configuration") || options.repair)) {
    await installMcp(context, {
      apiUrl: answers.publicUrl,
      repository: answers.applicationRepository,
      remote: answers.mcpMode === "remote",
      ...(answers.mcpMode === "remote"
        ? { remoteUrl: `${answers.publicUrl.replace(/\/$/, "")}/mcp` }
        : {}),
      test: answers.mcpMode === "local" && !options.skipCloudflare,
    });
    await markStep(context, "mcp_configuration", "complete", `${answers.mcpMode} MCP configured`);
  }
  if (
    !options.skipCodex &&
    answers.installCodex &&
    (!stepComplete(state, "codex_installation") || options.repair)
  ) {
    await installCodex(context);
    await markStep(context, "codex_installation", "complete", "Codex plugin installed");
  }
  const importFile = answers.importFile;
  if (importFile && (!stepComplete(state, "initial_data") || options.repair)) {
    const token =
      cloudflare?.adminToken ??
      process.env.ROADMAP_TOKEN ??
      process.env.ROADMAP_ADMIN_TOKEN ??
      (await promptForExistingAdminToken(context, answers.slug, Boolean(options.nonInteractive)));
    if (!token) {
      throw new Error(
        "Initial data is validated but cannot be applied without ROADMAP_TOKEN when Cloudflare setup is skipped.",
      );
    }
    await importRoadmap(context, {
      file: importFile,
      apiUrl: answers.publicUrl,
      token,
      provider: "native",
    });
    await markStep(context, "initial_data", "complete", `Imported ${importFile}`);
  }
  const runtimePending =
    discord &&
    (!stepComplete(state, "discord_forum_taxonomy") ||
      !stepComplete(state, "discord_roadmap_emojis") ||
      !stepComplete(state, "discord_projection") ||
      !stepComplete(state, "discord_reconciliation") ||
      (answers.gatewayProvider === "cloudflare" && !stepComplete(state, "discord_gateway")));
  const legacyReleaseComplete = stepComplete(state, "release_automation");
  const aiInfrastructureComplete =
    stepComplete(state, "ai_infrastructure") ||
    stepComplete(state, "release_infrastructure") ||
    legacyReleaseComplete;
  const aiConnectionComplete =
    stepComplete(state, "ai_connection") ||
    stepComplete(state, "release_ai") ||
    legacyReleaseComplete;
  const aiInfrastructurePending =
    answers.enableAi &&
    !options.skipCloudflare &&
    (!aiInfrastructureComplete || Boolean(options.repair));
  const aiConnectionPending =
    answers.enableAi && (!aiConnectionComplete || Boolean(options.repair));
  const releaseInfrastructurePending =
    answers.enableReleases &&
    !options.skipReleases &&
    !legacyReleaseComplete &&
    (!stepComplete(state, "release_infrastructure") || Boolean(options.repair));
  const releasePending =
    releaseInfrastructurePending || aiInfrastructurePending || aiConnectionPending;
  const roadmapToken =
    cloudflare?.adminToken ??
    process.env.ROADMAP_TOKEN ??
    process.env.ROADMAP_ADMIN_TOKEN ??
    (runtimePending || releasePending
      ? await promptForExistingAdminToken(context, answers.slug, Boolean(options.nonInteractive))
      : undefined);
  if (aiInfrastructurePending) {
    try {
      await configureAiInfrastructure(context, {
        apiUrl: answers.publicUrl,
        skipDeploy: releaseInfrastructurePending,
      });
      await markStep(
        context,
        "ai_infrastructure",
        "complete",
        "Worker encryption secret configured for ChatGPT OAuth",
      );
    } catch (error) {
      await markStep(context, "ai_infrastructure", "failed", errorMessage(error));
      throw error;
    }
  }
  if (releaseInfrastructurePending && roadmapToken) {
    try {
      await configureReleaseAutomation(context, {
        repository: answers.githubRepository,
        apiUrl: answers.publicUrl,
        roadmapToken,
        updatesRoleId:
          options.discordUpdatesRoleId ??
          resumeData.discord?.updatesRoleId ??
          configuredInstance.discord?.updatesRoleId,
        channelId:
          options.discordReleaseChannelId ??
          resumeData.discord?.releaseAnnouncementChannelId ??
          configuredInstance.discord?.releaseAnnouncementChannelId ??
          discord?.releaseAnnouncementChannelId,
        aiModel: answers.releaseAiModel,
        reasoningEffort: answers.releaseReasoningEffort,
        skipAiInfrastructure: true,
        nonInteractive: options.nonInteractive,
        skipAiConnect: true,
      });
      await markStep(
        context,
        "release_infrastructure",
        "complete",
        "GitHub release webhook, Worker secrets, deployment, and Discord announcement destination configured",
      );
    } catch (error) {
      await markStep(context, "release_infrastructure", "failed", errorMessage(error));
      throw error;
    }
  }
  if (aiConnectionPending && roadmapToken) {
    try {
      await connectReleaseAi(context, {
        apiUrl: answers.publicUrl,
        roadmapToken,
        nonInteractive: options.nonInteractive,
      });
      await markStep(
        context,
        "ai_connection",
        "complete",
        "ChatGPT OAuth connection for Discord report analysis verified",
      );
      if (answers.enableReleases) {
        await markStep(
          context,
          "release_ai",
          "complete",
          "Shared ChatGPT OAuth connection for release generation verified",
        );
      }
    } catch (error) {
      await markStep(context, "ai_connection", "failed", errorMessage(error));
      throw error;
    }
  }
  if (
    answers.enableReleases &&
    !options.skipReleases &&
    (legacyReleaseComplete ||
      ((releaseInfrastructurePending || stepComplete(state, "release_infrastructure")) &&
        (aiConnectionPending ||
          stepComplete(state, "ai_connection") ||
          stepComplete(state, "release_ai"))))
  ) {
    await markStep(
      context,
      "release_automation",
      "complete",
      "GitHub release webhook, encrypted ChatGPT OAuth, and Discord announcement delivery configured",
    );
  }
  if (discord && roadmapToken) {
    await finishDiscordRuntime(context, answers, roadmapToken, state, Boolean(options.repair));
  } else if (runtimePending) {
    throw new Error(
      "Discord is configured, but ROADMAP_TOKEN is required to publish and reconcile it.",
    );
  }

  output(
    context,
    "Setup completed and verified for the selected scope. Run `roadmap doctor` at any time for a complete installation report.",
  );
}

async function gatherAnswers(
  context: CliContext,
  options: SetupOptions,
  state: SetupState,
  resumeData: SetupResumeData,
): Promise<SetupAnswers> {
  const instance = await readJson<any>(path.join(context.root, "roadmap.instance.json"), {});
  const saved = resumeData.setup ?? {};
  const defaults: SetupAnswers = {
    projectName: options.projectName ?? saved.projectName ?? instance.project?.name ?? "SakuraCord",
    slug: options.slug ?? saved.slug ?? instance.project?.slug ?? "sakuracord",
    description:
      options.description ??
      saved.description ??
      instance.project?.description ??
      "Engineering roadmap for a native Swift and SwiftUI macOS Discord client.",
    applicationRepository:
      options.applicationRepository ??
      saved.applicationRepository ??
      instance.project?.applicationRepository ??
      "/Users/super_original/Developer/My Own Projects/SakuraCord",
    publicUrl:
      options.publicUrl ??
      saved.publicUrl ??
      instance.project?.publicUrl ??
      "https://roadmap.sakuracord.app",
    idPrefix: options.idPrefix ?? saved.idPrefix ?? instance.project?.idPrefix ?? "SCR",
    gatewayProvider:
      options.gatewayProvider ??
      saved.gatewayProvider ??
      instance.deployment?.gatewayProvider ??
      "cloudflare",
    initialData: options.initialData ?? saved.initialData ?? "empty",
    ...((options.importFile ?? saved.importFile)
      ? { importFile: options.importFile ?? saved.importFile }
      : {}),
    mcpMode: options.mcpMode ?? saved.mcpMode ?? "local",
    installCodex: saved.installCodex ?? !options.skipCodex,
    enableAi:
      options.skipAi === true
        ? false
        : (saved.enableAi ??
          saved.enableReleases ??
          instance.releases?.enabled ??
          !options.skipDiscord),
    enableReleases:
      options.skipReleases === true
        ? false
        : (saved.enableReleases ?? instance.releases?.enabled ?? false),
    ...((options.githubRepository ?? saved.githubRepository ?? instance.releases?.githubRepository)
      ? {
          githubRepository:
            options.githubRepository ??
            saved.githubRepository ??
            instance.releases?.githubRepository,
        }
      : {}),
    releaseAiModel:
      options.aiModel ??
      options.releaseAiModel ??
      saved.releaseAiModel ??
      instance.releases?.aiModel ??
      "gpt-5.6-sol",
    releaseReasoningEffort:
      options.aiReasoningEffort ??
      options.releaseReasoningEffort ??
      saved.releaseReasoningEffort ??
      instance.releases?.reasoningEffort ??
      "medium",
    primaryColor:
      options.primaryColor ?? saved.primaryColor ?? instance.branding?.primaryColor ?? "#F3A6C8",
    accentColor:
      options.accentColor ?? saved.accentColor ?? instance.branding?.accentColor ?? "#D9578B",
    backgroundColor:
      options.backgroundColor ??
      saved.backgroundColor ??
      instance.branding?.backgroundColor ??
      "#0E0C13",
    logoUrl: options.logoUrl ?? saved.logoUrl ?? instance.branding?.logoUrl ?? "/brand/logo.png",
    iconUrl: options.iconUrl ?? saved.iconUrl ?? instance.branding?.iconUrl ?? "/brand/icon.png",
    ...(options.areas
      ? { areas: parseIds(options.areas) }
      : saved.areas
        ? { areas: saved.areas }
        : {}),
    ...(options.itemTypes
      ? { itemTypes: parseIds(options.itemTypes) }
      : saved.itemTypes
        ? { itemTypes: saved.itemTypes }
        : {}),
    ...(options.lifecycle
      ? { lifecycle: parseIds(options.lifecycle) }
      : saved.lifecycle
        ? { lifecycle: saved.lifecycle }
        : Array.isArray(instance.lifecycle)
          ? { lifecycle: instance.lifecycle.map((value: { id: string }) => value.id) }
          : {}),
    ...(options.lifecycleColors
      ? { lifecycleColors: parseColors(options.lifecycleColors) }
      : saved.lifecycleColors
        ? { lifecycleColors: saved.lifecycleColors }
        : Array.isArray(instance.lifecycle)
          ? { lifecycleColors: instance.lifecycle.map((value: { color: string }) => value.color) }
          : {}),
    ...(options.priorities
      ? { priorities: parseIds(options.priorities) }
      : saved.priorities
        ? { priorities: saved.priorities }
        : Array.isArray(instance.priorities)
          ? { priorities: instance.priorities.map((value: { id: string }) => value.id) }
          : {}),
    ...(options.priorityColors
      ? { priorityColors: parseColors(options.priorityColors) }
      : saved.priorityColors
        ? { priorityColors: saved.priorityColors }
        : Array.isArray(instance.priorities)
          ? { priorityColors: instance.priorities.map((value: { color: string }) => value.color) }
          : {}),
  };
  if (defaults.lifecycle && defaults.lifecycleColors) {
    assertColorCount(defaults.lifecycleColors, defaults.lifecycle.length, "Lifecycle");
  }
  if (defaults.priorities && defaults.priorityColors) {
    assertColorCount(defaults.priorityColors, defaults.priorities.length, "Priority");
  }
  if (defaults.enableReleases && !defaults.enableAi) {
    throw new Error("AI cannot be skipped while release automation is enabled.");
  }
  if (options.nonInteractive) {
    if (
      !stepComplete(state, "project_configuration") &&
      (!options.projectName ||
        !options.slug ||
        !options.description ||
        !options.applicationRepository ||
        !options.publicUrl ||
        !options.idPrefix)
    ) {
      throw new Error(
        "Non-interactive setup requires --project-name, --slug, --description, --application-repository, --public-url, and --id-prefix.",
      );
    }
    return defaults;
  }
  if (stepComplete(state, "project_configuration") && !hasProjectOverrides(options)) {
    output(context, "Resuming setup with the saved project configuration.");
    return defaults;
  }
  const response = await prompts([
    { type: "text", name: "projectName", message: "Project name", initial: defaults.projectName },
    {
      type: "text",
      name: "slug",
      message: "Project slug",
      initial: defaults.slug,
      validate: (value: string) =>
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || "Use lower-case kebab-case.",
    },
    {
      type: "text",
      name: "description",
      message: "Project description",
      initial: defaults.description,
    },
    {
      type: "text",
      name: "applicationRepository",
      message: "Main application repository",
      initial: defaults.applicationRepository,
    },
    {
      type: "text",
      name: "publicUrl",
      message: "Public roadmap URL",
      initial: defaults.publicUrl,
      validate: (value: string) => {
        try {
          new URL(value);
          return true;
        } catch {
          return "Enter an absolute URL.";
        }
      },
    },
    {
      type: "text",
      name: "primaryColor",
      message: "Primary brand color",
      initial: defaults.primaryColor,
      validate: colorValidator,
    },
    {
      type: "text",
      name: "accentColor",
      message: "Accent color",
      initial: defaults.accentColor,
      validate: colorValidator,
    },
    {
      type: "text",
      name: "backgroundColor",
      message: "Background color",
      initial: defaults.backgroundColor,
      validate: colorValidator,
    },
    {
      type: "text",
      name: "logoUrl",
      message: "Public logo URL or path",
      initial: defaults.logoUrl,
    },
    {
      type: "text",
      name: "iconUrl",
      message: "Public icon URL or path",
      initial: defaults.iconUrl,
    },
    {
      type: "text",
      name: "idPrefix",
      message: "Stable item ID prefix",
      initial: defaults.idPrefix,
      validate: (value: string) =>
        /^[A-Z][A-Z0-9]{1,9}$/.test(value) || "Use 2-10 uppercase letters/numbers.",
    },
    {
      type: "select",
      name: "gatewayProvider",
      message: "Discord Gateway provider",
      choices: [
        {
          title: "Cloudflare scheduled reconciliation",
          value: "cloudflare",
        },
        { title: "Disabled", value: "disabled" },
      ],
      initial: defaults.gatewayProvider === "disabled" ? 1 : 0,
    },
    {
      type: "confirm",
      name: "customizeTaxonomy",
      message: "Customize areas, types, lifecycle, and priorities now?",
      initial: false,
    },
    {
      type: (customize: boolean) => (customize ? "text" : null),
      name: "areas",
      message: "Area IDs, comma-separated",
      initial: "product,platform",
    },
    {
      type: (_value: string, answers: Record<string, unknown>) =>
        answers.customizeTaxonomy ? "text" : null,
      name: "itemTypes",
      message: "Item type IDs, comma-separated",
      initial: "feature,bug,performance,refactor,research,infrastructure",
    },
    {
      type: (_value: string, answers: Record<string, unknown>) =>
        answers.customizeTaxonomy ? "text" : null,
      name: "lifecycle",
      message: "Lifecycle state IDs in order, comma-separated",
      initial: defaults.lifecycle?.join(",") ?? DEFAULT_LIFECYCLE_IDS.join(","),
    },
    {
      type: (_value: string, answers: Record<string, unknown>) =>
        answers.customizeTaxonomy ? "text" : null,
      name: "lifecycleColors",
      message: "Lifecycle colors in the same order, comma-separated",
      initial: defaults.lifecycleColors?.join(",") ?? DEFAULT_LIFECYCLE_COLORS.join(","),
      validate: colorListValidator,
    },
    {
      type: (_value: string, answers: Record<string, unknown>) =>
        answers.customizeTaxonomy ? "text" : null,
      name: "priorities",
      message: "Priority IDs, comma-separated",
      initial: defaults.priorities?.join(",") ?? DEFAULT_PRIORITY_IDS.join(","),
    },
    {
      type: (_value: string, answers: Record<string, unknown>) =>
        answers.customizeTaxonomy ? "text" : null,
      name: "priorityColors",
      message: "Priority colors in the same order, comma-separated",
      initial: defaults.priorityColors?.join(",") ?? DEFAULT_PRIORITY_COLORS.join(","),
      validate: colorListValidator,
    },
    {
      type: "select",
      name: "mcpMode",
      message: "MCP operation",
      choices: [
        { title: "Local stdio server", value: "local" },
        { title: "Remote Streamable HTTP endpoint", value: "remote" },
      ],
      initial: defaults.mcpMode === "remote" ? 1 : 0,
    },
    {
      type: "select",
      name: "initialData",
      message: "Initial roadmap data",
      choices: [
        { title: "Start empty", value: "empty" },
        { title: "Import JSON or YAML file", value: "file" },
      ],
      initial: defaults.initialData === "file" ? 1 : 0,
    },
    {
      type: (previous: string) => (previous === "file" ? "text" : null),
      name: "importFile",
      message: "Import file path",
      initial: defaults.importFile,
    },
    {
      type: "confirm",
      name: "installCodex",
      message: "Install the repo-local plugin into Codex?",
      initial: defaults.installCodex,
    },
    {
      type: "confirm",
      name: "enableAi",
      message: "Connect ChatGPT for automatic Discord report analysis?",
      initial: defaults.enableAi,
    },
    {
      type: (_value: boolean, answers: Record<string, unknown>) =>
        answers.enableAi ? "confirm" : null,
      name: "enableReleases",
      message: "Also generate GitHub release notes and Discord announcements?",
      initial: defaults.enableReleases,
    },
    {
      type: (enabled: boolean) => (enabled ? "text" : null),
      name: "githubRepository",
      message: "GitHub release repository (owner/name)",
      initial: defaults.githubRepository,
      validate: (value: string) =>
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || "Use owner/name.",
    },
    {
      type: (_value: string, answers: Record<string, unknown>) =>
        answers.enableAi ? "text" : null,
      name: "releaseAiModel",
      message: "Model for report analysis and release writing",
      initial: defaults.releaseAiModel,
    },
    {
      type: (_value: string, answers: Record<string, unknown>) =>
        answers.enableAi ? "select" : null,
      name: "releaseReasoningEffort",
      message: "Reasoning effort for AI report analysis and release writing",
      choices: [
        { title: "None", value: "none" },
        { title: "Low", value: "low" },
        { title: "Medium", value: "medium" },
        { title: "High", value: "high" },
        { title: "Extra high", value: "xhigh" },
        { title: "Maximum", value: "max" },
      ],
      initial: ["none", "low", "medium", "high", "xhigh", "max"].indexOf(
        defaults.releaseReasoningEffort,
      ),
    },
  ]);
  if (Object.keys(response).length < 10) throw new Error("Setup was interrupted; rerun to resume.");
  const values = response as SetupAnswers & { customizeTaxonomy?: boolean };
  values.enableReleases = Boolean(values.enableReleases);
  values.releaseAiModel ||= defaults.releaseAiModel;
  values.releaseReasoningEffort ||= defaults.releaseReasoningEffort;
  if (!values.customizeTaxonomy) {
    delete values.areas;
    delete values.itemTypes;
    delete values.lifecycle;
    delete values.lifecycleColors;
    delete values.priorities;
    delete values.priorityColors;
  } else {
    values.areas = parseIds(String(values.areas));
    values.itemTypes = parseIds(String(values.itemTypes));
    values.lifecycle = parseIds(String(values.lifecycle));
    values.lifecycleColors = parseColors(
      String(values.lifecycleColors),
      values.lifecycle.length,
      "Lifecycle",
    );
    values.priorities = parseIds(String(values.priorities));
    values.priorityColors = parseColors(
      String(values.priorityColors),
      values.priorities.length,
      "Priority",
    );
  }
  return values;
}

async function configureCloudflare(
  context: CliContext,
  answers: SetupAnswers,
  nonInteractive: boolean,
  requestedAccountId?: string,
  state: SetupState = {},
  repair = false,
): Promise<{ adminToken?: string }> {
  const migrationsCurrent =
    stepComplete(state, "d1_migrations") && state.d1_migrations?.detail.includes("schema 4");
  if (stepComplete(state, "cloudflare_deploy") && migrationsCurrent && !repair) {
    output(context, "✓ Resuming after completed Cloudflare deployment");
    return {};
  }
  const wranglerPath = path.join(context.root, "wrangler.jsonc");
  const wranglerConfig = parseWranglerConfiguration(await readFile(wranglerPath, "utf8"));
  let account: { id: string; name: string };
  if (stepComplete(state, "cloudflare_auth") && !repair) {
    if (typeof wranglerConfig.account_id !== "string" || !wranglerConfig.account_id) {
      throw new Error(
        "Setup recorded Cloudflare authentication as complete, but wrangler.jsonc has no account_id. Rerun with `roadmap setup --repair`.",
      );
    }
    account = { id: wranglerConfig.account_id, name: "configured Cloudflare account" };
    output(context, "✓ Reusing the selected Cloudflare account");
  } else {
    const whoami = await run(context, "npx", ["wrangler", "whoami", "--json"], { reject: false });
    if (whoami.exitCode !== 0) {
      await markStep(
        context,
        "cloudflare_auth",
        "failed",
        "Run `npx wrangler login`, then resume.",
      );
      throw new Error(
        `Cloudflare authentication failed: ${providerFailure(whoami)}. Run \`npx wrangler login\`, then rerun setup.`,
      );
    }
    let identity: {
      loggedIn?: boolean;
      accounts?: Array<{ id: string; name: string }>;
    };
    try {
      identity = JSON.parse(whoami.stdout) as typeof identity;
    } catch {
      throw new Error("Wrangler returned an unreadable identity response. Rerun with --verbose.");
    }
    if (!identity.loggedIn) throw new Error("Wrangler reports that no Cloudflare login is active.");
    account = await selectCloudflareAccount(
      identity.accounts ?? [],
      requestedAccountId ??
        process.env.CLOUDFLARE_ACCOUNT_ID ??
        (typeof wranglerConfig.account_id === "string" ? wranglerConfig.account_id : undefined),
      nonInteractive,
    );
    wranglerConfig.account_id = account.id;
    await markStep(
      context,
      "cloudflare_auth",
      "complete",
      `${account.name} (${account.id}) selected`,
    );
  }
  wranglerConfig.name = `${answers.slug}-roadmap`;
  if (Array.isArray(wranglerConfig.d1_databases) && wranglerConfig.d1_databases[0]) {
    wranglerConfig.d1_databases[0].database_name = `${answers.slug}-roadmap`;
  } else {
    throw new Error("wrangler.jsonc is missing the required DB binding.");
  }
  wranglerConfig.vars = {
    ...(wranglerConfig.vars ?? {}),
    ROADMAP_PUBLIC_URL: answers.publicUrl,
    ROADMAP_ALLOWED_ORIGINS: answers.publicUrl,
    ROADMAP_GATEWAY_PROVIDER: answers.gatewayProvider,
  };
  const publicUrl = new URL(answers.publicUrl);
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("The public roadmap URL must be an origin without a path, query, or fragment.");
  }
  if (
    !["localhost", "127.0.0.1"].includes(publicUrl.hostname) &&
    !publicUrl.hostname.endsWith(".workers.dev")
  ) {
    wranglerConfig.routes = [{ pattern: publicUrl.hostname, custom_domain: true }];
  }
  // Persist account selection before invoking D1 so Wrangler never has to
  // guess between multiple memberships. The account ID is public config.
  await writeFile(wranglerPath, `${JSON.stringify(wranglerConfig, null, 2)}\n`);

  const binding = wranglerConfig.d1_databases[0] as {
    database_id?: string;
    database_name?: string;
  };
  if (
    (!stepComplete(state, "d1_database") || repair) &&
    (!binding.database_id || binding.database_id === "REPLACE_WITH_D1_DATABASE_ID")
  ) {
    const databaseName = `${answers.slug}-roadmap`;
    let databases = await listD1Databases(context);
    let id = databases.find((database) => database.name === databaseName)?.id;
    if (!id) {
      const created = await run(context, "npx", ["wrangler", "d1", "create", databaseName], {
        reject: false,
      });
      id = extractUuid(`${created.stdout}\n${created.stderr}`);
      if (!id) {
        // A timed-out or interrupted create may still have succeeded remotely.
        // Re-list before deciding whether it is safe to retry.
        databases = await listD1Databases(context);
        id = databases.find((database) => database.name === databaseName)?.id;
      }
      if (created.exitCode !== 0 && !id) {
        throw new Error(
          `D1 creation failed for Cloudflare account ${account.name}: ${providerFailure(created)}`,
        );
      }
    }
    if (!id) {
      throw new Error(
        `Cloudflare did not return or list an ID for D1 database ${databaseName}. Rerun with --verbose.`,
      );
    }
    binding.database_id = id;
  }
  await writeFile(wranglerPath, `${JSON.stringify(wranglerConfig, null, 2)}\n`);
  if (!stepComplete(state, "d1_database") || repair) {
    await markStep(context, "d1_database", "complete", "D1 binding configured");
  } else {
    output(context, "✓ Reusing the existing D1 database");
  }
  if (!migrationsCurrent || repair) {
    await run(context, "npx", [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      `${answers.slug}-roadmap`,
      "--remote",
    ]);
    await markStep(
      context,
      "d1_migrations",
      "complete",
      "Remote migrations applied through schema 4",
    );
  } else {
    output(context, "✓ Skipping already-applied D1 migrations");
  }

  let adminToken: string | undefined;
  if (!stepComplete(state, "cloudflare_secrets") || repair) {
    const secretAnswers = nonInteractive
      ? {
          admin: process.env.ROADMAP_ADMIN_TOKEN,
        }
      : await prompts([
          {
            type: "password",
            name: "admin",
            message: "Bootstrap maintainer token (leave blank to generate)",
          },
        ]);
    const configuredAdminToken = secretAnswers.admin || randomBytes(32).toString("base64url");
    adminToken = configuredAdminToken;
    await putSecret(context, "ROADMAP_ADMIN_TOKEN", configuredAdminToken);
    const keychainStored = await storeMaintainerToken(context, answers.slug, configuredAdminToken);
    await markStep(
      context,
      "cloudflare_secrets",
      "complete",
      "Secrets stored in Worker secret storage",
    );
    if (keychainStored) {
      process.stdout.write(
        `Maintainer token saved in macOS Keychain service ${maintainerKeychainService(answers.slug)}.\n`,
      );
    } else {
      process.stdout.write(
        `Save the generated maintainer token in your password manager now: ${adminToken}\n`,
      );
    }
  } else {
    output(context, "✓ Reusing secrets already stored by Cloudflare");
  }
  if (!stepComplete(state, "cloudflare_deploy") || !migrationsCurrent || repair) {
    await deployAndVerify(context, answers.publicUrl);
    await markStep(
      context,
      "cloudflare_deploy",
      "complete",
      "Deployment and health check verified",
    );
  }
  return { ...(adminToken ? { adminToken } : {}) };
}

export async function selectCloudflareAccount(
  accounts: Array<{ id: string; name: string }>,
  requestedAccountId: string | undefined,
  nonInteractive: boolean,
): Promise<{ id: string; name: string }> {
  if (accounts.length === 0) {
    throw new Error("The active Cloudflare login has no accessible accounts.");
  }
  if (requestedAccountId) {
    const selected = accounts.find((account) => account.id === requestedAccountId);
    if (!selected) {
      throw new Error(
        `Cloudflare account ${requestedAccountId} is not available to this login. Available accounts: ${accounts
          .map((account) => `${account.name} (${account.id})`)
          .join(", ")}.`,
      );
    }
    return selected;
  }
  if (accounts.length === 1) return accounts[0]!;
  if (nonInteractive) {
    throw new Error(
      `Multiple Cloudflare accounts are available. Pass --cloudflare-account-id with one of: ${accounts
        .map((account) => `${account.name} (${account.id})`)
        .join(", ")}.`,
    );
  }
  const response = await prompts({
    type: "select",
    name: "accountId",
    message: "Cloudflare account",
    choices: accounts.map((account) => ({
      title: account.name,
      description: account.id,
      value: account.id,
    })),
  });
  if (!response.accountId) {
    throw new Error("Cloudflare account selection was cancelled; no D1 resource was created.");
  }
  return accounts.find((account) => account.id === response.accountId)!;
}

async function listD1Databases(context: CliContext): Promise<Array<{ id: string; name: string }>> {
  const listed = await run(context, "npx", ["wrangler", "d1", "list", "--json"], {
    reject: false,
  });
  if (listed.exitCode !== 0) {
    throw new Error(`Could not list D1 databases: ${providerFailure(listed)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(listed.stdout);
  } catch {
    throw new Error("Wrangler returned unreadable JSON while listing D1 databases.");
  }
  const records = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { result?: unknown }).result)
      ? (payload as { result: unknown[] }).result
      : [];
  return records
    .map((record) => {
      const value = record as { uuid?: unknown; id?: unknown; name?: unknown };
      return {
        id: String(value.uuid ?? value.id ?? ""),
        name: String(value.name ?? ""),
      };
    })
    .filter((database) => database.id && database.name);
}

function extractUuid(value: string): string | undefined {
  return value.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0];
}

function providerFailure(result: { stdout: string; stderr: string }): string {
  return (result.stderr.trim() || result.stdout.trim() || "unknown provider error").slice(0, 2_000);
}

async function deployAndVerify(context: CliContext, publicUrl: string): Promise<void> {
  await run(context, "npm", ["run", "build"]);
  await run(context, "npx", ["wrangler", "deploy"]);
  const healthUrl = `${publicUrl.replace(/\/$/, "")}/healthz`;
  let lastFailure = "no response";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const health = await resilientFetch(healthUrl, {
        headers: { Accept: "application/json" },
      });
      if (health.ok) {
        const payload = (await health.json()) as { ok?: boolean };
        if (payload.ok) return;
        lastFailure = "response did not confirm the migrated schema";
      } else {
        lastFailure = `HTTP ${health.status}`;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `Deployment finished but ${healthUrl} did not become healthy within 60 seconds (${lastFailure}). Check DNS/custom-domain routing and rerun \`roadmap doctor\`.`,
  );
}

export async function finishDiscordRuntime(
  context: CliContext,
  answers: Pick<SetupAnswers, "publicUrl" | "gatewayProvider">,
  roadmapToken: string,
  state: SetupState = {},
  repair = false,
): Promise<void> {
  const api = new CliApiClient(answers.publicUrl, roadmapToken);
  const iconTheme = await loadTagIconTheme(context.root);
  if (!stepComplete(state, "discord_forum_taxonomy") || repair) {
    const icons = await generateTagIconPayloads(iconTheme);
    const configured = await api.post("/api/v1/discord/forums/configure", {
      icons,
      replaceIconKeys: repair ? Object.keys(icons) : [],
    });
    const forums = Array.isArray(configured.data) ? configured.data : [];
    if (forums.length === 0) {
      throw new Error("Discord forum taxonomy provisioning did not return any configured forums.");
    }
    const missingIcons = forums.flatMap(
      (forum: { forumName?: string; tags?: Array<{ name?: string; emojiId?: string | null }> }) =>
        (forum.tags ?? [])
          .filter((tag) => !tag.emojiId)
          .map((tag) => `${forum.forumName ?? "forum"}:${tag.name ?? "unknown"}`),
    );
    if (missingIcons.length > 0) {
      throw new Error(`Discord did not attach generated emoji to: ${missingIcons.join(", ")}.`);
    }
    await markStep(
      context,
      "discord_forum_taxonomy",
      "complete",
      `${forums.length} forums unified with ${Object.keys(icons).length} generated emoji`,
    );
  }
  if (!stepComplete(state, "discord_roadmap_emojis") || repair) {
    const emojis = await generateRoadmapTimelineEmojiPayloads(iconTheme);
    const configured = await api.post("/api/v1/discord/roadmap-emojis/configure", {
      emojis,
      replaceKeys: repair ? Object.keys(emojis) : [],
    });
    const installed = Array.isArray(configured.data) ? configured.data : [];
    if (installed.length !== 2) {
      throw new Error("Discord did not provision both roadmap timeline emojis.");
    }
    await markStep(
      context,
      "discord_roadmap_emojis",
      "complete",
      "Roadmap line and release-point emojis provisioned",
    );
  }
  if (!stepComplete(state, "discord_projection") || repair) {
    const published = await api.post("/api/v1/discord/publish", { force: true });
    if (!published.data?.messageId) {
      throw new Error("Discord roadmap publication did not return a persistent message ID.");
    }
    await markStep(
      context,
      "discord_projection",
      "complete",
      `Roadmap message ${published.data.messageId} published`,
    );
  }

  if (!stepComplete(state, "discord_reconciliation") || repair) {
    const reconciled = await api.post("/api/v1/reconcile");
    const errors = reconciled.data?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(`Discord reconciliation reported errors: ${errors.join("; ")}`);
    }
    await markStep(
      context,
      "discord_reconciliation",
      "complete",
      `Reconciled ${reconciled.data?.threads ?? 0} threads`,
    );
  }

  if (
    answers.gatewayProvider === "cloudflare" &&
    (!stepComplete(state, "discord_gateway") || repair)
  ) {
    await api.post("/api/v1/discord/gateway/start");
    const status = await waitForCloudflareGateway(api);
    await markStep(
      context,
      "discord_gateway",
      "complete",
      status.sessionId
        ? `Cloudflare Gateway connected with session ${status.sessionId}`
        : `Cloudflare Discord synchronization healthy through ${status.provider}`,
    );
  }
}

async function waitForCloudflareGateway(api: CliApiClient): Promise<{
  connected: boolean;
  sessionId?: string;
  healthy: boolean;
  provider: string;
}> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await api.post("/api/v1/discord/gateway/status");
    if (response.data?.connected && response.data?.sessionId) {
      return {
        connected: true,
        sessionId: String(response.data.sessionId),
        healthy: true,
        provider: String(response.data.provider ?? "cloudflare-gateway"),
      };
    }
    if (response.data?.healthy && response.data?.provider) {
      return {
        connected: false,
        healthy: true,
        provider: String(response.data.provider),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Cloudflare Discord synchronization did not become healthy within 20 seconds.");
}

async function putSecret(context: CliContext, name: string, value: string): Promise<void> {
  const result = await run(context, "npx", ["wrangler", "secret", "put", name], {
    input: `${value}\n`,
    stdout: "ignore",
  });
  if (result.exitCode !== 0) throw new Error(`Failed to store ${name}.`);
}

export function parseWranglerConfiguration(text: string): Record<string, any> {
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0 || !value || typeof value !== "object" || Array.isArray(value)) {
    const detail = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new Error(`wrangler.jsonc is invalid${detail ? `: ${detail}` : "."}`);
  }
  return value as Record<string, any>;
}

async function readSetupState(context: CliContext): Promise<SetupState> {
  return readJson<SetupState>(path.join(context.root, ".roadmap/setup-state.json"), {});
}

async function readSetupResumeData(context: CliContext): Promise<SetupResumeData> {
  return readJson<SetupResumeData>(path.join(context.root, ".roadmap/setup-answers.json"), {});
}

async function saveSetupResumeData(context: CliContext, value: SetupResumeData): Promise<void> {
  const file = path.join(context.root, ".roadmap/setup-answers.json");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(file, value);
}

function stepComplete(state: SetupState, step: string): boolean {
  return state[step]?.status === "complete";
}

function completedStepNames(state: SetupState): string[] {
  return Object.entries(state)
    .filter(([, value]) => value.status === "complete")
    .map(([step]) => step);
}

function planEntryComplete(state: SetupState, target: string): boolean {
  if (target === "Cloudflare D1 schema") {
    return Boolean(
      stepComplete(state, "d1_migrations") && state.d1_migrations?.detail.includes("schema 4"),
    );
  }
  if (target === "GitHub release webhook, encrypted ChatGPT OAuth, and Discord announcements") {
    return Boolean(
      stepComplete(state, "release_automation") ||
      (stepComplete(state, "release_infrastructure") && stepComplete(state, "release_ai")),
    );
  }
  if (target === "encrypted ChatGPT OAuth for report analysis") {
    return Boolean(
      (stepComplete(state, "ai_infrastructure") ||
        stepComplete(state, "release_infrastructure") ||
        stepComplete(state, "release_automation")) &&
      (stepComplete(state, "ai_connection") ||
        stepComplete(state, "release_ai") ||
        stepComplete(state, "release_automation")),
    );
  }
  const checkpoints: Record<string, string[]> = {
    "roadmap.instance.json": ["project_configuration"],
    "typed project configuration": ["project_configuration"],
    "Cloudflare account via Wrangler": ["cloudflare_auth"],
    "Cloudflare D1 database": ["d1_database"],
    "Cloudflare D1 schema": ["d1_migrations"],
    "Cloudflare Worker secrets": ["cloudflare_secrets"],
    "Cloudflare Worker": ["cloudflare_deploy"],
    "Discord secrets, application resources, tags, and permissions": ["discord_configuration"],
    "Discord forum taxonomy and color-derived emojis": [
      "discord_forum_taxonomy",
      "discord_roadmap_emojis",
    ],
    "Discord-aware Cloudflare Worker configuration": ["discord_deployment"],
    "Discord channels, active/archive threads, and roadmap/release message permissions": [
      "discord_verification",
    ],
    "Codex plugin and MCP transport": ["mcp_configuration"],
    "Codex local marketplace plugin": ["codex_installation"],
    "initial roadmap data": ["initial_data"],
    "Discord roadmap message, forum state, and selected Gateway": [
      "discord_roadmap_emojis",
      "discord_projection",
      "discord_reconciliation",
      "discord_gateway",
    ],
  };
  const required = checkpoints[target];
  return Boolean(required?.every((step) => stepComplete(state, step)));
}

function hasProjectOverrides(options: SetupOptions): boolean {
  return [
    options.projectName,
    options.slug,
    options.description,
    options.applicationRepository,
    options.publicUrl,
    options.idPrefix,
    options.gatewayProvider,
    options.initialData,
    options.importFile,
    options.mcpMode,
    options.skipAi,
    options.areas,
    options.itemTypes,
    options.lifecycle,
    options.lifecycleColors,
    options.priorities,
    options.priorityColors,
    options.primaryColor,
    options.accentColor,
    options.backgroundColor,
    options.logoUrl,
    options.iconUrl,
    options.githubRepository,
    options.aiModel,
    options.aiReasoningEffort,
    options.releaseAiModel,
    options.releaseReasoningEffort,
    options.discordReleaseChannelId,
  ].some((value) => value !== undefined);
}

async function resumeConfiguredDiscord(
  options: {
    applicationId?: string;
    guildId?: string;
    featureForumId?: string;
    bugForumId?: string;
    roadmapChannelId?: string;
    releaseAnnouncementChannelId?: string;
    updatesRoleId?: string;
    nonInteractive?: boolean;
  },
  requireBotToken: boolean,
): Promise<ConfiguredDiscord> {
  const {
    applicationId,
    guildId,
    featureForumId,
    bugForumId,
    roadmapChannelId,
    releaseAnnouncementChannelId,
    updatesRoleId,
  } = options;
  if (
    !applicationId ||
    !guildId ||
    !featureForumId ||
    !bugForumId ||
    !roadmapChannelId ||
    !releaseAnnouncementChannelId
  ) {
    throw new Error(
      "The Discord checkpoint is complete but its safe setup answers are missing. Rerun `roadmap discord configure` once to repair them.",
    );
  }
  return {
    botToken: requireBotToken
      ? await getDiscordBotToken({ nonInteractive: options.nonInteractive })
      : "",
    applicationId,
    guildId,
    featureForumId,
    bugForumId,
    roadmapChannelId,
    releaseAnnouncementChannelId,
    updatesRoleId: updatesRoleId ?? "",
  };
}

async function promptForExistingAdminToken(
  context: CliContext,
  slug: string,
  nonInteractive: boolean,
): Promise<string> {
  const saved = await readMaintainerToken(context, slug);
  if (saved) return saved;
  if (nonInteractive) {
    throw new Error(
      `ROADMAP_TOKEN or macOS Keychain service ${maintainerKeychainService(slug)} is required to resume post-deployment setup in non-interactive mode.`,
    );
  }
  const response = await prompts({
    type: "password",
    name: "token",
    message: "Saved maintainer token",
    validate: (value: string) =>
      value.length >= 20 || "Paste the token saved during Cloudflare setup.",
  });
  if (!response.token) {
    throw new Error(
      "The saved maintainer token is required to publish and reconcile Discord. It is never written to project files.",
    );
  }
  return String(response.token);
}

async function storeMaintainerToken(
  context: CliContext,
  slug: string,
  token: string,
): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const result = await run(
    context,
    "/bin/sh",
    [
      "-c",
      'exec /usr/bin/security add-generic-password -U -a "$USER" -s "$ROADMAP_KEYCHAIN_SERVICE" -w "$ROADMAP_KEYCHAIN_TOKEN"',
    ],
    {
      env: {
        ...process.env,
        ROADMAP_KEYCHAIN_SERVICE: maintainerKeychainService(slug),
        ROADMAP_KEYCHAIN_TOKEN: token,
      },
      reject: false,
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  return result.exitCode === 0;
}

async function readMaintainerToken(context: CliContext, slug: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const result = await run(
    context,
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", maintainerKeychainService(slug)],
    { reject: false, stderr: "ignore" },
  );
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

function maintainerKeychainService(slug: string): string {
  return `dev.${slug}.roadmap-maintainer`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

async function markStep(
  context: CliContext,
  step: string,
  status: "complete" | "failed",
  detail: string,
) {
  const file = path.join(context.root, ".roadmap/setup-state.json");
  const state = await readJson<Record<string, unknown>>(file, {});
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(file, {
    ...state,
    [step]: { status, detail, updatedAt: new Date().toISOString() },
  });
}

function renderPlan(
  plan: Array<{ action: string; target: string; external: boolean }>,
  state: SetupState,
  resuming: boolean,
): string {
  return [
    resuming
      ? `Resuming setup (${completedStepNames(state).length} completed checkpoints will be skipped):`
      : "Setup plan:",
    ...(resuming
      ? completedStepNames(state).map((step) => `  ✓ ${step.replaceAll("_", " ")}`)
      : []),
    resuming ? "Remaining setup plan:" : "",
    ...plan.map(
      (step, index) =>
        `  ${index + 1}. ${step.action} ${step.target}${step.external ? " (external change)" : ""}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

const palette = ["#F3A6C8", "#D9578B", "#60A5FA", "#34D399", "#F59E0B", "#F87171", "#94A3B8"];
const DEFAULT_LIFECYCLE_IDS = [
  "planned",
  "in_progress",
  "polishing",
  "declined",
  "duplicate",
  "done",
];
const DEFAULT_LIFECYCLE_COLORS = ["#60A5FA", "#A78BFA", "#F3A6C8", "#F87171", "#F59E0B", "#34D399"];
const DEFAULT_PRIORITY_IDS = ["critical", "high", "medium", "low"];
const DEFAULT_PRIORITY_COLORS = ["#EF4444", "#F97316", "#EAB308", "#22C55E"];

function parseIds(value: string): string[] {
  const ids = value
    .split(",")
    .map((part) =>
      part
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_"),
    )
    .filter(Boolean);
  if (!ids.length || new Set(ids).size !== ids.length) {
    throw new Error("Taxonomy IDs must be a non-empty unique comma-separated list.");
  }
  return ids;
}

function makeOptions(ids: string[], colors?: string[]) {
  return ids.map((id, index) => ({
    id,
    label: id
      .split("_")
      .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
      .join(" "),
    color: colors?.[index] ?? palette[index % palette.length],
  }));
}

function makeLifecycle(ids: string[], colors?: string[]) {
  return makeOptions(ids, colors).map((option, index) => ({
    ...option,
    terminal: index === ids.length - 1,
    completionGate: index === ids.length - 1,
    transitionsTo: [
      ...(index > 0 ? [ids[index - 1]!] : []),
      ...(index < ids.length - 1 ? [ids[index + 1]!] : []),
    ],
  }));
}

function colorValidator(value: string): true | string {
  return /^#[0-9A-Fa-f]{6}$/.test(value) || "Use a six-digit hexadecimal color such as #D9578B.";
}

function colorListValidator(value: string): true | string {
  try {
    parseColors(value);
    return true;
  } catch (error) {
    return error instanceof Error ? error.message : "Enter comma-separated six-digit hex colors.";
  }
}

function parseColors(value: string, expected?: number, label = "Taxonomy"): string[] {
  const colors = value
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  if (!colors.length || colors.some((color) => !/^#[0-9A-F]{6}$/.test(color))) {
    throw new Error(`${label} colors must be comma-separated six-digit hex values.`);
  }
  assertColorCount(colors, expected, label);
  return colors;
}

function assertColorCount(colors: string[], expected?: number, label = "Taxonomy"): void {
  if (expected !== undefined && colors.length !== expected) {
    throw new Error(`${label} requires ${expected} colors, one for each configured ID.`);
  }
}
