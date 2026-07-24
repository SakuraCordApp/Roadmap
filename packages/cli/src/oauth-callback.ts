import { createServer, type Server, type ServerResponse } from "node:http";

export const CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";

export interface OAuthCallback {
  code: string;
  state: string;
}

export interface LocalOAuthCallbackServer {
  redirectUri: string;
  expectState(state: string): void;
  waitForCallback(deadline: number): Promise<OAuthCallback>;
  completeBrowser(): void;
  failBrowser(message: string): void;
  close(): Promise<void>;
}

export async function startLocalOAuthCallbackServer(): Promise<LocalOAuthCallbackServer> {
  let expectedState: string | undefined;
  let settled = false;
  let callbackResponse: ServerResponse | undefined;
  let resolveCallback: ((value: OAuthCallback) => void) | undefined;
  let rejectCallback: ((reason: Error) => void) | undefined;
  const callbackPromise = new Promise<OAuthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", CODEX_OAUTH_REDIRECT_URI);
    if (request.method !== "GET" || requestUrl.pathname !== "/auth/callback") {
      sendHtml(response, 404, "Not found", "This local callback only accepts ChatGPT sign-in.");
      return;
    }
    if (settled) {
      sendHtml(
        response,
        409,
        "Authorization already received",
        "Return to the roadmap setup in your terminal.",
      );
      return;
    }
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    const oauthError = requestUrl.searchParams.get("error");
    if (oauthError) {
      settled = true;
      const description =
        requestUrl.searchParams.get("error_description") ?? "ChatGPT authorization was declined.";
      sendHtml(response, 400, "Authorization failed", description);
      rejectCallback?.(new Error(description));
      return;
    }
    if (!code || !state) {
      sendHtml(
        response,
        400,
        "Incomplete authorization",
        "ChatGPT did not return the required authorization code and state.",
      );
      return;
    }
    if (!expectedState || state !== expectedState) {
      sendHtml(
        response,
        400,
        "Invalid authorization state",
        "This callback does not belong to the active roadmap setup.",
      );
      return;
    }
    settled = true;
    callbackResponse = response;
    resolveCallback?.({ code, state });
  });

  try {
    await listen(server);
  } catch (error) {
    server.close();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `ChatGPT sign-in needs local port 1455, but it could not be opened (${detail}). ` +
        "Close any other Codex sign-in window or process using port 1455, then rerun the command.",
    );
  }

  return {
    redirectUri: CODEX_OAUTH_REDIRECT_URI,
    expectState(state: string) {
      expectedState = state;
    },
    async waitForCallback(deadline: number) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("ChatGPT authorization expired before it started.");
      let timeout: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          callbackPromise,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("ChatGPT authorization was not completed before it expired.")),
              remaining,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
    completeBrowser() {
      if (!callbackResponse) return;
      sendHtml(
        callbackResponse,
        200,
        "ChatGPT connected",
        "You can close this window and return to the roadmap setup.",
      );
      callbackResponse = undefined;
    },
    failBrowser(message: string) {
      if (!callbackResponse) return;
      sendHtml(callbackResponse, 502, "Could not finish authorization", message);
      callbackResponse = undefined;
    },
    async close() {
      if (callbackResponse) {
        sendHtml(
          callbackResponse,
          503,
          "Authorization interrupted",
          "Return to the roadmap setup and retry ChatGPT sign-in.",
        );
        callbackResponse = undefined;
      }
      await closeServer(server);
    },
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(1455, "127.0.0.1");
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sendHtml(
  response: ServerResponse,
  status: number,
  heading: string,
  message: string,
): void {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  response.end(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${escapeHtml(heading)}</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111; color: #f7f7f7; }
  main { width: min(34rem, calc(100% - 3rem)); }
  h1 { font-size: clamp(2rem, 8vw, 3.5rem); letter-spacing: -.04em; margin: 0 0 1rem; }
  p { color: #c9c9c9; font-size: 1.1rem; line-height: 1.6; }
</style>
<main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p></main>
</html>`);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
