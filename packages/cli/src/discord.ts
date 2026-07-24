import path from "node:path";
import prompts from "prompts";
import {
  deepMerge,
  output,
  readJson,
  redacted,
  run,
  writeJsonAtomic,
  type CliContext,
} from "./context.js";
import { resilientFetch } from "./network.js";

const DISCORD_API = "https://discord.com/api/v10";
const REQUIRED_TAGS = [
  "Inbox",
  "Planned",
  "In Progress",
  "Polishing",
  "Done",
  "Declined",
  "Duplicate",
];

export interface DiscordOptions {
  botToken?: string;
  applicationId?: string;
  publicKey?: string;
  guildId?: string;
  featureForumId?: string;
  bugForumId?: string;
  roadmapChannelId?: string;
  releaseAnnouncementChannelId?: string;
  updatesRoleId?: string;
  publicUrl?: string;
  tokenEnv?: string;
  storeSecret?: boolean;
  createMissingTags?: boolean;
  nonInteractive?: boolean;
  maintainerRoleIds?: string;
  onAnswers?: (answers: DiscordSetupAnswers) => Promise<void>;
}

export interface DiscordSetupAnswers {
  applicationId: string;
  publicKey: string;
  guildId: string;
  featureForumId: string;
  bugForumId: string;
  roadmapChannelId: string;
  releaseAnnouncementChannelId: string;
  updatesRoleId: string;
  publicUrl: string;
  maintainerRoleIds: string;
}

export interface ConfiguredDiscord {
  botToken: string;
  applicationId: string;
  guildId: string;
  featureForumId: string;
  bugForumId: string;
  roadmapChannelId: string;
  releaseAnnouncementChannelId: string;
  updatesRoleId: string;
}

interface DiscordChannel {
  id: string;
  type: number;
  name: string;
  available_tags?: Array<{
    id: string;
    name: string;
    moderated: boolean;
    emoji_id?: string | null;
    emoji_name?: string | null;
  }>;
}

interface DiscordRole {
  id: string;
  name: string;
  position: number;
  permissions: string;
  managed: boolean;
  mentionable: boolean;
}

export async function configureDiscord(
  context: CliContext,
  options: DiscordOptions,
): Promise<ConfiguredDiscord> {
  const answers = await getDiscordAnswers(options);
  await options.onAnswers?.(answers);
  const token = await getDiscordBotToken(options);
  const current = await discordRequest<{ id: string; username: string }>("/users/@me", token);
  const application = await discordRequest<{ id: string; verify_key: string }>(
    "/oauth2/applications/@me",
    token,
  );
  if (current.id !== answers.applicationId) {
    throw new Error(
      `Bot user ${current.id} does not match application ID ${answers.applicationId}. No changes were made.`,
    );
  }
  if (application.id !== answers.applicationId) {
    throw new Error(
      `Bot application ${application.id} does not match application ID ${answers.applicationId}. No changes were made.`,
    );
  }
  if (application.verify_key.toLowerCase() !== answers.publicKey.trim().toLowerCase()) {
    throw new Error(
      "The Discord public key does not match this bot application. Copy the Public Key from General Information and rerun setup.",
    );
  }
  const guild = await discordRequest<{ id: string; name: string }>(
    `/guilds/${answers.guildId}`,
    token,
  );
  const featureForum = await validateChannel(answers.featureForumId, 15, token);
  const bugForum = await validateChannel(answers.bugForumId, 15, token);
  const roadmapChannel = await validateChannel(answers.roadmapChannelId, 0, token);
  const releaseAnnouncementChannel = await validateChannel(
    answers.releaseAnnouncementChannelId,
    0,
    token,
  );
  const updatesRole = await validateUpdatesRole(
    answers.guildId,
    answers.updatesRoleId,
    current.id,
    token,
  );
  const featureMappings = await mapOrCreateTags(
    featureForum,
    token,
    Boolean(options.createMissingTags),
  );
  const bugMappings = await mapOrCreateTags(bugForum, token, Boolean(options.createMissingTags));
  const mappings = {
    ...Object.fromEntries(
      Object.entries(featureMappings).map(([status, id]) => [`${featureForum.id}:${status}`, id]),
    ),
    ...Object.fromEntries(
      Object.entries(bugMappings).map(([status, id]) => [`${bugForum.id}:${status}`, id]),
    ),
  };
  const maintainerRoleIds = answers.maintainerRoleIds
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    maintainerRoleIds.length === 0 ||
    maintainerRoleIds.some((value) => !/^\d{17,20}$/.test(value))
  ) {
    throw new Error("At least one valid maintainer role ID is required.");
  }

  const endpoint = `${answers.publicUrl.replace(/\/$/, "")}/interactions/discord`;
  // Discord validates a new interaction endpoint immediately. The deployed
  // Worker must have the verification key at every edge before that request.
  if (options.storeSecret) {
    await putWorkerSecret(context, "DISCORD_BOT_TOKEN", token);
    await putWorkerSecret(context, "DISCORD_APPLICATION_ID", answers.applicationId);
    await putWorkerSecret(context, "DISCORD_PUBLIC_KEY", answers.publicKey);
    await waitForDiscordInteractionEndpoint(endpoint);
  }

  await discordRequest("/applications/@me", token, {
    method: "PATCH",
    body: { interactions_endpoint_url: endpoint },
  });
  await discordRequest(
    `/applications/${answers.applicationId}/guilds/${answers.guildId}/commands`,
    token,
    {
      method: "PUT",
      body: [
        {
          name: "roadmap",
          description: "Open the public engineering roadmap",
          type: 1,
          dm_permission: false,
        },
      ],
    },
  );
  const instancePath = path.join(context.root, "roadmap.instance.json");
  const existing = await readJson<Record<string, unknown>>(instancePath, {});
  await writeJsonAtomic(
    instancePath,
    deepMerge(existing, {
      discord: {
        guildId: answers.guildId,
        featureRequestsForumId: answers.featureForumId,
        bugReportsForumId: answers.bugForumId,
        roadmapChannelId: answers.roadmapChannelId,
        updatesRoleId: answers.updatesRoleId,
        releaseAnnouncementChannelId: answers.releaseAnnouncementChannelId,
        maintainerRoleIds,
        statusTagMappings: mappings,
      },
    }),
  );
  output(context, {
    verifiedBot: `${current.username} (${current.id})`,
    guild: `${guild.name} (${guild.id})`,
    featureForum: `${featureForum.name} (${featureForum.id})`,
    bugForum: `${bugForum.name} (${bugForum.id})`,
    roadmapChannel: `${roadmapChannel.name} (${roadmapChannel.id})`,
    releaseAnnouncementChannel: `${releaseAnnouncementChannel.name} (${releaseAnnouncementChannel.id})`,
    updatesRole: `${updatesRole.name} (${updatesRole.id})`,
    interactionsEndpoint: endpoint,
    statusTagMappings: mappings,
    inviteUrl: botInviteUrl(answers.applicationId, Boolean(options.createMissingTags)),
    storedToken: options.storeSecret ? redacted(token) : "not stored",
  });
  return {
    botToken: token,
    applicationId: answers.applicationId,
    guildId: answers.guildId,
    featureForumId: answers.featureForumId,
    bugForumId: answers.bugForumId,
    roadmapChannelId: answers.roadmapChannelId,
    releaseAnnouncementChannelId: answers.releaseAnnouncementChannelId,
    updatesRoleId: answers.updatesRoleId,
  };
}

export async function waitForDiscordInteractionEndpoint(
  endpoint: string,
  attempts = 30,
): Promise<void> {
  let lastFailure = "no response";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await resilientFetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ type: 1 }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      if (response.status === 401 && payload.error?.code === "INVALID_SIGNATURE") return;
      lastFailure = `HTTP ${response.status}${payload.error?.code ? ` ${payload.error.code}` : ""}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new Error(
    `Discord interaction endpoint did not observe the deployed public-key secret within ${attempts * 2} seconds (${lastFailure}).`,
  );
}

export async function verifyDiscord(
  context: CliContext,
  options: DiscordOptions & { writeTest?: boolean; roadmapToken?: string },
): Promise<void> {
  const token = await getDiscordBotToken(options);
  const config = await readJson<any>(path.join(context.root, "roadmap.instance.json"), {});
  const discord = config.discord ?? {};
  const applicationId = options.applicationId ?? process.env.DISCORD_APPLICATION_ID;
  const guildId = options.guildId ?? discord.guildId;
  const featureForumId = options.featureForumId ?? discord.featureRequestsForumId;
  const bugForumId = options.bugForumId ?? discord.bugReportsForumId;
  const roadmapChannelId = options.roadmapChannelId ?? discord.roadmapChannelId;
  const releaseAnnouncementChannelId =
    options.releaseAnnouncementChannelId ?? discord.releaseAnnouncementChannelId;
  const updatesRoleId = options.updatesRoleId ?? discord.updatesRoleId;
  if (
    !applicationId ||
    !guildId ||
    !featureForumId ||
    !bugForumId ||
    !roadmapChannelId ||
    !releaseAnnouncementChannelId ||
    !updatesRoleId
  ) {
    throw new Error("Discord IDs are incomplete. Run `roadmap discord configure` first.");
  }
  const me = await discordRequest<{ id: string; username: string }>("/users/@me", token);
  if (me.id !== applicationId)
    throw new Error("Configured application ID does not match bot token.");
  const updatesRole = await validateUpdatesRole(guildId, updatesRoleId, me.id, token);
  const channels = await Promise.all([
    validateChannel(featureForumId, 15, token),
    validateChannel(bugForumId, 15, token),
    validateChannel(roadmapChannelId, 0, token),
    ...(releaseAnnouncementChannelId === roadmapChannelId
      ? []
      : [validateChannel(releaseAnnouncementChannelId, 0, token)]),
  ]);
  const active = await discordRequest<{ threads: unknown[] }>(
    `/guilds/${guildId}/threads/active`,
    token,
  );
  await discordRequest(`/channels/${featureForumId}/threads/archived/public?limit=2`, token);
  await discordRequest(`/channels/${bugForumId}/threads/archived/public?limit=2`, token);
  let writeResult = "not requested";
  if (options.writeTest) {
    const results: string[] = [];
    for (const channelId of new Set([roadmapChannelId, releaseAnnouncementChannelId])) {
      const created = await discordRequest<{ id: string }>(
        `/channels/${channelId}/messages`,
        token,
        {
          method: "POST",
          body: {
            content: "Roadmap setup permission test — this message will be deleted immediately.",
            allowed_mentions: { parse: [] },
          },
        },
      );
      await discordRequest(`/channels/${channelId}/messages/${created.id}`, token, {
        method: "DELETE",
      });
      results.push(`channel ${channelId}: message ${created.id} created and deleted`);
    }
    writeResult = results.join("; ");
  }
  output(context, {
    bot: `${me.username} (${me.id})`,
    channels: channels.map(({ id, name, type }) => ({ id, name, type })),
    activeThreadsVisible: active.threads.length,
    archivedThreadPagination: "verified",
    writeTest: writeResult,
    updatesRole: `${updatesRole.name} (${updatesRole.id})`,
    requiredIntents: ["GUILDS", "GUILD_MESSAGES", "GUILD_MESSAGE_REACTIONS", "MESSAGE_CONTENT"],
    requiredPermissions: [
      "VIEW_CHANNEL",
      "SEND_MESSAGES",
      "SEND_MESSAGES_IN_THREADS",
      "READ_MESSAGE_HISTORY",
      "ADD_REACTIONS",
      "MANAGE_THREADS",
      "MANAGE_GUILD_EXPRESSIONS",
      "MANAGE_ROLES",
      "MENTION_EVERYONE",
      "USE_APPLICATION_COMMANDS",
      ...(options.createMissingTags ? ["MANAGE_CHANNELS"] : []),
    ],
  });
}

async function getDiscordAnswers(options: DiscordOptions): Promise<DiscordSetupAnswers> {
  const defaults = {
    applicationId: options.applicationId ?? process.env.DISCORD_APPLICATION_ID ?? "",
    publicKey: options.publicKey ?? process.env.DISCORD_PUBLIC_KEY ?? "",
    guildId: options.guildId ?? "",
    featureForumId: options.featureForumId ?? "",
    bugForumId: options.bugForumId ?? "",
    roadmapChannelId: options.roadmapChannelId ?? "",
    releaseAnnouncementChannelId: options.releaseAnnouncementChannelId ?? "",
    updatesRoleId: options.updatesRoleId ?? "",
    publicUrl: options.publicUrl ?? process.env.ROADMAP_PUBLIC_URL ?? "",
    maintainerRoleIds: options.maintainerRoleIds ?? "",
  };
  if (Object.values(defaults).every((value) => value)) return defaults;
  if (options.nonInteractive) {
    if (Object.values(defaults).some((value) => !value)) {
      throw new Error(
        "Non-interactive Discord configuration requires every ID, public key, and URL flag.",
      );
    }
    return defaults;
  }
  const response = await prompts(
    Object.entries(defaults).map(([name, initial]) => ({
      type: "text",
      name,
      message: humanize(name),
      initial,
      validate: (value: string) => value.trim().length > 0 || "Required",
    })),
  );
  if (Object.keys(response).length !== Object.keys(defaults).length) {
    throw new Error(
      "Discord configuration was interrupted before any project configuration was written.",
    );
  }
  return response as DiscordSetupAnswers;
}

export async function getDiscordBotToken(options: DiscordOptions): Promise<string> {
  if (options.botToken) return options.botToken;
  const envName = options.tokenEnv ?? "DISCORD_BOT_TOKEN";
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  if (options.nonInteractive) throw new Error(`${envName} must be set for non-interactive use.`);
  const response = await prompts({
    type: "password",
    name: "token",
    message: "Discord bot token (never written to project files)",
    validate: (value: string) => value.length >= 20 || "Token is too short.",
  });
  if (!response.token) throw new Error("A bot token is required.");
  return response.token as string;
}

async function validateChannel(
  id: string,
  expectedType: number,
  token: string,
): Promise<DiscordChannel> {
  const channel = await discordRequest<DiscordChannel>(`/channels/${id}`, token);
  if (channel.type !== expectedType) {
    throw new Error(
      `Discord channel ${id} (${channel.name}) has type ${channel.type}; expected ${expectedType}.`,
    );
  }
  return channel;
}

async function mapOrCreateTags(
  forum: DiscordChannel,
  token: string,
  createMissing: boolean,
): Promise<Record<string, string>> {
  let tags = forum.available_tags ?? [];
  const missing = REQUIRED_TAGS.filter(
    (required) => !tags.some((tag) => tag.name.toLowerCase() === required.toLowerCase()),
  );
  if (missing.length && !createMissing) {
    throw new Error(
      `${forum.name} is missing status tags: ${missing.join(", ")}. Create them or rerun with --create-missing-tags (requires MANAGE_CHANNELS).`,
    );
  }
  if (missing.length) {
    const updated = await discordRequest<DiscordChannel>(`/channels/${forum.id}`, token, {
      method: "PATCH",
      auditReason: "Create roadmap status tags",
      body: {
        available_tags: [...tags, ...missing.map((name) => ({ name, moderated: true }))],
      },
    });
    tags = updated.available_tags ?? [];
  }
  return Object.fromEntries(
    REQUIRED_TAGS.map((label) => {
      const tag = tags.find((candidate) => candidate.name.toLowerCase() === label.toLowerCase());
      if (!tag) throw new Error(`Discord did not return the required ${label} tag after update.`);
      return [toStatusId(label), tag.id];
    }),
  );
}

async function putWorkerSecret(context: CliContext, name: string, value: string): Promise<void> {
  const result = await run(context, "npx", ["wrangler", "secret", "put", name], {
    input: `${value}\n`,
    stdout: "ignore",
  });
  if (result.exitCode !== 0) throw new Error(`Failed to store ${name} in Cloudflare.`);
}

async function discordRequest<T = unknown>(
  path: string,
  token: string,
  options: {
    method?: string;
    body?: unknown;
    auditReason?: string;
  } = {},
): Promise<T> {
  const response = await fetch(`${DISCORD_API}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...(options.auditReason
        ? { "X-Audit-Log-Reason": encodeURIComponent(options.auditReason) }
        : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Discord ${options.method ?? "GET"} ${path} returned ${response.status}: ${detail.slice(0, 1_000)}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function botInviteUrl(applicationId: string, includeManageChannels = false): string {
  const permissions =
    1024n | // VIEW_CHANNEL
    64n | // ADD_REACTIONS
    2048n | // SEND_MESSAGES
    65536n | // READ_MESSAGE_HISTORY
    (1n << 31n) | // USE_APPLICATION_COMMANDS
    (1n << 34n) | // MANAGE_THREADS
    (1n << 38n) | // SEND_MESSAGES_IN_THREADS
    (1n << 30n) | // MANAGE_GUILD_EXPRESSIONS for custom tag emoji
    (1n << 28n) | // MANAGE_ROLES for the updates subscription
    (1n << 17n) | // MENTION_EVERYONE to notify a non-mentionable updates role
    (includeManageChannels ? 1n << 4n : 0n); // MANAGE_CHANNELS for setup tag creation
  const query = new URLSearchParams({
    client_id: applicationId,
    scope: "bot applications.commands",
    permissions: permissions.toString(),
    integration_type: "0",
  });
  return `https://discord.com/oauth2/authorize?${query}`;
}

export async function verifyUpdatesRoleConfiguration(
  guildId: string,
  roleId: string,
  botToken: string,
): Promise<{ bot: string; role: string }> {
  const bot = await discordRequest<{ id: string; username: string }>("/users/@me", botToken);
  const role = await validateUpdatesRole(guildId, roleId, bot.id, botToken);
  return {
    bot: `${bot.username} (${bot.id})`,
    role: `${role.name} (${role.id})`,
  };
}

async function validateUpdatesRole(
  guildId: string,
  roleId: string,
  botId: string,
  token: string,
): Promise<DiscordRole> {
  if (!/^\d{17,20}$/.test(roleId)) throw new Error("A valid updates role ID is required.");
  const [roles, member] = await Promise.all([
    discordRequest<DiscordRole[]>(`/guilds/${guildId}/roles`, token),
    discordRequest<{ roles: string[] }>(`/guilds/${guildId}/members/${botId}`, token),
  ]);
  const role = roles.find((candidate) => candidate.id === roleId);
  if (!role)
    throw new Error(`Discord updates role ${roleId} does not exist in the selected guild.`);
  if (role.managed || role.id === guildId) {
    throw new Error(`Discord role ${role.name} cannot be assigned by a bot.`);
  }
  const botRoles = roles.filter(
    (candidate) => candidate.id === guildId || member.roles.includes(candidate.id),
  );
  const highest = botRoles
    .filter((candidate) => candidate.id !== guildId)
    .sort((left, right) => right.position - left.position)[0];
  const permissions = botRoles.reduce(
    (combined, candidate) => combined | BigInt(candidate.permissions),
    0n,
  );
  const canManageRoles = Boolean(permissions & (1n << 28n) || permissions & (1n << 3n));
  const canMentionRole =
    role.mentionable || Boolean(permissions & (1n << 17n) || permissions & (1n << 3n));
  if (!canManageRoles) {
    throw new Error(
      "The bot does not have MANAGE_ROLES. Reinstall it using the generated invitation URL.",
    );
  }
  if (!highest || highest.position <= role.position) {
    throw new Error(
      `Move the bot's role above ${role.name} in Server Settings → Roles, then rerun setup.`,
    );
  }
  if (!canMentionRole) {
    throw new Error(
      "The updates role is not mentionable and the bot lacks MENTION_EVERYONE. Reinstall it using the generated invitation URL.",
    );
  }
  return role;
}

function toStatusId(label: string): string {
  return label.toLowerCase().replaceAll(" ", "_");
}

function humanize(value: string): string {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (first) => first.toUpperCase());
}
