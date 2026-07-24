import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

export interface CliContext {
  root: string;
  json: boolean;
  verbose: boolean;
}

export async function createContext(options: {
  root?: string;
  json?: boolean;
  verbose?: boolean;
}): Promise<CliContext> {
  return {
    root: options.root ? path.resolve(options.root) : await findRepositoryRoot(process.cwd()),
    json: Boolean(options.json),
    verbose: Boolean(options.verbose),
  };
}

export async function findRepositoryRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  for (;;) {
    const packagePath = path.join(current, "package.json");
    try {
      const pkg = JSON.parse(await readFile(packagePath, "utf8")) as { name?: string };
      if (pkg.name === "sakuracord-roadmap") return current;
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        "Could not find a SakuraCord Roadmap repository. Run inside a clone or use --root.",
      );
    }
    current = parent;
  }
}

export async function run(
  context: CliContext,
  command: string,
  args: string[],
  options: Record<string, unknown> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (context.verbose) process.stderr.write(`→ ${command} ${args.join(" ")}\n`);
  const result = await execa(command, args, {
    cwd: context.root,
    preferLocal: true,
    ...options,
  });
  return {
    exitCode: result.exitCode ?? 0,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    await execa(command, ["--version"], { reject: false, stdout: "ignore", stderr: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error: any) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function deepMerge<T>(left: T, right: unknown): T {
  if (Array.isArray(right)) return right as T;
  if (right && typeof right === "object" && left && typeof left === "object") {
    const output = { ...(left as Record<string, unknown>) };
    for (const [key, value] of Object.entries(right as Record<string, unknown>)) {
      output[key] = deepMerge(output[key], value);
    }
    return output as T;
  }
  return right as T;
}

export function output(context: CliContext, value: unknown): void {
  if (context.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function redacted(value: string): string {
  if (value.length < 10) return "[REDACTED]";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
