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
  enforceRateLimit,
  redactError,
} from "./security.js";
import {
  DEFAULT_JSON_BODY_LIMIT,
  FORUM_CONFIGURATION_BODY_LIMIT,
  readJsonBodyLimited,
} from "./request-body.js";
import { D1RoadmapStorage } from "./storage.js";

type Variables = {
  engine: RoadmapEngine;
  sync: DiscordSyncService;
};

const csvFilter = z
  .string()
  .trim()
  .max(500)
  .transform((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1).max(64)).max(20))
  .optional();
const isoDateTime = z
  .string()
  .trim()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), "Expected an ISO 8601 date-time.");
const ListQuerySchema = z
  .object({
    status: csvFilter,
    area: csvFilter,
    type: csvFilter,
    priority: csvFilter,
    difficulty: csvFilter,
    search: z.string().trim().max(200).optional(),
    completedSince: isoDateTime.optional(),
    cursor: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(250).optional(),
  })
  .strict();
const HistoryQuerySchema = z
  .object({
    itemId: z.string().trim().min(1).max(100).optional(),
    since: isoDateTime.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

export function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
      permissionsPolicy: {
        camera: [],
        geolocation: [],
        microphone: [],
        payment: [],
        usb: [],
      },
    }),
  );
  app.use("/api/*", async (context, next) => {
    const configured = context.env.ROADMAP_ALLOWED_ORIGINS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return cors({
      origin: configured?.length ? configured : roadmapConfig.auth.allowedOrigins,
      allowHeaders: [
        "Authorization",
        "Content-Type",
        "Idempotency-Key",
        "If-Match",
        "If-None-Match",
      ],
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
      const retryAfter =
        error.code === "RATE_LIMITED" &&
        typeof error.details === "object" &&
        error.details !== null &&
        "retryAfterSeconds" in error.details
          ? String((error.details as { retryAfterSeconds: number }).retryAfterSeconds)
          : undefined;
      return context.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        error.status as 400,
        retryAfter ? { "Retry-After": retryAfter } : undefined,
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
    return context.json(
      {
        ok: schema?.value === "5",
        schemaVersion: schema?.value ?? null,
        project: roadmapConfig.project.slug,
      },
      200,
      { "Cache-Control": "no-store" },
    );
  });

  app.get("/api/v1/config", async (context) => {
    await enforcePublicRateLimit(context.req.raw, context.env);
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
    const query = ListQuerySchema.parse(context.req.query());
    const page = await context.var.engine.list({
      ...(query.status ? { status: query.status } : {}),
      ...(query.area ? { area: query.area } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.difficulty ? { difficulty: query.difficulty } : {}),
      ...(query.search ? { search: query.search } : {}),
      ...(query.completedSince ? { completedSince: query.completedSince } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
    const etag = await weakEtag(page);
    const headers = {
      "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
      ETag: etag,
    };
    if (etagMatches(context.req.header("If-None-Match"), etag)) {
      return context.body(null, 304, headers);
    }
    return context.json(page, 200, headers);
  });

  app.get("/api/v1/items/:id", async (context) => {
    await enforcePublicRateLimit(context.req.raw, context.env);
    const item = await context.var.engine.get(context.req.param("id"));
    const etag = `"${item.id}:${item.revision}"`;
    const headers = {
      "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
      ETag: etag,
    };
    if (etagMatches(context.req.header("If-None-Match"), etag)) {
      return context.body(null, 304, headers);
    }
    return context.json({ data: item }, 200, headers);
  });

  app.get("/api/v1/history", async (context) => {
    await enforcePublicRateLimit(context.req.raw, context.env);
    const query = HistoryQuerySchema.parse(context.req.query());
    const history = await context.var.engine.history(query.itemId, query.since, query.limit);
    return context.json({ data: history });
  });

  app.get("/api/v1/items/:id/history", async (context) => {
    await enforcePublicRateLimit(context.req.raw, context.env);
    const query = HistoryQuerySchema.omit({ itemId: true }).parse(context.req.query());
    const history = await context.var.engine.history(
      context.req.param("id"),
      query.since,
      query.limit,
    );
    return context.json({ data: history });
  });

  app.post("/api/v1/validate", async (context) => {
    await enforcePublicRateLimit(context.req.raw, context.env);
    const input = await readJsonBodyLimited(context.req.raw);
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
    await enforcePublicRateLimit(context.req.raw, context.env);
    const items = await context.var.engine.list({ limit: 250 });
    const projection = await generateDiscordProjection(items.data, roadmapConfig);
    return context.json({ data: projection });
  });

  app.get("/api/v1/sync/status", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    const status = await context.var.engine.syncStatus();
    const lastReconcile = await context.env.DB.prepare(
      "SELECT value FROM discord_state WHERE key='last_reconcile_at'",
    ).first<{ value: string }>();
    return context.json({
      data: {
        ...status,
        gateway: {
          provider: "cloudflare-scheduled-reconciliation",
          mode: "polling",
          intervalSeconds: 60,
        },
        lastReconcileAt: lastReconcile?.value ?? null,
      },
    });
  });

  app.post("/api/v1/items", async (context) => {
    const actor = await authorizeMutation(context.req.raw, context.env);
    const input = CreateRoadmapItemSchema.parse(await readJsonBodyLimited(context.req.raw));
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
      .parse(await readJsonBodyLimited(context.req.raw));
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
    const body = TransitionRequestSchema.parse(await readJsonBodyLimited(context.req.raw));
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
      .parse(await readJsonBodyLimited(context.req.raw));
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
      .parse(await readJsonBodyLimited(context.req.raw));
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
      .parse(await readJsonBodyLimited(context.req.raw));
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
      .parse(await readJsonBodyLimited(context.req.raw));
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
    const body = await readJsonBodyLimited<{ force?: boolean }>(
      context.req.raw,
      DEFAULT_JSON_BODY_LIMIT,
      {},
    );
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
      .parse(await readJsonBodyLimited(context.req.raw, FORUM_CONFIGURATION_BODY_LIMIT, {}));
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
      .parse(await readJsonBodyLimited(context.req.raw, DEFAULT_JSON_BODY_LIMIT, {}));
    const reports = await context.var.sync.processPendingReportJobs(body.limit);
    const sync = await context.var.sync.processPendingJobs(20);
    return context.json({ data: { reports, sync } });
  });

  app.post("/api/v1/sync/process", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    const body = z
      .object({ limit: z.number().int().min(1).max(100).default(20) })
      .parse(await readJsonBodyLimited(context.req.raw, DEFAULT_JSON_BODY_LIMIT, {}));
    return context.json({ data: await context.var.sync.processPendingJobs(body.limit) });
  });

  app.post("/api/v1/ai/oauth/start", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    return context.json({ data: await beginAiOAuth(context.env) }, 201);
  });

  app.post("/api/v1/ai/oauth/complete", async (context) => {
    await authorizeMutation(context.req.raw, context.env);
    const body = await readJsonBodyLimited<{ code?: unknown; state?: unknown }>(
      context.req.raw,
      DEFAULT_JSON_BODY_LIMIT,
      {},
    );
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
    if (action === "start") {
      return context.json({
        data: {
          started: true,
          provider: "cloudflare-scheduled-reconciliation",
          reconciliation: await context.var.sync.reconcile(),
        },
      });
    }
    return context.json({
      data: {
        stopped: false,
        connected: false,
        healthy: true,
        managedByCron: true,
        provider: "cloudflare-scheduled-reconciliation",
        mode: "polling",
        intervalSeconds: 60,
      },
    });
  });

  app.post("/interactions/discord", async (context) =>
    handleDiscordInteraction(
      context.req.raw,
      context.env,
      roadmapConfig,
      context.var.engine,
      context.executionCtx,
    ),
  );

  app.all("/mcp", async (context) => {
    if (context.req.method === "GET") {
      return context.body(null, 405, { Allow: "POST" });
    }
    if (context.req.method !== "POST") {
      return context.body(null, 405, { Allow: "POST" });
    }
    await enforcePublicRateLimit(context.req.raw, context.env);
    const authorization = context.req.header("Authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const apiUrl = context.env.ROADMAP_PUBLIC_URL ?? new URL(context.req.url).origin;
    const server = createRoadmapMcpServer({
      apiUrl,
      ...(token ? { token } : {}),
    });
    const result = await server.handle(await readJsonBodyLimited(context.req.raw));
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
  await enforceRateLimit(env, `mutation:${ip}`, 60, 60, env.MUTATION_RATE_LIMITER);
  return authenticateMaintainer(request, env);
}

async function enforcePublicRateLimit(request: Request, env: Env) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  await enforceRateLimit(env, `public:${ip}`, 300, 60, env.PUBLIC_RATE_LIMITER);
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

function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim())
    .some(
      (value) =>
        value === "*" || value === etag || value.replace(/^W\//, "") === etag.replace(/^W\//, ""),
    );
}
