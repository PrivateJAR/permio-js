// CommonJS counterpart of smoke-dist.mjs.
const assert = require("node:assert/strict");
const { Permio, PermioConfigError, resource, validateApiKey } = require("../dist/index.cjs");

assert.equal(validateApiKey("a.b.c"), "jwt");
assert.equal(resource("x", "(y)"), "/x/%28y%29");
assert.throws(() => new Permio({ apiKey: "perms_nope" }), PermioConfigError);
assert.equal(typeof new Permio({ apiKey: "perms_0123456789ABCDEFGHIJKLMNOPQRSTUV1ggZdL" }).check, "function");
console.log(`CJS bundle OK on Node ${process.version}`);
