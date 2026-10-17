import { describe, expect, it } from "vitest";
import { API_KEY_LENGTH, isValidApiKey, Permio, PermioConfigError, validateApiKey } from "../src/index.js";
import { JWT_KEY, VALID_KEY, VALID_KEY_2 } from "./helpers.js";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

describe("API key validation", () => {
  it("accepts valid opaque keys", () => {
    expect(API_KEY_LENGTH).toBe(44);
    expect(validateApiKey(VALID_KEY)).toBe("opaque");
    expect(validateApiKey(VALID_KEY_2)).toBe("opaque");
  });

  it("rejects every single-character typo after the prefix", () => {
    for (let pos = "perms_".length; pos < VALID_KEY.length; pos++) {
      for (const c of ALPHABET) {
        if (c === VALID_KEY[pos]) continue;
        const typo = VALID_KEY.slice(0, pos) + c + VALID_KEY.slice(pos + 1);
        expect(() => validateApiKey(typo), typo).toThrow(/checksum mismatch/);
      }
    }
  });

  it("accepts legacy JWT keys without checksum validation", () => {
    expect(validateApiKey(JWT_KEY)).toBe("jwt");
    expect(validateApiKey("a.b.c")).toBe("jwt");
  });

  it.each([
    ["empty", ""],
    ["too short", VALID_KEY.slice(0, -1)],
    ["too long", VALID_KEY + "0"],
    ["bad character", VALID_KEY.slice(0, 10) + "-" + VALID_KEY.slice(11)],
    ["wrong prefix", "perm__" + VALID_KEY.slice(6)],
    ["upper-case prefix", "PERMS_" + VALID_KEY.slice(6)],
    ["trailing space", VALID_KEY.slice(0, -1) + " "],
    ["two-part token", "abc.def"],
    ["jwt with padding", "a.b.c=="],
    ["random text", "not a key"],
  ])("rejects %s", (_name, key) => {
    expect(() => validateApiKey(key)).toThrow(PermioConfigError);
    expect(isValidApiKey(key)).toBe(false);
  });

  it("validates eagerly in the constructor", () => {
    expect(() => new Permio({ apiKey: VALID_KEY.replace("0", "1") })).toThrow(PermioConfigError);
    expect(() => new Permio({ apiKey: "" })).toThrow(/apiKey is required/);
    expect(new Permio({ apiKey: VALID_KEY }).apiKeyKind).toBe("opaque");
    expect(new Permio({ apiKey: JWT_KEY }).apiKeyKind).toBe("jwt");
  });
});
