// Optional smoke test against a real deployment. Skipped unless both
// PERMIO_API_KEY and PERMIO_BASE_URL are set, and refuses to run against
// production. Example:
//   PERMIO_API_KEY=perms_... PERMIO_BASE_URL=https://dev-api.perms.io PERMIO_PROJECT=my-app npm test
import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, Permio, PermioAuthError } from "../src/index.js";

const apiKey = process.env.PERMIO_API_KEY;
const baseUrl = process.env.PERMIO_BASE_URL;
const project = process.env.PERMIO_PROJECT ?? "default";
const isProd = (url: string) => /(^|\/\/)(temp-)?api\.perms\.io\/?$/.test(url) || url.startsWith(DEFAULT_BASE_URL);

describe.skipIf(!apiKey || !baseUrl || isProd(baseUrl ?? ""))("live smoke test", () => {
  it("runs a check end to end", async () => {
    const permio = new Permio({ apiKey: apiKey!, baseUrl: baseUrl!, project });
    const result = await permio.checkDetailed({
      principal: "permio-js-smoke-test",
      resource: "/permio-js/smoke",
      permission: "permio-js.smoke",
    });
    expect(typeof result.allowed).toBe("boolean");
  });

  it("rejects an unknown key with PermioAuthError", async () => {
    const permio = new Permio({ apiKey: "perms_0123456789ABCDEFGHIJKLMNOPQRSTUV1ggZdL", baseUrl: baseUrl!, project });
    await expect(
      permio.check({ principal: "x", resource: "/x", permission: "x" }),
    ).rejects.toBeInstanceOf(PermioAuthError);
  });
});
