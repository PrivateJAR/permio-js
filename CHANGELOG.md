# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[semantic versioning](https://semver.org/).

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
