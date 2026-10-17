import type { DescService } from "@bufbuild/protobuf";
import { createClient, type CallOptions, type Client, type Transport } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import {
  AccessScopes,
  inconsistentResponse,
  scopeKindName,
  toAccessEntry,
  type AccessEntry,
  type AccessScopeInfo,
} from "./access.js";
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
import { Groups } from "./groups.js";
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

export interface BatchCheckParams extends RequestOptions {
  /** The principal whose permissions are checked. */
  principal: string;
  /**
   * Resource URIs to check, each answered separately. More than 100 are split
   * into several `BatchCheck` calls, sent in parallel.
   */
  resources: string[];
  /** A permission name. */
  permission?: string;
  /** Several permission names; a resource is allowed only with all of them. At most 100. */
  permissions?: string[];
  /** Project to check in. Defaults to the client's `project`. */
  project?: string;
}

/** One resource's result from `batchCheckDetailed`. */
export interface BatchCheckEntry {
  resource: string;
  /** True when the principal holds every requested permission on `resource`. */
  allowed: boolean;
  /** The requested permissions the principal lacks on `resource`, in request order. */
  missing: string[];
}

export interface ListAccessParams extends PageOptions, Omit<RequestOptions, "signal"> {
  /** The principal to look up. Access through roles and groups counts. */
  principal: string;
  /** The permission to look for. */
  permission: string;
  /** Only resources at or below this URI are considered, e.g. `"/docs"`. A `_` segment here is literal. */
  under: string;
  /** Project to look in. Defaults to the client's `project`. */
  project?: string;
}

export interface WhoHasAccessParams extends PageOptions, Omit<RequestOptions, "signal"> {
  /** The resource to look at. A `_` segment here is literal. */
  resource: string;
  /**
   * Only count grants that confer this permission, so a principal is listed
   * exactly when `check()` passes for it through its own grants (or, for
   * entries with `viaGroup`, through that group). Unset, any grant counts.
   */
  permission?: string;
  /** Also list every member of each listed group, once per group, with `viaGroup` set. */
  expandGroups?: boolean;
  /** Project to look in. Defaults to the client's `project`. */
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
  /** Groups of principals: create them, manage members, list them. */
  readonly groups: Groups;

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
    this.groups = new Groups({
      client: this.permissions,
      resolveProject: (project) => this.resolveProject(project),
      callOptions: (o) => Permio.callOptions(o),
    });
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

  /**
   * Checks each resource separately and returns, per resource URI, whether
   * `principal` holds every requested permission on it. The map has one entry
   * per distinct resource, in request order. Use it to filter a list you
   * already have in memory:
   *
   * ```ts
   * const allowed = await permio.batchCheck({ principal, resources: docs.map((d) => resource("docs", d.id)), permission: "docs.read" });
   * const visible = docs.filter((d) => allowed.get(resource("docs", d.id)));
   * ```
   *
   * @throws PermioPermissionError if the API key lacks `permission.check`.
   */
  async batchCheck(params: BatchCheckParams): Promise<Map<string, boolean>> {
    const entries = await this.batchCheckDetailed(params);
    return new Map(entries.map((e) => [e.resource, e.allowed]));
  }

  /** Like `batchCheck`, but returns one entry per resource with the missing permissions. */
  async batchCheckDetailed(params: BatchCheckParams): Promise<BatchCheckEntry[]> {
    if (!params?.principal) throw new PermioValidationError("permio: principal is required");
    if (!Array.isArray(params.resources)) throw new PermioValidationError("permio: resources must be an array");
    const resourceUris = unique(params.resources);
    if (resourceUris.length === 0) throw new PermioValidationError("permio: at least one resource is required");
    resourceUris.forEach(assertResourceUri);
    const permissions = pick(params.permission, params.permissions, "permission");
    const projectName = this.resolveProject(params.project);
    const chunks: string[][] = [];
    for (let i = 0; i < resourceUris.length; i += 100) chunks.push(resourceUris.slice(i, i + 100));
    const responses = await Promise.all(
      chunks.map((chunk) =>
        this.permissions.batchCheck(
          { projectName, principalId: params.principal, resourceUris: chunk, permissions },
          Permio.callOptions(params),
        ),
      ),
    );
    const byUri = new Map<string, BatchCheckEntry>();
    for (const res of responses) {
      for (const r of res.results) {
        byUri.set(r.resourceUri, {
          resource: r.resourceUri,
          allowed: r.allowed && r.missingPermissions.length === 0,
          missing: r.missingPermissions,
        });
      }
    }
    // Fail closed: every requested resource must have exactly its own answer.
    return resourceUris.map((uri) => {
      const entry = byUri.get(uri);
      if (!entry) throw inconsistentResponse(`no BatchCheck result for ${JSON.stringify(uri)}`);
      return entry;
    });
  }

  /**
   * Answers "where may `principal` use `permission` at or below `under`?",
   * following every page. Use the result to filter lists in your database:
   * `coversAll` means no filter is needed, `toPrefixes()` gives path prefixes,
   * `toRegExp()` a regex, and `allows(uri)` tests a single URI.
   *
   * ```ts
   * const access = await permio.listAccess({ principal: userId, permission: "docs.read", under: "/docs" });
   * const visible = docs.filter((d) => access.allows(resource("docs", d.id)));
   * ```
   *
   * @throws PermioPermissionError unless the API key has `permission.check` on
   *   `under` and `principal.assignment.get` on the principal.
   */
  async listAccess(params: ListAccessParams): Promise<AccessScopes> {
    if (!params?.principal) throw new PermioValidationError("permio: principal is required");
    if (!params.permission) throw new PermioValidationError("permio: permission is required");
    assertResourceUri(params.under);
    const projectName = this.resolveProject(params.project);
    let coversAll = false;
    const scopes: AccessScopeInfo[] = [];
    for await (const page of paginate(
      (pagination, signal) =>
        this.permissions.listAccess(
          { projectName, principalId: params.principal, permission: params.permission, underUri: params.under, pagination },
          Permio.callOptions({ ...params, signal }),
        ),
      (res) => [res],
      params,
    )) {
      if (page.coversAll) coversAll = true;
      for (const s of page.scopes) scopes.push({ uri: s.uri, kind: scopeKindName(s.scope) });
    }
    return new AccessScopes(params.under, coversAll, scopes);
  }

  /**
   * Answers "who has access to `resource`?", following every page. Lists the
   * principals (groups included, as `group:<slug>`) with a grant on the
   * resource, an ancestor of it, or a `_` wildcard URI matching it, ordered by
   * principal ID, with the grants that give the access.
   *
   * @throws PermioPermissionError unless the API key has `principal.list` and
   *   `principal.assignment.list` on the project.
   */
  async whoHasAccess(params: WhoHasAccessParams): Promise<AccessEntry[]> {
    assertResourceUri(params?.resource);
    if (params.permission !== undefined && params.permission === "") {
      throw new PermioValidationError("permio: permission must not be empty");
    }
    const projectName = this.resolveProject(params.project);
    const out: AccessEntry[] = [];
    for await (const p of paginate(
      (pagination, signal) =>
        this.permissions.listPrincipalsWithAccess(
          {
            projectName,
            resourceUri: params.resource,
            expandGroups: params.expandGroups ?? false,
            pagination,
            ...(params.permission !== undefined ? { permission: params.permission } : {}),
          },
          Permio.callOptions({ ...params, signal }),
        ),
      (res) => res.principals,
      params,
    )) {
      out.push(toAccessEntry(p));
    }
    return out;
  }
}
