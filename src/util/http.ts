export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers },
  });
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bot\s+[A-Za-z0-9._-]+/gi, "Bot [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/(token|key)=([^&\s]+)/gi, "$1=[REDACTED]")
    .slice(0, 2000);
}
