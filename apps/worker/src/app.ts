import {
  AcceptanceCriterionSchema,
  CreateRoadmapItemSchema,
  DiscordThreadLinkSchema,
  RoadmapEngine,
  RoadmapError,
  RoadmapItemSchema,
  RoadmapPatchSchema,
  TransitionRequestSchema,
  VerificationResultSchema,
  diffValues,
  generateDiscordProjection,
} from "@roadmap/core";
import { createRoadmapMcpServer } from "@roadmap/mcp";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import roadmapConfig from "../../../roadmap.config.js";
import { handleDiscordInteraction } from "./discord/interactions.js";
import { DiscordSyncService } from "./discord/sync.js";
import { aiOAuthStatus, beginAiOAuth, disconnectAiOAuth, finishAiOAuth } from "./ai-oauth.js";
import type { Env } from "./env.js";
import {
  acceptGithubReleaseWebhook,
  processPendingReleaseJobs,
  releaseAutomationStatus,
} from "./release-automation.js";
import {
  assertMutationOrigin,
  authenticateMaintainer,
  consumeReplayNonce,
  enforceRateLimit,
  redactError,
  verifyGatewaySignature,
} from "./security.js";
import { D1RoadmapStorage } from "./storage.js";

type Variables = {
  engine: RoadmapEngine;
  sync: DiscordSyncService;
};

export function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.use("*", secureHeaders());
  app.use("/api/*", async (context, next) => {
    const configured = context.env.ROADMAP_ALLOWED_ORIGINS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return cors({
      origin: configured?.length ? configured : roadmapConfig.auth.allowedOrigins,
      allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "If-Match"],
      allowMethods: ["GET", "HEAD", "OPTIONS", "POST", "PATCH", "DELETE"],
      maxAge: 86_400,
      credentials: false,
    })(context, next);
  });
  app.use("*", async (context, next) => {
    const storage = new D1RoadmapStorage(context.env.DB);
    const engine = new RoadmapEngine(storage, roadmapConfig);
    context.set("engine", engine);
    context.set("sync", new DiscordSyncService(context.env, roadmapConfig, engine));
    await next();
    const path = new URL(context.req.url).pathname;
    const isMutation = !["GET", "HEAD", "OPTIONS"].includes(context.req.method);
    if (
      context.res.ok &&
      isMutation &&
      (path.startsWith("/api/v1/items") || path === "/interactions/discord")
    ) {
      context.executionCtx.waitUntil(
        context.var.sync.processPendingJobs(20).catch((error) => {
          console.error("Discord synchronization attempt failed", redactError(error));
          return { processed: 0, failed: 1 };
        }),
      );
    }
  });

  app.onError((error, context) => {
    if (error instanceof RoadmapError) {
      return context.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        error.status as 400,
      );
    }
    if (error instanceof z.ZodError) {
      return context.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed.",
            details: error.issues,
          },
        },
        422,
      );
    }
    const requestId = context.req.header("CF-Ray") ?? crypto.randomUUID();
    console.error("Roadmap request failed", requestId, redactError(error));
    return context.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "The roadmap service could not complete the request.",
          details: { requestId },
        },
      },
      500,
    );
  });

  app.get("/healthz", async (context) => {
    const schema = await context.env.DB.prepare(
      "SELECT value FROM schema_metadata WHERE key='schema_version'",
    ).first<{ value: string }>();
    return context.json({
      ok: schema?.value === "3",
      schemaVersion: schema?.value ?? null,
      project: roadmapConfig.project.slug,
      time: new Date().toISOString(),
    });
  });

  app.get("/api/v1/config", (context) => {
    const publicConfig = {
      project: roadmapConfig.project,
      branding: roadmapConfig.branding,
      areas: roadmapConfig.areas,
      itemTypes: roadmapConfig.itemTypes,
      priorities: roadmapConfig.priorities,
      difficulties: roadmapConfig.difficulties,
    };
    return context.json(
      {
        ...publicConfig,
        lifecycle: roadmapConfig.lifecycle,
        publicSections: roadmapConfig.publicSections,
      },
      200,
      { "Cache-Control": "public, max-age=300, stale-while-revalidate=3600" },
    );
  });

  app.get("/api/v1/items", async (context) => {
    await enforcePublicRateLimit(context.req.raw, context.env);
    const query = context.req.query();
    const page = await context.var.engine.list({
      ...listFilter("status", query.status),
      ...listFilter("area", query.area),
      ...listFilter("type", query.type),
      ...listFilter("priority", query.priority),
      ...listFilter("difficulty", query.difficulty),
      ...(query.search ? { search: query.search.slice(0, 200) } : {}),
      ...(query.completedSince ? { completedSince: query.completedSince } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit ? { limit: Number(query.limit) } : {}),
    });
    return context.json(page, 200, {
      "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
      ETag: await weakEtag(page),
    });
  });

  app.get("/api/v1/items/:id", async (context) => {
    await enforcePublicRateLimit(context.req.raw, context.env);
    const item = await context.var.engine.get(context.req.param("id"));
    return context.json({ data: item }, 200, {
      "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
      ETag: `"${item.id}:${item.revision}"`,
    });
  });

  app.get("/api/v1/history", async (context) => {
    const history = await context.var.engine.history(
      context.req.query("itemId"),
      context.req.query("since"),
      Number(context.req.query("limit") ?? 100),
    );
    return context.json({ data: history });
  });

  app.get("/api/v1/items/:id/history", async (context) => {
    const history = await context.var.engine.history(
      context.req.param("id"),
      context.req.query("since"),
      Number(context.req.query("limit") ?? 100),
    );
    return context.json({ data: history });
  });

  app.post("/api/v1/validate", async (context) => {
    const input = await context.req.json();
    const parsed = RoadmapItemSchema.safeParse(input);
    if (!parsed.success) {
      return context.json({ valid: false, errors: parsed.error.issues }, 200);
    }
    const dynamicErrors: string[] = [];
    if (!roadmapConfig.areas.some((value) => value.id === parsed.data.area)) {
      dynamicErrors.push(`Unknown area: ${parsed.data.area}`);
    }
    if (!roadmapConfig.lifecycle.some((value) => value.id === parsed.data.status)) {
      dynamicErrors.push(`Unknown status: ${parsed.data.status}`);
    }
    return context.json({ valid: dynamicErrors.length === 0, errors: dynamicErrors });
  });

  app.get("/api/v1/discord/projection", async (context) => {
    const items = await context.var.engine.list({ limit: 250 });
    const projection = await generateDiscordProjection(items.data, roadmapConfig);
    return context.json({ data: projection });
  });

  app.get("/api/v1/sync/status", async (context) => {
    const status = await context.var.engine.syncStatus();
    const gateway =
      context.env.ROADMAP_GATEWAY_PROVIDER === "cloudflare"
        ? await gatewayRequest(context.env, "/status")
        : {
            provider:
              context.env.ROADMAP_GATEWAY_PROVIDER ?? roadmapConfig.deployment.gatewayProvider,
          };
    const lastReconcile = await context.env.DB.prepare(
      "SELECT value FROM discord_state WHERE key='last_reconcile_at'",
    ).first<{ value: string }>();
    return context.json({
      data: { ...status, gateway, lastReconcileAt: lastReconcile?.value ?? null },
    });
  });

  app.post("/api/v1/items", async (context) => {
    const actor = await authorizeMutation(context.req.raw, context.env);
    const input = CreateRoadmapItemSchema.parse(await context.req.json());
    const result = await context.var.engine.create(input, {
      actor,
      mutationId: mutationId(context.req.raw),
    });
    return context.json(withDiff(result), result.replayed ? 200 : 201);
  });

  app.patch("/api/v1/items/:id", async (context) => {
    const actor = await authorizeMutation(context.req.raw, context.env);
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        patch: RoadmapPatchSchema,
        overrideReason: z.string().trim().min(10).max(2_000).optional(),
      })
      .parse(await context.req.json());
    const result = await context.var.engine.update(
      context.req.param("id"),
      body.patch,
      body.expectedRevision,
      {
        actor,
        mutationId: mutationId(context.req.raw),
        ...(body.overrideReason ? { overrideReason: body.overrideReason } : {}),
      },
    );
    return context.json(withDiff(result));
  });

  app.post("/api/v1/items/:id/transition", async (context) => {
    const actor = await authorizeMutation(context.req.raw, context.env);
    const body = TransitionRequestSchema.parse(await context.req.json());
    const result = await context.var.engine.transition(
      context.req.param("id"),
      body.to,
      body.expectedRevision,
      {
        actor,
        mutationId: mutationId(context.req.raw),
        ...(body.overrideReason ? { overrideReason: body.overrideReason } : {}),
      },
    );
    return context.json(withDiff(result));
  });

  app.post("/api/v1/items/:id/link-discord", async (context) => {
    const actor = await authorizeMutation(context.req.raw, context.env);
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        thread: DiscordThreadLinkSchema,
      })
      .parse(await context.req.json());
    const item = await context.var.engine.get(context.req.param("id"));
    const links = [
      ...item.linkedDiscordThreads.filter((link) => link.threadId !== body.thread.threadId),
      body.thread,
    ];
    const result = await context.var.engine.update(
      item.id,
      { linkedDiscordThreads: links },
      body.expectedRevision,
      { actor, mutationId: mutationId(context.req.raw) },
    );
    await context.env.DB.prepare(
      `UPDATE discord_submissions SET linked_item_id=?,review_state='linked',updated_at=?
       WHERE thread_id=?`,
    )
      .bind(item.id, new Date().toISOString(), body.thread.threadId)
      .run();
    return context.json(withDiff(result));
  });

  app.post("/api/v1/items/:id/research", async (context) => {
    const actor = await authorizeMutation(context.req.raw, context.env);
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        research: z.string().trim().min(1).max(2_000),
      })
      .parse(await context.req.json());
    const item = await context.var.engine.get(context.req.param("id"));
    const result = await context.var.engine.update(
      item.id,
      { requiredResearch: [...item.requiredResearch, body.research] },
      body.expectedRevision,
      { actor, mutationId: mutationId(context.req.raw) },
    );
    return context.json(withDiff(result));
  });

  app.post("/api/v1/items/:id/acceptance-criteria", async (context) => {
    const actor = await authorizeMutation(context.req.raw, context.env);
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        criterion: AcceptanceCriterionSchema.omit({ id: true, updatedAt: true }),
      })
      .parse(await context.req.json());
    const item = await context.var.engine.get(context.req.param("id"));
    const criterion = AcceptanceCriterionSchema.parse({
      ...body.criterion,
      id: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    });
    const result = await context.var.engine.update(
      item.id,
      { acceptanceCriteria: [...item.acceptanceCriteria, criterion] },
      body.expectedRevision,
      { actor, mutationId: mutationId(context.req.raw) },
    );
    return context.json(withDiff(result));
  });

  app.post("/api/v1/items/:id/verifications", async (context) => {
    const actor = await authorizeMutation(context.req.raw, context.env);
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        verification: VerificationResultSchema.omit({ id: true, actor: true, verifiedAt: true }),
      })
      .parse(await context.req.json());
    const item = await context.var.engine.get(context.req.param("id"));
    const verification = VerificationResultSchema.parse({
      ...body.verification,
      id: crypto.randomUUID(),
      actor,
      verifiedAt: new Date().toISOString(),
    });
    const result = await context.var.engine.update(
      item.id,
      { verificationResults: [...item.verificationResults, verification] },
      body.expectedRevision,
      { actor, mutationId: mutationId(context.req.raw) },
    );
    return context.json(withDiff(result));
  });

  app.post("/api/v1/reconcile", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    const result = await context.var.sync.reconcile();
    return context.json({ data: result });
  });

  app.post("/api/v1/discord/publish", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    const body: { force?: boolean } = await context.req
      .json<{ force?: boolean }>()
      .catch(() => ({}));
    const result = await context.var.sync.publishRoadmap(Boolean(body.force));
    return context.json({ data: result });
  });

  app.post("/api/v1/discord/forums/configure", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    const body = z
      .object({
        icons: z.record(z.string(), z.string().max(512_000)).default({}),
        replaceIconKeys: z.array(z.string().min(1).max(64)).max(20).default([]),
      })
      .parse(await context.req.json().catch(() => ({})));
    return context.json({
      data: await context.var.sync.configureForums(body.icons, body.replaceIconKeys),
    });
  });

  app.post("/api/v1/discord/reports/status", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    return context.json({ data: await context.var.sync.reportAutomationStatus() });
  });

  app.post("/api/v1/discord/reports/process", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    const body = z
      .object({ limit: z.number().int().min(1).max(10).default(2) })
      .parse(await context.req.json().catch(() => ({})));
    const reports = await context.var.sync.processPendingReportJobs(body.limit);
    const sync = await context.var.sync.processPendingJobs(20);
    return context.json({ data: { reports, sync } });
  });

  app.post("/api/v1/sync/process", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    const body = z
      .object({ limit: z.number().int().min(1).max(100).default(20) })
      .parse(await context.req.json().catch(() => ({})));
    return context.json({ data: await context.var.sync.processPendingJobs(body.limit) });
  });

  app.post("/api/v1/ai/oauth/start", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    return context.json({ data: await beginAiOAuth(context.env) }, 201);
  });

  app.post("/api/v1/ai/oauth/complete", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    const body: { code?: unknown; state?: unknown } = await context.req
      .json<{ code?: unknown; state?: unknown }>()
      .catch(() => ({}));
    if (typeof body.code !== "string" || typeof body.state !== "string") {
      throw new RoadmapError(
        "OAUTH_CALLBACK_INVALID",
        "ChatGPT returned an incomplete authorization result.",
        400,
      );
    }
    return context.json({ data: await finishAiOAuth(context.env, body.code, body.state) });
  });

  app.get("/api/v1/ai/oauth/status", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    return context.json({ data: await aiOAuthStatus(context.env) });
  });

  app.delete("/api/v1/ai/oauth/session", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    await disconnectAiOAuth(context.env);
    return context.body(null, 204);
  });

  app.get("/api/v1/releases/status", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    return context.json({ data: await releaseAutomationStatus(context.env) });
  });

  app.post("/api/v1/releases/process", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    return context.json({
      data: await processPendingReleaseJobs(context.env, roadmapConfig, 2),
    });
  });

  app.post("/webhooks/github", async (context) => {
    const result = await acceptGithubReleaseWebhook(context.req.raw, context.env, roadmapConfig);
    if (result.accepted && !result.duplicate) {
      context.executionCtx.waitUntil(
        processPendingReleaseJobs(context.env, roadmapConfig, 1).catch((error) => {
          console.error("Release job background attempt failed", redactError(error));
          return { processed: 0, failed: 1 };
        }),
      );
    }
    return context.json({ data: result }, result.accepted ? 202 : 200);
  });

  app.post("/api/v1/discord/gateway/:action", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    const action = context.req.param("action");
    if (!["start", "stop", "status"].includes(action)) {
      throw new RoadmapError("INVALID_ACTION", "Unknown gateway action.", 400);
    }
    return context.json({ data: await gatewayRequest(context.env, `/${action}`) });
  });

  app.post("/api/internal/discord/events", async (context) => {
    if (!context.env.ROADMAP_GATEWAY_INGEST_SECRET) {
      throw new RoadmapError("GATEWAY_DISABLED", "Gateway ingestion is not configured.", 503);
    }
    const body = await context.req.text();
    const nonce = await verifyGatewaySignature(
      context.req.raw,
      context.env.ROADMAP_GATEWAY_INGEST_SECRET,
      body,
    );
    await consumeReplayNonce(context.env, `gateway:${nonce}`);
    const result = await context.var.sync.processEvent(JSON.parse(body));
    context.executionCtx.waitUntil(
      context.var.sync
        .processPendingReportJobs(1)
        .then(() => context.var.sync.processPendingJobs(20))
        .catch((error) => {
          console.error("Discord report analysis attempt failed", redactError(error));
          return { processed: 0, failed: 1 };
        }),
    );
    return context.json({ data: result });
  });

  app.post("/interactions/discord", async (context) =>
    handleDiscordInteraction(context.req.raw, context.env, roadmapConfig, context.var.engine),
  );

  app.all("/mcp", async (context) => {
    if (context.req.method === "GET") {
      return context.body(null, 405, { Allow: "POST" });
    }
    if (context.req.method !== "POST") {
      return context.body(null, 405, { Allow: "POST" });
    }
    const authorization = context.req.header("Authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const apiUrl = context.env.ROADMAP_PUBLIC_URL ?? new URL(context.req.url).origin;
    const server = createRoadmapMcpServer({
      apiUrl,
      ...(token ? { token } : {}),
    });
    const result = await server.handle(await context.req.json());
    if (!result) return context.body(null, 202);
    return context.json(result, 200, {
      "Cache-Control": "no-store",
      "MCP-Protocol-Version": "2025-11-25",
    });
  });

  app.all("*", async (context) => {
    const asset = await context.env.ASSETS.fetch(context.req.raw);
    // Asset binding responses have immutable headers. Hono's security-header
    // middleware needs a mutable response after the route returns.
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers: new Headers(asset.headers),
    });
  });
  return app;
}

async function authorizeMutation(request: Request, env: Env) {
  const configured = env.ROADMAP_ALLOWED_ORIGINS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  assertMutationOrigin(
    request,
    configured?.length ? configured : roadmapConfig.auth.allowedOrigins,
  );
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  await enforceRateLimit(env, `mutation:${ip}`, 60, 60);
  return authenticateMaintainer(request, env);
}

async function enforcePublicRateLimit(request: Request, env: Env) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  await enforceRateLimit(env, `public:${ip}`, 300, 60);
}

function listFilter(key: string, value?: string): Record<string, string[]> {
  return value
    ? {
        [key]: value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      }
    : {};
}

function mutationId(request: Request): string {
  const key = request.headers.get("Idempotency-Key");
  if (!key || key.length < 8 || key.length > 200) {
    throw new RoadmapError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Mutation requests require an Idempotency-Key header between 8 and 200 characters.",
      400,
    );
  }
  return key;
}

function withDiff(result: { before: unknown; after: unknown; replayed: boolean }) {
  return {
    data: {
      before: result.before,
      after: result.after,
      diff: diffValues(result.before, result.after),
      replayed: result.replayed,
    },
  };
}

async function weakEtag(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  const short = [...new Uint8Array(digest).slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `W/"${short}"`;
}

async function gatewayRequest(env: Env, path: string): Promise<unknown> {
  if (!env.ROADMAP_DISCORD_BOT_URL || !env.ROADMAP_GATEWAY_INGEST_SECRET) {
    throw new RoadmapError("DISCORD_BOT_UNAVAILABLE", "DiscordBot control is not configured.", 503);
  }
  const response = await fetch(
    `${env.ROADMAP_DISCORD_BOT_URL.replace(/\/+$/, "")}/internal/gateway${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.ROADMAP_GATEWAY_INGEST_SECRET}`,
      },
    },
  );
  if (!response.ok) {
    throw new RoadmapError(
      "DISCORD_BOT_UNAVAILABLE",
      `DiscordBot control request returned HTTP ${response.status}.`,
      502,
    );
  }
  return response.json();
}
