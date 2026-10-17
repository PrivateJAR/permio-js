import { PermioValidationError } from "./errors.js";

/** The API rejects resource URIs longer than this many bytes. */
export const MAX_RESOURCE_URI_LENGTH = 2048;

/**
 * Percent-encodes one resource URI segment. On top of `encodeURIComponent`
 * this encodes `! ' ( ) *`, because the API rejects `( ) *` in segments.
 */
export function encodeSegment(segment: string | number): string {
  const text = String(segment);
  if (text === "") throw new PermioValidationError("permio: resource URI segments must not be empty");
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Builds a resource URI from raw segments, encoding each one so that IDs
 * containing `/`, spaces or other reserved characters stay a single segment.
 *
 * ```ts
 * resource("projects", projectId, "docs", docId) // "/projects/p1/docs/a%2Fb"
 * ```
 *
 * Build URIs the same way when granting and when checking, or they will not match.
 */
export function resource(...segments: Array<string | number>): string {
  if (segments.length === 0) throw new PermioValidationError("permio: resource() needs at least one segment");
  return "/" + segments.map(encodeSegment).join("/");
}

/**
 * Throws `PermioValidationError` unless `uri` has the basic shape the API
 * accepts: a leading `/`, no empty segments (so no `//` or trailing `/`), no
 * whitespace or control characters, at most 2048 bytes. The API applies further
 * rules (for example no regex metacharacters such as `( ) [ ] * + ?` in
 * segments) and answers InvalidArgument when they are broken.
 */
export function assertResourceUri(uri: string): void {
  const fail = (why: string): never => {
    throw new PermioValidationError(`permio: invalid resource URI ${JSON.stringify(uri)}: ${why}`);
  };
  if (typeof uri !== "string" || uri === "") fail("it is empty");
  if (!uri.startsWith("/")) fail('it must start with "/" (use resource() to build URIs)');
  if (new TextEncoder().encode(uri).length > MAX_RESOURCE_URI_LENGTH) {
    fail(`it is longer than ${MAX_RESOURCE_URI_LENGTH} bytes`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f-\u009f]/u.test(uri)) fail("it contains whitespace or control characters");
  if (uri.slice(1).split("/").includes("")) fail("it contains an empty segment");
}
