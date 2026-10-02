import { actionOptions, openMilestones, performAction, type MaintainerAction } from "../actions";
import { DISCORD, ISSUE_TYPES, STATUS_BY_ID, statusLabel, type IssueKind } from "../config";
import {
  getDraft,
  getIssue,
  getThread,
  removeVote,
  saveDraft,
  subscriberRole,
  addSubscriber,
  type DraftUser,
} from "../db/store";
import type { Env } from "../env";
import {
  addDetails,
  addMeToo,
  createDraft,
  downloadAttachments,
  fileReport,
  findSimilar,
  cachedVersionOptions,
  type FiledReport,
  type SimilarReport,
} from "../reports";
import { cachedReportReleases } from "../releases";
import { REPORT_KINDS } from "../report/schema";
import { discordClient, refreshCard } from "./threads";
import { COMPONENTS_V2, EPHEMERAL, issueUrl } from "./cards";
import { detailsModal, fixedModal, parseModal, reportModal } from "./modals";
import { noMentions } from "./rest";
import { fromHex, randomId } from "../util/crypto";
import { errorMessage, json } from "../util/http";
import { escapeDiscord, truncate } from "../util/text";

const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;
const encoder = new TextEncoder();

interface Interaction {
  id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: DiscordUser; roles: string[]; permissions?: string; nick?: string | null };
  user?: DiscordUser;
  data?: any;
  message?: { id: string; flags?: number };
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export async function verifyDiscordRequest(request: Request, publicKey: string, body: string) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", fromHex(publicKey), { name: "Ed25519" }, false, [
    "verify",
  ]);
  return crypto.subtle.verify("Ed25519", key, fromHex(signature), encoder.encode(timestamp + body));
}

const ephemeral = (content: string, extra: Record<string, unknown> = {}) =>
  json({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: noMentions, ...extra } });
const deferEphemeral = () => json({ type: 5, data: { flags: EPHEMERAL } });
const deferUpdate = () => json({ type: 6 });

function userOf(interaction: Interaction): DraftUser {
  const user = interaction.member?.user ?? interaction.user!;
  return {
    id: user.id,
    username: user.username,
    name: interaction.member?.nick || user.global_name || user.username,
    avatarUrl: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : null,
  };
}

function isMaintainer(interaction: Interaction): boolean {
  const member = interaction.member;
  if (!member) return false;
  if (member.roles.some((role) => (DISCORD.maintainerRoleIds as readonly string[]).includes(role)))
    return true;
  const permissions = BigInt(member.permissions ?? "0");
  return (permissions & ADMINISTRATOR) !== 0n || (permissions & MANAGE_GUILD) !== 0n;
}

export async function handleInteraction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await request.text();
  if (!(await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY, body))) {
    return new Response("Invalid request signature", { status: 401 });
  }
  const interaction = JSON.parse(body) as Interaction;
  if (interaction.type === 1) return json({ type: 1 });
  if (interaction.guild_id && interaction.guild_id !== DISCORD.guildId) {
    return ephemeral("SakuraCord reports can only be filed in the SakuraCord server.");
  }
  const later = (task: () => Promise<void>) =>
    ctx.waitUntil(
      task().catch(async (error) => {
        console.error("Interaction task failed", errorMessage(error));
        await discordClient(env)
          .editInteractionResponse(interaction.token, {
            content: `⚠️ Something went wrong: ${truncate(errorMessage(error), 300)}`,
            components: [],
            flags: EPHEMERAL,
          })
          .catch(() => undefined);
      }),
    );

  const applyAction: typeof performAction = async (...args) => {
    const message = await performAction(...args);
    try {
      // Await this report's sync directly, even when Queue delivery is paused.
      // The RPC has its own invocation; GitHub mutation and projection do not
      // consume a single invocation's entire Free-tier D1/subrequest budget.
      for (let attempt = 0; attempt < 4; attempt++) {
        const result = await ctx.exports.ReportSync.run(args[1]);
        if (result?.status === "done") return message;
        if (!result || result.last_error || result.status === "failed") break;
        // A concurrent webhook may already own the same job's lease.
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (error) {
      console.error("Immediate report sync failed", errorMessage(error));
    }
    throw new Error("Saved on GitHub, but Discord has not finished updating. A retry is saved.");
  };

  try {
    if (interaction.type === 2) return await handleCommand(interaction, env);
    if (interaction.type === 3) return await handleComponent(interaction, env, later, applyAction);
    if (interaction.type === 5) return await handleModal(interaction, env, later, applyAction);
  } catch (error) {
    console.error("Interaction failed", errorMessage(error));
    return ephemeral(`⚠️ ${truncate(errorMessage(error), 300)}`);
  }
  return ephemeral("Unsupported interaction.");
}

type Later = (task: () => Promise<void>) => void;

// ---------------------------------------------------------------------------
// Slash and context-menu commands

async function handleCommand(interaction: Interaction, env: Env) {
  const name = interaction.data?.name;
  if (name === "bug" || name === "suggest") {
    const kind: IssueKind = name === "bug" ? "bug" : "feature";
    const versions = await cachedVersionOptions(env);
    if (!versions.length)
      return ephemeral(
        "Latest release choices are loading. Please use https://sakuracord.app/report or try again shortly.",
      );
    return json(reportModal(kind, 1, `m1:${kind}`, {}, versions));
  }
  if (name === "roadmap") {
    return ephemeral(
      `🗺️ [Roadmap](${env.WEBSITE_URL}/roadmap) · 📋 [Tracker](${env.WEBSITE_URL}/tracker) · 🐞 \`/bug\` · ✨ \`/suggest\``,
    );
  }
  return ephemeral("Unknown command.");
}

// ---------------------------------------------------------------------------
// Buttons and selects

async function handleComponent(
  interaction: Interaction,
  env: Env,
  later: Later,
  applyAction: typeof performAction,
) {
  const customId: string = interaction.data?.custom_id ?? "";
  const [scope, action, a, b] = customId.split(":");
  const discord = discordClient(env);

  if (customId === "r:bug" || customId === "r:feature") {
    const kind = customId === "r:bug" ? "bug" : "feature";
    const versions = await cachedVersionOptions(env);
    if (!versions.length)
      return ephemeral(
        "Latest release choices are loading. Please use https://sakuracord.app/report or try again shortly.",
      );
    return json(reportModal(kind, 1, `m1:${kind}`, {}, versions));
  }

  if (customId === "roadmap:subscribe") {
    later(async () => {
      const user = userOf(interaction);
      const subscribed = interaction.member?.roles.includes(DISCORD.updatesRoleId);
      const path = `/guilds/${DISCORD.guildId}/members/${user.id}/roles/${DISCORD.updatesRoleId}`;
      if (subscribed) await discord.delete(path, { reason: "Roadmap update unsubscribe" });
      else await discord.put(path, undefined, { reason: "Roadmap update subscribe" });
      await discord.editInteractionResponse(interaction.token, {
        content: subscribed
          ? "🔕 You won't be pinged for SakuraCord updates anymore."
          : "🔔 You'll be pinged when new SakuraCord versions ship.",
      });
    });
    return deferEphemeral();
  }

  if (scope === "d") return handleDraftComponent(interaction, env, later, action!, a!, b);

  if (scope === "i") {
    const number = Number(a);
    if (action === "vote") {
      later(async () => {
        const user = userOf(interaction);
        const issue = await getIssue(env.DB, number);
        if (!issue) throw new Error(`#${number} was not found.`);
        const role = await subscriberRole(env.DB, number, user.id);
        let content: string;
        if (role === "reporter") {
          content = "You reported this, so you're already following it. 🌸";
        } else if (role === "vote") {
          await removeVote(env.DB, number, user.id);
          content = `Removed your vote from #${number}. You won't be pinged about it anymore.`;
        } else {
          await addSubscriber(env.DB, number, user.id, "vote");
          const thread = await getThread(env.DB, interaction.channel_id ?? "");
          if (thread) {
            await discord
              .put(`/channels/${thread.threadId}/thread-members/${user.id}`)
              .catch(() => undefined);
          }
          content = `👍 Thanks! You're now following #${number} and will be pinged when it ships.`;
        }
        await refreshCard(env, issue).catch(() => undefined);
        await discord.editInteractionResponse(interaction.token, { content });
      });
      return deferEphemeral();
    }
    if (action === "details") {
      const issue = await getIssue(env.DB, number);
      if (!issue || !STATUS_BY_ID.get(issue.status)!.open) {
        return ephemeral("This report is closed, so it can't take new details.");
      }
      return json(detailsModal(number));
    }
    if (action === "manage") {
      if (!isMaintainer(interaction))
        return ephemeral("Only SakuraCord maintainers can manage reports.");
      const issue = await getIssue(env.DB, number);
      if (!issue) return ephemeral(`#${number} was not found.`);
      const options = actionOptions(issue.status, issue.kind);
      const triage = issue.triage;
      const lines = [
        `**#${number} · ${escapeDiscord(truncate(issue.title, 150))}**`,
        `-# ${statusLabel(issue.status, issue.kind)}${issue.priority ? ` · ${issue.priority} priority` : ""}${issue.milestoneTitle ? ` · v${issue.milestoneTitle}` : ""}`,
        triage?.duplicateOf
          ? `-# 🤖 Possible duplicate of #${triage.duplicateOf} (${Math.round(triage.duplicateConfidence * 100)}%): ${escapeDiscord(truncate(triage.duplicateReason, 200))}`
          : null,
      ].filter(Boolean);
      return ephemeral(lines.join("\n"), {
        components: [
          {
            type: 1,
            components: [
              {
                type: 3,
                custom_id: `i:act:${number}`,
                placeholder: "Choose an action",
                options: options.map((option) => ({
                  label: option.label,
                  value: option.value,
                  description: option.description,
                  emoji: { name: option.emoji },
                })),
              },
            ],
          },
          {
            type: 1,
            components: [{ type: 2, style: 5, label: "Open on GitHub", url: issueUrl(number) }],
          },
        ],
      });
    }
    if (action === "act") {
      if (!isMaintainer(interaction))
        return ephemeral("Only SakuraCord maintainers can manage reports.");
      const chosen = interaction.data.values?.[0] as MaintainerAction;
      const issue = await getIssue(env.DB, number);
      if (!issue) return ephemeral(`#${number} was not found.`);
      const option = actionOptions(issue.status, issue.kind).find(
        (value) => value.value === chosen,
      );
      if (!option) return ephemeral("That action isn't available anymore.");
      if (chosen === "mark_fixed")
        return json(fixedModal(number, issue.kind, await cachedReportReleases(env)));
      if (chosen === "plan") {
        const milestones = await openMilestones(env);
        if (!milestones.length)
          return ephemeral("There are no open milestones. Create one on GitHub first.");
        return json({
          type: 7,
          data: {
            content: `Plan **#${number}** for which version?`,
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 3,
                    custom_id: `i:ms:${number}`,
                    placeholder: "Choose a version",
                    options: milestones.slice(0, 25).map((milestone) => ({
                      label: `v${milestone.title}`,
                      value: String(milestone.number),
                      description: truncate(
                        (milestone.description ?? "").split("\n")[0] || "Milestone",
                        100,
                      ),
                    })),
                  },
                ],
              },
            ],
          },
        });
      }
      if (option.input) {
        const prefill =
          chosen === "duplicate" && issue.triage?.duplicateOf
            ? String(issue.triage.duplicateOf)
            : undefined;
        return json({
          type: 9,
          data: {
            custom_id: `ma:${chosen}:${number}`,
            title: truncate(`${option.label.replace(/…$/, "")} · #${number}`, 45),
            components: [
              {
                type: 18,
                label: option.input.label,
                component: {
                  type: 4,
                  custom_id: "note",
                  style: option.input.short ? 1 : 2,
                  required: option.input.required,
                  max_length: option.input.short ? 12 : 1500,
                  placeholder: option.input.placeholder,
                  ...(prefill ? { value: prefill } : {}),
                },
              },
            ],
          },
        });
      }
      later(async () => {
        const message = await applyAction(env, number, chosen, userOf(interaction).name);
        await discord.editInteractionResponse(interaction.token, {
          content: `✅ ${message}`,
          components: [],
        });
      });
      return deferUpdate();
    }
    if (action === "ms") {
      if (!isMaintainer(interaction))
        return ephemeral("Only SakuraCord maintainers can manage reports.");
      const milestone = Number(interaction.data.values?.[0]);
      later(async () => {
        const message = await applyAction(env, number, "plan", userOf(interaction).name, {
          milestone,
        });
        await discord.editInteractionResponse(interaction.token, {
          content: `✅ ${message}`,
          components: [],
        });
      });
      return deferUpdate();
    }
  }
  return ephemeral("This button has expired.");
}

// ---------------------------------------------------------------------------
// Report drafts: duplicate check, optional details, filing

function similarPrompt(draftId: string, kind: IssueKind, similar: SimilarReport[]) {
  const definition = REPORT_KINDS[kind];
  const blocks: unknown[] = [];
  if (similar.length) {
    blocks.push({
      type: 10,
      content: `### Is it one of these?\nThese ${kind === "bug" ? "reports" : "suggestions"} look similar. If one matches, add yourself to it instead. You'll get the same updates.`,
    });
    for (const report of similar) {
      blocks.push({
        type: 9,
        components: [
          {
            type: 10,
            content: `**[#${report.number} · ${escapeDiscord(truncate(report.title, 90))}](${report.threadUrl ?? report.url})**\n-# ${report.statusLabel}${report.votes ? ` · 👍 ${report.votes}` : ""}${report.resolution ? `\n${report.resolution}` : ""}`,
          },
        ],
        accessory: report.open
          ? {
              type: 2,
              style: 3,
              custom_id: `d:same:${draftId}:${report.number}`,
              label: "That's mine",
            }
          : { type: 2, style: 5, label: "View", url: report.threadUrl ?? report.url },
      });
    }
    blocks.push({ type: 14, divider: true, spacing: 1 });
    blocks.push({ type: 10, content: "-# Not listed? Submit yours below." });
  } else {
    blocks.push({
      type: 10,
      content: `### Almost done\nNo similar ${kind === "bug" ? "reports" : "suggestions"} found. ${
        kind === "bug"
          ? "Screenshots and your macOS version make bugs much faster to fix."
          : "Mockups or examples help a lot."
      }`,
    });
  }
  return {
    flags: EPHEMERAL | COMPONENTS_V2,
    components: [
      { type: 17, accent_color: 0xef9bc4, components: blocks },
      {
        type: 1,
        components: [
          { type: 2, style: 1, custom_id: `d:submit:${draftId}`, label: definition.submitLabel },
          {
            type: 2,
            style: 2,
            custom_id: `d:details:${draftId}`,
            emoji: { name: "📎" },
            label: definition.detailsLabel,
          },
          { type: 2, style: 2, custom_id: `d:cancel:${draftId}`, label: "Cancel" },
        ],
      },
    ],
  };
}

function filedMessage(report: FiledReport, kind: IssueKind, existing = false) {
  const noun = kind === "bug" ? "report" : "suggestion";
  return {
    flags: EPHEMERAL | COMPONENTS_V2,
    components: [
      {
        type: 17,
        accent_color: 0x34d399,
        components: [
          {
            type: 10,
            content: existing
              ? `### 👍 You're following #${report.number}\nWe added your details and you'll be pinged when it changes${report.threadId ? ` in <#${report.threadId}>` : ""}.`
              : `### ✅ Filed as #${report.number}\nThanks! Your ${noun} is${report.threadId ? ` in <#${report.threadId}>` : " on GitHub"}. You'll be pinged when it's confirmed, fixed, and shipped.`,
          },
        ],
      },
      {
        type: 1,
        components: [
          ...(report.threadUrl
            ? [{ type: 2, style: 5, label: "Open post", url: report.threadUrl }]
            : []),
          { type: 2, style: 5, label: "GitHub", url: report.issueUrl },
          { type: 2, style: 5, label: "Tracker", url: report.trackerUrl },
        ],
      },
    ],
  };
}

async function handleDraftComponent(
  interaction: Interaction,
  env: Env,
  later: Later,
  action: string,
  draftId: string,
  target?: string,
) {
  const draft = await getDraft(env.DB, draftId);
  const discord = discordClient(env);
  if (!draft || draft.user.id !== userOf(interaction).id) {
    return json({
      type: 7,
      data: {
        content: "This draft has expired. Start again with `/bug` or `/suggest`.",
        components: [],
        flags: EPHEMERAL,
      },
    });
  }
  if (action === "cancel") {
    return json({
      type: 7,
      data: { content: "Cancelled. Nothing was filed.", components: [], flags: EPHEMERAL },
    });
  }
  if (action === "details") {
    return json(
      reportModal(draft.kind, 2, `m2:${draft.id}`, draft.values, await cachedVersionOptions(env)),
    );
  }
  if (action === "same") {
    const number = Number(target);
    later(async () => {
      const description = [draft.values.what_happened ?? draft.values.request, draft.values.steps]
        .filter(Boolean)
        .join("\n\n");
      const result = await addMeToo(env, number, draft.user, "discord", description);
      await discord.editInteractionResponse(
        interaction.token,
        filedMessage(result, draft.kind, true),
      );
    });
    return deferUpdate();
  }
  if (action === "submit") {
    later(async () => {
      await discord.editInteractionResponse(interaction.token, {
        flags: EPHEMERAL | COMPONENTS_V2,
        components: [{ type: 10, content: "⏳ Filing your report…" }],
      });
      const result = await fileReport(env, draft, []);
      await discord.editInteractionResponse(interaction.token, filedMessage(result, draft.kind));
    });
    return deferUpdate();
  }
  return ephemeral("This button has expired.");
}

// ---------------------------------------------------------------------------
// Modals

async function handleModal(
  interaction: Interaction,
  env: Env,
  later: Later,
  applyAction: typeof performAction,
) {
  const customId: string = interaction.data?.custom_id ?? "";
  const [scope, a, b] = customId.split(":");
  const submission = parseModal(interaction.data);
  const discord = discordClient(env);
  const user = userOf(interaction);

  if (scope === "m1") {
    const kind = a as IssueKind;
    if (!ISSUE_TYPES[kind]) return ephemeral("Unknown report type.");
    const limit = await env.REPORT_RATE_LIMITER.limit({ key: `report:${user.id}` });
    if (!limit.success)
      return ephemeral("You're filing reports very quickly. Try again in a minute.");
    const draft = await createDraft(env, {
      id: randomId(10),
      source: "discord",
      kind,
      user,
      values: submission.values,
      attachments: [],
      candidates: [],
    });
    later(async () => {
      const text = [
        submission.values.title,
        submission.values.what_happened ?? submission.values.request,
      ]
        .filter(Boolean)
        .join("\n");
      const similar = await findSimilar(env, text);
      draft.candidates = similar.map((report) => report.number);
      await saveDraft(env.DB, draft);
      await discord.editInteractionResponse(
        interaction.token,
        similarPrompt(draft.id, kind, similar),
      );
    });
    return deferEphemeral();
  }

  if (scope === "m2") {
    const draft = await getDraft(env.DB, a!);
    if (!draft || draft.user.id !== user.id)
      return ephemeral("This draft has expired. Start again with `/bug`.");
    draft.values = { ...draft.values, ...submission.values };
    await saveDraft(env.DB, draft);
    later(async () => {
      await discord.editInteractionResponse(interaction.token, {
        flags: EPHEMERAL | COMPONENTS_V2,
        components: [{ type: 10, content: "⏳ Filing your report…" }],
      });
      const files = await downloadAttachments(submission.attachments);
      const result = await fileReport(env, draft, files);
      await discord.editInteractionResponse(interaction.token, filedMessage(result, draft.kind));
    });
    return deferUpdate();
  }

  if (scope === "m3") {
    const number = Number(a);
    later(async () => {
      const files = await downloadAttachments(submission.attachments);
      const text = submission.values.text ?? "";
      if (!text.trim() && !files.length) {
        await discord.editInteractionResponse(interaction.token, { content: "Nothing to add." });
        return;
      }
      await addDetails(env, number, user, { text, files }, "discord");
      await discord.editInteractionResponse(interaction.token, {
        content: `📎 Added to [#${number}](${issueUrl(number)}). Thanks!`,
      });
    });
    return deferEphemeral();
  }

  if (scope === "ma") {
    if (!isMaintainer(interaction))
      return ephemeral("Only SakuraCord maintainers can manage reports.");
    const action = a as MaintainerAction;
    const number = Number(b);
    later(async () => {
      const message = await applyAction(env, number, action, user.name, {
        note: submission.values.note,
        release: submission.values.release,
        reference: submission.values.reference,
      });
      await discord.editInteractionResponse(interaction.token, {
        content: `✅ ${message}`,
        components: [],
      });
    });
    return deferUpdate();
  }
  return ephemeral("This form has expired.");
}
