import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconDirectory = path.join(root, "assets", "discord-tag-icons");
const apiUrl = (process.env.ROADMAP_API_URL ?? "https://roadmap.sakuracord.app").replace(/\/$/, "");
const token =
  process.env.ROADMAP_TOKEN ??
  execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "dev.sakuracord.roadmap-maintainer"],
    { encoding: "utf8" },
  ).trim();
const files = (await readdir(iconDirectory))
  .filter((name) => name.endsWith(".png") && name !== "preview.png")
  .sort();
const icons = {};
for (const file of files) {
  icons[path.basename(file, ".png")] =
    `data:image/png;base64,${(await readFile(path.join(iconDirectory, file))).toString("base64")}`;
}
const replaceIconKeys = (process.env.ROADMAP_REPLACE_ICON_KEYS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const response = await fetch(`${apiUrl}/api/v1/discord/forums/configure`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ icons, replaceIconKeys }),
});
const payload = await response.json();
if (!response.ok) {
  throw new Error(`Forum configuration failed with HTTP ${response.status}.`);
}
for (const forum of payload.data) {
  console.log(`${forum.forumName}: ${forum.tags.length} tags with custom icons`);
}
