import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

if (!process.env.ROADMAP_API_URL) throw new Error("ROADMAP_API_URL is required.");
const child = spawn("node", [path.resolve("packages/mcp/dist/index.js")], {
  env: { ...process.env, ROADMAP_API_URL: process.env.ROADMAP_API_URL },
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: child.stdout });
const responses = new Map<number, (value: any) => void>();
lines.on("line", (line) => {
  const value = JSON.parse(line);
  if (typeof value.id === "number") responses.get(value.id)?.(value);
});
const send = (id: number, method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve) => {
    responses.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
await send(1, "initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "roadmap-cli-doctor", version: "0.1.0" },
});
child.stdin.write(
  `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
);
const listResponse = await send(2, "tools/list");
const tools = listResponse.result.tools as Array<{ name: string }>;
const required = [
  "roadmap_list",
  "roadmap_get",
  "roadmap_create",
  "roadmap_transition",
  "roadmap_reconcile",
  "roadmap_history",
];
for (const name of required) {
  if (!tools.some((tool) => tool.name === name)) throw new Error(`MCP tool missing: ${name}`);
}
child.stdin.end();
await new Promise((resolve) => child.once("exit", resolve));
process.stdout.write(`Verified ${tools.length} MCP tools.\n`);
