import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "assets", "discord-roadmap-emojis");
const apiUrl = (process.env.ROADMAP_API_URL ?? "https://roadmap.sakuracord.app").replace(/\/$/, "");
const token =
  process.env.ROADMAP_TOKEN ??
  execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "dev.sakuracord.roadmap-maintainer"],
    { encoding: "utf8" },
  ).trim();
const emojis = {};
for (const key of ["line", "dot"]) {
  const image = await readFile(path.join(directory, `${key}.png`));
  emojis[key] = `data:image/png;base64,${image.toString("base64")}`;
}
const response = await fetch(`${apiUrl}/api/v1/discord/roadmap-emojis/configure`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Idempotency-Key": `roadmap-emojis-${Date.now()}`,
  },
  body: JSON.stringify({ emojis, replaceKeys: ["line", "dot"] }),
});
const payload = await response.json();
if (!response.ok) {
  throw new Error(`Roadmap emoji configuration failed with HTTP ${response.status}.`);
}
for (const emoji of payload.data) {
  console.log(`${emoji.name}: ${emoji.id}`);
}
