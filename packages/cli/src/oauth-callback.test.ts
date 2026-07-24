import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_OAUTH_REDIRECT_URI,
  startLocalOAuthCallbackServer,
  type LocalOAuthCallbackServer,
} from "./oauth-callback.js";

describe("local ChatGPT OAuth callback", () => {
  let server: LocalOAuthCallbackServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("accepts only the expected state and never exposes the code in the response", async () => {
    server = await startLocalOAuthCallbackServer();
    server.expectState("expected-state");

    const invalid = await get(`${CODEX_OAUTH_REDIRECT_URI}?code=secret-code&state=wrong-state`);
    expect(invalid.status).toBe(400);
    expect(invalid.body).not.toContain("secret-code");

    const callback = server.waitForCallback(Date.now() + 2_000);
    const validResponse = get(`${CODEX_OAUTH_REDIRECT_URI}?code=secret-code&state=expected-state`);
    await expect(callback).resolves.toEqual({
      code: "secret-code",
      state: "expected-state",
    });
    server.completeBrowser();
    await expect(validResponse).resolves.toMatchObject({
      status: 200,
      body: expect.stringContaining("ChatGPT connected"),
    });
  });
});

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: "GET" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}
