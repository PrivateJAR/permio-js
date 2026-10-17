# permio

TypeScript SDK for [perms.io](https://perms.io), permissions as a service with
hierarchical resource-URI RBAC.

- One call to ask "may this principal do X on this resource?"
- Typed errors, retries for idempotent reads, async iterators over list endpoints
- The full generated API (every RPC of `PermissionsService` and `OrganisationService`) is available as an escape hatch
- Works in Node 18+, edge runtimes and browsers (gRPC-web over `fetch`)
- ESM and CommonJS, bundled type definitions, three runtime dependencies

## Install

```sh
npm install permio
```

## Quickstart (5 minutes)

**1. Create an API key.** In the perms.io dashboard, select your project, open
**API Keys** and click **Create New Key**. Copy the key: it is shown only once.
Keys look like `perms_` followed by 38 letters and digits.

**2. Grant something to check.** In the dashboard, create a permission (say
`docs.read`) and grant it to a principal (say `alice`) on a resource
(say `/docs/42`). Principal IDs are your own identifiers: user IDs, service
names, anything stable.

**3. Check it.**

```ts
import { Permio, resource } from "permio";

const permio = new Permio({
  apiKey: process.env.PERMIO_API_KEY!,
  project: "my-app", // your project name
});

const allowed = await permio.check({
  principal: "alice",
  resource: resource("docs", 42), // "/docs/42"
  permission: "docs.read",
});

console.log(allowed); // true
```

A principal that lacks the permission is a normal answer: `check` resolves to
`false`. It only throws when the call itself fails (bad key, malformed input,
network trouble).

A runnable version lives in [`examples/check.mjs`](examples/check.mjs).

## Configuration

```ts
new Permio({
  apiKey: "perms_…",       // required; format and checksum are validated immediately
  baseUrl: "https://…",    // default https://temp-api.perms.io (production)
  project: "my-app",       // default project for helpers; can be overridden per call
  timeoutMs: 10_000,       // per attempt; 0 disables
  retries: 2,              // or { maxRetries, baseDelayMs, maxDelayMs }
  fetch: customFetch,      // defaults to globalThis.fetch
});
```

| Environment | `baseUrl`                    |
| ----------- | ---------------------------- |
| Production  | `https://temp-api.perms.io` (default). This will become `https://api.perms.io`; the default will follow in a future release. |
| Development | `https://dev-api.perms.io` (also exported as `DEV_BASE_URL`) |

Keep API keys on the server. In a browser bundle the key is visible to anyone
who loads the page.

## Checking permissions

```ts
// Every permission on every resource?
await permio.check({ principal, resources: ["/docs/1", "/docs/2"], permissions: ["docs.read", "docs.write"] });

// Same, with what is missing.
const { allowed, missing } = await permio.checkDetailed({ principal, resource: "/docs/1", permissions: ["docs.read", "docs.write"] });
// missing: [{ resource: "/docs/1", permissions: ["docs.write"] }]

// Throw PermioDeniedError unless allowed.
await permio.assert({ principal, resource: "/docs/1", permission: "docs.write" });

// At least one of the permissions on each resource (still one API call).
await permio.checkAny({ principal, resource: "/docs/1", permissions: ["docs.admin", "docs.write"] });

// checkAll is an alias of check.
```

Each helper takes `project` (overrides the client default), `signal` (an
`AbortSignal`), `timeoutMs` (an overall deadline for this call, across retries)
and `headers`. A single check accepts up to 100 resources and 100 permissions;
duplicates are removed before sending.

### Resource URIs

Resource URIs are paths such as `/projects/p1/docs/42`. A grant on a URI also
covers every URI beneath it, so a grant on `/projects/p1` satisfies a check on
`/projects/p1/docs/42`. A `_` segment in a granted URI matches any single
segment.

Use `resource()` to build URIs from IDs. It adds the leading slash and
percent-encodes each segment, so an ID containing `/` or other reserved
characters stays one segment:

```ts
resource("projects", projectId, "docs", docId); // "/projects/p1/docs/a%2Fb"
```

Build URIs the same way when granting and when checking. Before sending, the SDK
checks the basic shape (leading `/`, no empty segments, no whitespace, at most
2048 bytes); the API enforces the rest, for example no `( ) [ ] { } * + ? | ^ $ \`
in segments, and answers with a `PermioValidationError`.

## Express

```ts
import express, { type RequestHandler } from "express";
import { Permio, PermioDeniedError, resource } from "permio";

const permio = new Permio({ apiKey: process.env.PERMIO_API_KEY!, project: "my-app" });
const app = express();

const can = (permission: string): RequestHandler => async (req, res, next) => {
  try {
    await permio.assert({
      principal: res.locals.userId, // set by your auth middleware
      resource: resource("docs", req.params.id),
      permission,
    });
    next();
  } catch (err) {
    if (err instanceof PermioDeniedError) return res.status(403).json({ error: "forbidden" });
    next(err); // PermioError: auth, validation, network...
  }
};

app.get("/docs/:id", can("docs.read"), (req, res) => res.json({ id: req.params.id }));
```

## Next.js (App Router)

```ts
// lib/permio.ts (server only)
import { Permio } from "permio";
export const permio = new Permio({ apiKey: process.env.PERMIO_API_KEY!, project: "my-app" });
```

```ts
// app/docs/[id]/route.ts
import { resource } from "permio";
import { permio } from "@/lib/permio";
import { getUserId } from "@/lib/auth"; // your auth

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const allowed = await permio.check({
    principal: await getUserId(),
    resource: resource("docs", id),
    permission: "docs.delete",
  });
  if (!allowed) return new Response("Forbidden", { status: 403 });
  // ...delete the doc
  return new Response(null, { status: 204 });
}
```

The client uses only `fetch`, so it also runs in the Edge runtime and middleware.

## Errors

Every error the SDK throws extends `PermioError`, which has `code` (the gRPC
status `Code`, re-exported from this package), `codeName` (for example
`"permission_denied"`), `metadata` (response headers and trailers) and `cause`
(the original `ConnectError`).

| Class                    | When                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `PermioConfigError`      | Bad client setup: malformed API key, missing `project`, invalid `baseUrl`              |
| `PermioAuthError`        | `Unauthenticated`: the key is unknown, invalidated or missing                          |
| `PermioPermissionError`  | `PermissionDenied`: the *API key* lacks rights for this call. `missing` lists what it lacks when the API says |
| `PermioValidationError`  | `InvalidArgument`, or the SDK's own input checks (e.g. a URI without a leading `/`)    |
| `PermioNotFoundError`    | `NotFound`, e.g. `getPermission` for a name that does not exist                        |
| `PermioUnavailableError` | `Unavailable`, including network failures                                              |
| `PermioTimeoutError`     | `DeadlineExceeded`, including the SDK's own timeouts                                   |
| `PermioDeniedError`      | Thrown only by `assert()` when the *principal* is not allowed; has `principal` and `missing` |

Anything else is a plain `PermioError` with the matching `code`.

```ts
import { PermioAuthError, PermioDeniedError, PermioError, PermioPermissionError } from "permio";

try {
  await permio.assert({ principal, resource, permission });
} catch (err) {
  if (err instanceof PermioDeniedError) {
    // the principal may not do this: return 403
  } else if (err instanceof PermioPermissionError) {
    // the API key may not check this principal/resource (needs permission.check)
    console.error(err.missing);
  } else if (err instanceof PermioAuthError) {
    // rotate or fix the API key
  } else if (err instanceof PermioError) {
    console.error(err.codeName, err.message);
  }
}
```

`PermioPermissionError.missing` uses the API's fully qualified URIs
(`/organisation/{org}/project/{project}/...`), not the URIs you sent.

### Retries and timeouts

Idempotent reads (`Check`, and every `Get*` and `List*` RPC) are retried on
`Unavailable` and `DeadlineExceeded`, twice by default, with exponential backoff
and jitter. Writes are never retried. `timeoutMs` on the client applies to each
attempt; `timeoutMs` on a call is an overall deadline. Aborting `signal` cancels
the call and any pending retry.

## Listing

List RPCs are paginated with a cursor. The helpers return async iterators that
fetch pages of up to 100 items as you go:

```ts
for await (const p of permio.listPermissions({ search: "docs." })) console.log(p.name);
for await (const role of permio.listRoles()) console.log(role.name, role.permissions.length);
for await (const id of permio.listPrincipals()) console.log(id);
for await (const a of permio.listAssignments({ principal: "alice" })) console.log(a.resourceUri, a.roles);
```

Each takes `project`, `pageSize` (1–100), `signal`, `timeoutMs` (per page) and
`headers`. For other list RPCs use `paginate`:

```ts
import { paginate } from "permio";

for await (const key of paginate(
  (pagination, signal) =>
    permio.organisations.listAPIKeys({ organisationId, projectName: "my-app", pagination }, { signal }),
  (res) => res.apiKeys,
)) {
  console.log(key.name);
}
```

## Raw clients (full API)

`permio.permissions` and `permio.organisations` are the generated
[Connect](https://connectrpc.com/docs/web/using-clients) clients for
`permio.permissions.v1.PermissionsService` and
`permio.organisation.v1.OrganisationService`, with authentication, timeouts,
retries and error mapping already applied. Every RPC in the API is there,
with request and response types generated from the protos:

```ts
await permio.permissions.createPermission({ projectName: "my-app", name: "docs.read", description: "Read docs" });

await permio.permissions.grantUserPermissionsAndRolesOnResource({
  projectName: "my-app",
  userId: "alice",
  resourceUri: "/docs/42",
  permissions: ["docs.read"],
});

const res = await permio.permissions.check({
  projectName: "my-app",
  principalId: "alice",
  resourceUris: ["/docs/42"],
  permissions: ["docs.read"],
});
```

What a key may do depends on its access level. A key with check access (the
default) can run checks and read permissions, roles and principals. Creating,
updating and deleting permissions and roles, and granting or revoking, needs a
key with full access.

The generated messages are exported as `permissionsv1`, `organisationv1` and
`paginationv1`, and the service descriptors as `PermissionsService` and
`OrganisationService`:

```ts
import { create } from "@bufbuild/protobuf";
import { permissionsv1 } from "permio";

const req = create(permissionsv1.CheckPermissionRequestSchema, { projectName: "my-app" });
```

## API key format

Keys created in the dashboard are opaque strings of 44 characters:

```
perms_ + 32 random base62 characters + 6 base62 characters of CRC32 checksum
```

The checksum lets the SDK reject a mistyped or truncated key in the
constructor, before any request is made. It says nothing about whether the key
exists or is still valid; only the API knows that. Older keys are JWTs; any
value shaped like a JWT (three base64url parts separated by dots) is accepted
as is. `validateApiKey(key)` returns `"opaque"` or `"jwt"` and throws
`PermioConfigError` otherwise.

## How it talks to the API

The SDK uses the gRPC-web protocol over `fetch` (via `@connectrpc/connect-web`),
which the perms.io gateway supports directly from servers, edge runtimes and
browsers. The API key is sent as `Authorization: Bearer <key>`.

## Development

```sh
npm install
npm run typecheck
npm run build
npm test
```

`src/gen/` is generated from Permio's protobuf definitions, which define the
API (see the [perms.io docs](https://docs.perms.io)), and committed.
**Never edit it by hand**; regenerate it instead:

```sh
scripts/generate.sh                               # expects the proto repo at ../proto
PERMIO_PROTO_DIR=/path/to/proto scripts/generate.sh
```

This needs [buf](https://buf.build/docs/installation). Only
`permissions/v1/permissions.proto`, `organisation/v1/organisation.proto` and
`pagination/v1/pagination.proto` (plus the files they import) are generated;
internal services are never included. Everything else in `src/` is written by
hand.

The live smoke test in `test/live.test.ts` runs only when `PERMIO_API_KEY` and
`PERMIO_BASE_URL` are set, and refuses to run against production:

```sh
PERMIO_API_KEY=perms_… PERMIO_BASE_URL=https://dev-api.perms.io PERMIO_PROJECT=my-app npm test
```

## License

MIT
