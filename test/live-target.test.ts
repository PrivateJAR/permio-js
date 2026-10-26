import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, DEV_BASE_URL } from "../src/index.js";
import { isAllowedLiveTarget } from "./live-target.js";

describe("live test target allowlist", () => {
  it.each([
    DEV_BASE_URL,
    "https://dev-api.perms.io",
    "https://dev-api.perms.io/",
    "https://dev-api.perms.io:443",
    "https://DEV-API.perms.io",
    "https://dev-api.perms.io.",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
    "http://api.localhost",
    "https://permio.test",
    "https://gateway.permio.test:8443",
  ])("allows %s", (url) => {
    expect(isAllowedLiveTarget(url)).toBe(true);
  });

  it.each([
    DEFAULT_BASE_URL,
    "https://api.perms.io",
    "https://api.perms.io/",
    "https://api.perms.io:443",
    "https://API.PERMS.IO",
    "https://api.perms.io.",
    "https://temp-api.perms.io",
    "http://api.perms.io",
    "https://dev-api.perms.io@api.perms.io",
    "https://dev-api.perms.io.evil.example",
    "https://localhost.example",
    "https://test",
    "https://example.com/dev-api.perms.io",
    "ftp://localhost",
    "",
    "dev-api.perms.io",
  ])("refuses %s", (url) => {
    expect(isAllowedLiveTarget(url)).toBe(false);
  });
});
