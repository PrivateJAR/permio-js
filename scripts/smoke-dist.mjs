// Loads the built ESM bundle and runs a check against a stubbed fetch. Used by
// CI to prove dist/ works on every supported Node version, including 18.
import assert from "node:assert/strict";
import { AccessScopes, Permio, PermioAuthError, group, resource, validateApiKey } from "../dist/index.js";

const key = "perms_0123456789ABCDEFGHIJKLMNOPQRSTUV1ggZdL";
assert.equal(validateApiKey(key), "opaque");
assert.equal(resource("docs", "a/b"), "/docs/a%2Fb");
assert.equal(group("editors"), "group:editors");
const scopes = new AccessScopes("/docs", false, [{ uri: "/docs/1", kind: "subtree" }]);
assert.equal(scopes.allows("/docs/1/x"), true);
assert.equal(scopes.allows("/docs/12"), false);

const trailer = new TextEncoder().encode("grpc-status: 16\r\ngrpc-message: invalid api key\r\n");
const body = new Uint8Array(5 + trailer.length);
body[0] = 0x80;
new DataView(body.buffer).setUint32(1, trailer.length);
body.set(trailer, 5);

const permio = new Permio({
  apiKey: key,
  project: "smoke",
  fetch: async () => new Response(body, { headers: { "content-type": "application/grpc-web+proto" } }),
});
await assert.rejects(permio.check({ principal: "p", resource: "/r", permission: "x" }), PermioAuthError);
console.log(`ESM bundle OK on Node ${process.version}`);
