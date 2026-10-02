import { z } from "zod";
import { AREAS, type IssueKind } from "./config";
import type { DraftUser } from "./db/store";
import type { UploadFile } from "./discord/rest";
import type { Env } from "./env";
import { publicMeta } from "./api/public";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  addDetails,
  addMeToo,
  createDraft,
  fileReport,
  findSimilar,
  versionOptions,
} from "./reports";
import { REPORT_KINDS, TITLE_MAX_LENGTH, type ReportField } from "./report/schema";
import { websiteComment } from "./sync/comments";
import { randomId } from "./util/crypto";

// Operations the website performs through its service binding. They are not
// reachable from the internet; the website authenticates people with Discord
// and passes the verified identity along.

const User = z.object({
  id: z.string().regex(/^\d{17,20}$/),
  username: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  avatarUrl: z.string().url().nullable().optional(),
});

const File = z.object({
  name: z.string().min(1).max(200),
  type: z.string().max(100).optional(),
  data: z.instanceof(ArrayBuffer),
});

function validateValues(kind: IssueKind, values: Record<string, string>): Record<string, string> {
  const definition = REPORT_KINDS[kind];
  const clean: Record<string, string> = {};
  const title = values.title?.trim() ?? "";
  if (title.length < 4) throw new Error("Add a short title (at least 4 characters).");
  clean.title = title.slice(0, TITLE_MAX_LENGTH);
  for (const field of definition.fields as ReportField[]) {
    if (field.kind === "files") continue;
    const value = values[field.id]?.trim() ?? "";
    if (!value) {
      if (field.required) throw new Error(`“${field.label}” is required.`);
      continue;
    }
    if (field.kind === "choice" && !field.options!.some((option) => option.value === value)) {
      throw new Error(`Pick an option for “${field.label}”.`);
    }
    if (field.kind === "area" && !AREAS.some((area) => area.id === value)) {
      throw new Error("Pick a valid area.");
    }
    clean[field.id] = value.slice(0, field.maxLength ?? 4000);
  }
  return clean;
}

function toUploads(files: Array<z.infer<typeof File>>): UploadFile[] {
  if (files.length > MAX_FILES) throw new Error(`Attach at most ${MAX_FILES} files.`);
  return files.map((file) => {
    if (file.data.byteLength > MAX_FILE_BYTES)
      throw new Error(`${file.name} is larger than 10 MB.`);
    return { name: file.name, contentType: file.type ?? null, data: file.data };
  });
}

async function rateLimit(env: Env, user: DraftUser) {
  const outcome = await env.REPORT_RATE_LIMITER.limit({ key: `web:${user.id}` });
  if (!outcome.success) throw new Error("You're going a bit fast. Try again in a minute.");
}

export const rpc = {
  async reportForm(env: Env) {
    return {
      applicationId: env.DISCORD_APPLICATION_ID,
      versions: await versionOptions(env),
      kinds: REPORT_KINDS,
      meta: publicMeta(),
    };
  },

  async similar(env: Env, input: unknown) {
    const { text } = z.object({ text: z.string().max(8000) }).parse(input);
    return findSimilar(env, text, 4);
  },

  async submit(env: Env, input: unknown) {
    const parsed = z
      .object({
        kind: z.enum(["bug", "feature"]),
        values: z.record(z.string(), z.string()),
        files: z.array(File).default([]),
        user: User,
      })
      .parse(input);
    await rateLimit(env, parsed.user);
    const values = validateValues(parsed.kind, parsed.values);
    const uploads = toUploads(parsed.files);
    const draft = await createDraft(env, {
      id: randomId(10),
      source: "website",
      kind: parsed.kind,
      user: parsed.user,
      values,
      attachments: [],
      candidates: [],
    });
    return fileReport(env, draft, uploads);
  },

  async meToo(env: Env, input: unknown) {
    const parsed = z
      .object({
        number: z.number().int().positive(),
        user: User,
        note: z.string().max(4000).optional(),
      })
      .parse(input);
    await rateLimit(env, parsed.user);
    return addMeToo(env, parsed.number, parsed.user, "website", parsed.note);
  },

  async comment(env: Env, input: unknown) {
    const parsed = z
      .object({
        number: z.number().int().positive(),
        user: User,
        text: z.string().min(1).max(6000),
      })
      .parse(input);
    await rateLimit(env, parsed.user);
    return websiteComment(env, parsed.number, parsed.user, parsed.text);
  },

  async addDetails(env: Env, input: unknown) {
    const parsed = z
      .object({
        number: z.number().int().positive(),
        user: User,
        text: z.string().max(4000).default(""),
        files: z.array(File).default([]),
      })
      .parse(input);
    await rateLimit(env, parsed.user);
    return addDetails(
      env,
      parsed.number,
      parsed.user,
      { text: parsed.text, files: toUploads(parsed.files) },
      "website",
    );
  },
};
