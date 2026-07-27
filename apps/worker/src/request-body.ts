import { RoadmapError } from "@roadmap/core";

export const DEFAULT_JSON_BODY_LIMIT = 1_048_576;
export const SIGNED_WEBHOOK_BODY_LIMIT = 2_097_152;
export const FORUM_CONFIGURATION_BODY_LIMIT = 12_582_912;

export async function readBodyTextLimited(request: Request, maximumBytes: number): Promise<string> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maximumBytes) {
      throw payloadTooLarge(maximumBytes);
    }
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("Request body exceeded the configured limit.");
        throw payloadTooLarge(maximumBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

export async function readJsonBodyLimited<T>(
  request: Request,
  maximumBytes = DEFAULT_JSON_BODY_LIMIT,
  emptyValue?: T,
): Promise<T> {
  let text: string;
  try {
    text = await readBodyTextLimited(request, maximumBytes);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new RoadmapError("INVALID_REQUEST_BODY", "Request body is not valid UTF-8.", 400);
    }
    throw error;
  }
  if (!text.trim()) {
    if (emptyValue !== undefined) return emptyValue;
    throw new RoadmapError("INVALID_JSON", "Request body must contain JSON.", 400);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RoadmapError("INVALID_JSON", "Request body contains invalid JSON.", 400);
  }
}

function payloadTooLarge(maximumBytes: number): RoadmapError {
  return new RoadmapError(
    "PAYLOAD_TOO_LARGE",
    `Request body exceeds the ${maximumBytes}-byte limit.`,
    413,
    { maximumBytes },
  );
}
