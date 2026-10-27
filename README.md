# permio

TypeScript SDK for [perms.io](https://perms.io), permissions as a service with
hierarchical resource-URI RBAC.

- One call to ask "may this principal do X on this resource?"
- Batch checks, grant and revoke, groups, and "where can they do X?" queries that turn into database filters
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
(say `/docs/42`), or grant it from code with `permio.grant()` and a
full-access key (see [Granting and revoking](#granting-and-revoking)).
Principal IDs are your own identifiers: user IDs, service names, anything
stable.

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
  baseUrl: "https://…",    // default https://api.perms.io (production)
  project: "my-app",       // default project for helpers; can be overridden per call
  timeoutMs: 10_000,       // per attempt; 0 disables
  listTimeoutMs: 10_000,   // per attempt for each list page; defaults to timeoutMs
  retries: 2,              // or { maxRetries, baseDelayMs, maxDelayMs }
  fetch: customFetch,      // defaults to globalThis.fetch
});
```

| Environment | `baseUrl`                    |
| ----------- | ---------------------------- |
| Production  | `https://api.perms.io` (default)                             |
| Development | `https://dev-api.perms.io` (also exported as `DEV_BASE_URL`) |

Keep API keys on the server. In a browser bundle the key is visible to anyone
who loads the page.

To confirm a key works and see what it is, call `whoAmI()`. It needs no
`project`:

```ts
const me = await permio.whoAmI();
// { principalId: "…", organisationId: "…", kind: "api_key", project: "my-app", apiKeyAccess: "full", email: undefined }
```

`kind` is `"api_key"`, `"user"`, `"service_account"` or `"unknown"`. For an API
key, `project` is the only project it can be used in and `apiKeyAccess` is
`"check"` (checks and reads), `"full"` (also writes, including grant and
revoke) or `"unknown"` (rights changed by hand). An unknown or invalidated key
throws `PermioAuthError`.

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

## Batch checks

`batchCheck` answers each resource separately, in one call per 100 resources.
It returns a `Map` from resource URI to `true`/`false`, so filtering a list you
already have is one line:

```ts
const uris = docs.map((d) => resource("docs", d.id));
const allowed = await permio.batchCheck({ principal: userId, resources: uris, permission: "docs.read" });
const visible = docs.filter((d) => allowed.get(resource("docs", d.id)));
```

A resource is allowed only if the principal holds every requested permission
on it (`permission` or `permissions`, up to 100). Duplicate resources are sent
once; more than 100 are split into several calls, at most 4 in flight at once.
One call takes at most `maxResources` resources (default 10,000, counted before
de-duplication); more throws `PermioValidationError` before anything is sent.
When you also want to know
what is missing, `batchCheckDetailed` returns
`[{ resource, allowed, missing: ["docs.write"] }, ...]` in request order.

## Granting and revoking

`grant` gives a principal permissions and roles (by role ID) on a resource URI,
and so on everything below it. It is additive: what the principal already holds
there is kept. `revoke` removes them from the grant on exactly that URI.

```ts
await permio.grant({ principal: "alice", resource: resource("docs", 42), permission: "docs.read" });
await permio.grant({ principal: "alice", resource: "/docs", permissions: ["docs.read", "docs.write"], roles: [editorRoleId] });

await permio.revoke({ principal: "alice", resource: "/docs", permission: "docs.write" });
```

Each call takes `principal`, `resource`, at least one of `permission`,
`permissions`, `role` or `roles`, and the usual `project`, `signal`,
`timeoutMs` and `headers`. Both need a key with full access.

- Every permission and role must already exist in the project, or `grant`
  throws `PermioValidationError`.
- `revoke` ignores names the grant does not hold, and does not touch grants on
  other URIs. A grant on an ancestor (say `/docs` when you revoke on `/docs/42`)
  still applies, so the principal can still pass `check`; use `whoHasAccess` to
  see where access comes from.
- Like every write, `grant` and `revoke` are sent once and never retried
  automatically. Both converge if repeated, so it is safe to call them again
  yourself after a `PermioUnavailableError` or `PermioTimeoutError`, but doing
  it blindly could undo a change someone else made in between.

## Groups

A group is a named set of principals in a project. Grant permissions or roles
to the group's principal ID, `group:<slug>`, and every member holds them.
`group(slug)` builds that ID. Groups cannot contain groups.

```ts
import { group } from "permio";

await permio.groups.create("editors", { description: "Can edit every doc" });
await permio.groups.addMembers("editors", ["alice", "bob"]); // { added: [...], existing: [...] }

await permio.grant({ principal: group("editors"), resource: "/docs", permission: "docs.write" }); // "group:editors"

await permio.check({ principal: "alice", resource: "/docs/42", permission: "docs.write" }); // true
```

| Method | Returns |
| ------ | ------- |
| `groups.create(name, { description? })` | `Group`. `AlreadyExists` if the name is taken |
| `groups.get(name)` | `Group`, or `PermioNotFoundError` |
| `groups.update(name, { description })` | `Group`. Only the description can change |
| `groups.delete(name)` | Deletes the group, its memberships and its grants. Resolves even if it did not exist |
| `groups.list({ search? })` | Async iterator of `Group`, ordered by name |
| `groups.addMembers(name, principals)` | `{ added, existing }`; up to 100 principals |
| `groups.removeMembers(name, principals)` | `{ removed, notMembers }`; up to 100 principals |
| `groups.listMembers(name)` | Async iterator of `GroupMember` (`principalId`, `createdAt`) |
| `groups.listForPrincipal(principal)` | Async iterator of the `Group`s the principal belongs to |

`name` is the slug (`"editors"`) or the principal ID (`"group:editors"`).
Slugs are 1–64 lower-case letters, digits and hyphens, and cannot be renamed.
Every method also takes `project`, `signal`, `timeoutMs` and `headers`; the
list methods take `pageSize` too.

## Filtering lists

To show a user only the rows they may see, ask once where they have access and
turn the answer into a database filter, instead of checking row by row.

```ts
const access = await permio.listAccess({
  principal: userId,
  permission: "docs.read",
  under: "/docs", // only resources at or below this URI are considered
});
```

`listAccess` follows every page and returns an `AccessScopes` object. It
collects at most `maxResults` scopes (default 10,000) and throws
`PermioTooManyResultsError` beyond that; to handle any number, stream them with
`listAccessIter` (see [Large results](#large-results)).

| Member | Meaning |
| ------ | ------- |
| `coversAll` | The principal holds the permission on `under` itself, so on everything below it. No filter needed |
| `isEmpty` | No access anywhere under `under` |
| `scopes` | `[{ uri, kind }]`, where `kind` is `"subtree"` (the URI and everything below it), `"pattern"` (each `_` segment matches exactly one segment, then everything below) or `"exact"` (reserved, not returned today) |
| `allows(uri)` | Whether a URI is covered. Segment-aware: `/docs/1` covers `/docs/1/x` but not `/docs/12` |
| `toPrefixes()` | The subtree URIs, for prefix filters. Prefixes covered by a shorter one are dropped |
| `patterns()` / `hasPatterns` | The pattern URIs, which no prefix can express |
| `toRegExp()` | One anchored `RegExp` matching exactly what `allows()` accepts, patterns included |

A prefix `p` stands for `p` itself and everything below it, so match
`path = p OR path starts with p + "/"`. A bare "starts with `p`" would let
`/docs/1` match `/docs/12`. Pattern scopes appear when a grant was made on a URI
with `_` wildcard segments (such as `/docs/_/comments`); handle them with
`toRegExp()`, or by filtering candidates with `allows()`.

The answer is about resources at or below `under`. For a URI outside it,
`allows()` returning `false` means "not asked", not "denied".

### Prisma

Assuming each row stores its resource URI in `path`:

```ts
let docs: Doc[];
if (access.coversAll) {
  docs = await prisma.doc.findMany();
} else if (!access.hasPatterns) {
  const prefixes = access.toPrefixes();
  docs = await prisma.doc.findMany({
    where: { OR: [{ path: { in: prefixes } }, ...prefixes.map((p) => ({ path: { startsWith: p + "/" } }))] },
  });
} else {
  // Prisma has no portable regex filter: load the candidates under /docs and keep the allowed ones.
  const candidates = await prisma.doc.findMany({ where: { path: { startsWith: "/docs/" } } });
  docs = candidates.filter((d) => access.allows(d.path));
}
```

If your rows are only identified by an ID and their URI is `/docs/<id>`, the
prefixes one segment below `under` are the readable IDs (when `hasPatterns` is
false; a pattern such as `/docs/_` would stand for every doc):

```ts
const ids = access.toPrefixes().filter((p) => p.split("/").length === 3).map((p) => decodeURIComponent(p.split("/")[2]!));
const docs = access.coversAll ? await prisma.doc.findMany() : await prisma.doc.findMany({ where: { id: { in: ids } } });
```

A deeper prefix such as `/docs/7/comments` grants access below doc 7, not to
doc 7 itself, so it is rightly left out.

### SQL (PostgreSQL)

```ts
const prefixes = access.toPrefixes();
const { rows } = access.coversAll
  ? await pool.query("SELECT * FROM docs")
  : await pool.query(
      `SELECT * FROM docs
        WHERE path = ANY($1::text[])
           OR EXISTS (SELECT 1 FROM unnest($1::text[]) AS p WHERE starts_with(path, p || '/'))
           OR ($2::text IS NOT NULL AND path ~ $2)`,
      [prefixes, access.hasPatterns ? access.toRegExp().source : null],
    );
```

Avoid `LIKE p || '%'`: `_` and `%` are wildcards in `LIKE`, and `_` is common in
IDs, so it would match rows it should not unless you escape them.
`starts_with` (PostgreSQL 11+) compares literally. `toRegExp().source` is valid
PostgreSQL regex syntax, so `path ~ $1` alone also works, without index support.

### MongoDB

```ts
const filter = access.coversAll ? {} : { path: access.toRegExp() };
const docs = await db.collection("docs").find(filter).toArray();
```

`toRegExp()` covers subtree, pattern and exact scopes in one anchored regex.

### In memory

```ts
const visible = docs.filter((d) => access.allows(resource("docs", d.id)));
```

For a short list you already have, `batchCheck` works too and needs only
`permission.check` on the API key. `listAccess` also needs
`principal.assignment.get` on the principal.

## Who has access

`whoHasAccess` lists the principals with a grant on a resource, on an ancestor
of it, or on a `_` wildcard URI that matches it, following every page. It
collects at most `maxResults` entries (default 10,000); a popular resource can
have millions, so use `whoHasAccessIter` to stream them (see
[Large results](#large-results)):

```ts
const entries = await permio.whoHasAccess({ resource: "/docs/42", permission: "docs.read", expandGroups: true });
// [
//   { principal: "alice", isGroup: false, viaGroup: undefined,
//     via: [{ resource: "/docs", inherited: true, match: "ancestor", source: { type: "role", id: "r1", name: "viewer" } }] },
//   { principal: "group:editors", isGroup: true, viaGroup: undefined, via: [...] },
//   { principal: "bob", isGroup: false, viaGroup: "editors", via: [...] },
// ]
```

With `permission`, only grants that confer it count, so a principal is listed
exactly when `check()` passes for it (directly, or through the group in
`viaGroup`). Without it, any grant counts. `expandGroups` adds an entry for each
member of each listed group. Entries are ordered by principal ID. The API key
needs `principal.list` and `principal.assignment.list` on the project.

## Large results

`whoHasAccess` and `listAccess` collect everything into memory, so they stop at
`maxResults` (default 10,000). When there are more, they throw
`PermioTooManyResultsError` (with `maxResults`) after fetching at most
`maxResults + 1` items. Either raise the cap or stream instead:

```ts
for await (const entry of permio.whoHasAccessIter({ resource: "/docs/42", permission: "docs.read" })) {
  await notify(entry.principal);
}
for await (const scope of permio.listAccessIter({ principal: userId, permission: "docs.read", under: "/docs" })) {
  // { uri, kind }. When the principal covers all of `under`, this is a single
  // { uri: under, kind: "subtree" } scope.
}
```

The `…Iter` forms take the same options (minus `maxResults`), fetch one page
(`pageSize`, default 100) at a time as you iterate, and stop fetching when you
`break`. Each page is a read RPC with the usual retries and `listTimeoutMs`.

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
| `PermioRateLimitError`   | `ResourceExhausted` (HTTP 429): the organisation's check rate limit is used up. `retryAfterMs` is the server's requested delay |
| `PermioDeniedError`      | Thrown only by `assert()` when the *principal* is not allowed; has `principal` and `missing` |
| `PermioTooManyResultsError` | `whoHasAccess` / `listAccess` found more than `maxResults` (default 10,000). Use the `…Iter` form or raise `maxResults` |

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

Idempotent reads (`Check`, `BatchCheck`, `WhoAmI`, and every `Get*` and `List*` RPC) are retried on
`Unavailable` and `DeadlineExceeded`, twice by default, with exponential backoff
and jitter (a retry always waits first; a timed-out list page is never retried
immediately). Writes, including `grant` and `revoke`, are never retried. `timeoutMs` on the client applies to each
attempt, and `listTimeoutMs` (default: `timeoutMs`) to each attempt of a list
page; `timeoutMs` on a call is an overall deadline. Aborting `signal` cancels
the call and any pending retry.

Checks are rate limited per organisation (checks per second, by plan). When the
limit is used up the API returns `ResourceExhausted` with a `google.rpc.RetryInfo`
delay (and a `Retry-After` header): idempotent reads are retried after that delay
(plus a little jitter) when it is within `maxDelayMs`, otherwise
`PermioRateLimitError` is thrown with `retryAfterMs`. A `Retry-After` header on an
`Unavailable` response is also honoured as the minimum backoff.

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
key with full access. Pick the level when creating a key:

```ts
import { organisationv1 } from "permio";

const { apiKey } = await permio.organisations.createAPIKey({
  organisationId,
  projectName: "my-app",
  name: "ci",
  access: organisationv1.APIKeyAccess.API_KEY_ACCESS_FULL, // or API_KEY_ACCESS_CHECK, the default
});
console.log(apiKey?.key, apiKey?.access);
```

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

`.proto-version` records the proto release (tag and commit) that `src/gen/` is
generated from. CI regenerates from that commit and fails if `src/gen/` differs,
so update both together. When the protos are released, their release workflow
regenerates `src/gen/`, updates `.proto-version` and opens a pull request here.
Merging that pull request does not publish anything. To release, update the
hand-written code, `CHANGELOG.md` and the `package.json` version as needed,
then push a matching `vX.Y.Z` tag, which runs the npm publish workflow.

The integration test in `test/live.test.ts` runs only when `PERMIO_API_KEY` is
set. It needs a full-access key, talks to the development API unless
`PERMIO_BASE_URL` says otherwise, and refuses to run (fails) against anything
but the development API and local hosts (`localhost`, `127.0.0.1`, `[::1]`,
`*.localhost`, `*.test`). It
covers `whoAmI`, grant, check, `batchCheck`, `listAccess`, revoke, a group and
a bad key, using fixed `sdk-it-js-*` IDs and `sdk-it-js.*` permissions that it
deletes before and after. The project is the key's own unless
`PERMIO_PROJECT` is set:

```sh
PERMIO_API_KEY=perms_… npx vitest run test/live.test.ts
```

CI runs it in the `integration` job when the `PERMIO_DEV_API_KEY` secret is
set, and skips it otherwise.

## License

Apache-2.0. See [LICENSE](LICENSE).
