import { PermioConfigError } from "./errors.js";

// Mirrors go-common/middleware/apikey: "perms_" + 32 random base62 characters +
// 6 base62 characters encoding the CRC32 (IEEE) of those 32, 44 characters total.
const PREFIX = "perms_";
const RANDOM_LENGTH = 32;
const CHECKSUM_LENGTH = 6;
export const API_KEY_LENGTH = PREFIX.length + RANDOM_LENGTH + CHECKSUM_LENGTH;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

let crcTable: Uint32Array | undefined;

function crc32(text: string): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  // The body is base62, so every character is a single byte.
  for (let i = 0; i < text.length; i++) {
    crc = crcTable[(crc ^ text.charCodeAt(i)) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function checksum(body: string): string {
  let value = crc32(body);
  const out: string[] = new Array(CHECKSUM_LENGTH);
  for (let i = CHECKSUM_LENGTH - 1; i >= 0; i--) {
    out[i] = ALPHABET[value % 62]!;
    value = Math.floor(value / 62);
  }
  return out.join("");
}

/** `"opaque"` for `perms_…` keys, `"jwt"` for legacy JWT keys. */
export type ApiKeyKind = "opaque" | "jwt";

/**
 * Checks that `key` looks like a perms.io API key and returns its kind.
 *
 * Opaque `perms_` keys are checked for length, alphabet and CRC32 checksum, so
 * a typo is caught before any request is made. Legacy JWT keys are only checked
 * for the three-part shape. This does not tell you whether the key exists or
 * is still valid; only the API can.
 *
 * @throws PermioConfigError if the key is malformed.
 */
export function validateApiKey(key: string): ApiKeyKind {
  if (typeof key !== "string" || key.length === 0) {
    throw new PermioConfigError("permio: apiKey is required");
  }
  if (key.startsWith(PREFIX)) {
    if (key.length !== API_KEY_LENGTH) {
      throw new PermioConfigError(
        `permio: malformed API key (expected ${API_KEY_LENGTH} characters starting with "${PREFIX}", got ${key.length})`,
      );
    }
    const rest = key.slice(PREFIX.length);
    for (let i = 0; i < rest.length; i++) {
      if (!ALPHABET.includes(rest[i]!)) {
        throw new PermioConfigError("permio: malformed API key (characters after perms_ must be 0-9, A-Z or a-z)");
      }
    }
    if (checksum(rest.slice(0, RANDOM_LENGTH)) !== rest.slice(RANDOM_LENGTH)) {
      throw new PermioConfigError("permio: API key checksum mismatch; check it was copied correctly");
    }
    return "opaque";
  }
  if (JWT.test(key)) return "jwt";
  throw new PermioConfigError(
    'permio: malformed API key (expected a "perms_" key from the dashboard, or a legacy JWT key)',
  );
}

/** Returns true if `key` passes `validateApiKey`. */
export function isValidApiKey(key: string): boolean {
  try {
    validateApiKey(key);
    return true;
  } catch {
    return false;
  }
}
