import { spawnSync } from "node:child_process";

// Production resources are provisioned only inside the GitHub-triggered
// Cloudflare Workers Build. Local checks never create Cloudflare resources.
if (process.env.WORKERS_CI === "1") {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const run = (args, options = {}) =>
    spawnSync(npx, ["wrangler", ...args], { encoding: "utf8", ...options });

  const queue = "sakuracord-discord-reports";
  const queues = run(["queues", "list"], { stdio: ["ignore", "pipe", "inherit"] });
  if (queues.status !== 0) throw new Error("Unable to list Cloudflare Queues.");
  if (!queues.stdout.split(/\s+/u).includes(queue)) {
    if (run(["queues", "create", queue], { stdio: "inherit" }).status !== 0) {
      throw new Error(`Unable to create Cloudflare Queue ${queue}.`);
    }
  }

  const index = "sakuracord-issues";
  const indexes = run(["vectorize", "list", "--json"], { stdio: ["ignore", "pipe", "inherit"] });
  const names = indexes.status === 0 ? indexes.stdout : "";
  if (!names.includes(`"${index}"`)) {
    const created = run(["vectorize", "create", index, "--dimensions=1024", "--metric=cosine"], {
      stdio: "inherit",
    });
    if (created.status !== 0) console.warn(`Vectorize index ${index} could not be created here.`);
  }
}
