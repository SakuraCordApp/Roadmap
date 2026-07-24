#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "plugins/roadmap-management");
const manifestPath = path.join(root, ".codex-plugin/plugin.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const errors = [];

if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name ?? "")) {
  errors.push("name must be kebab-case");
}
if (path.basename(root) !== manifest.name) errors.push("plugin folder must match manifest name");
if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(manifest.version ?? "")) {
  errors.push("version must be semantic");
}
for (const field of [
  "description",
  "author.name",
  "interface.displayName",
  "interface.shortDescription",
  "interface.longDescription",
  "interface.developerName",
  "interface.category",
]) {
  const value = field.split(".").reduce((object, key) => object?.[key], manifest);
  if (typeof value !== "string" || !value.trim()) errors.push(`${field} is required`);
}
for (const field of ["skills", "mcpServers"]) {
  if (manifest[field]) {
    try {
      await access(path.resolve(root, manifest[field]));
    } catch {
      errors.push(`${field} references a missing path`);
    }
  }
}
const serialized = JSON.stringify(manifest);
if (serialized.includes("[TODO:")) errors.push("manifest contains TODO placeholders");
if (errors.length) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Validated ${manifest.name} ${manifest.version}\n`);
