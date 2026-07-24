import { RoadmapError } from "@roadmap/core";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function encryptJson(
  secret: string,
  value: unknown,
  purpose: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importEncryptionKey(secret, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return {
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
    iv: bytesToBase64Url(iv),
  };
}

export async function decryptJson<T>(
  secret: string,
  ciphertext: string,
  iv: string,
  purpose: string,
): Promise<T> {
  try {
    const key = await importEncryptionKey(secret, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(base64UrlToBytes(iv)),
        additionalData: encoder.encode(purpose),
      },
      key,
      toArrayBuffer(base64UrlToBytes(ciphertext)),
    );
    return JSON.parse(decoder.decode(decrypted)) as T;
  } catch {
    throw new RoadmapError(
      "OAUTH_CREDENTIAL_DECRYPTION_FAILED",
      "The stored AI credential could not be decrypted. Reconnect the ChatGPT account.",
      503,
    );
  }
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function importEncryptionKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64UrlToBytes(secret);
  } catch {
    raw = new Uint8Array();
  }
  if (raw.byteLength !== 32) {
    throw new RoadmapError(
      "OAUTH_ENCRYPTION_KEY_INVALID",
      "ROADMAP_OAUTH_ENCRYPTION_KEY must be a base64url-encoded 32-byte secret.",
      503,
    );
  }
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), "AES-GCM", false, usages);
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
