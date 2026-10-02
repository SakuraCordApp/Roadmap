// Generate the rounded status icons used as custom emoji on forum tags.
//
//   npm run tag-icons            -> writes assets/discord-tag-icons/*.svg|png
//   npm run tag-icons -- --json  -> prints {"sc_<status>": "data:image/png;base64,..."}
//
// The JSON is the `emojis` payload for POST /admin/setup/discord.

import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

const STATUSES = {
  new: "F472B6",
  needs_info: "FBBF24",
  confirmed: "38BDF8",
  planned: "60A5FA",
  in_progress: "A78BFA",
  in_nightly: "EF9BC4",
  shipped: "34D399",
  duplicate: "F59E0B",
  declined: "F87171",
  cant_reproduce: "9CA3AF",
};

const stroke = `fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"`;
const GLYPHS = {
  new: `<path d="M32 46V30" ${stroke}/><path d="M32 32c0-8-6-13-14-13 0 8 6 13 14 13Zm0-4c0-7 5-11 12-11 0 7-5 11-12 11Z" ${stroke}/>`,
  needs_info: `<path d="M25 24a7 7 0 1 1 10 6.3c-2 1-3 2.6-3 4.7v1" ${stroke}/><circle cx="32" cy="44" r="2.6" fill="#fff"/>`,
  confirmed: `<circle cx="32" cy="32" r="16" ${stroke}/><path d="m25 32 5 5 9-10" ${stroke}/>`,
  planned: `<rect x="15" y="18" width="34" height="31" rx="7" ${stroke}/><path d="M23 14v8M41 14v8M16 29h32M24 38h6M36 38h5" ${stroke}/>`,
  in_progress: `<path d="M49.39 27.34A18 18 0 1 1 32 14" ${stroke}/><path d="M32 14h8M34 8l6 6-6 6" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
  in_nightly: `<path d="M41 41A15 15 0 0 1 28 16a15 15 0 1 0 19 19 15 15 0 0 1-6 6Z" ${stroke}/>`,
  shipped: `<path d="M32 31c-5-3-6-9-3-13 1 1.5 2 2.5 3 2.5s2-1 3-2.5c3 4 2 10-3 13Z" fill="#fff" transform="rotate(0 32 32)"/><path d="M32 31c-5-3-6-9-3-13 1 1.5 2 2.5 3 2.5s2-1 3-2.5c3 4 2 10-3 13Z" fill="#fff" transform="rotate(72 32 32)"/><path d="M32 31c-5-3-6-9-3-13 1 1.5 2 2.5 3 2.5s2-1 3-2.5c3 4 2 10-3 13Z" fill="#fff" transform="rotate(144 32 32)"/><path d="M32 31c-5-3-6-9-3-13 1 1.5 2 2.5 3 2.5s2-1 3-2.5c3 4 2 10-3 13Z" fill="#fff" transform="rotate(216 32 32)"/><path d="M32 31c-5-3-6-9-3-13 1 1.5 2 2.5 3 2.5s2-1 3-2.5c3 4 2 10-3 13Z" fill="#fff" transform="rotate(288 32 32)"/><circle cx="32" cy="32" r="3" fill="#2c7a57"/>`,
  duplicate: `<rect x="14" y="14" width="27" height="27" rx="7" ${stroke}/><path d="M24 47a7 7 0 0 0 7 4h13a7 7 0 0 0 7-7V31a7 7 0 0 0-4-7" ${stroke}/>`,
  declined: `<circle cx="32" cy="32" r="18" ${stroke}/><path d="m20 44 24-24" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>`,
  cant_reproduce: `<circle cx="29" cy="29" r="11" ${stroke}/><path d="m37 37 9 9M25 25l8 8M33 25l-8 8" ${stroke}/>`,
};

function mix(left, right, ratio) {
  const a = [1, 3, 5].map((i) => Number.parseInt(left.slice(i, i + 2), 16));
  const b = [1, 3, 5].map((i) => Number.parseInt(right.slice(i, i + 2), 16));
  return `#${a
    .map((v, i) =>
      Math.round(v * (1 - ratio) + b[i] * ratio)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function svg(color, glyph) {
  const hex = `#${color}`;
  const start = mix(hex, "#000000", 0.18);
  const end = mix(hex, "#000000", 0.42);
  const outline = mix(hex, "#ffffff", 0.28);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse"><stop stop-color="${start}"/><stop offset="1" stop-color="${end}"/></linearGradient></defs><rect x="4" y="4" width="56" height="56" rx="18" fill="url(#g)" stroke="${outline}" stroke-width="2.5"/>${glyph}</svg>`;
}

const json = process.argv.includes("--json");
const payloads = {};
if (!json) await mkdir("assets/discord-tag-icons", { recursive: true });
for (const [status, color] of Object.entries(STATUSES)) {
  const source = svg(color, GLYPHS[status]);
  const png = await sharp(Buffer.from(source)).resize(128, 128).png().toBuffer();
  payloads[`sc_${status}`] = `data:image/png;base64,${png.toString("base64")}`;
  if (!json) {
    await writeFile(`assets/discord-tag-icons/${status}.svg`, `${source}\n`);
    await writeFile(`assets/discord-tag-icons/${status}.png`, png);
  }
}
if (json) process.stdout.write(JSON.stringify(payloads));
else console.log(`Wrote ${Object.keys(STATUSES).length} icons to assets/discord-tag-icons`);
