// Integration test against a real deployment. Skipped unless PERMIO_API_KEY is
// set. PERMIO_BASE_URL defaults to the development API (DEV_BASE_URL). Because
// it writes, it refuses to run against anything but the development API or a
// local host (see live-target.ts). The key needs full
// access to its project (PERMIO_PROJECT, default: the key's project from whoAmI):
//   PERMIO_API_KEY=perms_... npm test -- test/live.test.ts
//
// Everything it creates uses fixed IDs prefixed "sdk-it-js" and is removed
// before and after the run, so an interrupted run is cleaned up by the next one.
// Runs sharing a project must not overlap (CI serialises them).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEV_BASE_URL, Permio, PermioAuthError, group } from "../src/index.js";
import { isAllowedLiveTarget } from "./live-target.js";

const apiKey = process.env.PERMIO_API_KEY;
const baseUrl = process.env.PERMIO_BASE_URL || DEV_BASE_URL;
if (apiKey && !isAllowedLiveTarget(baseUrl)) {
  throw new Error(
    `refusing to run the live test against ${baseUrl}: it writes, so only ${DEV_BASE_URL} and local hosts ` +
      "(localhost, 127.0.0.1, [::1], *.localhost, *.test) are allowed",
  );
}

const ALICE = "sdk-it-js-alice";
const BOB = "sdk-it-js-bob";
const GROUP = "sdk-it-js-editors";
const READ = "sdk-it-js.read";
const WRITE = "sdk-it-js.write";
const ROOT = "/sdk-it-js";
const DOCS = `${ROOT}/docs`;
const DOC1 = `${DOCS}/1`;
const OTHER = `${ROOT}/other`;

describe.skipIf(!apiKey)("live integration", { timeout: 30_000 }, () => {
  let permio: Permio;
  let project: string;

  // Deleting the permissions also removes every grant that uses them.
  async function cleanUp() {
    await permio.groups.delete(GROUP);
    await permio.permissions.deletePermission({ projectName: project, name: READ });
    await permio.permissions.deletePermission({ projectName: project, name: WRITE });
  }

  beforeAll(async () => {
    const probe = new Permio({ apiKey: apiKey ?? "", baseUrl });
    project = process.env.PERMIO_PROJECT || (await probe.whoAmI()).project || "default";
    permio = new Permio({ apiKey: apiKey ?? "", baseUrl, project });
    await cleanUp();
    await permio.permissions.createPermission({ projectName: project, name: READ, description: "permio-js integration test" });
    await permio.permissions.createPermission({ projectName: project, name: WRITE, description: "permio-js integration test" });
  }, 60_000);

  afterAll(cleanUp, 60_000);

  it("whoAmI describes the API key", async () => {
    const me = await permio.whoAmI();
    expect(me.kind).toBe("api_key");
    expect(me.project).toBe(project);
    expect(me.principalId).not.toBe("");
    expect(me.organisationId).not.toBe("");
    expect(me.apiKeyAccess).toBe("full");
  });

  it("grant, then check is allowed below the granted URI", async () => {
    expect(await permio.check({ principal: ALICE, resource: DOC1, permission: READ })).toBe(false);
    await permio.grant({ principal: ALICE, resource: DOCS, permission: READ });
    expect(await permio.check({ principal: ALICE, resource: DOC1, permission: READ })).toBe(true);
    expect(await permio.check({ principal: ALICE, resource: DOC1, permission: WRITE })).toBe(false);
  });

  it("batchCheck answers each resource", async () => {
    const result = await permio.batchCheck({ principal: ALICE, resources: [DOC1, OTHER, DOCS], permission: READ });
    expect([...result]).toEqual([
      [DOC1, true],
      [OTHER, false],
      [DOCS, true],
    ]);
  });

  it("listAccess returns the granted subtree", async () => {
    const access = await permio.listAccess({ principal: ALICE, permission: READ, under: ROOT });
    expect(access.coversAll).toBe(false);
    expect(access.toPrefixes()).toEqual([DOCS]);
    expect(access.allows(DOC1)).toBe(true);
    expect(access.allows(OTHER)).toBe(false);
  });

  it("revoke, then check is denied", async () => {
    await permio.revoke({ principal: ALICE, resource: DOCS, permission: READ });
    expect(await permio.check({ principal: ALICE, resource: DOC1, permission: READ })).toBe(false);
    // Revoking what is no longer held is harmless.
    await permio.revoke({ principal: ALICE, resource: DOCS, permission: READ });
  });

  it("a group grant applies to its members until the group is deleted", async () => {
    await permio.groups.create(GROUP, { description: "permio-js integration test" });
    expect(await permio.groups.addMembers(GROUP, [BOB])).toEqual({ added: [BOB], existing: [] });
    await permio.grant({ principal: group(GROUP), resource: DOCS, permission: WRITE });
    expect(await permio.check({ principal: BOB, resource: DOC1, permission: WRITE })).toBe(true);
    expect(await permio.check({ principal: ALICE, resource: DOC1, permission: WRITE })).toBe(false);

    await permio.groups.delete(GROUP);
    expect(await permio.check({ principal: BOB, resource: DOC1, permission: WRITE })).toBe(false);
  });

  it("rejects an unknown key with PermioAuthError", async () => {
    const bad = new Permio({ apiKey: "perms_0123456789ABCDEFGHIJKLMNOPQRSTUV1ggZdL", baseUrl, project });
    await expect(bad.check({ principal: ALICE, resource: DOC1, permission: READ })).rejects.toBeInstanceOf(
      PermioAuthError,
    );
    await expect(bad.whoAmI()).rejects.toBeInstanceOf(PermioAuthError);
  });
});
