import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_BATCH_RESOURCES,
  DEFAULT_MAX_RESULTS,
  PermioError,
  PermioTimeoutError,
  PermioTooManyResultsError,
  PermioValidationError,
  PermissionsService,
  permissionsv1,
} from "../src/index.js";
import { client } from "./helpers.js";

const { AccessScopeKind } = permissionsv1;

/**
 * A fake ListPrincipalsWithAccess over `total` principals (p00000, p00001, ...),
 * paged by numeric cursor. Records every requested page limit.
 */
function principalsServer(total: number) {
  const limits: number[] = [];
  let served = 0;
  const permio = client((router) =>
    router.service(PermissionsService, {
      listPrincipalsWithAccess(req) {
        const limit = req.pagination?.limit ?? 10;
        limits.push(limit);
        const start = Number(req.pagination?.cursor || "0");
        const end = Math.min(total, start + limit);
        served += end - start;
        return {
          principals: Array.from({ length: end - start }, (_, i) => ({
            principalId: `p${String(start + i).padStart(5, "0")}`,
            via: [],
          })),
          pagination: { nextCursor: end < total ? String(end) : "" },
        };
      },
    }),
  );
  return { permio, limits, served: () => served };
}

function scopesServer(total: number) {
  const limits: number[] = [];
  const permio = client((router) =>
    router.service(PermissionsService, {
      listAccess(req) {
        const limit = req.pagination?.limit ?? 10;
        limits.push(limit);
        const start = Number(req.pagination?.cursor || "0");
        const end = Math.min(total, start + limit);
        return {
          scopes: Array.from({ length: end - start }, (_, i) => ({
            uri: `/docs/${start + i}`,
            scope: AccessScopeKind.EXACT,
          })),
          pagination: { nextCursor: end < total ? String(end) : "" },
        };
      },
    }),
  );
  return { permio, limits };
}

describe("whoHasAccessIter", () => {
  it("streams every entry across many pages, fetching lazily", async () => {
    const { permio, limits } = principalsServer(25_050);
    const iter = permio.whoHasAccessIter({ resource: "/docs/1" });
    expect(limits).toEqual([]); // nothing fetched until iterated
    let n = 0;
    let last = "";
    for await (const e of iter) {
      if (n === 0) expect(limits).toEqual([100]);
      n++;
      last = e.principal;
    }
    expect(n).toBe(25_050);
    expect(last).toBe("p25049");
    expect(limits).toHaveLength(251);
  });

  it("fetches no further pages when the consumer stops", async () => {
    const { permio, limits } = principalsServer(1_000_000);
    let n = 0;
    for await (const _ of permio.whoHasAccessIter({ resource: "/docs/1", pageSize: 50 })) {
      if (++n === 120) break;
    }
    expect(limits).toEqual([50, 50, 50]);
  });

  it("validates eagerly", () => {
    const { permio } = principalsServer(0);
    expect(() => permio.whoHasAccessIter({ resource: "docs" })).toThrow(PermioValidationError);
  });
});

describe("whoHasAccess maxResults", () => {
  it("defaults to 10,000", () => {
    expect(DEFAULT_MAX_RESULTS).toBe(10_000);
  });

  it("returns exactly maxResults entries", async () => {
    const { permio, limits } = principalsServer(250);
    await expect(permio.whoHasAccess({ resource: "/docs/1", maxResults: 250 })).resolves.toHaveLength(250);
    // Asks for cap + 1 in total; the server had only 250.
    expect(limits).toEqual([100, 100, 51]);
  });

  it("throws PermioTooManyResultsError after fetching at most cap + 1", async () => {
    const { permio, limits, served } = principalsServer(1_000_000);
    const err = await permio.whoHasAccess({ resource: "/docs/1", maxResults: 250 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermioTooManyResultsError);
    expect(err).toBeInstanceOf(PermioError);
    expect((err as PermioTooManyResultsError).maxResults).toBe(250);
    expect((err as Error).message).toMatch(/whoHasAccessIter/);
    expect((err as Error).message).toMatch(/maxResults/);
    expect(limits).toEqual([100, 100, 51]);
    expect(served()).toBe(251);
  });

  it("stops at 10,001 by default", async () => {
    const { permio, served } = principalsServer(1_000_000);
    await expect(permio.whoHasAccess({ resource: "/docs/1" })).rejects.toBeInstanceOf(PermioTooManyResultsError);
    expect(served()).toBe(10_001);
  });

  it("rejects a non-positive or fractional maxResults", async () => {
    const { permio } = principalsServer(1);
    for (const maxResults of [0, -1, 1.5, Number.NaN]) {
      await expect(permio.whoHasAccess({ resource: "/docs/1", maxResults })).rejects.toBeInstanceOf(
        PermioValidationError,
      );
    }
  });
});

describe("listAccessIter / listAccess maxResults", () => {
  it("streams scopes across many pages", async () => {
    const { permio, limits } = scopesServer(1_234);
    const uris: string[] = [];
    for await (const s of permio.listAccessIter({ principal: "a", permission: "p", under: "/docs" })) uris.push(s.uri);
    expect(uris).toHaveLength(1_234);
    expect(uris[1_233]).toBe("/docs/1233");
    expect(limits).toHaveLength(13);
  });

  it("yields the single subtree scope when the principal covers all", async () => {
    const permio = client((router) =>
      router.service(PermissionsService, {
        listAccess: () => ({
          coversAll: true,
          scopes: [{ uri: "/docs", scope: AccessScopeKind.SUBTREE }],
          pagination: { nextCursor: "" },
        }),
      }),
    );
    const got = [];
    for await (const s of permio.listAccessIter({ principal: "a", permission: "p", under: "/docs" })) got.push(s);
    expect(got).toEqual([{ uri: "/docs", kind: "subtree" }]);
    const all = await permio.listAccess({ principal: "a", permission: "p", under: "/docs" });
    expect(all.coversAll).toBe(true);
  });

  it("listAccess throws after fetching at most cap + 1 scopes", async () => {
    const { permio, limits } = scopesServer(100_000);
    const err = await permio
      .listAccess({ principal: "a", permission: "p", under: "/docs", maxResults: 150 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermioTooManyResultsError);
    expect((err as Error).message).toMatch(/listAccessIter/);
    expect(limits).toEqual([100, 51]);
  });

  it("listAccess returns up to maxResults scopes", async () => {
    const { permio } = scopesServer(150);
    const all = await permio.listAccess({ principal: "a", permission: "p", under: "/docs", maxResults: 150 });
    expect(all.scopes).toHaveLength(150);
  });
});

describe("batchCheck bounds", () => {
  function batchServer() {
    let calls = 0;
    const permio = client((router) =>
      router.service(PermissionsService, {
        batchCheck(req) {
          calls++;
          return { results: req.resourceUris.map((uri) => ({ resourceUri: uri, allowed: true })) };
        },
      }),
    );
    return { permio, calls: () => calls };
  }

  it("accepts up to 10,000 resources by default", async () => {
    expect(DEFAULT_MAX_BATCH_RESOURCES).toBe(10_000);
    const { permio, calls } = batchServer();
    const resources = Array.from({ length: 10_000 }, (_, i) => `/docs/${i}`);
    await expect(permio.batchCheck({ principal: "a", resources, permission: "p" })).resolves.toHaveProperty(
      "size",
      10_000,
    );
    expect(calls()).toBe(100);
  });

  it("rejects more than maxResources before sending anything", async () => {
    const { permio, calls } = batchServer();
    const resources = Array.from({ length: 10_001 }, (_, i) => `/docs/${i}`);
    await expect(permio.batchCheck({ principal: "a", resources, permission: "p" })).rejects.toThrow(
      /maxResources \(10000\)/,
    );
    // Counted as given, before de-duplication.
    await expect(
      permio.batchCheck({ principal: "a", resources: ["/d", "/d", "/d"], permission: "p", maxResources: 2 }),
    ).rejects.toBeInstanceOf(PermioValidationError);
    await expect(
      permio.batchCheck({ principal: "a", resources: ["/d"], permission: "p", maxResources: 0 }),
    ).rejects.toBeInstanceOf(PermioValidationError);
    expect(calls()).toBe(0);
  });

  it("a raised maxResources allows more", async () => {
    const { permio } = batchServer();
    const resources = Array.from({ length: 10_001 }, (_, i) => `/docs/${i}`);
    const result = await permio.batchCheck({ principal: "a", resources, permission: "p", maxResources: 20_000 });
    expect(result.size).toBe(10_001);
  });
});

describe("list page timeouts and retries", () => {
  it("applies listTimeoutMs to list pages and timeoutMs to checks", async () => {
    const hang = () => new Promise<never>(() => {});
    const permio = client(
      (router) =>
        router.service(PermissionsService, {
          listPrincipalsWithAccess: hang,
          check: hang,
        }),
      { timeoutMs: 1_000, listTimeoutMs: 20, retries: 0 },
    );
    const t0 = Date.now();
    await expect(permio.whoHasAccess({ resource: "/docs/1" })).rejects.toBeInstanceOf(PermioTimeoutError);
    expect(Date.now() - t0).toBeLessThan(500);

    const fast = client(
      (router) => router.service(PermissionsService, { check: hang, listPrincipalsWithAccess: hang }),
      { timeoutMs: 20, listTimeoutMs: 1_000, retries: 0 },
    );
    const t1 = Date.now();
    await expect(fast.check({ principal: "a", resource: "/d", permission: "p" })).rejects.toBeInstanceOf(
      PermioTimeoutError,
    );
    expect(Date.now() - t1).toBeLessThan(500);
  });

  it("backs off before retrying a page that hit DeadlineExceeded", async () => {
    const at: number[] = [];
    const permio = client(
      (router) =>
        router.service(PermissionsService, {
          listPrincipalsWithAccess() {
            at.push(Date.now());
            if (at.length < 3) throw new ConnectError("slow", Code.DeadlineExceeded);
            return { principals: [{ principalId: "a", via: [] }], pagination: { nextCursor: "" } };
          },
        }),
      { retries: { maxRetries: 2, baseDelayMs: 40, maxDelayMs: 1_000 } },
    );
    await expect(permio.whoHasAccess({ resource: "/docs/1" })).resolves.toHaveLength(1);
    expect(at).toHaveLength(3);
    // Jittered backoff: at least half of 40 ms, then of 80 ms.
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(19);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(39);
  });

  it("honours Retry-After on a rate-limited page", async () => {
    const at: number[] = [];
    const permio = client(
      (router) =>
        router.service(PermissionsService, {
          listAccess() {
            at.push(Date.now());
            if (at.length === 1) {
              throw new ConnectError("slow down", Code.ResourceExhausted, { "retry-after": "1" });
            }
            return { scopes: [], pagination: { nextCursor: "" } };
          },
        }),
      { retries: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2_000 } },
    );
    await permio.listAccess({ principal: "a", permission: "p", under: "/docs" });
    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(990);
  });
});
