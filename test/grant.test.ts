import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  PermioAuthError,
  PermioConfigError,
  PermioPermissionError,
  PermioUnavailableError,
  PermioValidationError,
  PermissionsService,
  group,
  isIdempotentMethod,
  permissionsv1,
  resource,
} from "../src/index.js";
import { client } from "./helpers.js";

type GrantReq = permissionsv1.GrantUserPermissionsAndRolesOnResourceRequest;
type RevokeReq = permissionsv1.RevokeUserPermissionsAndRolesOnResourceRequest;

const plain = (r: GrantReq | RevokeReq) => ({
  projectName: r.projectName,
  userId: r.userId,
  resourceUri: r.resourceUri,
  permissions: r.permissions,
  roles: r.roles,
});

function recorder() {
  const grants: GrantReq[] = [];
  const revokes: RevokeReq[] = [];
  const permio = client((router) =>
    router.service(PermissionsService, {
      grantUserPermissionsAndRolesOnResource(req) {
        grants.push(req);
        return {};
      },
      revokeUserPermissionsAndRolesOnResource(req) {
        revokes.push(req);
        return {};
      },
    }),
  );
  return { permio, grants, revokes };
}

describe("grant", () => {
  it("sends one Grant with permissions and roles, deduplicated, in the default project", async () => {
    const { permio, grants } = recorder();
    await permio.grant({
      principal: "alice",
      resource: resource("docs", 42),
      permission: "docs.read",
      permissions: ["docs.read", "docs.write"],
      role: "role-1",
      roles: ["role-1", "role-2"],
    });
    expect(grants.map(plain)).toEqual([
      {
        projectName: "my-app",
        userId: "alice",
        resourceUri: "/docs/42",
        permissions: ["docs.read", "docs.write"],
        roles: ["role-1", "role-2"],
      },
    ]);
  });

  it("grants to a group and honours a per-call project", async () => {
    const { permio, grants } = recorder();
    await permio.grant({ principal: group("editors"), resource: "/docs", role: "editor", project: "other" });
    expect(grants.map(plain)).toEqual([
      { projectName: "other", userId: "group:editors", resourceUri: "/docs", permissions: [], roles: ["editor"] },
    ]);
  });

  it("validates input before sending anything", async () => {
    const { permio, grants } = recorder();
    const base = { principal: "alice", resource: "/docs/1", permission: "docs.read" };
    await expect(permio.grant({ ...base, principal: "" })).rejects.toThrow(/principal is required/);
    await expect(permio.grant({ ...base, resource: "docs/1" })).rejects.toBeInstanceOf(PermioValidationError);
    await expect(permio.grant({ ...base, resource: "/docs//1" })).rejects.toThrow(/empty segment/);
    await expect(permio.grant({ principal: "alice", resource: "/docs/1" })).rejects.toThrow(
      /at least one permission or role/,
    );
    await expect(permio.grant({ principal: "alice", resource: "/docs/1", permissions: [], roles: [] })).rejects.toThrow(
      /at least one permission or role/,
    );
    await expect(permio.grant({ ...base, permissions: [""] })).rejects.toThrow(/permissions must be non-empty/);
    await expect(permio.grant({ ...base, roles: [""] })).rejects.toThrow(/roles must be non-empty/);
    await expect(
      permio.grant({ ...base, permissions: "docs.read" as unknown as string[] }),
    ).rejects.toThrow(/must be an array/);
    expect(grants).toEqual([]);
  });

  it("needs a project", async () => {
    const { permio } = recorder();
    const noProject = client(() => {}, { project: undefined as unknown as string });
    await expect(
      noProject.grant({ principal: "a", resource: "/x", permission: "p" }),
    ).rejects.toBeInstanceOf(PermioConfigError);
    // The recorder's client has a project, for contrast.
    await expect(permio.grant({ principal: "a", resource: "/x", permission: "p" })).resolves.toBeUndefined();
  });

  it("maps API errors", async () => {
    const permio = client((router) =>
      router.service(PermissionsService, {
        grantUserPermissionsAndRolesOnResource() {
          throw new ConnectError("permission docs.nope does not exist", Code.InvalidArgument);
        },
        revokeUserPermissionsAndRolesOnResource() {
          throw new ConnectError(
            "missing permissions: [{ResourceURI:/organisation/o/project/p/docs MissingPermissions:[principal.revoke]}]",
            Code.PermissionDenied,
          );
        },
      }),
    );
    await expect(
      permio.grant({ principal: "a", resource: "/docs", permission: "docs.nope" }),
    ).rejects.toBeInstanceOf(PermioValidationError);
    const err = await permio.revoke({ principal: "a", resource: "/docs", permission: "docs.read" }).catch((e) => e);
    expect(err).toBeInstanceOf(PermioPermissionError);
    expect(err.missing).toEqual([{ resource: "/organisation/o/project/p/docs", permissions: ["principal.revoke"] }]);
  });
});

describe("revoke", () => {
  it("sends one Revoke on the exact URI", async () => {
    const { permio, revokes, grants } = recorder();
    await permio.revoke({ principal: "alice", resource: "/docs/42", permissions: ["docs.write"], roles: ["r"] });
    expect(revokes.map(plain)).toEqual([
      { projectName: "my-app", userId: "alice", resourceUri: "/docs/42", permissions: ["docs.write"], roles: ["r"] },
    ]);
    expect(grants).toEqual([]);
  });

  it("validates input like grant", async () => {
    const { permio, revokes } = recorder();
    await expect(permio.revoke({ principal: "alice", resource: "/docs/1" })).rejects.toThrow(
      /at least one permission or role/,
    );
    await expect(permio.revoke({ principal: "alice", resource: "", permission: "p" })).rejects.toThrow(/empty/);
    expect(revokes).toEqual([]);
  });
});

describe("grant and revoke are not retried", () => {
  it("sends each write once on Unavailable", async () => {
    const counts = { grant: 0, revoke: 0 };
    const permio = client((router) =>
      router.service(PermissionsService, {
        grantUserPermissionsAndRolesOnResource() {
          counts.grant++;
          throw new ConnectError("down", Code.Unavailable);
        },
        revokeUserPermissionsAndRolesOnResource() {
          counts.revoke++;
          throw new ConnectError("down", Code.Unavailable);
        },
      }),
    );
    await expect(permio.grant({ principal: "a", resource: "/x", permission: "p" })).rejects.toBeInstanceOf(
      PermioUnavailableError,
    );
    await expect(permio.revoke({ principal: "a", resource: "/x", permission: "p" })).rejects.toBeInstanceOf(
      PermioUnavailableError,
    );
    expect(counts).toEqual({ grant: 1, revoke: 1 });
  });

  it("keeps Grant and Revoke off the retry allowlist and puts WhoAmI on it", () => {
    const svc = "permio.permissions.v1.PermissionsService.";
    expect(isIdempotentMethod(svc + "WhoAmI")).toBe(true);
    expect(isIdempotentMethod(svc + "GrantUserPermissionsAndRolesOnResource")).toBe(false);
    expect(isIdempotentMethod(svc + "RevokeUserPermissionsAndRolesOnResource")).toBe(false);
  });
});

describe("whoAmI", () => {
  const { PrincipalType, APIKeyAccess } = permissionsv1;

  it("describes an API key", async () => {
    const permio = client((router) =>
      router.service(PermissionsService, {
        whoAmI() {
          return {
            principalId: "key-123",
            organisationId: "org-1",
            principalType: PrincipalType.API_KEY,
            projectName: "my-app",
            apiKeyAccess: APIKeyAccess.API_KEY_ACCESS_FULL,
          };
        },
      }),
    );
    expect(await permio.whoAmI()).toEqual({
      principalId: "key-123",
      organisationId: "org-1",
      kind: "api_key",
      project: "my-app",
      apiKeyAccess: "full",
      email: undefined,
    });
  });

  it("maps check-only and hand-edited keys, and users", async () => {
    const responses = [
      { principalType: PrincipalType.API_KEY, apiKeyAccess: APIKeyAccess.API_KEY_ACCESS_CHECK, projectName: "p" },
      { principalType: PrincipalType.API_KEY, apiKeyAccess: APIKeyAccess.API_KEY_ACCESS_UNSPECIFIED, projectName: "p" },
      { principalType: PrincipalType.USER, principalId: "u1", email: "u@example.com" },
      { principalType: PrincipalType.SERVICE_ACCOUNT },
      {},
    ];
    let i = 0;
    const permio = client((router) =>
      router.service(PermissionsService, {
        whoAmI() {
          return responses[i++]!;
        },
      }),
    );
    const got = [];
    for (let n = 0; n < responses.length; n++) {
      const w = await permio.whoAmI();
      got.push([w.kind, w.apiKeyAccess, w.project, w.email]);
    }
    expect(got).toEqual([
      ["api_key", "check", "p", undefined],
      ["api_key", "unknown", "p", undefined],
      ["user", undefined, undefined, "u@example.com"],
      ["service_account", undefined, undefined, undefined],
      ["unknown", undefined, undefined, undefined],
    ]);
  });

  it("does not need a project", async () => {
    const permio = client(
      (router) =>
        router.service(PermissionsService, {
          whoAmI() {
            return { principalType: PrincipalType.API_KEY, projectName: "p" };
          },
        }),
      { project: undefined as unknown as string },
    );
    expect((await permio.whoAmI()).project).toBe("p");
  });

  it("is retried on Unavailable and maps Unauthenticated", async () => {
    let calls = 0;
    const flaky = client((router) =>
      router.service(PermissionsService, {
        whoAmI() {
          if (++calls < 3) throw new ConnectError("down", Code.Unavailable);
          return { principalId: "k", principalType: PrincipalType.API_KEY };
        },
      }),
    );
    expect((await flaky.whoAmI()).principalId).toBe("k");
    expect(calls).toBe(3);

    const denied = client((router) =>
      router.service(PermissionsService, {
        whoAmI() {
          throw new ConnectError("invalid api key", Code.Unauthenticated);
        },
      }),
    );
    await expect(denied.whoAmI()).rejects.toBeInstanceOf(PermioAuthError);
  });

  it("passes signal, timeout and headers through", async () => {
    let seen: string | null = null;
    const permio = client((router) =>
      router.service(PermissionsService, {
        whoAmI(_req, ctx) {
          seen = ctx.requestHeader.get("x-trace");
          return {};
        },
      }),
    );
    await permio.whoAmI({ headers: { "x-trace": "t1" }, timeoutMs: 1000, signal: new AbortController().signal });
    expect(seen).toBe("t1");
  });
});
