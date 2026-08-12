import {
  createOpenAIOAuthRequest,
  createOpenAIOAuthTransport,
  exchangeOpenAIOAuthCode,
  refreshOpenAIOAuthTokens,
  type OpenAIOAuthSession,
} from "@openai-oauth/core";
import { RoadmapError } from "@roadmap/core";
import type { Env } from "./env.js";
import { decryptJson, encryptJson } from "./crypto-store.js";
import { requeueAiAutomationJobs } from "./job-recovery.js";
import { sha256 } from "./security.js";

const SESSION_PURPOSE = "sakuracord-roadmap:ai-oauth-session:v1";
const REQUEST_PURPOSE = "sakuracord-roadmap:ai-oauth-request:v1";
export const CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";

interface OAuthRequestRow {
  encrypted_verifier: string;
  iv: string;
  redirect_uri: string;
  expires_at: string;
  consumed_at: string | null;
}

interface SessionRow {
  encrypted_session: string;
  iv: string;
  account_id_hash: string;
  expires_at: string | null;
  updated_at: string;
  refresh_lock_id: string | null;
  refresh_locked_at: string | null;
}

export async function beginAiOAuth(
  env: Env,
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  const encryptionKey = requireEncryptionKey(env);
  const redirectUri = CODEX_OAUTH_REDIRECT_URI;
  const request = await createOpenAIOAuthRequest({ redirectUri });
  const encrypted = await encryptJson(
    encryptionKey,
    { codeVerifier: request.codeVerifier },
    REQUEST_PURPOSE,
  );
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO ai_oauth_requests(
      state_hash,encrypted_verifier,iv,redirect_uri,expires_at
    ) VALUES(?,?,?,?,?)`,
  )
    .bind(await sha256(request.state), encrypted.ciphertext, encrypted.iv, redirectUri, expiresAt)
    .run();
  return { authorizationUrl: request.authorizationUrl, expiresAt };
}

export async function finishAiOAuth(
  env: Env,
  code: string,
  state: string,
): Promise<{ accountIdHash: string }> {
  const encryptionKey = requireEncryptionKey(env);
  const stateHash = await sha256(state);
  const row = await env.DB.prepare(
    `SELECT encrypted_verifier,iv,redirect_uri,expires_at,consumed_at
     FROM ai_oauth_requests WHERE state_hash=?`,
  )
    .bind(stateHash)
    .first<OAuthRequestRow>();
  if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.now()) {
    throw new RoadmapError(
      "OAUTH_REQUEST_INVALID",
      "This ChatGPT authorization request is invalid, expired, or already used.",
      400,
    );
  }
  const claimed = await env.DB.prepare(
    `UPDATE ai_oauth_requests SET consumed_at=?
     WHERE state_hash=? AND consumed_at IS NULL AND expires_at>?`,
  )
    .bind(new Date().toISOString(), stateHash, new Date().toISOString())
    .run();
  if (claimed.meta.changes !== 1) {
    throw new RoadmapError("OAUTH_REQUEST_REPLAYED", "This authorization was already used.", 409);
  }
  const verifier = await decryptJson<{ codeVerifier: string }>(
    encryptionKey,
    row.encrypted_verifier,
    row.iv,
    REQUEST_PURPOSE,
  );
  const tokens = await exchangeOpenAIOAuthCode({
    code,
    codeVerifier: verifier.codeVerifier,
    redirectUri: row.redirect_uri,
    fetch: workerFetch,
  });
  if (!tokens.accountId || !tokens.refreshToken) {
    throw new RoadmapError(
      "OAUTH_SESSION_INCOMPLETE",
      "ChatGPT authorization did not return an account and refresh token.",
      502,
    );
  }
  const now = new Date().toISOString();
  const session: OpenAIOAuthSession = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken,
    accountId: tokens.accountId,
    isFedRamp: tokens.isFedRamp,
    expiresAt: expiryFrom(tokens.expiresIn),
    lastRefresh: now,
  };
  const encrypted = await encryptJson(encryptionKey, session, SESSION_PURPOSE);
  const accountIdHash = await sha256(session.accountId);
  await env.DB.prepare(
    `INSERT INTO ai_oauth_session(
      id,encrypted_session,iv,account_id_hash,expires_at,updated_at
    ) VALUES('primary',?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      encrypted_session=excluded.encrypted_session,
      iv=excluded.iv,
      account_id_hash=excluded.account_id_hash,
      expires_at=excluded.expires_at,
      refresh_lock_id=NULL,
      refresh_locked_at=NULL,
      updated_at=excluded.updated_at`,
  )
    .bind(encrypted.ciphertext, encrypted.iv, accountIdHash, session.expiresAt ?? null, now)
    .run();
  await requeueAiAutomationJobs(env.DB);
  return { accountIdHash };
}

export async function aiOAuthStatus(env: Env): Promise<{
  connected: boolean;
  accountIdHash?: string;
  expiresAt?: string | null;
  updatedAt?: string;
}> {
  const row = await env.DB.prepare(
    `SELECT encrypted_session,iv,account_id_hash,expires_at,updated_at
     FROM ai_oauth_session WHERE id='primary'`,
  ).first<
    Pick<SessionRow, "encrypted_session" | "iv" | "account_id_hash" | "expires_at" | "updated_at">
  >();
  if (!row || !env.ROADMAP_OAUTH_ENCRYPTION_KEY) return { connected: false };
  try {
    await decryptJson<OpenAIOAuthSession>(
      env.ROADMAP_OAUTH_ENCRYPTION_KEY,
      row.encrypted_session,
      row.iv,
      SESSION_PURPOSE,
    );
    return {
      connected: true,
      accountIdHash: row.account_id_hash.slice(0, 12),
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
    };
  } catch {
    return { connected: false };
  }
}

export async function disconnectAiOAuth(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM ai_oauth_session WHERE id='primary'").run();
}

export async function requestWithFreshAiSession(
  env: Env,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const request = async (forceRefresh: boolean) => {
    const transport = createOpenAIOAuthTransport({
      auth: await getFreshAiSession(env, forceRefresh),
      fetch: workerFetch,
      responsesState: false,
    });
    return transport.request(path, init);
  };
  const response = await request(false);
  if (response.status !== 401 && response.status !== 403) return response;
  return request(true);
}

export async function getFreshAiSession(
  env: Env,
  forceRefresh = false,
): Promise<OpenAIOAuthSession> {
  const encryptionKey = requireEncryptionKey(env);
  const row = await env.DB.prepare(
    `SELECT encrypted_session,iv,account_id_hash,expires_at,updated_at,
      refresh_lock_id,refresh_locked_at
     FROM ai_oauth_session WHERE id='primary'`,
  ).first<SessionRow>();
  if (!row) {
    throw new RoadmapError(
      "AI_OAUTH_REQUIRED",
      "No ChatGPT account is connected. Run `roadmap releases connect-ai`.",
      503,
    );
  }
  const current = await decryptJson<OpenAIOAuthSession>(
    encryptionKey,
    row.encrypted_session,
    row.iv,
    SESSION_PURPOSE,
  );
  const expiresSoon =
    forceRefresh || !current.expiresAt || Date.parse(current.expiresAt) <= Date.now() + 5 * 60_000;
  if (!expiresSoon) return current;
  if (!current.refreshToken) {
    throw new RoadmapError(
      "AI_OAUTH_REFRESH_REQUIRED",
      "The ChatGPT session cannot be refreshed. Reconnect it.",
      503,
    );
  }
  const lockId = crypto.randomUUID();
  const locked = await env.DB.prepare(
    `UPDATE ai_oauth_session SET refresh_lock_id=?,refresh_locked_at=?
     WHERE id='primary' AND updated_at=?
       AND (
         refresh_lock_id IS NULL OR
         refresh_locked_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes')
       )`,
  )
    .bind(lockId, new Date().toISOString(), row.updated_at)
    .run();
  if (locked.meta.changes !== 1) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const latest = await env.DB.prepare(
        "SELECT expires_at,refresh_lock_id FROM ai_oauth_session WHERE id='primary'",
      ).first<{ expires_at: string | null; refresh_lock_id: string | null }>();
      if (
        latest?.expires_at &&
        Date.parse(latest.expires_at) > Date.now() + 5 * 60_000 &&
        !latest.refresh_lock_id
      ) {
        return getFreshAiSession(env);
      }
    }
    throw new RoadmapError(
      "AI_OAUTH_REFRESH_BUSY",
      "Another release job is refreshing ChatGPT authorization. Retry shortly.",
      503,
    );
  }
  let refreshed;
  try {
    refreshed = await refreshOpenAIOAuthTokens({
      refreshToken: current.refreshToken,
      fetch: workerFetch,
    });
  } catch (error) {
    await env.DB.prepare(
      `UPDATE ai_oauth_session SET refresh_lock_id=NULL,refresh_locked_at=NULL
       WHERE id='primary' AND refresh_lock_id=?`,
    )
      .bind(lockId)
      .run();
    throw error;
  }
  const now = new Date().toISOString();
  const next: OpenAIOAuthSession = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? current.refreshToken,
    idToken: refreshed.idToken ?? current.idToken,
    accountId: refreshed.accountId ?? current.accountId,
    isFedRamp: refreshed.isFedRamp ?? current.isFedRamp,
    expiresAt: expiryFrom(refreshed.expiresIn),
    lastRefresh: now,
  };
  const encrypted = await encryptJson(encryptionKey, next, SESSION_PURPOSE);
  const saved = await env.DB.prepare(
    `UPDATE ai_oauth_session SET
      encrypted_session=?,iv=?,account_id_hash=?,expires_at=?,updated_at=?,
      refresh_lock_id=NULL,refresh_locked_at=NULL
     WHERE id='primary' AND refresh_lock_id=?`,
  )
    .bind(
      encrypted.ciphertext,
      encrypted.iv,
      await sha256(next.accountId),
      next.expiresAt ?? null,
      now,
      lockId,
    )
    .run();
  if (saved.meta.changes !== 1) return getFreshAiSession(env);
  return next;
}

function expiryFrom(expiresIn?: number): string | undefined {
  return expiresIn ? new Date(Date.now() + expiresIn * 1_000).toISOString() : undefined;
}

function requireEncryptionKey(env: Env): string {
  if (!env.ROADMAP_OAUTH_ENCRYPTION_KEY) {
    throw new RoadmapError(
      "AI_OAUTH_NOT_CONFIGURED",
      "ROADMAP_OAUTH_ENCRYPTION_KEY is not configured.",
      503,
    );
  }
  return env.ROADMAP_OAUTH_ENCRYPTION_KEY;
}

const workerFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
