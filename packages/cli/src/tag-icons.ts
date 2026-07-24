import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

interface ColoredOption {
  id: string;
  color: string;
}

export interface TagIconTheme {
  primaryColor: string;
  accentColor: string;
  priorities: ColoredOption[];
  lifecycle: ColoredOption[];
}

const DEFAULT_PRIORITIES: ColoredOption[] = [
  { id: "critical", color: "#EF4444" },
  { id: "high", color: "#F97316" },
  { id: "medium", color: "#EAB308" },
  { id: "low", color: "#22C55E" },
];

const DEFAULT_LIFECYCLE: ColoredOption[] = [
  { id: "inbox", color: "#94A3B8" },
  { id: "planned", color: "#60A5FA" },
  { id: "in_progress", color: "#A78BFA" },
  { id: "polishing", color: "#F3A6C8" },
  { id: "declined", color: "#F87171" },
  { id: "duplicate", color: "#F59E0B" },
  { id: "done", color: "#34D399" },
];

export async function loadTagIconTheme(root: string): Promise<TagIconTheme> {
  const instance = JSON.parse(await readFile(path.join(root, "roadmap.instance.json"), "utf8")) as {
    branding?: { primaryColor?: unknown; accentColor?: unknown };
    priorities?: unknown;
    lifecycle?: unknown;
  };
  return {
    primaryColor: validColor(instance.branding?.primaryColor) ?? "#F3A6C8",
    accentColor: validColor(instance.branding?.accentColor) ?? "#D9578B",
    priorities: coloredOptions(instance.priorities, DEFAULT_PRIORITIES),
    lifecycle: coloredOptions(instance.lifecycle, DEFAULT_LIFECYCLE),
  };
}

export async function generateTagIconPayloads(
  theme: TagIconTheme,
): Promise<Record<string, string>> {
  const svgs = new Map<string, string>([
    ["visual", categorySvg(theme.primaryColor, theme.accentColor, "visual")],
    ["functionality", categorySvg(theme.primaryColor, theme.accentColor, "functionality")],
  ]);
  for (const priority of theme.priorities) {
    svgs.set(priority.id, prioritySvg(priority.id, priority.color));
  }
  for (const state of theme.lifecycle) {
    svgs.set(state.id, statusSvg(state.id, state.color));
  }
  return Object.fromEntries(
    await Promise.all(
      [...svgs].map(async ([key, svg]) => {
        const png = await sharp(Buffer.from(svg)).resize(128, 128).png().toBuffer();
        return [key, `data:image/png;base64,${png.toString("base64")}`];
      }),
    ),
  );
}

function categorySvg(start: string, end: string, kind: "visual" | "functionality"): string {
  const glyph =
    kind === "visual"
      ? `<path d="M13 32s7-11 19-11 19 11 19 11-7 11-19 11S13 32 13 32Z" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="32" r="6" fill="#fff"/>`
      : `<path d="M37 16a10 10 0 0 0-10 13L15 41a4 4 0 0 0 0 6l2 2a4 4 0 0 0 6 0l12-12a10 10 0 0 0 13-12l-7 7-7-2-2-7 7-7h-2Z" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  return framedSvg(start, end, glyph, false);
}

function prioritySvg(key: string, color: string): string {
  const start = mix(color, "#FFFFFF", 0.18);
  const end = mix(color, "#000000", 0.16);
  const shape =
    key === "low"
      ? `<path d="M28 10Q32 4 36 10L56 47Q60 55 51 55H13Q4 55 8 47L28 10Z" fill="url(#g)"/>`
      : key === "high"
        ? `<path d="M13.23 22.14L28.42 11.1Q32 8.5 35.58 11.1L50.77 22.14Q54.35 24.74 52.98 28.94L47.18 46.81Q45.81 51.01 41.39 51.01L22.61 51.01Q18.19 51.01 16.82 46.81L11.02 28.94Q9.65 24.74 13.23 22.14Z" fill="url(#g)"/>`
        : key === "critical"
          ? `<path d="M45.34 15.27L53.16 28.81Q55 32 53.16 35.19L45.34 48.73Q43.5 51.92 39.82 51.92L24.18 51.92Q20.5 51.92 18.66 48.73L10.84 35.19Q9 32 10.84 28.81L18.66 15.27Q20.5 12.08 24.18 12.08L39.82 12.08Q43.5 12.08 45.34 15.27Z" fill="url(#g)"/>`
          : `<rect x="8" y="8" width="48" height="48" rx="13" fill="url(#g)"/>`;
  return svg(start, end, shape);
}

function statusSvg(key: string, color: string): string {
  const glyphs: Record<string, string> = {
    inbox: `<path d="M14 35h11l4 6h6l4-6h11l-5-16H19l-5 16v11h36V35" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    planned: `<rect x="15" y="18" width="34" height="31" rx="7" fill="none" stroke="#fff" stroke-width="4.5"/><path d="M23 14v8M41 14v8M16 29h32M24 38h6M36 38h5" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/>`,
    in_progress: `<path d="M49.39 27.34A18 18 0 1 1 32 14" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/><path d="M32 14h8M34 8l6 6-6 6" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
    polishing: `<path d="m18 25 6-8h16l6 8-14 23-14-23Z" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 25h26M24 17l8 8 8-8M32 25v22" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    done: `<path d="m16 33 10 10 22-24" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`,
    declined: `<circle cx="32" cy="32" r="18" fill="none" stroke="#fff" stroke-width="4.5"/><path d="m20 44 24-24" stroke="#fff" stroke-width="5" stroke-linecap="round"/>`,
    duplicate: `<rect x="14" y="14" width="27" height="27" rx="7" fill="none" stroke="#fff" stroke-width="4.5"/><path d="M24 47a7 7 0 0 0 7 4h13a7 7 0 0 0 7-7V31a7 7 0 0 0-4-7" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/>`,
  };
  const fallback = `<circle cx="32" cy="32" r="15" fill="none" stroke="#fff" stroke-width="4.5"/><path d="M24 32h16" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/>`;
  return framedSvg(
    mix(color, "#000000", 0.18),
    mix(color, "#000000", 0.42),
    glyphs[key] ?? fallback,
    true,
    mix(color, "#FFFFFF", 0.28),
  );
}

function framedSvg(
  start: string,
  end: string,
  glyph: string,
  outlined: boolean,
  stroke = mix(start, "#FFFFFF", 0.3),
): string {
  return svg(
    start,
    end,
    `<rect x="4" y="4" width="56" height="56" rx="18" fill="url(#g)"${outlined ? ` stroke="${stroke}" stroke-width="2.5"` : ""}/>${glyph}`,
  );
}

function svg(start: string, end: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse"><stop stop-color="${start}"/><stop offset="1" stop-color="${end}"/></linearGradient></defs>${body}</svg>`;
}

function coloredOptions(value: unknown, fallback: ColoredOption[]): ColoredOption[] {
  if (!Array.isArray(value)) return fallback;
  const parsed = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as { id?: unknown; color?: unknown };
    const color = validColor(candidate.color);
    return typeof candidate.id === "string" && color ? [{ id: candidate.id, color }] : [];
  });
  return parsed.length ? parsed : fallback;
}

function validColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value)
    ? value.toUpperCase()
    : undefined;
}

function mix(left: string, right: string, ratio: number): string {
  const a = rgb(left);
  const b = rgb(right);
  const channel = (first: number, second: number) =>
    Math.round(first * (1 - ratio) + second * ratio)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(a[0], b[0])}${channel(a[1], b[1])}${channel(a[2], b[2])}`.toUpperCase();
}

function rgb(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}
