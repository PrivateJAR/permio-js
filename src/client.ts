import type { DescService } from "@bufbuild/protobuf";
import { createClient, type CallOptions, type Client, type Transport } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { validateApiKey, type ApiKeyKind } from "./apikey.js";
import {
  PermioConfigError,
  PermioDeniedError,
  PermioValidationError,
  toPermioError,
  type MissingPermission,
} from "./errors.js";
import { OrganisationService } from "./gen/proto/organisation/v1/organisation_pb.js";
import {
  PermissionsService,
  type Assignment,
  type Permission,
  type Role,
} from "./gen/proto/permissions/v1/permissions_pb.js";
import { paginate, type PageOptions } from "./pagination.js";
import { assertResourceUri } from "./resource.js";
import { withResilience, type RetryOptions } from "./transport.js";

/** Production API. Will move to https://api.perms.io. */
export const DEFAULT_BASE_URL = "https://temp-api.perms.io";
/** Development API. */
export const DEV_BASE_URL = "https://dev-api.perms.io";

export interface PermioOptions {
  /** API key from the dashboard (`perms_…`), or a legacy JWT key. */
  apiKey: string;
  /** API host. Defaults to production, `https://temp-api.perms.io`. */
  baseUrl?: string;
  /** Default `project_name` for helpers that take a `project`. */
  project?: string;
  /** Timeout per attempt in ms. Default 10000; 0 disables it. */
  timeoutMs?: number;
  /** Custom fetch, e.g. to add an agent or for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /**
   * Retries for idempotent reads (Check, Get*, List*) on Unavailable or
   * DeadlineExceeded. A number sets `maxRetries`. Default 2. Writes are never retried.
   */
  retries?: number | RetryOptions;
  /**
   * Advanced: a Connect transport to use instead of the default gRPC-web
   * transport, e.g. `createRouterTransport` in tests. `baseUrl` and `fetch` are
   * then ignored; auth, timeouts and retries still apply.
   */
  transport?: Transport;
}

/** Options accepted by every helper call. */
export interface RequestOptions {
  /** Cancels the call. */
  signal?: AbortSignal;
  /** Overall deadline for this call in ms, across retries. */
  timeoutMs?: number;
  /** Extra request headers. */
  headers?: HeadersInit;
}

export interface CheckParams extends RequestOptions {
  /** The principal (user, service, ...) whose permissions are checked. */
  principal: string;
  /** Resource URI to check, e.g. `resource("docs", id)`. */
  resource?: string;
  /** Several resource URIs; every one is checked. */
  resources?: string[];
  /** A permission name. */
  permission?: string;
  /** Several permission names. */
  permissions?: string[];
  /** Project to check in. Defaults to the client's `project`. */
  project?: string;
}

export interface CheckResult {
  /** True when the principal holds every permission on every resource. */
  allowed: boolean;
  /** What is missing, per resource, in request order. Empty when allowed. */
  missing: MissingPermission[];
}

/** List options. `timeoutMs` and `headers` apply to each page request. */
export interface ListParams extends PageOptions, Omit<RequestOptions, "signal"> {
  /** Project to list in. Defaults to the client's `project`. */
  project?: string;
  /** Filters by name. */
  search?: string;
}

export interface ListAssignmentsParams extends PageOptions, Omit<RequestOptions, "signal"> {
  principal: string;
  project?: string;
}

// Errors from the raw clients are converted to PermioError subclasses. Every
// public RPC is unary; any streaming method would be passed through untouched.
function wrapClient<S extends DescService>(service: S, transport: Transport): Client<S> {
  const raw = createClient(service, transport) as Record<string, (...args: unknown[]) => unknown>;
  const wrapped: Record<string, unknown> = {};
  for (const method of service.methods) {
    const fn = raw[method.localName]!;
    wrapped[method.localName] =
      method.methodKind === "unary"
        ? (...args: unknown[]) =>
            (fn(...args) as Promise<unknown>).catch((e: unknown) => {
              throw toPermioError(e);
            })
        : fn;
  }
  return wrapped as Client<S>;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function pick(one: string | undefined, many: string[] | undefined, what: string): string[] {
  const values = unique([...(one !== undefined ? [one] : []), ...(many ?? [])]);
  if (values.length === 0) throw new PermioValidationError(`permio: at least one ${what} is required`);
  if (values.length > 100) throw new PermioValidationError(`permio: at most 100 ${what}s per check`);
  return values;
}

/**
 * Client for the perms.io API.
 *
 * ```ts
 * const permio = new Permio({ apiKey: process.env.PERMIO_API_KEY!, project: "my-app" });
 * if (await permio.check({ principal: userId, resource: resource("docs", docId), permission: "docs.read" })) { ... }
 * ```
 */
export class Permio {
  /** Raw `PermissionsService` client with auth, timeouts and retries applied. */
  readonly permissions: Client<typeof PermissionsService>;
  /** Raw `OrganisationService` client with auth, timeouts and retries applied. */
  readonly organisations: Client<typeof OrganisationService>;
  /** Default project for helpers, if configured. */
  readonly project: string | undefined;
  /** Whether the configured key is an opaque `perms_` key or a legacy JWT. */
  readonly apiKeyKind: ApiKeyKind;
  readonly baseUrl: string;

  constructor(options: PermioOptions) {
    if (!options || typeof options !== "object") throw new PermioConfigError("permio: options are required");
    this.apiKeyKind = validateApiKey(options.apiKey);
    this.project = options.project;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (!options.transport && !/^https?:\/\//.test(this.baseUrl)) {
      throw new PermioConfigError(`permio: baseUrl must be an http(s) URL, got ${JSON.stringify(options.baseUrl)}`);
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!options.transport && typeof fetchImpl !== "function") {
      throw new PermioConfigError("permio: no fetch implementation available; pass options.fetch (Node 18+ has one built in)");
    }

    const retry = typeof options.retries === "number" ? { maxRetries: options.retries } : (options.retries ?? {});
    const transport = withResilience(
      options.transport ??
        createGrpcWebTransport({
          baseUrl: this.baseUrl,
          // Bound so environments that check `this` (some browsers, edge runtimes) are happy.
          fetch: (input, init) => fetchImpl(input, init),
        }),
      {
        apiKey: options.apiKey,
        timeoutMs: Math.max(0, options.timeoutMs ?? 10_000),
        retry: {
          maxRetries: Math.max(0, Math.floor(retry.maxRetries ?? 2)),
          baseDelayMs: Math.max(0, retry.baseDelayMs ?? 100),
          maxDelayMs: Math.max(0, retry.maxDelayMs ?? 2_000),
        },
      },
    );
    this.permissions = wrapClient(PermissionsService, transport);
    this.organisations = wrapClient(OrganisationService, transport);
  }

  private resolveProject(project: string | undefined): string {
    const name = project ?? this.project;
    if (!name) {
      throw new PermioConfigError("permio: no project given; pass `project` to this call or to new Permio()");
    }
    return name;
  }

  private static callOptions(o: {
    signal?: AbortSignal | undefined;
    timeoutMs?: number | undefined;
    headers?: HeadersInit | undefined;
  }): CallOptions {
    const out: CallOptions = {};
    if (o.signal) out.signal = o.signal;
    if (o.timeoutMs !== undefined) out.timeoutMs = o.timeoutMs;
    if (o.headers) out.headers = o.headers;
    return out;
  }

  /**
   * Checks whether `principal` holds every permission on every resource and
   * returns what is missing. A denial is a normal result, not an error.
   *
   * @throws PermioPermissionError if the API key lacks `permission.check`.
   * @throws PermioValidationError for malformed URIs or empty inputs.
   */
  async checkDetailed(params: CheckParams): Promise<CheckResult> {
    if (!params?.principal) throw new PermioValidationError("permio: principal is required");
    const resourceUris = pick(params.resource, params.resources, "resource");
    resourceUris.forEach(assertResourceUri);
    const permissions = pick(params.permission, params.permissions, "permission");
    const res = await this.permissions.check(
      {
        projectName: this.resolveProject(params.project),
        principalId: params.principal,
        resourceUris,
        permissions,
      },
      Permio.callOptions(params),
    );
    const missing = res.missingPermissions.map((m) => ({ resource: m.resourceUri, permissions: m.missingPermissions }));
    return { allowed: res.passed, missing };
  }

  /** True when `principal` holds every permission on every resource. */
  async check(params: CheckParams): Promise<boolean> {
    return (await this.checkDetailed(params)).allowed;
  }

  /** Alias of `check`: every permission on every resource. */
  checkAll(params: CheckParams): Promise<boolean> {
    return this.check(params);
  }

  /**
   * True when, on every resource, `principal` holds at least one of the
   * permissions. Uses a single `Check` call.
   */
  async checkAny(params: CheckParams): Promise<boolean> {
    const { allowed, missing } = await this.checkDetailed(params);
    if (allowed) return true;
    const wanted = pick(params.permission, params.permissions, "permission");
    return missing.every((m) => wanted.some((p) => !m.permissions.includes(p)));
  }

  /**
   * Resolves when `principal` holds every permission on every resource.
   *
   * @throws PermioDeniedError when it does not, with `missing` filled in.
   */
  async assert(params: CheckParams): Promise<void> {
    const { allowed, missing } = await this.checkDetailed(params);
    if (!allowed) throw new PermioDeniedError(params.principal, missing);
  }

  /** Iterates every permission in a project. */
  listPermissions(params: ListParams = {}): AsyncGenerator<Permission, void, undefined> {
    const projectName = this.resolveProject(params.project);
    return paginate(
      (pagination, signal) =>
        this.permissions.listPermissions(
          { projectName, pagination, ...(params.search ? { search: params.search } : {}) },
          Permio.callOptions({ ...params, signal }),
        ),
      (res) => res.permissions,
      params,
    );
  }

  /** Iterates every role in a project. */
  listRoles(params: ListParams = {}): AsyncGenerator<Role, void, undefined> {
    const projectName = this.resolveProject(params.project);
    return paginate(
      (pagination, signal) =>
        this.permissions.listRoles(
          { projectName, pagination, ...(params.search ? { search: params.search } : {}) },
          Permio.callOptions({ ...params, signal }),
        ),
      (res) => res.roles,
      params,
    );
  }

  /** Iterates the IDs of every principal with grants in a project. */
  listPrincipals(params: ListParams = {}): AsyncGenerator<string, void, undefined> {
    const projectName = this.resolveProject(params.project);
    return paginate(
      (pagination, signal) =>
        this.permissions.listPrincipals(
          { projectName, pagination, ...(params.search ? { search: params.search } : {}) },
          Permio.callOptions({ ...params, signal }),
        ),
      (res) => res.principals,
      params,
    );
  }

  /** Iterates every assignment (resource + permissions + roles) of a principal in a project. */
  listAssignments(params: ListAssignmentsParams): AsyncGenerator<Assignment, void, undefined> {
    if (!params?.principal) throw new PermioValidationError("permio: principal is required");
    const projectName = this.resolveProject(params.project);
    return paginate(
      (pagination, signal) =>
        this.permissions.getAllAssignmentsForPrincipal(
          { projectName, principalId: params.principal, pagination },
          Permio.callOptions({ ...params, signal }),
        ),
      (res) => res.assignments,
      params,
    );
  }
}
