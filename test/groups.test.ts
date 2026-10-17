import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  PermioError,
  PermioNotFoundError,
  PermioUnavailableError,
  PermioValidationError,
  PermissionsService,
  group,
  isIdempotentMethod,
  permissionsv1,
} from "../src/index.js";
import { client } from "./helpers.js";

type Group = { name: string; description: string };

// An in-memory groups backend.
function groupsServer(calls: string[] = []) {
  const groups = new Map<string, Group>();
  const members = new Map<string, string[]>();
  const memberships = (principal: string) =>
    [...groups.values()].filter((g) => members.get(g.name)?.includes(principal)).map(out);
  const out = (g: Group) => ({ ...g, projectName: "my-app", principalId: `group:${g.name}` });
  const page = <T>(items: T[], pagination: permissionsv1.ListGroupsRequest["pagination"]) => {
    const start = pagination?.cursor ? Number(pagination.cursor) : 0;
    const limit = pagination?.limit ?? 100;
    const next = start + limit < items.length ? String(start + limit) : "";
    return { items: items.slice(start, start + limit), pagination: { nextCursor: next } };
  };

  const permio = client((router) =>
    router.service(PermissionsService, {
      createGroup(req) {
        calls.push(`create ${req.projectName} ${req.name}`);
        if (groups.has(req.name)) throw new ConnectError("group already exists", Code.AlreadyExists);
        const g = { name: req.name, description: req.description };
        groups.set(req.name, g);
        members.set(req.name, []);
        return out(g);
      },
      getGroup(req) {
        const g = groups.get(req.name);
        if (!g) throw new ConnectError("group not found", Code.NotFound);
        return out(g);
      },
      updateGroup(req) {
        const g = groups.get(req.name);
        if (!g) throw new ConnectError("group not found", Code.NotFound);
        g.description = req.description;
        return out(g);
      },
      deleteGroup(req) {
        calls.push(`delete ${req.name}`);
        groups.delete(req.name);
        members.delete(req.name);
        return {};
      },
      listGroups(req) {
        calls.push(`listGroups ${req.pagination?.limit} ${req.pagination?.cursor ?? ""} ${req.search ?? ""}`);
        const all = [...groups.values()]
          .filter((g) => !req.search || g.name.includes(req.search))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(out);
        const p = page(all, req.pagination);
        return { groups: p.items, pagination: p.pagination };
      },
      addGroupMembers(req) {
        const list = members.get(req.name);
        if (!list) throw new ConnectError("group not found", Code.NotFound);
        const added = req.principalIds.filter((p) => !list.includes(p));
        list.push(...added);
        return { addedPrincipalIds: added, existingPrincipalIds: req.principalIds.filter((p) => !added.includes(p)) };
      },
      removeGroupMembers(req) {
        const list = members.get(req.name) ?? [];
        const removed = req.principalIds.filter((p) => list.includes(p));
        members.set(
          req.name,
          list.filter((p) => !removed.includes(p)),
        );
        return {
          removedPrincipalIds: removed,
          notMemberPrincipalIds: req.principalIds.filter((p) => !removed.includes(p)),
        };
      },
      listGroupMembers(req) {
        const all = [...(members.get(req.name) ?? [])].sort().map((principalId) => ({ principalId }));
        const p = page(all, req.pagination);
        return { members: p.items, pagination: p.pagination };
      },
      listGroupsForPrincipal(req) {
        const p = page(memberships(req.principalId), req.pagination);
        return { groups: p.items, pagination: p.pagination };
      },
    }),
  );
  return permio;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("group()", () => {
  it("builds the group principal ID", () => {
    expect(group("editors")).toBe("group:editors");
    expect(group("team-2")).toBe("group:team-2");
  });

  it("rejects invalid slugs", () => {
    for (const bad of ["", "Editors", "a b", "a/b", "group:x", "x".repeat(65)]) {
      expect(() => group(bad)).toThrow(PermioValidationError);
    }
  });
});

describe("permio.groups", () => {
  it("creates, gets, updates and deletes a group", async () => {
    const calls: string[] = [];
    const permio = groupsServer(calls);
    const created = await permio.groups.create("editors", { description: "Can edit" });
    expect(created).toMatchObject({ name: "editors", description: "Can edit", principalId: "group:editors" });
    await expect(permio.groups.get("group:editors")).resolves.toMatchObject({ description: "Can edit" });
    await expect(permio.groups.update("editors", { description: "Edits docs" })).resolves.toMatchObject({
      description: "Edits docs",
    });
    await expect(permio.groups.delete("editors")).resolves.toBeUndefined();
    await expect(permio.groups.get("editors")).rejects.toBeInstanceOf(PermioNotFoundError);
    await expect(permio.groups.delete("editors")).resolves.toBeUndefined();
    expect(calls).toEqual(["create my-app editors", "delete editors", "delete editors"]);
  });

  it("maps AlreadyExists to a PermioError with the code", async () => {
    const permio = groupsServer();
    await permio.groups.create("a");
    const err = await permio.groups.create("a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermioError);
    expect((err as PermioError).code).toBe(Code.AlreadyExists);
    expect((err as PermioError).codeName).toBe("already_exists");
  });

  it("uses the per-call project", async () => {
    const calls: string[] = [];
    const permio = groupsServer(calls);
    await permio.groups.create("a", { project: "other" });
    expect(calls).toEqual(["create other a"]);
  });

  it("adds and removes members, reporting existing and non-members", async () => {
    const permio = groupsServer();
    await permio.groups.create("eng");
    await expect(permio.groups.addMembers("eng", ["alice", "bob"])).resolves.toEqual({
      added: ["alice", "bob"],
      existing: [],
    });
    await expect(permio.groups.addMembers(group("eng"), ["bob", "carol", "carol"])).resolves.toEqual({
      added: ["carol"],
      existing: ["bob"],
    });
    await expect(permio.groups.removeMembers("eng", ["bob", "dave"])).resolves.toEqual({
      removed: ["bob"],
      notMembers: ["dave"],
    });
    const members = await collect(permio.groups.listMembers("eng"));
    expect(members.map((m) => m.principalId)).toEqual(["alice", "carol"]);
  });

  it("lists groups across pages, with search", async () => {
    const calls: string[] = [];
    const permio = groupsServer(calls);
    for (const n of ["e", "d", "c", "b", "a"]) await permio.groups.create(n);
    calls.length = 0;
    const names = (await collect(permio.groups.list({ pageSize: 2 }))).map((g) => g.name);
    expect(names).toEqual(["a", "b", "c", "d", "e"]);
    expect(calls).toEqual(["listGroups 2  ", "listGroups 2 2 ", "listGroups 2 4 "]);
    calls.length = 0;
    expect((await collect(permio.groups.list({ search: "c" }))).map((g) => g.name)).toEqual(["c"]);
    expect(calls).toEqual(["listGroups 100  c"]);
  });

  it("lists members and a principal's groups across pages", async () => {
    const permio = groupsServer();
    await permio.groups.create("one");
    await permio.groups.create("two");
    await permio.groups.create("three");
    const people = Array.from({ length: 5 }, (_, i) => `user-${i}`);
    await permio.groups.addMembers("one", people);
    await permio.groups.addMembers("three", ["user-1"]);
    const members = await collect(permio.groups.listMembers("one", { pageSize: 2 }));
    expect(members.map((m) => m.principalId)).toEqual(people);
    const groups = await collect(permio.groups.listForPrincipal("user-1", { pageSize: 1 }));
    expect(groups.map((g) => g.name)).toEqual(["one", "three"]);
  });

  it("validates input before calling the API", async () => {
    const calls: string[] = [];
    const permio = groupsServer(calls);
    await expect(permio.groups.create("Bad Name")).rejects.toBeInstanceOf(PermioValidationError);
    await expect(permio.groups.get("")).rejects.toBeInstanceOf(PermioValidationError);
    await expect(permio.groups.update("a", {} as { description: string })).rejects.toThrow(/description/);
    await expect(permio.groups.addMembers("a", [])).rejects.toThrow(/at least one/);
    await expect(permio.groups.addMembers("a", ["group:b"])).rejects.toThrow(/groups cannot contain groups/);
    await expect(
      permio.groups.addMembers(
        "a",
        Array.from({ length: 101 }, (_, i) => `p${i}`),
      ),
    ).rejects.toThrow(/at most 100/);
    await expect(permio.groups.removeMembers("a", [""])).rejects.toThrow(/non-empty/);
    expect(() => permio.groups.listForPrincipal("")).toThrow(/principal/);
    expect(() => permio.groups.listMembers("A")).toThrow(PermioValidationError);
    expect(calls).toEqual([]);
  });
});

describe("groups error mapping and retries", () => {
  it("retries reads but not writes", async () => {
    const counts = { get: 0, list: 0, create: 0, add: 0, del: 0 };
    const down = () => {
      throw new ConnectError("down", Code.Unavailable);
    };
    const permio = client((router) =>
      router.service(PermissionsService, {
        getGroup() {
          counts.get++;
          return down();
        },
        listGroupMembers() {
          counts.list++;
          return down();
        },
        createGroup() {
          counts.create++;
          return down();
        },
        addGroupMembers() {
          counts.add++;
          return down();
        },
        deleteGroup() {
          counts.del++;
          return down();
        },
      }),
    );
    await expect(permio.groups.get("a")).rejects.toBeInstanceOf(PermioUnavailableError);
    await expect(collect(permio.groups.listMembers("a"))).rejects.toBeInstanceOf(PermioUnavailableError);
    await expect(permio.groups.create("a")).rejects.toBeInstanceOf(PermioUnavailableError);
    await expect(permio.groups.addMembers("a", ["x"])).rejects.toBeInstanceOf(PermioUnavailableError);
    await expect(permio.groups.delete("a")).rejects.toBeInstanceOf(PermioUnavailableError);
    expect(counts).toEqual({ get: 3, list: 3, create: 1, add: 1, del: 1 });
  });

  it("puts exactly the new read RPCs on the retry allowlist", () => {
    const svc = "permio.permissions.v1.PermissionsService.";
    for (const m of [
      "BatchCheck",
      "ListAccess",
      "ListPrincipalsWithAccess",
      "GetGroup",
      "ListGroups",
      "ListGroupMembers",
      "ListGroupsForPrincipal",
    ]) {
      expect([m, isIdempotentMethod(svc + m)]).toEqual([m, true]);
    }
    for (const m of ["CreateGroup", "UpdateGroup", "DeleteGroup", "AddGroupMembers", "RemoveGroupMembers"]) {
      expect([m, isIdempotentMethod(svc + m)]).toEqual([m, false]);
    }
  });

  it("maps NotFound on member calls", async () => {
    const permio = groupsServer();
    await expect(permio.groups.addMembers("missing", ["a"])).rejects.toBeInstanceOf(PermioNotFoundError);
  });
});
