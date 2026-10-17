// Runnable example: checks one permission and prints the result.
//
//   npm run build
//   PERMIO_API_KEY=perms_... PERMIO_PROJECT=my-app node examples/check.mjs alice docs 42 docs.read
//
// Set PERMIO_BASE_URL=https://dev-api.perms.io to use the development API.
// In your own project, import from "permio" instead of "../dist/index.js".
import { Permio, PermioError, resource } from "../dist/index.js";

const [principal = "alice", type = "docs", id = "42", permission = "docs.read"] = process.argv.slice(2);

const permio = new Permio({
  apiKey: process.env.PERMIO_API_KEY ?? "",
  project: process.env.PERMIO_PROJECT,
  ...(process.env.PERMIO_BASE_URL ? { baseUrl: process.env.PERMIO_BASE_URL } : {}),
});

const uri = resource(type, id);
try {
  const { allowed, missing } = await permio.checkDetailed({ principal, resource: uri, permission });
  console.log(`${principal} ${allowed ? "has" : "does not have"} ${permission} on ${uri}`);
  for (const m of missing) console.log(`  missing on ${m.resource}: ${m.permissions.join(", ")}`);
  process.exitCode = allowed ? 0 : 2;
} catch (err) {
  if (err instanceof PermioError) {
    console.error(`${err.name} (${err.codeName ?? "client"}): ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
