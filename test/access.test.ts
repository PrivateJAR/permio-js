import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  AccessScopes,
  PermioError,
  PermioNotFoundError,
  PermioPermissionError,
  PermioUnavailableError,
  PermioValidationError,
  PermissionsService,
  permissionsv1,
  resource,
  type AccessScopeInfo,
} from "../src/index.js";
import { client } from "./helpers.js";

const { AccessScopeKind, AccessGrantMatch } = permissionsv1;

function scopes(list: Array<[string, AccessScopeInfo["kind"]]>, coversAll = false, under = "/docs"): AccessScopes {
  return new AccessScopes(under, coversAll, list.map(([uri, kind]) => ({ uri, kind })));
}

describe("AccessScopes.allows", () => {
  it("subtree matches the URI and everything below it, on segment boundaries", () => {
    const a = scopes([["/a/b", "subtree"]]);
    expect(a.allows("/a/b")).toBe(true);
    expect(a.allows("/a/b/c")).toBe(true);
    expect(a.allows("/a/b/c/d")).toBe(true);
    expect(a.allows("/a/bc")).toBe(false);
    expect(a.allows("/a/bc/d")).toBe(false);
    expect(a.allows("/a")).toBe(false);
    expect(a.allows("/a/c")).toBe(false);
    expect(a.allows("/x/a/b")).toBe(false);
  });

  it("treats _ in a subtree scope as literal", () => {
    const a = scopes([["/docs/_", "subtree"]], true, "/docs/_");
    expect(a.allows("/docs/_")).toBe(true);
    expect(a.allows("/docs/_/1")).toBe(true);
    expect(a.allows("/docs/1")).toBe(false);
  });

  it("pattern _ matches exactly one segment, then the subtree below", () => {
    const a = scopes([["/docs/_/files", "pattern"]]);
    expect(a.allows("/docs/1/files")).toBe(true);
    expect(a.allows("/docs/abc/files/9")).toBe(true);
    expect(a.allows("/docs/_/files")).toBe(true);
    expect(a.allows("/docs/1")).toBe(false);
    expect(a.allows("/docs/1/2/files")).toBe(false);
    expect(a.allows("/docs/1/filesx")).toBe(false);
    expect(a.allows("/docs/files")).toBe(false);
  });

  it("pattern with several wildcards, including a trailing one", () => {
    const a = scopes([["/_/a/_", "pattern"]]);
    expect(a.allows("/doc/a/1")).toBe(true);
    expect(a.allows("/x/a/y/z")).toBe(true);
    expect(a.allows("/doc/a")).toBe(false);
    expect(a.allows("/doc/b/1")).toBe(false);
  });

  it("a concrete segment does not match a literal _ in the URI", () => {
    const a = scopes([["/docs/a", "pattern"]]);
    expect(a.allows("/docs/_")).toBe(false);
  });

  it("exact matches only the URI itself", () => {
    const a = scopes([["/docs/1", "exact"]]);
    expect(a.allows("/docs/1")).toBe(true);
    expect(a.allows("/docs/1/x")).toBe(false);
    expect(a.allows("/docs")).toBe(false);
  });

  it("never matches unknown scope kinds or malformed URIs", () => {
    const a = scopes([
      ["/docs", "unknown"],
      ["/a", "subtree"],
    ]);
    expect(a.allows("/docs/1")).toBe(false);
    expect(a.allows("a")).toBe(false);
    expect(a.allows("/a/")).toBe(false);
    expect(a.allows("/a//b")).toBe(false);
    expect(a.allows("")).toBe(false);
    expect(a.allows("/")).toBe(false);
    expect(a.allows(undefined as unknown as string)).toBe(false);
  });

  it("coversAll allows everything at or below under", () => {
    const a = scopes([["/docs", "subtree"]], true);
    expect(a.coversAll).toBe(true);
    expect(a.isEmpty).toBe(false);
    expect(a.allows("/docs")).toBe(true);
    expect(a.allows("/docs/1/2")).toBe(true);
    expect(a.allows("/docsx")).toBe(false);
  });

  it("an empty result allows nothing", () => {
    const a = scopes([]);
    expect(a.isEmpty).toBe(true);
    expect(a.allows("/docs/1")).toBe(false);
    expect(a.toPrefixes()).toEqual([]);
    expect(a.toRegExp().test("/docs/1")).toBe(false);
    expect(a.toRegExp().test("")).toBe(false);
  });
});

describe("AccessScopes prefixes, patterns and regex", () => {
  const a = scopes([
    ["/docs/1", "subtree"],
    ["/docs/1/sub", "subtree"],
    ["/docs/12", "subtree"],
    ["/docs/_/shared", "pattern"],
    ["/docs/9", "exact"],
    ["/docs/x", "unknown"],
  ]);

  it("toPrefixes returns subtree URIs only, dropping ones covered by a shorter prefix", () => {
    expect(a.toPrefixes()).toEqual(["/docs/1", "/docs/12"]);
  });

  it("exposes patterns and exact scopes separately", () => {
    expect(a.hasPatterns).toBe(true);
    expect(a.patterns()).toEqual(["/docs/_/shared"]);
    expect(a.exact()).toEqual(["/docs/9"]);
    expect(scopes([["/a", "subtree"]]).hasPatterns).toBe(false);
  });

  it("toRegExp agrees with allows()", () => {
    const re = a.toRegExp();
    const uris = [
      "/docs/1",
      "/docs/1/a",
      "/docs/10",
      "/docs/12/z",
      "/docs/123",
      "/docs/7/shared",
      "/docs/7/shared/x",
      "/docs/7/sharedx",
      "/docs/7/8/shared",
      "/docs/9",
      "/docs/9/x",
      "/docs/x",
      "/docs",
    ];
    for (const uri of uris) expect([uri, re.test(uri)]).toEqual([uri, a.allows(uri)]);
  });

  it("toRegExp escapes regex metacharacters in segments", () => {
    const b = scopes([["/a.b/c%2Fd", "subtree"]]);
    const re = b.toRegExp();
    expect(re.test("/a.b/c%2Fd/e")).toBe(true);
    expect(re.test("/aXb/c%2Fd")).toBe(false);
  });

  it("is immutable", () => {
    expect(() => (a.scopes as AccessScopeInfo[]).push({ uri: "/z", kind: "subtree" })).toThrow();
  });
});

describe("listAccess", () => {
  type Req = permissionsv1.ListAccessRequest;

  it("follows every page and maps scope kinds", async () => {
    const seen: Req[] = [];
    const pages = [
      {
        scopes: [
          { uri: "/docs/1", scope: AccessScopeKind.SUBTREE },
          { uri: "/docs/_/shared", scope: AccessScopeKind.PATTERN },
        ],
        pagination: { nextCursor: "/docs/_/shared" },
      },
      { scopes: [{ uri: "/docs/3", scope: AccessScopeKind.SUBTREE }], pagination: { nextCursor: "" } },
    ];
    const permio = client((router) =>
      router.service(PermissionsService, {
        listAccess(req) {
          seen.push(req);
          return pages[seen.length - 1]!;
        },
      }),
    );
    const access = await permio.listAccess({ principal: "alice", permission: "docs.read", under: "/docs" });
    expect(access.coversAll).toBe(false);
    expect(access.under).toBe("/docs");
    expect(access.scopes).toEqual([
      { uri: "/docs/1", kind: "subtree" },
      { uri: "/docs/_/shared", kind: "pattern" },
      { uri: "/docs/3", kind: "subtree" },
    ]);
    expect(access.allows(resource("docs", 3, "x"))).toBe(true);
    expect(access.allows("/docs/2")).toBe(false);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      projectName: "my-app",
      principalId: "alice",
      permission: "docs.read",
      underUri: "/docs",
      pagination: { limit: 100 },
    });
    expect(seen[1]?.pagination?.cursor).toBe("/docs/_/shared");
  });

  it("reports coversAll", async () => {
    const permio = client((router) =>
      router.service(PermissionsService, {
        listAccess(req) {
          return { coversAll: true, scopes: [{ uri: req.underUri, scope: AccessScopeKind.SUBTREE }] };
        },
      }),
    );
    const access = await permio.listAccess({ principal: "a", permission: "p", under: "/docs", project: "other" });
    expect(access.coversAll).toBe(true);
    expect(access.toPrefixes()).toEqual(["/docs"]);
    expect(access.allows("/docs/anything/below")).toBe(true);
  });

  it("validates input before calling the API", async () => {
    let calls = 0;
    const permio = client((router) =>
      router.service(PermissionsService, {
        listAccess() {
          calls++;
          return {};
        },
      }),
    );
    await expect(permio.listAccess({ principal: "", permission: "p", under: "/d" })).rejects.toThrow(/principal/);
    await expect(permio.listAccess({ principal: "a", permission: "", under: "/d" })).rejects.toThrow(/permission/);
    await expect(permio.listAccess({ principal: "a", permission: "p", under: "d" })).rejects.toBeInstanceOf(
      PermioValidationError,
    );
    expect(calls).toBe(0);
  });

  it("retries on Unavailable (it is a read)", async () => {
    let calls = 0;
    const permio = client((router) =>
      router.service(PermissionsService, {
        listAccess() {
          if (++calls < 2) throw new ConnectError("down", Code.Unavailable);
          return { coversAll: true, scopes: [{ uri: "/d", scope: AccessScopeKind.SUBTREE }] };
        },
      }),
    );
    await expect(permio.listAccess({ principal: "a", permission: "p", under: "/d" })).resolves.toBeInstanceOf(
      AccessScopes,
    );
    expect(calls).toBe(2);
  });
});

describe("batchCheck", () => {
  type Req = permissionsv1.BatchCheckRequest;
  const grants: Record<string, string[]> = { "/docs/1": ["docs.read", "docs.write"], "/docs/2": ["docs.read"] };

  function batcher(seen: Req[] = []) {
    return client((router) =>
      router.service(PermissionsService, {
        batchCheck(req) {
          seen.push(req);
          return {
            results: req.resourceUris.map((uri) => {
              const missing = req.permissions.filter((p) => !grants[uri]?.includes(p));
              return { resourceUri: uri, allowed: missing.length === 0, missingPermissions: missing };
            }),
          };
        },
      }),
    );
  }

  it("returns a Map of resource to allowed, in request order", async () => {
    const seen: Req[] = [];
    const permio = batcher(seen);
    const result = await permio.batchCheck({
      principal: "alice",
      resources: ["/docs/2", "/docs/1", "/docs/3", "/docs/1"],
      permission: "docs.read",
    });
    expect([...result]).toEqual([
      ["/docs/2", true],
      ["/docs/1", true],
      ["/docs/3", false],
    ]);
    expect(seen[0]).toMatchObject({
      projectName: "my-app",
      principalId: "alice",
      resourceUris: ["/docs/2", "/docs/1", "/docs/3"],
      permissions: ["docs.read"],
    });
  });

  it("batchCheckDetailed reports the missing permissions per resource", async () => {
    const permio = batcher();
    await expect(
      permio.batchCheckDetailed({
        principal: "alice",
        resources: ["/docs/1", "/docs/2"],
        permissions: ["docs.read", "docs.write"],
      }),
    ).resolves.toEqual([
      { resource: "/docs/1", allowed: true, missing: [] },
      { resource: "/docs/2", allowed: false, missing: ["docs.write"] },
    ]);
  });

  it("splits more than 100 resources into several calls", async () => {
    const seen: Req[] = [];
    const permio = batcher(seen);
    const resources = Array.from({ length: 250 }, (_, i) => `/docs/${i}`);
    const result = await permio.batchCheck({ principal: "alice", resources, permission: "docs.read" });
    expect(seen.map((r) => r.resourceUris.length)).toEqual([100, 100, 50]);
    expect(result.size).toBe(250);
    expect([...result.keys()]).toEqual(resources);
    expect(result.get("/docs/1")).toBe(true);
    expect(result.get("/docs/0")).toBe(false);
  });

  it("fails closed when a result is missing", async () => {
    const permio = client((router) =>
      router.service(PermissionsService, {
        batchCheck() {
          return { results: [{ resourceUri: "/docs/1", allowed: true }] };
        },
      }),
    );
    const err = await permio
      .batchCheck({ principal: "a", resources: ["/docs/1", "/docs/2"], permission: "p" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermioError);
    expect((err as Error).message).toMatch(/\/docs\/2/);
  });

  it("validates input before calling the API", async () => {
    const seen: Req[] = [];
    const permio = batcher(seen);
    await expect(permio.batchCheck({ principal: "a", resources: [], permission: "p" })).rejects.toThrow(/resource/);
    await expect(permio.batchCheck({ principal: "a", resources: ["/d"] })).rejects.toThrow(/permission/);
    await expect(permio.batchCheck({ principal: "a", resources: ["nope"], permission: "p" })).rejects.toBeInstanceOf(
      PermioValidationError,
    );
    await expect(permio.batchCheck({ principal: "", resources: ["/d"], permission: "p" })).rejects.toThrow(/principal/);
    expect(seen).toHaveLength(0);
  });
});

describe("whoHasAccess", () => {
  type Req = permissionsv1.ListPrincipalsWithAccessRequest;

  it("follows every page and maps entries", async () => {
    const seen: Req[] = [];
    const permio = client((router) =>
      router.service(PermissionsService, {
        listPrincipalsWithAccess(req) {
          seen.push(req);
          if (!req.pagination?.cursor) {
            return {
              principals: [
                {
                  principalId: "alice",
                  via: [
                    {
                      resourceUri: "/docs",
                      inherited: true,
                      match: AccessGrantMatch.ANCESTOR,
                      source: { case: "role", value: { id: "r1", name: "viewer" } },
                    },
                  ],
                },
                {
                  principalId: "bob",
                  viaGroup: "eng",
                  via: [
                    {
                      resourceUri: "/docs/_",
                      inherited: true,
                      match: AccessGrantMatch.WILDCARD,
                      source: { case: "direct", value: {} },
                    },
                  ],
                },
              ],
              pagination: { nextCursor: "c1" },
            };
          }
          return {
            principals: [
              {
                principalId: "group:eng",
                isGroup: true,
                via: [{ resourceUri: "/docs/1", match: AccessGrantMatch.EXACT, source: { case: "direct", value: {} } }],
              },
            ],
            pagination: { nextCursor: "" },
          };
        },
      }),
    );
    const entries = await permio.whoHasAccess({ resource: "/docs/1", permission: "docs.read", expandGroups: true });
    expect(entries).toEqual([
      {
        principal: "alice",
        isGroup: false,
        viaGroup: undefined,
        via: [{ resource: "/docs", inherited: true, match: "ancestor", source: { type: "role", id: "r1", name: "viewer" } }],
      },
      {
        principal: "bob",
        isGroup: false,
        viaGroup: "eng",
        via: [{ resource: "/docs/_", inherited: true, match: "wildcard", source: { type: "direct" } }],
      },
      {
        principal: "group:eng",
        isGroup: true,
        viaGroup: undefined,
        via: [{ resource: "/docs/1", inherited: false, match: "exact", source: { type: "direct" } }],
      },
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      projectName: "my-app",
      resourceUri: "/docs/1",
      permission: "docs.read",
      expandGroups: true,
    });
    expect(seen[1]?.pagination?.cursor).toBe("c1");
  });

  it("leaves permission unset and expandGroups false by default", async () => {
    const seen: Req[] = [];
    const permio = client((router) =>
      router.service(PermissionsService, {
        listPrincipalsWithAccess(req) {
          seen.push(req);
          return {};
        },
      }),
    );
    await expect(permio.whoHasAccess({ resource: "/docs/1" })).resolves.toEqual([]);
    expect(seen[0]?.permission).toBeUndefined();
    expect(seen[0]?.expandGroups).toBe(false);
    await expect(permio.whoHasAccess({ resource: "docs" })).rejects.toBeInstanceOf(PermioValidationError);
  });
});

describe("error mapping on the access calls", () => {
  function failing(code: Code, message: string) {
    const fail = () => {
      throw new ConnectError(message, code);
    };
    return client(
      (router) =>
        router.service(PermissionsService, {
          batchCheck: fail,
          listAccess: fail,
          listPrincipalsWithAccess: fail,
        }),
      { retries: 0 },
    );
  }

  const calls = {
    batchCheck: (p: ReturnType<typeof failing>) => p.batchCheck({ principal: "a", resources: ["/d"], permission: "x" }),
    listAccess: (p: ReturnType<typeof failing>) => p.listAccess({ principal: "a", permission: "x", under: "/d" }),
    whoHasAccess: (p: ReturnType<typeof failing>) => p.whoHasAccess({ resource: "/d" }),
  };

  it.each(Object.keys(calls))("%s maps API errors to PermioError subclasses", async (name) => {
    const call = calls[name as keyof typeof calls];
    for (const [code, cls] of [
      [Code.PermissionDenied, PermioPermissionError],
      [Code.NotFound, PermioNotFoundError],
      [Code.Unavailable, PermioUnavailableError],
      [Code.InvalidArgument, PermioValidationError],
    ] as const) {
      const err = await call(failing(code, "boom")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(cls);
      expect((err as PermioError).code).toBe(code);
      expect((err as PermioError).cause).toBeInstanceOf(ConnectError);
    }
  });

  it("parses the missing list for the API key", async () => {
    const err = (await calls
      .listAccess(
        failing(
          Code.PermissionDenied,
          "missing permissions: [{ResourceURI:/organisation/o1/project/my-app/principal/a MissingPermissions:[principal.assignment.get]}]",
        ),
      )
      .catch((e: unknown) => e)) as PermioPermissionError;
    expect(err.missing).toEqual([
      { resource: "/organisation/o1/project/my-app/principal/a", permissions: ["principal.assignment.get"] },
    ]);
  });
});
