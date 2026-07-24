import { randomUUID } from "node:crypto";
import { resilientFetch } from "./network.js";

export class CliApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  get(path: string) {
    return this.request(path);
  }

  post(path: string, body: unknown = {}, idempotencyKey?: string) {
    return this.request(path, "POST", body, idempotencyKey);
  }

  async request(
    path: string,
    method = "GET",
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<any> {
    const mutation = method !== "GET";
    if (mutation && !this.token) throw new Error("A maintainer token is required.");
    const response = await resilientFetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(mutation ? { "Idempotency-Key": idempotencyKey ?? `cli-${randomUUID()}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `${payload?.error?.message ?? `HTTP ${response.status}`}${
          payload?.error?.details ? `: ${JSON.stringify(payload.error.details)}` : ""
        }`,
      );
    }
    return payload;
  }
}
