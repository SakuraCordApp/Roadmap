import { spawnSync } from "node:child_process";

const REPORT_QUEUE = "sakuracord-discord-reports";

// Production resources are provisioned only inside the GitHub-triggered
// Cloudflare Workers Builds environment. Local validation stays read-only.
if (process.env.WORKERS_CI === "1") {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const listed = spawnSync(npx, ["wrangler", "queues", "list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (listed.status !== 0) {
    throw new Error("Unable to list Cloudflare Queues during Workers Build.");
  }

  const queueExists = listed.stdout.split(/\s+/u).includes(REPORT_QUEUE);
  if (queueExists) {
    console.log(`Cloudflare Queue ${REPORT_QUEUE} already exists.`);
  } else {
    console.log(`Creating Cloudflare Queue ${REPORT_QUEUE} from Workers Build.`);
    const created = spawnSync(npx, ["wrangler", "queues", "create", REPORT_QUEUE], {
      stdio: "inherit",
    });
    if (created.status !== 0) {
      throw new Error(`Unable to create Cloudflare Queue ${REPORT_QUEUE}.`);
    }
  }
}
