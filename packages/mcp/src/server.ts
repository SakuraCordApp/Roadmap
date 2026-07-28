import type { CreateRoadmapItem, RoadmapPatch } from "@roadmap/core";
import { z } from "zod";
import { RoadmapApiClient } from "./client.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface RegisteredTool {
  name: string;
  title?: string;
  description?: string;
  schema: z.ZodObject<z.ZodRawShape>;
  annotations?: ToolAnnotations;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export class RoadmapMcpServer {
  private readonly tools: RegisteredTool[] = [];

  registerTool<Shape extends z.ZodRawShape>(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: Shape;
      annotations?: ToolAnnotations;
    },
    callback: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
  ): void {
    const schema = z.object(config.inputSchema ?? ({} as Shape)).strict();
    this.tools.push({
      name,
      title: config.title,
      description: config.description,
      schema,
      annotations: config.annotations,
      execute: callback as (args: Record<string, unknown>) => Promise<ToolResult>,
    });
  }

  async handle(message: JsonRpcMessage): Promise<Record<string, unknown> | null> {
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    if (!message.method) {
      return hasId ? this.error(message.id, -32600, "Invalid Request") : null;
    }
    if (
      message.method === "notifications/initialized" ||
      message.method === "notifications/cancelled"
    ) {
      return null;
    }
    if (!hasId) return null;
    if (message.method === "initialize") {
      const requested = String(message.params?.protocolVersion ?? "");
      const protocolVersion = ["2025-11-25", "2025-06-18"].includes(requested)
        ? requested
        : "2025-11-25";
      return this.result(message.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "roadmap-management",
          title: "Roadmap Management",
          version: "0.1.0",
          description: "Revision-safe canonical roadmap management tools.",
        },
        instructions:
          "Read an item's current revision before mutation. Keep roadmap data limited to report-supported fields and lifecycle metadata.",
      });
    }
    if (message.method === "ping") return this.result(message.id, {});
    if (message.method === "tools/list") {
      return this.result(message.id, {
        tools: this.tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: z.toJSONSchema(tool.schema, { target: "draft-7" }),
          annotations: tool.annotations,
          execution: { taskSupport: "forbidden" },
        })),
      });
    }
    if (message.method === "tools/call") {
      const name = String(message.params?.name ?? "");
      const tool = this.tools.find((candidate) => candidate.name === name);
      if (!tool) return this.error(message.id, -32602, `Unknown tool: ${name}`);
      const parsed = tool.schema.safeParse(message.params?.arguments ?? {});
      if (!parsed.success) {
        return this.error(
          message.id,
          -32602,
          "Tool arguments failed validation.",
          parsed.error.issues,
        );
      }
      try {
        return this.result(message.id, await tool.execute(parsed.data));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return this.result(message.id, {
          content: [{ type: "text", text }],
          isError: true,
        });
      }
    }
    return this.error(message.id, -32601, `Method not found: ${message.method}`);
  }

  private result(id: JsonRpcMessage["id"], result: unknown): Record<string, unknown> {
    return { jsonrpc: "2.0", id: id ?? null, result };
  }

  private error(
    id: JsonRpcMessage["id"],
    code: number,
    message: string,
    data?: unknown,
  ): Record<string, unknown> {
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    };
  }
}

export interface RepositoryInspector {
  search(
    query: string,
    limit: number,
  ): Promise<Array<{ path: string; line: number; text: string }>>;
  recentChanges(
    since: string,
  ): Promise<Array<{ commit: string; subject: string; files: string[] }>>;
}

export interface RoadmapMcpOptions {
  apiUrl: string;
  token?: string;
  repositoryInspector?: RepositoryInspector;
}

const Id = z.string().min(3).max(64);
const ExpectedRevision = z.number().int().positive();

export function createRoadmapMcpServer(options: RoadmapMcpOptions): RoadmapMcpServer {
  const api = new RoadmapApiClient(options.apiUrl, options.token);
  const server = new RoadmapMcpServer();

  server.registerTool(
    "roadmap_list",
    {
      title: "List roadmap items",
      description:
        "List canonical roadmap items with optional status, area, type, priority, and search filters.",
      inputSchema: {
        status: z.string().optional(),
        area: z.string().optional(),
        type: z.string().optional(),
        priority: z.string().optional(),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(250).default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      toolResult(
        await api.list({
          status: args.status,
          area: args.area,
          type: args.type,
          priority: args.priority,
          search: args.search,
          limit: args.limit,
        }),
      ),
  );

  server.registerTool(
    "roadmap_get",
    {
      title: "Get roadmap item",
      description: "Get the complete current revision of one canonical roadmap item.",
      inputSchema: { id: Id },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => toolResult(await api.get(id)),
  );

  server.registerTool(
    "roadmap_search",
    {
      title: "Search roadmap",
      description:
        "Search title and description, optionally narrowing by area, type, or lifecycle state.",
      inputSchema: {
        query: z.string().min(1).max(200),
        status: z.string().optional(),
        area: z.string().optional(),
        type: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, ...filters }) => toolResult(await api.search(query, filters)),
  );

  server.registerTool(
    "roadmap_create",
    {
      title: "Create roadmap item",
      description:
        "Create a validated canonical roadmap item. New community submissions enter Planned after automated analysis.",
      inputSchema: {
        title: z.string().min(1).max(180),
        description: z.string().min(1).max(20_000),
        type: z.string().min(1),
        area: z.string().min(1),
        status: z.string().default("planned"),
        priority: z.string().min(1),
        labels: z.array(z.string().min(1).max(64)).max(50).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => toolResult(await api.create(args as CreateRoadmapItem)),
  );

  server.registerTool(
    "roadmap_update",
    {
      title: "Update roadmap item",
      description:
        "Update fields on an item using optimistic concurrency. Status changes must use roadmap_transition.",
      inputSchema: {
        id: Id,
        expectedRevision: ExpectedRevision,
        patch: z.record(z.string(), z.unknown()),
        overrideReason: z.string().min(10).max(2_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ id, expectedRevision, patch, overrideReason }) =>
      toolResult(await api.update(id, expectedRevision, patch as RoadmapPatch, overrideReason)),
  );

  server.registerTool(
    "roadmap_transition",
    {
      title: "Transition roadmap item",
      description:
        "Move an item through the configured lifecycle with revision checking and acceptance-criteria gates.",
      inputSchema: {
        id: Id,
        expectedRevision: ExpectedRevision,
        to: z.string().min(1),
        overrideReason: z.string().min(10).max(2_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ id, expectedRevision, to, overrideReason }) =>
      toolResult(await api.transition(id, expectedRevision, to, overrideReason)),
  );

  server.registerTool(
    "roadmap_link_discord_thread",
    {
      title: "Link Discord thread",
      description: "Link a Feature Request or Bug Report forum thread to a canonical roadmap item.",
      inputSchema: {
        id: Id,
        expectedRevision: ExpectedRevision,
        threadId: z.string().regex(/^\d{17,20}$/),
        forumId: z.string().regex(/^\d{17,20}$/),
        guildId: z.string().regex(/^\d{17,20}$/),
        kind: z.enum(["feature_request", "bug_report"]),
        title: z.string().min(1).max(100),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ id, expectedRevision, threadId, forumId, guildId, kind, title }) =>
      toolResult(
        await api.linkDiscord(id, expectedRevision, {
          threadId,
          forumId,
          guildId,
          kind,
          title,
          url: `https://discord.com/channels/${guildId}/${threadId}`,
          linkedAt: new Date().toISOString(),
        }),
      ),
  );

  server.registerTool(
    "roadmap_add_acceptance_criterion",
    {
      title: "Add acceptance criterion",
      description: "Add an objective, independently verifiable acceptance criterion.",
      inputSchema: {
        id: Id,
        expectedRevision: ExpectedRevision,
        statement: z.string().min(1).max(2_000),
        satisfied: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ id, expectedRevision, statement, satisfied }) =>
      toolResult(
        await api.addCriterion(id, expectedRevision, {
          statement,
          satisfied,
          evidence: [],
        }),
      ),
  );

  server.registerTool(
    "roadmap_generate_discord_view",
    {
      title: "Generate Discord roadmap view",
      description:
        "Generate the feature-name-only Discord projection and its drift-prevention hash without publishing it.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => toolResult(await api.projection()),
  );

  server.registerTool(
    "roadmap_validate",
    {
      title: "Validate roadmap data",
      description: "Validate a complete roadmap item against strict and configured schemas.",
      inputSchema: { item: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ item }) => toolResult(await api.validate(item)),
  );

  server.registerTool(
    "roadmap_sync_status",
    {
      title: "Get synchronization status",
      description:
        "Inspect pending/failed synchronization jobs, Gateway status, and reconciliation time.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => toolResult(await api.syncStatus()),
  );

  server.registerTool(
    "roadmap_reconcile",
    {
      title: "Reconcile Discord state",
      description:
        "Run an idempotent REST reconciliation of active and archived forum posts, messages, attachments, tags, and database links.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => toolResult(await api.reconcile()),
  );

  server.registerTool(
    "roadmap_history",
    {
      title: "Read roadmap history",
      description: "Read complete mutation history for an item or for a time range.",
      inputSchema: {
        itemId: Id.optional(),
        since: z.iso.datetime().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ itemId, since, limit }) => toolResult(await api.history(itemId, since, limit)),
  );

  if (options.repositoryInspector) {
    const inspector = options.repositoryInspector;
    server.registerTool(
      "roadmap_inspect_repository",
      {
        title: "Inspect configured application repository",
        description:
          "Read-only search of the separately configured application repository. This tool never writes roadmap data or commits there.",
        inputSchema: {
          query: z.string().min(1).max(200),
          limit: z.number().int().min(1).max(200).default(50),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ query, limit }) => toolResult(await inspector.search(query, limit)),
    );
    server.registerTool(
      "roadmap_repository_changes",
      {
        title: "Inspect application changes",
        description:
          "Read recent commits and changed files from the configured application repository for evidence-backed roadmap status review.",
        inputSchema: { since: z.string().min(1).max(100).default("1 week ago") },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ since }) => toolResult(await inspector.recentChanges(since)),
    );
  }

  return server;
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: normalizeStructured(value),
  };
}

function normalizeStructured(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
}
