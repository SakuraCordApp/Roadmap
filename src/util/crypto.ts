const encoder = new TextEncoder();

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fromHex(value: string): Uint8Array {
  return new Uint8Array(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let mismatch = 0;
  for (let index = 0; index < x.length; index += 1) mismatch |= x[index]! ^ y[index]!;
  return mismatch === 0;
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
}

export function base64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomId(length = 12): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}
