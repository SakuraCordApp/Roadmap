import {
  CreateRoadmapItemSchema,
  escapeDiscord,
  type Actor,
  type RoadmapConfig,
  type RoadmapEngine,
} from "@roadmap/core";
import { z } from "zod";
import type { Env } from "../env.js";
import { readBodyTextLimited } from "../request-body.js";
import { redactError, verifyDiscordInteraction } from "../security.js";
import { DiscordRestClient, safeAllowedMentions } from "./rest.js";

interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: {
    user?: { id: string; username: string };
    roles?: string[];
    permissions?: string;
  };
  user?: { id: string; username: string };
  data?: {
    name?: string;
    custom_id?: string;
    component_type?: number;
    values?: string[];
    options?: Array<{ name: string; value: unknown }>;
    components?: Array<{ components?: Array<{ custom_id: string; value?: string }> }>;
  };
  message?: { id: string };
}

interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

const InteractionEnvelopeSchema = z
  .object({
    id: z.string().regex(/^\d{17,20}$/),
    application_id: z.string().regex(/^\d{17,20}$/),
    type: z.number().int().min(1).max(5),
    token: z.string().min(1).max(512),
  })
  .passthrough();

export async function handleDiscordInteraction(
  request: Request,
  env: Env,
  config: RoadmapConfig,
  engine: RoadmapEngine,
  executionContext: WaitUntilContext,
): Promise<Response> {
  if (!env.DISCORD_PUBLIC_KEY) return json({ error: "Discord is not configured." }, 503);
  const body = await readBodyTextLimited(request, 1_048_576);
  await verifyDiscordInteraction(request, env.DISCORD_PUBLIC_KEY, body);
  const interaction = parseInteraction(body);
  if (interaction.type === 1) return json({ type: 1 });
  const customId = interaction.data?.custom_id;
  if (interaction.type === 2 && interaction.data?.name === "roadmap") {
    return json({
      type: 4,
      data: {
        flags: 64,
        content: `Open the detailed ${escapeDiscord(config.project.name)} roadmap: <${config.project.publicUrl}>`,
        allowed_mentions: safeAllowedMentions(),
      },
    });
  }
  if (!isMaintainer(interaction, config)) {
    if (customId !== "roadmap:subscribe") {
      return ephemeral("You need a configured maintainer role to perform this action.");
    }
  }
  if (interaction.type === 3 && customId && customId !== "roadmap:subscribe") {
    const [namespace, action, threadId] = customId.split(":");
    if (namespace !== "roadmap" || !action || !threadId) return ephemeral("Unknown action.");
    if (["accept", "link", "decline", "duplicate", "request_info"].includes(action)) {
      return json(modalFor(action, threadId));
    }
  }
  if (!isDeferredInteraction(interaction)) return ephemeral("Unsupported roadmap interaction.");

  await env.DB.prepare(
    `INSERT OR IGNORE INTO discord_interaction_jobs(interaction_id,payload_json)
     VALUES(?,?)`,
  )
    .bind(interaction.id, JSON.stringify(interaction))
    .run();
  executionContext.waitUntil(
    processPendingInteractionJobs(env, config, engine, 1).catch((error) => {
      console.error("Discord interaction background attempt failed", redactError(error));
      return { processed: 0, failed: 1 };
    }),
  );
  return deferredEphemeral();
}

export async function processPendingInteractionJobs(
  env: Env,
  config: RoadmapConfig,
  engine: RoadmapEngine,
  limit = 5,
): Promise<{ processed: number; failed: number }> {
  const jobs = await env.DB.prepare(
    `SELECT interaction_id,payload_json,attempts
     FROM discord_interaction_jobs
     WHERE attempts < 10 AND (
       (status IN ('pending','failed')
         AND available_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       OR (status='processing' AND unixepoch(locked_at) <= unixepoch('now') - 300)
     )
     ORDER BY created_at LIMIT ?`,
  )
    .bind(Math.min(Math.max(limit, 1), 20))
    .all<{ interaction_id: string; payload_json: string; attempts: number }>();
  let processed = 0;
  let failed = 0;
  for (const job of jobs.results) {
    const lock = await env.DB.prepare(
      `UPDATE discord_interaction_jobs
       SET status='processing',locked_at=datetime('now'),attempts=attempts+1
       WHERE interaction_id=? AND attempts < 10 AND (
         status IN ('pending','failed')
         OR (status='processing' AND unixepoch(locked_at) <= unixepoch('now') - 300)
       )`,
    )
      .bind(job.interaction_id)
      .run();
    if (lock.meta.changes !== 1) continue;
    try {
      const interaction = parseInteraction(job.payload_json);
      const content = await performDeferredInteraction(env, config, engine, interaction);
      await editOriginalInteractionResponse(interaction, content);
      await env.DB.prepare(
        `UPDATE discord_interaction_jobs
         SET status='complete',payload_json='{}',completed_at=datetime('now'),
             locked_at=NULL,last_error=NULL
         WHERE interaction_id=?`,
      )
        .bind(job.interaction_id)
        .run();
      processed += 1;
    } catch (error) {
      const delay = Math.min(300, 2 ** Math.min(job.attempts + 1, 8));
      await env.DB.prepare(
        `UPDATE discord_interaction_jobs
         SET status='failed',last_error=?,
             available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),locked_at=NULL
         WHERE interaction_id=?`,
      )
        .bind(redactError(error).slice(0, 2_000), `+${delay} seconds`, job.interaction_id)
        .run();
      failed += 1;
    }
  }
  return { processed, failed };
}

async function performDeferredInteraction(
  env: Env,
  config: RoadmapConfig,
  engine: RoadmapEngine,
  interaction: Interaction,
): Promise<string> {
  const actor = discordActor(interaction);
  const customId = interaction.data?.custom_id;
  if (customId === "roadmap:subscribe") {
    const guildId = interaction.guild_id;
    const roleId = config.discord.updatesRoleId;
    if (!guildId || guildId !== config.discord.guildId || !roleId || !env.DISCORD_BOT_TOKEN) {
      return "Release update subscriptions are not configured.";
    }
    const subscribed = Boolean(interaction.member?.roles?.includes(roleId));
    const rest = new DiscordRestClient(env.DISCORD_BOT_TOKEN);
    const rolePath = `/guilds/${guildId}/members/${actor.id}/roles/${roleId}`;
    if (subscribed) await rest.delete(rolePath);
    else await rest.put(rolePath);
    return subscribed
      ? "You will no longer receive release update pings."
      : "You will now receive release update pings.";
  }
  if (!isMaintainer(interaction, config)) {
    return "You need a configured maintainer role to perform this action.";
  }
  if (interaction.type === 3 && customId) {
    const [namespace, action, threadId] = customId.split(":");
    if (namespace !== "roadmap" || !action || !threadId) return "Unknown action.";
    if (action === "archive" || action === "reopen") {
      await modifyThread(env, threadId, action === "archive");
      return `Thread ${action === "archive" ? "archived" : "reopened"}.`;
    }
    if (action === "status" && interaction.data?.values?.[0]) {
      const itemId = await linkedItemId(env, threadId);
      if (!itemId) return "This thread is not linked to a roadmap item.";
      const item = await engine.get(itemId);
      await engine.transition(item.id, interaction.data.values[0], item.revision, {
        actor,
        mutationId: `discord:${interaction.id}`,
      });
      return `Moved ${item.id} to ${interaction.data.values[0]}.`;
    }
  }
  if (interaction.type === 5 && customId) {
    const [namespace, action, threadId] = customId.split(":");
    if (namespace !== "roadmap" || !action || !threadId) return "Unknown modal.";
    await handleModalAction(
      env,
      config,
      engine,
      actor,
      interaction.id,
      action,
      threadId,
      modalFields(interaction),
    );
    return "Roadmap and Discord review state updated.";
  }
  return "Unsupported roadmap interaction.";
}

async function handleModalAction(
  env: Env,
  config: RoadmapConfig,
  engine: RoadmapEngine,
  actor: Actor,
  interactionId: string,
  action: string,
  threadId: string,
  fields: Record<string, string>,
): Promise<void> {
  const submission = await env.DB.prepare("SELECT * FROM discord_submissions WHERE thread_id=?")
    .bind(threadId)
    .first<Record<string, any>>();
  if (!submission) throw new Error("Submission was not found.");
  if (action === "accept") {
    if (submission.linked_item_id) {
      let item = await engine.get(String(submission.linked_item_id));
      const edited = await engine.update(
        item.id,
        {
          title: fields.title || item.title,
          description: fields.description || item.description,
          area: fields.area || item.area,
        },
        item.revision,
        { actor, mutationId: `discord:${interactionId}:edit` },
      );
      item = edited.after;
      await setReviewState(env, threadId, "accepted", item.id, null);
    } else {
      const created = await engine.create(
        CreateRoadmapItemSchema.parse({
          title: fields.title || submission.title,
          description: fields.description || submission.content || submission.title,
          type: submission.kind === "bug_report" ? "bug" : "feature",
          labels: ["functionality"],
          area: fields.area || config.areas[0]!.id,
          status: "planned",
          priority: "medium",
          difficulty: "medium",
          linkedDiscordThreads: [
            {
              threadId,
              forumId: submission.forum_id,
              guildId: submission.guild_id,
              kind: submission.kind,
              url: `https://discord.com/channels/${submission.guild_id}/${threadId}`,
              title: submission.title,
              linkedAt: new Date().toISOString(),
            },
          ],
        }),
        { actor, mutationId: `discord:${interactionId}` },
      );
      await setReviewState(env, threadId, "accepted", created.after.id, null);
    }
  } else if (action === "link") {
    const item = await engine.get(fields.item_id ?? "");
    const link = {
      threadId,
      forumId: String(submission.forum_id),
      guildId: String(submission.guild_id),
      kind: submission.kind as "feature_request" | "bug_report",
      url: `https://discord.com/channels/${submission.guild_id}/${threadId}`,
      title: String(submission.title),
      linkedAt: new Date().toISOString(),
    };
    await engine.update(
      item.id,
      {
        linkedDiscordThreads: [
          ...item.linkedDiscordThreads.filter((value) => value.threadId !== threadId),
          link,
        ],
      },
      item.revision,
      { actor, mutationId: `discord:${interactionId}` },
    );
    await setReviewState(env, threadId, "linked", item.id, null);
  } else if (["decline", "duplicate", "request_info"].includes(action)) {
    const state = action === "request_info" ? "needs_information" : action;
    const reason = fields.reason ?? "";
    const linkedItemId = submission.linked_item_id ? String(submission.linked_item_id) : null;
    if (linkedItemId && (action === "decline" || action === "duplicate")) {
      const item = await engine.get(linkedItemId);
      await engine.transition(item.id, action, item.revision, {
        actor,
        mutationId: `discord:${interactionId}:${action}`,
      });
    }
    await setReviewState(env, threadId, state, linkedItemId, reason);
    if (env.DISCORD_BOT_TOKEN) {
      await new DiscordRestClient(env.DISCORD_BOT_TOKEN).post(
        `/channels/${threadId}/messages`,
        {
          content: `**Maintainer update:** ${escapeDiscord(reason)}`,
          allowed_mentions: safeAllowedMentions(),
        },
        `review:${interactionId}`,
      );
    }
  }
}

async function setReviewState(
  env: Env,
  threadId: string,
  state: string,
  itemId: string | null,
  reason: string | null,
) {
  await env.DB.prepare(
    `UPDATE discord_submissions SET review_state=?,linked_item_id=?,decision_reason=?,updated_at=?
     WHERE thread_id=?`,
  )
    .bind(state, itemId, reason, new Date().toISOString(), threadId)
    .run();
}

function modalFor(action: string, threadId: string) {
  const definitions: Record<string, { title: string; fields: Array<[string, string, number]> }> = {
    accept: {
      title: "Accept roadmap request",
      fields: [
        ["title", "Roadmap title", 1],
        ["description", "Public description", 2],
        ["area", "Area ID", 1],
      ],
    },
    link: { title: "Link roadmap item", fields: [["item_id", "Stable roadmap ID", 1]] },
    decline: { title: "Decline request", fields: [["reason", "Public reason", 2]] },
    duplicate: { title: "Mark duplicate", fields: [["reason", "Duplicate of / reason", 2]] },
    request_info: { title: "Request more information", fields: [["reason", "What is needed?", 2]] },
  };
  const definition = definitions[action]!;
  return {
    type: 9,
    data: {
      custom_id: `roadmap:${action}:${threadId}`,
      title: definition.title,
      components: definition.fields.map(([id, label, style]) => ({
        type: 1,
        components: [{ type: 4, custom_id: id, label, style, required: true, max_length: 2_000 }],
      })),
    },
  };
}

function modalFields(interaction: Interaction): Record<string, string> {
  return Object.fromEntries(
    (interaction.data?.components ?? []).flatMap((row) =>
      (row.components ?? [])
        .filter((field) => typeof field.value === "string")
        .map((field) => [field.custom_id, field.value!]),
    ),
  );
}

function discordActor(interaction: Interaction): Actor {
  const user = interaction.member?.user ?? interaction.user;
  return {
    id: user?.id ?? "unknown-discord-user",
    displayName: user?.username ?? "Discord maintainer",
    kind: "discord",
  };
}

function isMaintainer(interaction: Interaction, config: RoadmapConfig): boolean {
  const configured = config.discord.maintainerRoleIds;
  return (
    configured.length > 0 &&
    (interaction.member?.roles ?? []).some((role) => configured.includes(role))
  );
}

async function linkedItemId(env: Env, threadId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT linked_item_id FROM discord_submissions WHERE thread_id=?",
  )
    .bind(threadId)
    .first<{ linked_item_id: string | null }>();
  return row?.linked_item_id ?? null;
}

async function modifyThread(env: Env, threadId: string, archived: boolean): Promise<void> {
  if (!env.DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN is not configured.");
  await new DiscordRestClient(env.DISCORD_BOT_TOKEN).patch(
    `/channels/${threadId}`,
    { archived, locked: archived },
    archived ? "Maintainer archived roadmap submission" : "Maintainer reopened roadmap submission",
  );
}

function ephemeral(content: string): Response {
  return json({ type: 4, data: { flags: 64, content, allowed_mentions: safeAllowedMentions() } });
}

function deferredEphemeral(): Response {
  return json({ type: 5, data: { flags: 64 } });
}

function isDeferredInteraction(interaction: Interaction): boolean {
  const customId = interaction.data?.custom_id;
  if (customId === "roadmap:subscribe") return true;
  if (interaction.type === 5 && customId?.startsWith("roadmap:")) return true;
  if (interaction.type !== 3 || !customId) return false;
  const action = customId.split(":")[1];
  return action === "archive" || action === "reopen" || action === "status";
}

function parseInteraction(body: string): Interaction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Discord interaction body contains invalid JSON.");
  }
  return InteractionEnvelopeSchema.parse(parsed) as Interaction;
}

async function editOriginalInteractionResponse(
  interaction: Interaction,
  content: string,
): Promise<void> {
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        allowed_mentions: safeAllowedMentions(),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Discord interaction response update returned HTTP ${response.status}.`);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
