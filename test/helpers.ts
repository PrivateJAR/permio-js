import { create, toBinary } from "@bufbuild/protobuf";
import { createRouterTransport, type ConnectRouter } from "@connectrpc/connect";
import { Permio, type PermioOptions } from "../src/index.js";

// Built independently of src/apikey.ts (Python zlib.crc32), so the tests do not
// just check the implementation against itself.
export const VALID_KEY = "perms_0123456789ABCDEFGHIJKLMNOPQRSTUV1ggZdL";
export const VALID_KEY_2 = "perms_Gm84ZXwbuzUsr46kO1xQ2GwiPWlHJaO32P8mP7";
export const JWT_KEY =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLWJ5dGVz";

export function client(routes: (router: ConnectRouter) => void, options: Partial<PermioOptions> = {}): Permio {
  return new Permio({
    apiKey: VALID_KEY,
    project: "my-app",
    retries: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 },
    transport: createRouterTransport(routes),
    ...options,
  });
}

/** Encodes a gRPC-web response body: one message frame and a trailer frame. */
export function grpcWebBody(
  message: Uint8Array | undefined,
  status = 0,
  statusMessage = "",
): Uint8Array {
  const frame = (flag: number, data: Uint8Array) => {
    const out = new Uint8Array(5 + data.length);
    out[0] = flag;
    new DataView(out.buffer).setUint32(1, data.length);
    out.set(data, 5);
    return out;
  };
  const trailer = new TextEncoder().encode(
    `grpc-status: ${status}\r\ngrpc-message: ${encodeURIComponent(statusMessage)}\r\n`,
  );
  const parts = [...(message ? [frame(0, message)] : []), frame(0x80, trailer)];
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.length;
  }
  return body;
}

export { create, toBinary };
