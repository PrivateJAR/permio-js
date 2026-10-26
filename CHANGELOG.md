# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[semantic versioning](https://semver.org/).

## Unreleased

### Added

- `permio.grant()` and `permio.revoke()`: grant or revoke permissions and roles
  on a resource URI. Like every write, they are sent once and never retried.
- `permio.whoAmI()`: describes the key in use (ID, organisation, project and
  access level). `WhoAmI` is retried like the other reads.
- The live test (`test/live.test.ts`) is now an integration test of grant,
  check, batch check, list access, revoke, groups and error mapping. It runs
  whenever `PERMIO_API_KEY` is set (against the dev API by default), and in CI
  when the `PERMIO_DEV_API_KEY` secret is available.

### Changed

- The package is now licensed under Apache-2.0 (previously MIT). Releases up
  to and including 0.2.2 remain available under MIT.

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
