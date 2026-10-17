import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  Permio,
  PermioAuthError,
  PermioConfigError,
  PermioDeniedError,
  PermioError,
  PermioNotFoundError,
  PermioPermissionError,
  PermioTimeoutError,
  PermioUnavailableError,
  PermioValidationError,
  PermissionsService,
  permissionsv1,
  resource,
} from "../src/index.js";
import { client, create, grpcWebBody, toBinary, VALID_KEY } from "./helpers.js";

type CheckReq = permissionsv1.CheckPermissionRequest;

// Grants held by the fake server: principal -> resource -> permissions.
const grants: Record<string, Record<string, string[]>> = {
  alice: { "/docs/1": ["docs.read", "docs.write"], "/docs/2": ["docs.read"] },
  bob: { "/docs/1": ["docs.read"] },
};

function fakeCheck(req: CheckReq) {
  const missingPermissions = req.resourceUris
    .map((uri) => ({
      resourceUri: uri,
      missingPermissions: req.permissions.filter((p) => !grants[req.principalId]?.[uri]?.includes(p)),
    }))
    .filter((m) => m.missingPermissions.length > 0);
  return { passed: missingPermissions.length === 0, missingPermissions };
}

function checker(seen: CheckReq[] = [], headers: Headers[] = []) {
  return client((router) =>
    router.service(PermissionsService, {
      check(req, ctx) {
        seen.push(req);
        headers.push(ctx.requestHeader);
        return fakeCheck(req);
      },
    }),
  );
}

describe("check helpers", () => {
  it("returns true when allowed and sends the request fields", async () => {
    const seen: CheckReq[] = [];
    const headers: Headers[] = [];
    const permio = checker(seen, headers);
    await expect(permio.check({ principal: "alice", resource: "/docs/1", permission: "docs.write" })).resolves.toBe(
      true,
    );
    expect(seen[0]).toMatchObject({
      projectName: "my-app",
      principalId: "alice",
      resourceUris: ["/docs/1"],
      permissions: ["docs.write"],
    });
    expect(headers[0]?.get("authorization")).toBe(`Bearer ${VALID_KEY}`);
  });

  it("returns false (not an error) when denied", async () => {
    const permio = checker();
    await expect(permio.check({ principal: "bob", resource: "/docs/1", permission: "docs.write" })).resolves.toBe(
      false,
    );
  });

  it("checkDetailed reports what is missing per resource", async () => {
    const permio = checker();
    const result = await permio.checkDetailed({
      principal: "bob",
      resources: ["/docs/1", "/docs/2"],
      permissions: ["docs.read", "docs.write"],
    });
    expect(result).toEqual({
      allowed: false,
      missing: [
        { resource: "/docs/1", permissions: ["docs.write"] },
        { resource: "/docs/2", permissions: ["docs.read", "docs.write"] },
      ],
    });
  });

  it("merges and de-duplicates singular and plural inputs, and uses per-call project", async () => {
    const seen: CheckReq[] = [];
    const permio = checker(seen);
    await permio.check({
      principal: "alice",
      resource: "/docs/1",
      resources: ["/docs/1", "/docs/2"],
      permission: "docs.read",
      permissions: ["docs.read"],
      project: "other",
    });
    expect(seen[0]?.resourceUris).toEqual(["/docs/1", "/docs/2"]);
    expect(seen[0]?.permissions).toEqual(["docs.read"]);
    expect(seen[0]?.projectName).toBe("other");
  });

  it("assert throws PermioDeniedError with the missing list", async () => {
    const permio = checker();
    await expect(permio.assert({ principal: "alice", resource: "/docs/1", permission: "docs.read" })).resolves.toBe(
      undefined,
    );
    const err = await permio
      .assert({ principal: "bob", resource: "/docs/1", permission: "docs.write" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermioDeniedError);
    expect(err).toBeInstanceOf(PermioError);
    expect((err as PermioDeniedError).missing).toEqual([{ resource: "/docs/1", permissions: ["docs.write"] }]);
    expect((err as PermioDeniedError).code).toBeUndefined();
  });

  it("checkAny passes if each resource has at least one permission; checkAll needs all", async () => {
    const permio = checker();
    const p = { principal: "bob", permissions: ["docs.write", "docs.read"] };
    await expect(permio.checkAny({ ...p, resource: "/docs/1" })).resolves.toBe(true);
    await expect(permio.checkAll({ ...p, resource: "/docs/1" })).resolves.toBe(false);
    await expect(permio.checkAny({ ...p, resources: ["/docs/1", "/docs/2"] })).resolves.toBe(false);
    await expect(permio.checkAny({ ...p, principal: "alice", resources: ["/docs/1", "/docs/2"] })).resolves.toBe(
      true,
    );
  });

  it("works with URIs from resource()", async () => {
    const permio = checker();
    await expect(
      permio.check({ principal: "alice", resource: resource("docs", 2), permission: "docs.read" }),
    ).resolves.toBe(true);
  });

  it("validates input before calling the API", async () => {
    let calls = 0;
    const permio = client((router) =>
      router.service(PermissionsService, {
        check(req) {
          calls++;
          return fakeCheck(req);
        },
      }),
    );
    await expect(permio.check({ principal: "a", resource: "docs/1", permission: "x" })).rejects.toBeInstanceOf(
      PermioValidationError,
    );
    await expect(permio.check({ principal: "a", resources: [], permission: "x" })).rejects.toThrow(/resource/);
    await expect(permio.check({ principal: "a", resource: "/d" })).rejects.toThrow(/permission/);
    await expect(permio.check({ principal: "", resource: "/d", permission: "x" })).rejects.toThrow(/principal/);
    const noProject = new Permio({ apiKey: VALID_KEY, transport: createRouterTransport(() => {}) });
    await expect(noProject.check({ principal: "a", resource: "/d", permission: "x" })).rejects.toBeInstanceOf(
      PermioConfigError,
    );
    expect(calls).toBe(0);
  });
});

describe("error mapping", () => {
  function failing(code: Code, message: string) {
    return client((router) =>
      router.service(PermissionsService, {
        check() {
          throw new ConnectError(message, code);
        },
        getPermission() {
          throw new ConnectError(message, code);
        },
      }),
    );
  }

  it.each([
    [Code.Unauthenticated, PermioAuthError],
    [Code.PermissionDenied, PermioPermissionError],
    [Code.InvalidArgument, PermioValidationError],
    [Code.NotFound, PermioNotFoundError],
    [Code.Unavailable, PermioUnavailableError],
    [Code.DeadlineExceeded, PermioTimeoutError],
    [Code.Internal, PermioError],
  ] as const)("maps %s to %s", async (code, cls) => {
    const permio = failing(code, "boom");
    const err = await permio.check({ principal: "a", resource: "/d", permission: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(cls);
    expect(err).toBeInstanceOf(PermioError);
    expect((err as PermioError).code).toBe(code);
    expect((err as PermioError).message).toBe("boom");
    expect((err as PermioError).cause).toBeInstanceOf(ConnectError);
  });

  it("maps errors from the raw clients too", async () => {
    const permio = failing(Code.NotFound, "permission not found");
    const err = await permio.permissions
      .getPermission({ projectName: "my-app", name: "nope" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermioNotFoundError);
    expect((err as PermioError).codeName).toBe("not_found");
  });

  it("parses the missing list from PermissionDenied", async () => {
    const permio = failing(
      Code.PermissionDenied,
      "missing permissions: [{ResourceURI:/organisation/o1/project/my-app/docs/1 MissingPermissions:[permission.check]} " +
        "{ResourceURI:/organisation/o1/project/my-app/principal/bob MissingPermissions:[permission.check other.perm]}]",
    );
    const err = (await permio
      .check({ principal: "bob", resource: "/docs/1", permission: "docs.read" })
      .catch((e: unknown) => e)) as PermioPermissionError;
    expect(err).toBeInstanceOf(PermioPermissionError);
    expect(err.missing).toEqual([
      { resource: "/organisation/o1/project/my-app/docs/1", permissions: ["permission.check"] },
      { resource: "/organisation/o1/project/my-app/principal/bob", permissions: ["permission.check", "other.perm"] },
    ]);
  });

  it("leaves missing empty when the message has no list", async () => {
    const permio = failing(Code.PermissionDenied, "you are not allowed to perform this action");
    const err = (await permio
      .check({ principal: "a", resource: "/d", permission: "x" })
      .catch((e: unknown) => e)) as PermioPermissionError;
    expect(err.missing).toEqual([]);
  });
});

describe("retries", () => {
  it("retries idempotent reads on Unavailable and succeeds", async () => {
    let calls = 0;
    const permio = client((router) =>
      router.service(PermissionsService, {
        check(req) {
          if (++calls < 3) throw new ConnectError("try again", Code.Unavailable);
          return fakeCheck(req);
        },
      }),
    );
    await expect(permio.check({ principal: "alice", resource: "/docs/1", permission: "docs.read" })).resolves.toBe(
      true,
    );
    expect(calls).toBe(3);
  });

  it("gives up after the configured retries", async () => {
    let calls = 0;
    const permio = client(
      (router) =>
        router.service(PermissionsService, {
          listPermissions() {
            calls++;
            throw new ConnectError("down", Code.Unavailable);
          },
        }),
      { retries: { maxRetries: 1, baseDelayMs: 1 } },
    );
    await expect(permio.permissions.listPermissions({ projectName: "my-app" })).rejects.toBeInstanceOf(
      PermioUnavailableError,
    );
    expect(calls).toBe(2);
  });

  it("does not retry writes", async () => {
    let calls = 0;
    const permio = client((router) =>
      router.service(PermissionsService, {
        createPermission() {
          calls++;
          throw new ConnectError("down", Code.Unavailable);
        },
      }),
    );
    await expect(
      permio.permissions.createPermission({ projectName: "my-app", name: "docs.read" }),
    ).rejects.toBeInstanceOf(PermioUnavailableError);
    expect(calls).toBe(1);
  });

  it("does not retry non-transient errors", async () => {
    let calls = 0;
    const permio = client((router) =>
      router.service(PermissionsService, {
        check() {
          calls++;
          throw new ConnectError("bad", Code.InvalidArgument);
        },
      }),
    );
    await expect(permio.check({ principal: "a", resource: "/d", permission: "x" })).rejects.toBeInstanceOf(
      PermioValidationError,
    );
    expect(calls).toBe(1);
  });

  it("can be disabled", async () => {
    let calls = 0;
    const permio = client(
      (router) =>
        router.service(PermissionsService, {
          check() {
            calls++;
            throw new ConnectError("down", Code.Unavailable);
          },
        }),
      { retries: 0 },
    );
    await expect(permio.check({ principal: "a", resource: "/d", permission: "x" })).rejects.toBeInstanceOf(
      PermioUnavailableError,
    );
    expect(calls).toBe(1);
  });

  it("times out slow attempts and retries them", async () => {
    let calls = 0;
    const permio = client(
      (router) =>
        router.service(PermissionsService, {
          async check(req) {
            if (++calls === 1) await new Promise((r) => setTimeout(r, 500));
            return fakeCheck(req);
          },
        }),
      { timeoutMs: 30 },
    );
    await expect(permio.check({ principal: "alice", resource: "/docs/1", permission: "docs.read" })).resolves.toBe(
      true,
    );
    expect(calls).toBe(2);
  });

  it("maps a timeout to PermioTimeoutError when retries run out", async () => {
    const permio = client(
      (router) =>
        router.service(PermissionsService, {
          async check(req) {
            await new Promise((r) => setTimeout(r, 500));
            return fakeCheck(req);
          },
        }),
      { timeoutMs: 20, retries: 0 },
    );
    await expect(permio.check({ principal: "a", resource: "/d", permission: "x" })).rejects.toBeInstanceOf(
      PermioTimeoutError,
    );
  });

  it("does not retry after the caller aborts", async () => {
    let calls = 0;
    const permio = client((router) =>
      router.service(PermissionsService, {
        async check(req) {
          calls++;
          await new Promise((r) => setTimeout(r, 200));
          return fakeCheck(req);
        },
      }),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const err = await permio
      .check({ principal: "a", resource: "/d", permission: "x", signal: controller.signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermioError);
    expect((err as PermioError).code).toBe(Code.Canceled);
    expect(calls).toBe(1);
  });
});

describe("pagination", () => {
  const all = Array.from({ length: 7 }, (_, i) => `perm.${i}`);

  function paged(requests: Array<{ limit?: number; cursor?: string }>) {
    return client((router) =>
      router.service(PermissionsService, {
        listPermissions(req) {
          requests.push({
            ...(req.pagination?.limit !== undefined ? { limit: req.pagination.limit } : {}),
            ...(req.pagination?.cursor !== undefined ? { cursor: req.pagination.cursor } : {}),
          });
          const start = req.pagination?.cursor ? Number(req.pagination.cursor) : 0;
          const limit = req.pagination?.limit ?? 10;
          const page = all.slice(start, start + limit);
          const next = start + limit < all.length ? String(start + limit) : "";
          return {
            permissions: page.map((name) => ({ name, projectName: req.projectName })),
            pagination: { nextCursor: next },
          };
        },
        listPrincipals(req) {
          const cursor = req.pagination?.cursor ?? "";
          return cursor === ""
            ? { principals: ["alice", "bob"], pagination: { nextCursor: "c1" } }
            : { principals: ["carol"], pagination: { nextCursor: "" } };
        },
      }),
    );
  }

  it("follows cursors across pages", async () => {
    const requests: Array<{ limit?: number; cursor?: string }> = [];
    const permio = paged(requests);
    const names: string[] = [];
    for await (const p of permio.listPermissions({ pageSize: 3 })) names.push(p.name);
    expect(names).toEqual(all);
    expect(requests.map((r) => [r.limit, r.cursor])).toEqual([
      [3, undefined],
      [3, "3"],
      [3, "6"],
    ]);
  });

  it("defaults to the largest page size", async () => {
    const requests: Array<{ limit?: number; cursor?: string }> = [];
    const permio = paged(requests);
    let n = 0;
    for await (const _ of permio.listPermissions()) n++;
    expect(n).toBe(7);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.limit).toBe(100);
  });

  it("supports breaking out early", async () => {
    const requests: Array<{ limit?: number; cursor?: string }> = [];
    const permio = paged(requests);
    for await (const p of permio.listPermissions({ pageSize: 2 })) {
      if (p.name === "perm.1") break;
    }
    expect(requests).toHaveLength(1);
  });

  it("lists principals", async () => {
    const permio = paged([]);
    const out: string[] = [];
    for await (const p of permio.listPrincipals()) out.push(p);
    expect(out).toEqual(["alice", "bob", "carol"]);
  });

  it("stops if the server repeats a cursor", async () => {
    let calls = 0;
    const permio = client((router) =>
      router.service(PermissionsService, {
        listRoles() {
          calls++;
          return { roles: [{ id: `r${calls}` }], pagination: { nextCursor: "same" } };
        },
      }),
    );
    const ids: string[] = [];
    for await (const r of permio.listRoles()) ids.push(r.id);
    expect(ids).toEqual(["r1", "r2"]);
  });
});

describe("gRPC-web transport over fetch", () => {
  function fetchMock(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      return respond(url, init ?? {});
    }) as typeof fetch;
    return { fn, calls };
  }

  function grpcWebResponse(body: Uint8Array, status = 200) {
    return new Response(body as Uint8Array<ArrayBuffer>, { status, headers: { "content-type": "application/grpc-web+proto" } });
  }

  it("sends a gRPC-web request with the bearer key and decodes the response", async () => {
    const res = create(permissionsv1.CheckPermissionResponseSchema, { passed: true });
    const { fn, calls } = fetchMock(() =>
      grpcWebResponse(grpcWebBody(toBinary(permissionsv1.CheckPermissionResponseSchema, res))),
    );
    const permio = new Permio({ apiKey: VALID_KEY, project: "my-app", fetch: fn, baseUrl: "https://example.test/" });
    await expect(
      permio.check({ principal: "a", resource: "/d", permission: "x", timeoutMs: 5000 }),
    ).resolves.toBe(true);
    expect(calls[0]?.url).toBe("https://example.test/permio.permissions.v1.PermissionsService/Check");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${VALID_KEY}`);
    expect(headers.get("content-type")).toBe("application/grpc-web+proto");
    // Not in the gateway's CORS allow list, so it must never be sent.
    expect(headers.get("grpc-timeout")).toBeNull();
  });

  it("maps a gRPC status in the trailers", async () => {
    const { fn } = fetchMock(() => grpcWebResponse(grpcWebBody(undefined, Code.Unauthenticated, "invalid api key")));
    const permio = new Permio({ apiKey: VALID_KEY, project: "my-app", fetch: fn });
    const err = await permio.check({ principal: "a", resource: "/d", permission: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermioAuthError);
    expect((err as PermioError).message).toBe("invalid api key");
  });

  it("maps HTTP 401 from the gateway to PermioAuthError", async () => {
    const { fn } = fetchMock(() => new Response("unauthorized", { status: 401 }));
    const permio = new Permio({ apiKey: VALID_KEY, project: "my-app", fetch: fn });
    await expect(permio.check({ principal: "a", resource: "/d", permission: "x" })).rejects.toBeInstanceOf(
      PermioAuthError,
    );
  });

  it("treats network failures as Unavailable and retries reads", async () => {
    const { fn, calls } = fetchMock(() => {
      throw new TypeError("fetch failed");
    });
    const permio = new Permio({
      apiKey: VALID_KEY,
      project: "my-app",
      fetch: fn,
      retries: { maxRetries: 2, baseDelayMs: 1 },
    });
    await expect(permio.check({ principal: "a", resource: "/d", permission: "x" })).rejects.toBeInstanceOf(
      PermioUnavailableError,
    );
    expect(calls).toHaveLength(3);
  });

  it("defaults to the production host", () => {
    expect(new Permio({ apiKey: VALID_KEY }).baseUrl).toBe("https://temp-api.perms.io");
    expect(() => new Permio({ apiKey: VALID_KEY, baseUrl: "dev-api.perms.io" })).toThrow(PermioConfigError);
  });
});
