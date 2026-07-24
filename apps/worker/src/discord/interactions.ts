import {
  CreateRoadmapItemSchema,
  escapeDiscord,
  type Actor,
  type RoadmapConfig,
  type RoadmapEngine,
} from "@roadmap/core";
import type { Env } from "../env.js";
import { verifyDiscordInteraction } from "../security.js";
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

export async function handleDiscordInteraction(
  request: Request,
  env: Env,
  config: RoadmapConfig,
  engine: RoadmapEngine,
): Promise<Response> {
  if (!env.DISCORD_PUBLIC_KEY) return json({ error: "Discord is not configured." }, 503);
  const body = await request.text();
  await verifyDiscordInteraction(request, env.DISCORD_PUBLIC_KEY, body);
  const interaction = JSON.parse(body) as Interaction;
  if (interaction.type === 1) return json({ type: 1 });
  const replay = await env.DB.prepare("SELECT nonce FROM replay_nonces WHERE nonce=?")
    .bind(`interaction:${interaction.id}`)
    .first();
  if (replay) return json({ type: 6 });
  await env.DB.prepare(
    "INSERT INTO replay_nonces(nonce,expires_at) VALUES(?,datetime('now','+1 day'))",
  )
    .bind(`interaction:${interaction.id}`)
    .run();
  const actor = discordActor(interaction);
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
  if (customId === "roadmap:subscribe") {
    const guildId = interaction.guild_id;
    const roleId = config.discord.updatesRoleId;
    if (!guildId || guildId !== config.discord.guildId || !roleId || !env.DISCORD_BOT_TOKEN) {
      return ephemeral("Release update subscriptions are not configured.");
    }
    const subscribed = Boolean(interaction.member?.roles?.includes(roleId));
    const rest = new DiscordRestClient(env.DISCORD_BOT_TOKEN);
    const rolePath = `/guilds/${guildId}/members/${actor.id}/roles/${roleId}`;
    if (subscribed) await rest.delete(rolePath);
    else await rest.put(rolePath);
    return ephemeral(
      subscribed
        ? "You will no longer receive release update pings."
        : "You will now receive release update pings.",
    );
  }
  if (!isMaintainer(interaction, config)) {
    return ephemeral("You need a configured maintainer role to perform this action.");
  }
  if (interaction.type === 3 && customId) {
    const [namespace, action, threadId] = customId.split(":");
    if (namespace !== "roadmap" || !action || !threadId) return ephemeral("Unknown action.");
    if (["accept", "link", "decline", "duplicate", "request_info"].includes(action)) {
      return json(modalFor(action, threadId));
    }
    if (action === "archive" || action === "reopen") {
      await modifyThread(env, threadId, action === "archive");
      return ephemeral(`Thread ${action === "archive" ? "archived" : "reopened"}.`);
    }
    if (action === "status" && interaction.data?.values?.[0]) {
      const itemId = await linkedItemId(env, threadId);
      if (!itemId) return ephemeral("This thread is not linked to a roadmap item.");
      const item = await engine.get(itemId);
      await engine.transition(item.id, interaction.data.values[0], item.revision, {
        actor,
        mutationId: `discord:${interaction.id}`,
      });
      return ephemeral(`Moved ${item.id} to ${interaction.data.values[0]}.`);
    }
  }
  if (interaction.type === 5 && customId) {
    const [namespace, action, threadId] = customId.split(":");
    if (namespace !== "roadmap" || !action || !threadId) return ephemeral("Unknown modal.");
    const fields = modalFields(interaction);
    await handleModalAction(env, config, engine, actor, interaction.id, action, threadId, fields);
    return ephemeral("Roadmap and Discord review state updated.");
  }
  return ephemeral("Unsupported roadmap interaction.");
}

export function reviewControls(threadId: string, config: RoadmapConfig): unknown[] {
  return [
    {
      type: 1,
      components: [
        button("Accept", `roadmap:accept:${threadId}`, 3),
        button("Link", `roadmap:link:${threadId}`, 1),
        button("Decline", `roadmap:decline:${threadId}`, 4),
        button("Duplicate", `roadmap:duplicate:${threadId}`, 2),
        button("Request info", `roadmap:request_info:${threadId}`, 2),
      ],
    },
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `roadmap:status:${threadId}`,
          placeholder: "Change linked roadmap status",
          options: config.lifecycle.map((state) => ({
            label: state.label,
            value: state.id,
          })),
        },
        button("Reopen", `roadmap:reopen:${threadId}`, 2),
        button("Archive", `roadmap:archive:${threadId}`, 2),
      ],
    },
  ];
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
      if (item.status === "inbox") {
        item = (
          await engine.transition(item.id, "planned", item.revision, {
            actor,
            mutationId: `discord:${interactionId}:accept`,
          })
        ).after;
      }
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

function button(label: string, customId: string, style: number) {
  return { type: 2, label, custom_id: customId, style };
}

function ephemeral(content: string): Response {
  return json({ type: 4, data: { flags: 64, content, allowed_mentions: safeAllowedMentions() } });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
