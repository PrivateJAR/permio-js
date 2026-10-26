// CommonJS counterpart of smoke-dist.mjs.
const assert = require("node:assert/strict");
const { AccessScopes, Permio, PermioConfigError, group, resource, validateApiKey } = require("../dist/index.cjs");

assert.equal(validateApiKey("a.b.c"), "jwt");
assert.equal(resource("x", "(y)"), "/x/%28y%29");
assert.equal(group("editors"), "group:editors");
assert.deepEqual(new AccessScopes("/d", false, [{ uri: "/d/1", kind: "subtree" }, { uri: "/d/_/x", kind: "pattern" }]).toPrefixes(), ["/d/1"]);
assert.equal(typeof new Permio({ apiKey: "perms_0123456789ABCDEFGHIJKLMNOPQRSTUV1ggZdL" }).groups.list, "function");
assert.throws(() => new Permio({ apiKey: "perms_nope" }), PermioConfigError);
assert.equal(typeof new Permio({ apiKey: "perms_0123456789ABCDEFGHIJKLMNOPQRSTUV1ggZdL" }).check, "function");
for (const m of ["grant", "revoke", "whoAmI"]) assert.equal(typeof new Permio({ apiKey: "perms_0123456789ABCDEFGHIJKLMNOPQRSTUV1ggZdL" })[m], "function");
console.log(`CJS bundle OK on Node ${process.version}`);
