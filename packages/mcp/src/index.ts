#!/usr/bin/env node
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { Command } from "commander";
import { createRoadmapMcpServer, type JsonRpcMessage, type RepositoryInspector } from "./server.js";

const execFileAsync = promisify(execFile);
const program = new Command()
  .name("roadmap-mcp")
  .option("--transport <transport>", "stdio or http", "stdio")
  .option("--port <port>", "HTTP port", "8788")
  .option("--host <host>", "HTTP bind host", "127.0.0.1")
  .option("--api-url <url>", "Roadmap API URL", process.env.ROADMAP_API_URL)
  .parse();

const options = program.opts<{
  transport: "stdio" | "http";
  port: string;
  host: string;
  apiUrl?: string;
}>();
if (!options.apiUrl) throw new Error("ROADMAP_API_URL or --api-url is required.");

const repositoryPath = process.env.ROADMAP_APP_REPOSITORY;
const inspector = repositoryPath ? createRepositoryInspector(repositoryPath) : undefined;

if (options.transport === "stdio") {
  const server = createRoadmapMcpServer({
    apiUrl: options.apiUrl,
    ...(process.env.ROADMAP_TOKEN ? { token: process.env.ROADMAP_TOKEN } : {}),
    ...(inspector ? { repositoryInspector: inspector } : {}),
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      continue;
    }
    const response = await server.handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
} else if (options.transport === "http") {
  const httpServer = createServer(async (request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end("Not found");
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const host = request.headers.host?.split(":")[0];
    if (options.host === "127.0.0.1" && host && !["127.0.0.1", "localhost"].includes(host)) {
      response.writeHead(403).end("Host is not allowed");
      return;
    }
    const bearer = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : process.env.ROADMAP_TOKEN;
    const mcp = createRoadmapMcpServer({
      apiUrl: options.apiUrl!,
      ...(bearer ? { token: bearer } : {}),
      ...(inspector ? { repositoryInspector: inspector } : {}),
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1_048_576) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(buffer);
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcMessage;
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
      );
      return;
    }
    const result = await mcp.handle(message);
    if (!result) {
      response.writeHead(202).end();
      return;
    }
    response
      .writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "MCP-Protocol-Version": "2025-11-25",
      })
      .end(JSON.stringify(result));
  });
  httpServer.listen(Number(options.port), options.host, () => {
    process.stderr.write(`Roadmap MCP listening on http://${options.host}:${options.port}/mcp\n`);
  });
} else {
  throw new Error(`Unsupported transport: ${options.transport}`);
}

function createRepositoryInspector(repository: string): RepositoryInspector {
  return {
    async search(query, limit) {
      const { stdout } = await execFileAsync(
        "rg",
        ["--line-number", "--color", "never", "--max-count", String(limit), "--", query, "."],
        {
          cwd: repository,
          maxBuffer: 2 * 1024 * 1024,
        },
      ).catch((error: any) => {
        if (error.code === 1) return { stdout: "", stderr: "" };
        throw error;
      });
      return stdout
        .split("\n")
        .filter(Boolean)
        .slice(0, limit)
        .map((line) => {
          const match = line.match(/^(.+?):(\d+):(.*)$/);
          return match
            ? { path: match[1]!, line: Number(match[2]), text: match[3]! }
            : { path: "", line: 0, text: line };
        });
    },
    async recentChanges(since) {
      const separator = "\u001f";
      const record = "\u001e";
      const { stdout } = await execFileAsync(
        "git",
        [
          "-C",
          repository,
          "log",
          `--since=${since}`,
          `--pretty=format:%H${separator}%s${record}`,
          "--name-only",
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      return stdout
        .split(record)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [header, ...files] = entry.split("\n").filter(Boolean);
          const [commit, subject] = (header ?? "").split(separator);
          return { commit: commit ?? "", subject: subject ?? "", files };
        });
    },
  };
}
