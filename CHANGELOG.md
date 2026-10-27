# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[semantic versioning](https://semver.org/).

## Unreleased (0.4.0)

### Changed

- **Behaviour change:** `whoHasAccess` and `listAccess` now collect at most
  `maxResults` results (default 10,000) and throw the new
  `PermioTooManyResultsError` beyond that, instead of following every page
  into memory. They fetch at most `maxResults + 1` items before throwing. Pass
  a larger `maxResults`, or switch to the streaming forms below.
- **Behaviour change:** `batchCheck` / `batchCheckDetailed` accept at most
  `maxResources` resources per call (default 10,000, counted before
  de-duplication) and throw `PermioValidationError` above it. Chunk requests
  are built as they are sent instead of all up front.

### Added

- `whoHasAccessIter()` and `listAccessIter()`: async generators that stream
  the same entries / scopes page by page, with no cap.
- `maxResults` on `whoHasAccess` / `listAccess`, `maxResources` on
  `batchCheck`, and the `DEFAULT_MAX_RESULTS` / `DEFAULT_MAX_BATCH_RESOURCES`
  constants.
- `listTimeoutMs` client option: the per-attempt timeout for every list page
  (any RPC with a `pagination` request field). Defaults to `timeoutMs`.
- `paginate()` takes `maxItems`; the last page then asks only for the items
  still wanted.

## 0.3.0

### Added

- `permio.grant()` and `permio.revoke()`: grant or revoke permissions and roles
  on a resource URI. Like every write, they are sent once and never retried.
- `permio.whoAmI()`: describes the key in use (ID, organisation, project and
  access level). `WhoAmI` is retried like the other reads.
- The live test (`test/live.test.ts`) is now an integration test of grant,
  check, batch check, list access, revoke, groups and error mapping. It runs
  whenever `PERMIO_API_KEY` is set (against the dev API by default), and in CI
  when the `PERMIO_DEV_API_KEY` secret is available.
- `PermioRateLimitError` for `ResourceExhausted` (HTTP 429), with
  `retryAfterMs` from the server's `google.rpc.RetryInfo` or `Retry-After`.
- Rate-limited idempotent reads are retried after the server's requested delay
  when it is within `retries.maxDelayMs`. A `Retry-After` header on
  `Unavailable` is honoured as the minimum backoff.

### Changed

- The package is now licensed under Apache-2.0 (previously MIT). Releases up
  to and including 0.2.2 remain available under MIT.
- `batchCheck` / `batchCheckDetailed` with more than 100 resources now have at
  most 4 `BatchCheck` calls in flight at once instead of sending every chunk
  in parallel. After a call fails, no further chunks are sent.

### Fixed

- `checkAny` failed open: a denial (`passed: false`) with an empty missing
  list returned `true`. It now returns `false`.
- A list RPC that returns a cursor it already returned now throws a
  `PermioError` ("inconsistent response from the API") instead of silently
  ending the listing, which returned a truncated list as if it were complete.
- The live integration test's production guard could be bypassed with an
  explicit port (`https://api.perms.io:443`), upper case or a trailing dot. It
  now parses the URL and accepts only the development API and local hosts
  (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `*.test`), and fails
  instead of skipping when `PERMIO_BASE_URL` is anything else.

## 0.2.2

### Changed

- The production default is now `https://api.perms.io`. Version 0.2.1 and
  earlier default to `https://temp-api.perms.io`, which is being retired:
  upgrade, or pass `baseUrl: "https://api.perms.io"`.

## 0.2.1

### Changed

- Generated code updated to the v0.0.17 protos. The `createPermission` and
  `createRole` documentation now states that creating an existing name never
  clears fields you leave out; only specified fields that differ are changed.
  No API changes.

## 0.2.0

Requires a perms.io API that serves the v0.0.16 protos (groups and access
queries).

### Added

- Groups: `permio.groups.create`, `get`, `update`, `delete`, `list`,
  `addMembers`, `removeMembers`, `listMembers` and `listForPrincipal`, with
  async iterators for the list calls. `group(slug)` returns the group's
  principal ID, `"group:<slug>"`.
- `permio.batchCheck()` returns a `Map` from resource URI to allowed, one
  answer per resource. More than 100 resources are split into parallel calls.
  `permio.batchCheckDetailed()` also returns the missing permissions.
- `permio.listAccess()` answers "where may this principal use this permission
  under a URI?" across every page, as an `AccessScopes` object with
  `coversAll`, `scopes`, `allows(uri)`, `toPrefixes()`, `patterns()`,
  `exact()` and `toRegExp()` for filtering lists in a database.
- `permio.whoHasAccess()` lists the principals with access to a resource and
  the grants that give it, optionally expanding groups.
- Regenerated `src/gen/` from the v0.0.16 protos: the raw `permio.permissions`
  client has `BatchCheck`, `ListAccess`, `ListPrincipalsWithAccess` and the
  group RPCs, and `OrganisationService.CreateAPIKey` takes `access`
  (`APIKeyAccess.API_KEY_ACCESS_CHECK` or `API_KEY_ACCESS_FULL`), which
  `APIKey` reports.
- `BatchCheck`, `ListAccess`, `ListPrincipalsWithAccess`, `GetGroup`,
  `ListGroups`, `ListGroupMembers` and `ListGroupsForPrincipal` are retried on
  `Unavailable` and `DeadlineExceeded` like the other reads. Group writes are
  never retried.
- README sections on batch checks, groups, filtering lists (Prisma, SQL,
  MongoDB) and who has access.

## 0.1.0

- First release: `check`, `checkDetailed`, `checkAny`, `checkAll`, `assert`,
  list iterators, typed errors, retries and timeouts, API key validation,
  `resource()` and the generated raw clients.
