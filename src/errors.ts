import { Code, ConnectError } from "@connectrpc/connect";

/** Permissions missing on one resource. */
export interface MissingPermission {
  /** The resource URI the permissions are missing on. */
  resource: string;
  /** The permission names the principal does not hold on `resource`. */
  permissions: string[];
}

export interface PermioErrorOptions {
  code?: Code;
  cause?: unknown;
  metadata?: Headers;
}

/**
 * Base class for every error thrown by the SDK.
 *
 * `code` is the Connect/gRPC status code when the error came from the API, and
 * `cause` holds the original error (usually a `ConnectError`).
 */
export class PermioError extends Error {
  override name = "PermioError";
  /** gRPC status code, when the error came from (or maps to) an API status. */
  readonly code: Code | undefined;
  /** Response headers/trailers sent with the error, if any. */
  readonly metadata: Headers;
  override readonly cause: unknown;

  constructor(message: string, options: PermioErrorOptions = {}) {
    super(message);
    this.code = options.code;
    this.cause = options.cause;
    this.metadata = options.metadata ?? new Headers();
  }

  /** Lower-case gRPC code name, e.g. `"permission_denied"`, or undefined. */
  get codeName(): string | undefined {
    if (this.code === undefined) return undefined;
    return Code[this.code]
      ?.replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase();
  }
}

/** The client was configured incorrectly, e.g. a malformed API key. */
export class PermioConfigError extends PermioError {
  override name = "PermioConfigError";
}

/** The API key was missing, unknown, invalidated or otherwise rejected (gRPC Unauthenticated). */
export class PermioAuthError extends PermioError {
  override name = "PermioAuthError";
}

/**
 * The API key is valid but lacks the rights for this call (gRPC PermissionDenied).
 *
 * For `Check`, the key needs `permission.check` on the checked resources and on
 * the principal. When the API lists what is missing, it is parsed into
 * `missing`. Those resource URIs are the fully qualified internal ones
 * (`/organisation/{org}/project/{project}/...`), not the URIs you sent.
 *
 * This is about the *caller's* rights. A principal failing a check is not an
 * error: `check()` returns `false` and `assert()` throws `PermioDeniedError`.
 */
export class PermioPermissionError extends PermioError {
  override name = "PermioPermissionError";
  readonly missing: MissingPermission[];

  constructor(message: string, options: PermioErrorOptions & { missing?: MissingPermission[] } = {}) {
    super(message, options);
    this.missing = options.missing ?? [];
  }
}

/** The request was rejected as malformed (gRPC InvalidArgument), or failed the SDK's own checks. */
export class PermioValidationError extends PermioError {
  override name = "PermioValidationError";
}

/** The requested entity does not exist (gRPC NotFound). */
export class PermioNotFoundError extends PermioError {
  override name = "PermioNotFoundError";
}

/** The API could not be reached or is temporarily unavailable (gRPC Unavailable). */
export class PermioUnavailableError extends PermioError {
  override name = "PermioUnavailableError";
}

/** The call did not finish in time (gRPC DeadlineExceeded). */
export class PermioTimeoutError extends PermioError {
  override name = "PermioTimeoutError";
}

/**
 * Thrown by `assert()` when the principal does not hold the requested
 * permissions. This is a normal authorization outcome, not an API failure, so
 * `code` is undefined.
 */
export class PermioDeniedError extends PermioError {
  override name = "PermioDeniedError";
  readonly principal: string;
  readonly missing: MissingPermission[];

  constructor(principal: string, missing: MissingPermission[]) {
    const summary = missing.map((m) => `${m.permissions.join(", ")} on ${m.resource}`).join("; ");
    super(`principal ${JSON.stringify(principal)} is missing ${summary || "the requested permissions"}`);
    this.principal = principal;
    this.missing = missing;
  }
}

// The permissions service formats PermissionDenied as Go's %+v of its missing list:
//   missing permissions: [{ResourceURI:/organisation/o/project/p/doc MissingPermissions:[permission.check]} ...]
const missingEntry = /\{ResourceURI:(\S*) MissingPermissions:\[([^\]]*)\]\}/g;

/** Extracts the missing-permission list from a PermissionDenied message, if it has one. */
export function parseMissingPermissions(message: string): MissingPermission[] {
  const out: MissingPermission[] = [];
  for (const match of message.matchAll(missingEntry)) {
    const permissions = (match[2] ?? "").split(" ").filter(Boolean);
    out.push({ resource: match[1] ?? "", permissions });
  }
  return out;
}

/** Converts any thrown value into the matching `PermioError` subclass. */
export function toPermioError(error: unknown): PermioError {
  if (error instanceof PermioError) return error;
  const ce = ConnectError.from(error);
  const options: PermioErrorOptions = { code: ce.code, cause: error, metadata: ce.metadata };
  const message = ce.rawMessage;
  switch (ce.code) {
    case Code.Unauthenticated:
      return new PermioAuthError(message, options);
    case Code.PermissionDenied:
      return new PermioPermissionError(message, { ...options, missing: parseMissingPermissions(message) });
    case Code.InvalidArgument:
      return new PermioValidationError(message, options);
    case Code.NotFound:
      return new PermioNotFoundError(message, options);
    case Code.Unavailable:
      return new PermioUnavailableError(message, options);
    case Code.DeadlineExceeded:
      return new PermioTimeoutError(message, options);
    default:
      return new PermioError(message, options);
  }
}
