import { describe, expect, it } from "vitest";
import { assertResourceUri, encodeSegment, PermioValidationError, resource } from "../src/index.js";

describe("resource()", () => {
  it("joins segments with a leading slash", () => {
    expect(resource("projects", "p1", "docs", 42)).toBe("/projects/p1/docs/42");
  });

  it("keeps IDs with reserved characters in one segment", () => {
    expect(resource("docs", "a/b")).toBe("/docs/a%2Fb");
    expect(resource("users", "jo@example.com")).toBe("/users/jo%40example.com");
    expect(resource("q", "a b?c#d")).toBe("/q/a%20b%3Fc%23d");
    expect(resource("x", "café")).toBe("/x/caf%C3%A9");
  });

  it("encodes characters the API rejects in segments", () => {
    expect(encodeSegment("f(x)*!'")).toBe("f%28x%29%2A%21%27");
    expect(resource("r", "[a]{b}+|^$\\")).toBe("/r/%5Ba%5D%7Bb%7D%2B%7C%5E%24%5C");
    for (const uri of [resource("r", "(*)"), resource("r", "[a]{b}+|^$\\")]) {
      expect(uri).not.toMatch(/[()[\]{}*+?|^$\\]/);
    }
  });

  it("leaves safe characters alone", () => {
    expect(resource("a-b_c.d~e")).toBe("/a-b_c.d~e");
  });

  it("rejects empty segments and no segments", () => {
    expect(() => resource("docs", "")).toThrow(PermioValidationError);
    expect(() => resource()).toThrow(PermioValidationError);
  });
});

describe("assertResourceUri()", () => {
  it.each(["/a", "/a/b/c", "/organisation/o/project/p", resource("docs", "a/b")])("accepts %s", (uri) => {
    expect(() => assertResourceUri(uri)).not.toThrow();
  });

  it.each(["", "a/b", "/", "/a//b", "/a/", "/a b", "/a\tb", "/a\u0000", "/" + "a".repeat(2048)])(
    "rejects %j",
    (uri) => {
      expect(() => assertResourceUri(uri)).toThrow(PermioValidationError);
    },
  );
});
