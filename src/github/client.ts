import { REPOSITORY } from "../config";
import { getJsonState, setState } from "../db/store";
import type { Env } from "../env";
import { base64Url } from "../util/crypto";
import { HttpError } from "../util/http";

const API = "https://api.github.com";
const USER_AGENT = "SakuraCord-Hub (+https://github.com/SakuraCordApp/Roadmap)";
const TOKEN_STATE_KEY = "github:installation-token";

let memoryToken: { token: string; expiresAt: number } | null = null;

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error("GITHUB_APP_PRIVATE_KEY must be PKCS#8 (BEGIN PRIVATE KEY).");
  }
  const der = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function appJwt(env: Env): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new HttpError(503, "The GitHub App is not configured.");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }),
  );
  const key = await importPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function installationToken(env: Env): Promise<string> {
  const now = Date.now();
  if (memoryToken && memoryToken.expiresAt - now > 5 * 60_000) return memoryToken.token;
  const cached = await getJsonState<{ token: string; expiresAt: number } | null>(
    env.DB,
    TOKEN_STATE_KEY,
    null,
  );
  if (cached && cached.expiresAt - now > 5 * 60_000) {
    memoryToken = cached;
    return cached.token;
  }
  const jwt = await appJwt(env);
  const installation = await rawRequest<{ id: number }>(
    "GET",
    `/repos/${REPOSITORY.owner}/${REPOSITORY.name}/installation`,
    `Bearer ${jwt}`,
  );
  const created = await rawRequest<{ token: string; expires_at: string }>(
    "POST",
    `/app/installations/${installation.id}/access_tokens`,
    `Bearer ${jwt}`,
  );
  memoryToken = { token: created.token, expiresAt: Date.parse(created.expires_at) };
  await setState(env.DB, TOKEN_STATE_KEY, JSON.stringify(memoryToken));
  return created.token;
}

async function rawRequest<T>(
  method: string,
  path: string,
  authorization: string,
  body?: unknown,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: authorization,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const retryAfter = Number(response.headers.get("retry-after"));
    const secondaryLimit =
      response.status === 429 ||
      (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") ||
      (response.status === 403 && Number.isFinite(retryAfter) && retryAfter > 0);
    if ((secondaryLimit || response.status >= 500) && attempt < 4) {
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 20_000)));
      continue;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new HttpError(
        response.status,
        `GitHub ${method} ${path.replace(API, "")} failed with ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

export class GitHub {
  constructor(private readonly env: Env) {}

  get configured(): boolean {
    return Boolean(this.env.GITHUB_APP_ID && this.env.GITHUB_APP_PRIVATE_KEY);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await installationToken(this.env);
    try {
      return await rawRequest<T>(method, path, `Bearer ${token}`, body);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        memoryToken = null;
        await setState(this.env.DB, TOKEN_STATE_KEY, "null");
        return rawRequest<T>(method, path, `Bearer ${await installationToken(this.env)}`, body);
      }
      throw error;
    }
  }

  repo(path: string): string {
    return `/repos/${REPOSITORY.owner}/${REPOSITORY.name}${path}`;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const result = await this.request<{ data?: T; errors?: Array<{ message: string }> }>(
      "POST",
      "/graphql",
      { query, variables },
    );
    if (result.errors?.length) throw new Error(`GitHub GraphQL: ${result.errors[0]!.message}`);
    return result.data as T;
  }

  /** Paginate a list endpoint (per_page=100). */
  async list<T>(path: string, maxPages = 20): Promise<T[]> {
    const items: T[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await this.request<T[]>("GET", `${path}${separator}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }
}
