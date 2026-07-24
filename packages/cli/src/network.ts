import { Resolver } from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";

type FetchImplementation = typeof globalThis.fetch;

export interface ResilientFetchDependencies {
  directFetch?: FetchImplementation;
  resolvePublicIpv4?: (hostname: string) => Promise<string[]>;
  resolvedFetch?: (
    input: string | URL,
    init: RequestInit | undefined,
    address: string,
  ) => Promise<Response>;
}

/**
 * Uses the system resolver first, then falls back to public DNS for the brief
 * period where a newly-created Worker custom domain is still negatively cached
 * by the operator's local resolver.
 */
export async function resilientFetch(
  input: string | URL,
  init?: RequestInit,
  dependencies: ResilientFetchDependencies = {},
): Promise<Response> {
  const directFetch = dependencies.directFetch ?? globalThis.fetch;
  try {
    return await directFetch(input, init);
  } catch (error) {
    if (!isDnsResolutionError(error)) throw error;
    const url = new URL(String(input));
    const resolvePublicIpv4 = dependencies.resolvePublicIpv4 ?? defaultResolvePublicIpv4;
    const resolvedFetch = dependencies.resolvedFetch ?? fetchThroughAddress;
    const addresses = await resolvePublicIpv4(url.hostname);
    let lastError: unknown = error;
    for (const address of addresses) {
      try {
        return await resolvedFetch(url, init, address);
      } catch (fallbackError) {
        lastError = fallbackError;
      }
    }
    throw lastError;
  }
}

export function isDnsResolutionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === "object" &&
      "code" in current &&
      ["ENOTFOUND", "EAI_AGAIN"].includes(String((current as { code?: unknown }).code))
    ) {
      return true;
    }
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

async function defaultResolvePublicIpv4(hostname: string): Promise<string[]> {
  const resolveWith = async (server: string) => {
    const resolver = new Resolver();
    resolver.setServers([server]);
    return resolver.resolve4(hostname);
  };
  try {
    return await Promise.any([resolveWith("1.1.1.1"), resolveWith("8.8.8.8")]);
  } catch {
    throw new Error(
      `Neither the system resolver nor public DNS could resolve ${hostname}. Check the custom-domain DNS record.`,
    );
  }
}

async function fetchThroughAddress(
  input: string | URL,
  init: RequestInit | undefined,
  address: string,
): Promise<Response> {
  const dispatcher = new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) {
          callback(null, [{ address, family: 4 }]);
        } else {
          callback(null, address, 4);
        }
      },
    },
  });
  try {
    const response = await undiciFetch(input, {
      ...init,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]);
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
    });
  } finally {
    await dispatcher.close();
  }
}
