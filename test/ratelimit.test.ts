import { create, toBinary } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { AnySchema, DurationSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { Permio, PermioRateLimitError, PermioUnavailableError, PermissionsService, permissionsv1 } from "../src/index.js";
import { client, VALID_KEY } from "./helpers.js";

/** google.rpc.RetryInfo { retry_delay } encoded by hand (the SDK has no generated google.rpc types). */
function retryInfo(ms: number): Uint8Array {
  const delay = toBinary(
    DurationSchema,
    create(DurationSchema, { seconds: BigInt(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1e6 }),
  );
  return new BinaryWriter().tag(1, WireType.LengthDelimited).bytes(delay).finish();
}

function rateLimited(ms?: number, headers?: HeadersInit): ConnectError {
  const err = new ConnectError("check rate limit of 25 per second exceeded", Code.ResourceExhausted, headers);
  if (ms !== undefined) err.details.push({ type: "google.rpc.RetryInfo", value: retryInfo(ms) });
  return err;
}

const checkParams = { principal: "alice", resource: "/docs/1", permission: "docs.read" };
const passed = () => create(permissionsv1.CheckPermissionResponseSchema, { passed: true });

describe("rate limiting (ResourceExhausted)", () => {
  it("retries a rate-limited read after the RetryInfo delay", async () => {
    const at: number[] = [];
    const permio = client(
      (router) =>
        router.service(PermissionsService, {
          check() {
            at.push(Date.now());
            if (at.length === 1) throw rateLimited(60);
            return passed();
          },
        }),
      { retries: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1000 } },
    );
    await expect(permio.check(checkParams)).resolves.toBe(true);
    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(55);
  });

  it("honours a Retry-After header", async () => {
    const at: number[] = [];
    const permio = client(
      (router) =>
        router.service(PermissionsService, {
          check() {
            at.push(Date.now());
            if (at.length === 1) throw rateLimited(undefined, { "retry-after": "1" });
            return passed();
          },
        }),
      { retries: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2000 } },
    );
    await expect(permio.check(checkParams)).resolves.toBe(true);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(950);
  });

  it("does not wait longer than maxDelayMs: throws PermioRateLimitError with the delay", async () => {
    let calls = 0;
    const permio = client(
      (router) =>
        router.service(PermissionsService, {
          check() {
            calls++;
            throw rateLimited(900);
          },
        }),
      { retries: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 100 } },
    );
    const err = await permio.check(checkParams).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermioRateLimitError);
    expect((err as PermioRateLimitError).retryAfterMs).toBe(900);
    expect((err as PermioRateLimitError).codeName).toBe("resource_exhausted");
    expect(calls).toBe(1);
  });

  it("does not retry ResourceExhausted without a server delay", async () => {
    let calls = 0;
    const permio = client((router) =>
      router.service(PermissionsService, {
        check() {
          calls++;
          throw rateLimited();
        },
      }),
    );
    const err = await permio.check(checkParams).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermioRateLimitError);
    expect((err as PermioRateLimitError).retryAfterMs).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("never retries writes, even with a delay", async () => {
    let calls = 0;
    const permio = client(
      (router) =>
        router.service(PermissionsService, {
          createPermission() {
            calls++;
            throw rateLimited(10);
          },
        }),
      { retries: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1000 } },
    );
    await expect(
      permio.permissions.createPermission({ projectName: "my-app", name: "docs.read" }),
    ).rejects.toBeInstanceOf(PermioRateLimitError);
    expect(calls).toBe(1);
  });

  it("uses Retry-After as the minimum backoff for Unavailable (e.g. an HTTP 429 from a proxy)", async () => {
    const at: number[] = [];
    const permio = client(
      (router) =>
        router.service(PermissionsService, {
          check() {
            at.push(Date.now());
            if (at.length === 1) throw new ConnectError("too many requests", Code.Unavailable, { "retry-after": "1" });
            return passed();
          },
        }),
      { retries: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2000 } },
    );
    await expect(permio.check(checkParams)).resolves.toBe(true);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(950);
  });

  it("reads RetryInfo from a gRPC-web grpc-status-details-bin trailer", async () => {
    // google.rpc.Status { code = 8, message, details = [Any(RetryInfo)] }, as ESPv2 forwards it.
    const any = toBinary(AnySchema, create(AnySchema, { typeUrl: "type.googleapis.com/google.rpc.RetryInfo", value: retryInfo(250) }));
    const statusBin = new BinaryWriter()
      .tag(1, WireType.Varint)
      .int32(Code.ResourceExhausted)
      .tag(2, WireType.LengthDelimited)
      .string("check rate limit of 25 per second exceeded")
      .tag(3, WireType.LengthDelimited)
      .bytes(any)
      .finish();
    const trailer = new TextEncoder().encode(
      `grpc-status: 8\r\ngrpc-message: rate%20limited\r\ngrpc-status-details-bin: ${Buffer.from(statusBin).toString("base64").replace(/=+$/, "")}\r\n`,
    );
    const body = new Uint8Array(5 + trailer.length);
    body[0] = 0x80;
    new DataView(body.buffer).setUint32(1, trailer.length);
    body.set(trailer, 5);
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(body, { status: 200, headers: { "content-type": "application/grpc-web+proto" } });
    }) as typeof fetch;
    const permio = new Permio({ apiKey: VALID_KEY, project: "my-app", fetch: fetchFn, retries: 0 });
    const err = await permio.check(checkParams).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermioRateLimitError);
    expect((err as PermioRateLimitError).retryAfterMs).toBe(250);
    expect(calls).toBe(1);
  });

  it("still treats plain Unavailable as before", async () => {
    const permio = client(
      (router) =>
        router.service(PermissionsService, {
          check() {
            throw new ConnectError("down", Code.Unavailable);
          },
        }),
      { retries: 0 },
    );
    await expect(permio.check(checkParams)).rejects.toBeInstanceOf(PermioUnavailableError);
  });
});
