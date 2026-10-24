import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { serverRetryDelayMs } from "./errors.js";

export interface RetryOptions {
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** Delay before the first retry; doubles each time, with jitter. Default 100 ms. */
  baseDelayMs?: number;
  /**
   * Upper bound for a single delay. Default 2000 ms. A rate-limited read
   * (ResourceExhausted) is retried after the server's requested delay only when
   * that delay is within this bound; otherwise `PermioRateLimitError` is thrown.
   */
  maxDelayMs?: number;
}

export interface ResilienceOptions {
  apiKey: string;
  /** Per-attempt timeout in ms; 0 disables it. */
  timeoutMs: number;
  retry: Required<RetryOptions>;
}

// Read-only RPCs that are safe to repeat. Anything not listed (every Create,
// Update, Delete, Grant, Revoke, Invite, Set, Invalidate, Remove...) is sent
// exactly once.
//
// Grant and Revoke converge on the server (a grant is additive, a revoke
// ignores names the grant lacks), but they stay off this list: after a timeout
// the first attempt may still land, and repeating it could undo another
// caller's revoke or grant made in between. The caller decides instead.
const IDEMPOTENT_METHODS = new Set([
  "permio.permissions.v1.PermissionsService.Check",
  "permio.permissions.v1.PermissionsService.GetPermission",
  "permio.permissions.v1.PermissionsService.ListPermissions",
  "permio.permissions.v1.PermissionsService.GetRole",
  "permio.permissions.v1.PermissionsService.ListRoles",
  "permio.permissions.v1.PermissionsService.GetUserPermissionsAndRolesOnResource",
  "permio.permissions.v1.PermissionsService.ListPrincipals",
  "permio.permissions.v1.PermissionsService.GetAllAssignmentsForPrincipal",
  "permio.permissions.v1.PermissionsService.GetTotalRolesAndPermissionsForOrganisation",
  "permio.permissions.v1.PermissionsService.BatchCheck",
  "permio.permissions.v1.PermissionsService.ListAccess",
  "permio.permissions.v1.PermissionsService.ListPrincipalsWithAccess",
  "permio.permissions.v1.PermissionsService.GetGroup",
  "permio.permissions.v1.PermissionsService.ListGroups",
  "permio.permissions.v1.PermissionsService.ListGroupMembers",
  "permio.permissions.v1.PermissionsService.ListGroupsForPrincipal",
  "permio.permissions.v1.PermissionsService.WhoAmI",
  "permio.organisation.v1.OrganisationService.GetOrganisation",
  "permio.organisation.v1.OrganisationService.GetUsersOrganisation",
  "permio.organisation.v1.OrganisationService.ListAPIKeys",
  "permio.organisation.v1.OrganisationService.GetProject",
  "permio.organisation.v1.OrganisationService.GetProjectsForOrganisation",
  "permio.organisation.v1.OrganisationService.GetPrincipalUsageStats",
  "permio.organisation.v1.OrganisationService.GetUsageHistory",
  "permio.organisation.v1.OrganisationService.GetOrganisationDashboard",
]);

const RETRYABLE_CODES = new Set([Code.Unavailable, Code.DeadlineExceeded]);

/** Whether the SDK retries this RPC (by fully qualified `package.Service.Method` name). */
export function isIdempotentMethod(typeName: string): boolean {
  return IDEMPOTENT_METHODS.has(typeName);
}

/** Returns a signal that aborts when `parent` aborts, or with `timeoutError()` after `ms` (0 = never). */
function linkedSignal(
  parent: AbortSignal | undefined,
  ms: number,
  timeoutError: () => ConnectError,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = ms > 0 ? setTimeout(() => controller.abort(timeoutError()), ms) : undefined;
  return {
    signal: controller.signal,
    cleanup() {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

/** Rejects as soon as `signal` aborts, whether or not `promise` honours it. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return raceAbort(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

// Messages fetch() uses for network failures: Node/undici, Chrome, Firefox, Safari.
const NETWORK_ERROR = /fetch failed|failed to fetch|networkerror|load failed|network request failed/i;

function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError && NETWORK_ERROR.test(e.message);
}

function asConnectError(e: unknown): ConnectError {
  // A failed fetch (DNS, refused connection, TLS, offline) surfaces as a plain
  // TypeError, which the transport wraps as Unknown. Treat it as Unavailable so
  // reads are retried and callers get a PermioUnavailableError.
  if (isNetworkError(e)) return new ConnectError((e as TypeError).message, Code.Unavailable, undefined, undefined, e);
  if (e instanceof ConnectError) {
    if (e.code === Code.Unknown && isNetworkError(e.cause)) {
      return new ConnectError(e.rawMessage, Code.Unavailable, e.metadata, undefined, e.cause);
    }
    return e;
  }
  return ConnectError.from(e);
}

/**
 * Wraps a transport with auth, per-attempt timeouts and retries for idempotent
 * reads. It works with any Connect transport, which is how the tests run the
 * client against an in-memory router.
 */
export function withResilience(inner: Transport, opts: ResilienceOptions): Transport {
  const authorization = `Bearer ${opts.apiKey}`;
  return {
    async unary(method, signal, timeoutMs, header, input, contextValues) {
      const headers = new Headers(header);
      headers.set("Authorization", authorization);

      // A per-call `timeoutMs` is an overall deadline across retries. It is
      // enforced here rather than handed to the inner transport, which would
      // send a grpc-timeout header that the gateway's CORS policy does not
      // allow from browsers.
      const overall = linkedSignal(
        signal,
        timeoutMs ?? 0,
        () => new ConnectError(`deadline of ${timeoutMs}ms exceeded`, Code.DeadlineExceeded),
      );
      const retries = isIdempotentMethod(method.parent.typeName + "." + method.name) ? opts.retry.maxRetries : 0;
      try {
        for (let attempt = 0; ; attempt++) {
          const attemptSignal = linkedSignal(
            overall.signal,
            opts.timeoutMs,
            () => new ConnectError(`request timed out after ${opts.timeoutMs}ms`, Code.DeadlineExceeded),
          );
          try {
            return await raceAbort(
              inner.unary(method, attemptSignal.signal, undefined, headers, input, contextValues),
              attemptSignal.signal,
            );
          } catch (e) {
            const err = asConnectError(e);
            if (overall.signal.aborted) throw asConnectError(overall.signal.reason ?? err);
            // The server's RetryInfo detail / Retry-After header, if any. A rate
            // limited (ResourceExhausted) read is only retried when the server
            // says when, and only if that is within maxDelayMs.
            const serverDelay = serverRetryDelayMs(err);
            const retryable =
              RETRYABLE_CODES.has(err.code) || (err.code === Code.ResourceExhausted && serverDelay !== undefined);
            if (attempt >= retries || !retryable) throw err;
            if (serverDelay !== undefined && serverDelay > opts.retry.maxDelayMs) throw err;
            const ceiling = Math.min(opts.retry.maxDelayMs, opts.retry.baseDelayMs * 2 ** attempt);
            const backoff = ceiling / 2 + Math.random() * (ceiling / 2);
            // Wait at least as long as the server asked, plus a little jitter so
            // clients limited in the same second don't all retry at once.
            const delay =
              serverDelay === undefined ? backoff : Math.max(backoff, serverDelay + Math.random() * Math.min(100, ceiling));
            await sleep(delay, overall.signal);
          } finally {
            attemptSignal.cleanup();
          }
        }
      } finally {
        overall.cleanup();
      }
    },
    stream(method, signal, timeoutMs, header, input, contextValues) {
      // No public RPC streams today. Pass through with auth, without retries.
      const headers = new Headers(header);
      headers.set("Authorization", authorization);
      return inner.stream(method, signal, timeoutMs, headers, input, contextValues);
    },
  };
}
