import { randomBytes } from "node:crypto";
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
import { getDiscordBotToken, verifyUpdatesRoleConfiguration } from "./discord.js";
import { CODEX_OAUTH_REDIRECT_URI, startLocalOAuthCallbackServer } from "./oauth-callback.js";

const GITHUB_API = "https://api.github.com";

export interface ReleaseConfigureOptions {
  repository?: string;
  apiUrl?: string;
  roadmapToken?: string;
  githubToken?: string;
  githubTokenEnv?: string;
  updatesRoleId?: string;
  channelId?: string;
  aiModel?: string;
  reasoningEffort?: string;
  skipAiInfrastructure?: boolean;
  skipAiConnect?: boolean;
  skipDeploy?: boolean;
  nonInteractive?: boolean;
}

export async function configureReleaseAutomation(
  context: CliContext,
  options: ReleaseConfigureOptions,
): Promise<void> {
  const instancePath = path.join(context.root, "roadmap.instance.json");
  const instance = await readJson<any>(instancePath, {});
  const repository =
    options.repository ??
    instance.releases?.githubRepository ??
    (await discoverGithubRepository(context, instance.project?.applicationRepository));
  const apiUrl = options.apiUrl ?? process.env.ROADMAP_API_URL ?? instance.project?.publicUrl;
  const updatesRoleId = options.updatesRoleId ?? instance.discord?.updatesRoleId;
  const channelId =
    options.channelId ??
    instance.discord?.releaseAnnouncementChannelId ??
    instance.discord?.roadmapChannelId;
  const aiModel = options.aiModel ?? instance.releases?.aiModel ?? "gpt-5.6-sol";
  const reasoningEffort = options.reasoningEffort ?? instance.releases?.reasoningEffort ?? "medium";
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Release setup requires a GitHub repository in owner/name form.");
  }
  if (!apiUrl) throw new Error("Release setup requires the deployed public roadmap URL.");
  if (!updatesRoleId || !/^\d{17,20}$/.test(updatesRoleId)) {
    throw new Error("Release setup requires a valid Discord updates role ID.");
  }
  if (!channelId || !/^\d{17,20}$/.test(channelId)) {
    throw new Error("Release setup requires a valid Discord announcement channel ID.");
  }
  const guildId = instance.discord?.guildId;
  if (!guildId || !/^\d{17,20}$/.test(guildId)) {
    throw new Error("Release setup requires a configured Discord guild.");
  }

  const githubToken = await getSecret(
    options.githubToken,
    options.githubTokenEnv ?? "GITHUB_RELEASE_TOKEN",
    "GitHub fine-grained token (Contents write, Webhooks write)",
    Boolean(options.nonInteractive),
  );
  const roadmapToken =
    options.roadmapToken ??
    process.env.ROADMAP_TOKEN ??
    process.env.ROADMAP_ADMIN_TOKEN ??
    (await promptForRoadmapToken(Boolean(options.nonInteractive)));
  const discordToken = await getDiscordBotToken({
    nonInteractive: options.nonInteractive,
  });
  const roleVerification = await verifyUpdatesRoleConfiguration(
    guildId,
    updatesRoleId,
    discordToken,
  );
  const repositoryInfo = await githubRequest<{
    full_name: string;
    permissions?: { admin?: boolean };
  }>(`/repos/${repository}`, githubToken);
  if (repositoryInfo.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`GitHub resolved ${repository} as ${repositoryInfo.full_name}.`);
  }

  await writeJsonAtomic(
    instancePath,
    deepMerge(instance, {
      discord: {
        updatesRoleId,
        releaseAnnouncementChannelId: channelId,
      },
      releases: {
        enabled: true,
        githubRepository: repositoryInfo.full_name,
        aiModel,
        reasoningEffort,
        maxCommits: instance.releases?.maxCommits ?? 2_000,
      },
    }),
  );

  const webhookSecret = randomBytes(32).toString("base64url");
  await putWorkerSecret(context, "GITHUB_RELEASE_TOKEN", githubToken);
  await putWorkerSecret(context, "GITHUB_WEBHOOK_SECRET", webhookSecret);
  if (!options.skipAiInfrastructure) {
    await configureAiInfrastructure(context, { apiUrl, skipDeploy: true });
  }
  const database =
    instance.deployment?.d1DatabaseName ?? `${instance.project?.slug ?? "project"}-roadmap`;
  await run(context, "npx", ["wrangler", "d1", "migrations", "apply", database, "--remote"]);
  if (!options.skipDeploy) {
    await run(context, "npx", ["wrangler", "deploy"]);
    await waitForHealth(apiUrl);
  }

  const webhookUrl = `${apiUrl.replace(/\/$/, "")}/webhooks/github`;
  const hook = await upsertReleaseWebhook(
    repositoryInfo.full_name,
    githubToken,
    webhookUrl,
    webhookSecret,
  );
  if (!options.skipAiConnect) {
    await connectReleaseAi(context, {
      apiUrl,
      roadmapToken,
      nonInteractive: options.nonInteractive,
    });
  }
  output(context, {
    repository: repositoryInfo.full_name,
    webhook: `${webhookUrl} (${hook.created ? "created" : "updated"})`,
    updatesRoleId,
    announcementChannelId: channelId,
    verifiedSubscriptionRole: roleVerification,
    aiModel,
    reasoningEffort,
    githubToken: redacted(githubToken),
    status: options.skipAiConnect
      ? "Release infrastructure configured and verified; ChatGPT connection remains."
      : "Release automation configured and verified.",
  });
}

export async function configureAiInfrastructure(
  context: CliContext,
  options: { apiUrl: string; skipDeploy?: boolean },
): Promise<void> {
  const encryptionKey = randomBytes(32).toString("base64url");
  await putWorkerSecret(context, "ROADMAP_OAUTH_ENCRYPTION_KEY", encryptionKey);
  if (!options.skipDeploy) {
    await run(context, "npx", ["wrangler", "deploy"]);
    await waitForHealth(options.apiUrl);
  }
  output(context, {
    aiCredentialEncryption: "AES-256-GCM key stored as a Worker secret",
    deployment: options.skipDeploy ? "deferred to the next setup deployment" : "verified",
  });
}

export async function connectReleaseAi(
  context: CliContext,
  options: { apiUrl?: string; roadmapToken?: string; nonInteractive?: boolean },
): Promise<void> {
  const instance = await readJson<any>(path.join(context.root, "roadmap.instance.json"), {});
  const apiUrl = options.apiUrl ?? process.env.ROADMAP_API_URL ?? instance.project?.publicUrl;
  const roadmapToken =
    options.roadmapToken ??
    process.env.ROADMAP_TOKEN ??
    process.env.ROADMAP_ADMIN_TOKEN ??
    (await promptForRoadmapToken(Boolean(options.nonInteractive)));
  if (!apiUrl) throw new Error("The deployed roadmap URL is required.");

  const existing = await roadmapRequest<{ connected: boolean }>(
    apiUrl,
    "/api/v1/ai/oauth/status",
    roadmapToken,
  );
  if (existing.connected) {
    output(context, "ChatGPT is already connected for release generation.");
    return;
  }
  if (options.nonInteractive) {
    throw new Error(
      "ChatGPT OAuth needs an interactive browser once. Run `roadmap releases connect-ai` before non-interactive setup.",
    );
  }
  const callbackServer = await startLocalOAuthCallbackServer();
  try {
    const started = await roadmapRequest<{ authorizationUrl: string; expiresAt: string }>(
      apiUrl,
      "/api/v1/ai/oauth/start",
      roadmapToken,
      "POST",
    );
    const authorization = new URL(started.authorizationUrl);
    const state = authorization.searchParams.get("state");
    const redirectUri = authorization.searchParams.get("redirect_uri");
    if (
      authorization.origin !== "https://auth.openai.com" ||
      !state ||
      redirectUri !== CODEX_OAUTH_REDIRECT_URI
    ) {
      throw new Error(
        "The roadmap service returned an invalid ChatGPT authorization request. Redeploy the latest Worker and retry.",
      );
    }
    callbackServer.expectState(state);
    output(
      context,
      `Opening ChatGPT authorization. The browser will return to the temporary local callback at ${CODEX_OAUTH_REDIRECT_URI}.\n${started.authorizationUrl}`,
    );
    if (process.platform === "darwin") {
      await run(context, "open", [started.authorizationUrl], { reject: false });
    }
    const deadline = Math.min(Date.parse(started.expiresAt), Date.now() + 10 * 60_000);
    const callback = await callbackServer.waitForCallback(deadline);
    try {
      await roadmapRequest<{ accountIdHash: string }>(
        apiUrl,
        "/api/v1/ai/oauth/complete",
        roadmapToken,
        "POST",
        callback,
      );
      callbackServer.completeBrowser();
    } catch (error) {
      const message = error instanceof Error ? error.message : "The roadmap service rejected it.";
      callbackServer.failBrowser(message);
      throw error;
    }
    const status = await roadmapRequest<{ connected: boolean; accountIdHash?: string }>(
      apiUrl,
      "/api/v1/ai/oauth/status",
      roadmapToken,
    );
    if (!status.connected) {
      throw new Error("ChatGPT authorization completed, but the encrypted session was not saved.");
    }
    output(context, {
      connected: true,
      account: status.accountIdHash,
      credentialStorage: "AES-256-GCM encrypted in D1; encryption key stored as Worker secret",
    });
  } finally {
    await callbackServer.close();
  }
}

export async function releaseStatus(
  context: CliContext,
  options: { apiUrl?: string; roadmapToken?: string; nonInteractive?: boolean },
): Promise<void> {
  const instance = await readJson<any>(path.join(context.root, "roadmap.instance.json"), {});
  const apiUrl = options.apiUrl ?? process.env.ROADMAP_API_URL ?? instance.project?.publicUrl;
  const token =
    options.roadmapToken ??
    process.env.ROADMAP_TOKEN ??
    process.env.ROADMAP_ADMIN_TOKEN ??
    (await promptForRoadmapToken(Boolean(options.nonInteractive)));
  if (!apiUrl) throw new Error("The deployed roadmap URL is required.");
  output(context, await roadmapRequest(apiUrl, "/api/v1/releases/status", token));
}

async function discoverGithubRepository(
  context: CliContext,
  applicationRepository?: string,
): Promise<string | undefined> {
  if (!applicationRepository) return undefined;
  const result = await run(context, "git", ["remote", "get-url", "origin"], {
    cwd: applicationRepository,
    reject: false,
  });
  if (result.exitCode !== 0) return undefined;
  const match = result.stdout
    .trim()
    .match(/github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return match?.[1];
}

async function upsertReleaseWebhook(
  repository: string,
  token: string,
  url: string,
  secret: string,
): Promise<{ id: number; created: boolean }> {
  const hooks = await githubRequest<
    Array<{ id: number; events: string[]; config: { url?: string } }>
  >(`/repos/${repository}/hooks?per_page=100`, token);
  const existing = hooks.find((hook) => hook.config.url === url);
  const body = {
    active: true,
    events: ["release"],
    config: {
      url,
      content_type: "json",
      insecure_ssl: "0",
      secret,
    },
  };
  if (existing) {
    await githubRequest(`/repos/${repository}/hooks/${existing.id}`, token, {
      method: "PATCH",
      body,
    });
    return { id: existing.id, created: false };
  }
  const created = await githubRequest<{ id: number }>(`/repos/${repository}/hooks`, token, {
    method: "POST",
    body: { name: "web", ...body },
  });
  return { id: created.id, created: true };
}

async function githubRequest<T = unknown>(
  endpoint: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${GITHUB_API}${endpoint}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "SakuraCord-Roadmap-Setup",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub ${options.method ?? "GET"} ${endpoint.split("?")[0]} returned ${response.status}: ${(await response.text()).slice(0, 1_000)}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function roadmapRequest<T>(
  apiUrl: string,
  pathname: string,
  token: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await resilientFetch(`${apiUrl.replace(/\/$/, "")}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `release-setup-${randomBytes(12).toString("hex")}`,
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `Roadmap API returned HTTP ${response.status}.`);
  }
  return payload.data as T;
}

async function getSecret(
  provided: string | undefined,
  envName: string,
  message: string,
  nonInteractive: boolean,
): Promise<string> {
  const value = provided ?? process.env[envName];
  if (value) return value;
  if (nonInteractive) throw new Error(`${envName} is required for non-interactive setup.`);
  const response = await prompts({
    type: "password",
    name: "value",
    message,
    validate: (candidate: string) => candidate.length >= 20 || "Token is too short.",
  });
  if (!response.value) throw new Error(`${message} is required.`);
  return response.value as string;
}

async function promptForRoadmapToken(nonInteractive: boolean): Promise<string> {
  if (nonInteractive) {
    throw new Error("ROADMAP_TOKEN is required for non-interactive release setup.");
  }
  const response = await prompts({
    type: "password",
    name: "token",
    message: "Saved roadmap maintainer token",
    validate: (value: string) => value.length >= 20 || "Token is too short.",
  });
  if (!response.token) throw new Error("The roadmap maintainer token is required.");
  return response.token as string;
}

async function putWorkerSecret(context: CliContext, name: string, value: string): Promise<void> {
  const result = await run(context, "npx", ["wrangler", "secret", "put", name], {
    input: `${value}\n`,
    stdout: "ignore",
  });
  if (result.exitCode !== 0) throw new Error(`Failed to store ${name} in Cloudflare.`);
}

async function waitForHealth(apiUrl: string): Promise<void> {
  let last = "no response";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await resilientFetch(`${apiUrl.replace(/\/$/, "")}/healthz`);
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        schemaVersion?: string;
      };
      if (response.ok && body.ok && body.schemaVersion === "6") return;
      last = `HTTP ${response.status}, schema ${body.schemaVersion ?? "unknown"}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 29) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Release-enabled deployment did not become healthy (${last}).`);
}
