import type { CallOptions, Client } from "@connectrpc/connect";
import { PermioValidationError } from "./errors.js";
import type { Group, GroupMember, PermissionsService } from "./gen/proto/permissions/v1/permissions_pb.js";
import { paginate, type PageOptions } from "./pagination.js";

/** Prefix of the principal ID that grants to a group are made to. */
export const GROUP_PRINCIPAL_PREFIX = "group:";

const SLUG = /^[a-z0-9-]{1,64}$/;

function assertSlug(slug: string): string {
  if (typeof slug !== "string" || !SLUG.test(slug)) {
    throw new PermioValidationError(
      `permio: invalid group name ${JSON.stringify(slug)}: use 1-64 lower-case letters, digits and hyphens`,
    );
  }
  return slug;
}

/**
 * The principal ID of a group, `"group:<slug>"`. Grant permissions and roles to
 * it, or check it, like any other principal; every member of the group holds
 * what the group is granted.
 *
 * ```ts
 * group("editors") // "group:editors"
 * ```
 */
export function group(slug: string): string {
  return GROUP_PRINCIPAL_PREFIX + assertSlug(slug);
}

// Group methods accept a slug or a "group:<slug>" principal ID.
function slugOf(nameOrPrincipal: string): string {
  const name =
    typeof nameOrPrincipal === "string" && nameOrPrincipal.startsWith(GROUP_PRINCIPAL_PREFIX)
      ? nameOrPrincipal.slice(GROUP_PRINCIPAL_PREFIX.length)
      : nameOrPrincipal;
  return assertSlug(name);
}

function principalList(principals: string[], what: string): string[] {
  if (!Array.isArray(principals)) throw new PermioValidationError(`permio: principals must be an array`);
  const values = [...new Set(principals)];
  if (values.length === 0) throw new PermioValidationError(`permio: at least one principal is required`);
  if (values.length > 100) throw new PermioValidationError(`permio: at most 100 principals per ${what}`);
  for (const p of values) {
    if (typeof p !== "string" || p === "") throw new PermioValidationError("permio: principal IDs must be non-empty strings");
  }
  return values;
}

/** Options accepted by every group call. */
export interface GroupRequestOptions {
  /** Project of the group. Defaults to the client's `project`. */
  project?: string;
  signal?: AbortSignal;
  /** Overall deadline for this call in ms, across retries. */
  timeoutMs?: number;
  headers?: HeadersInit;
}

export interface CreateGroupOptions extends GroupRequestOptions {
  description?: string;
}

export interface UpdateGroupOptions extends GroupRequestOptions {
  /** Replaces the description. A group's name cannot be changed. */
  description: string;
}

/** List options for groups. `timeoutMs` and `headers` apply to each page request. */
export interface ListGroupsParams extends PageOptions {
  project?: string;
  /** Filters by name. */
  search?: string;
  timeoutMs?: number;
  headers?: HeadersInit;
}

/** List options. `timeoutMs` and `headers` apply to each page request. */
export interface GroupListOptions extends PageOptions {
  project?: string;
  timeoutMs?: number;
  headers?: HeadersInit;
}

export interface AddMembersResult {
  /** Principals that were added, in request order. */
  added: string[];
  /** Principals that were already members, in request order. */
  existing: string[];
}

export interface RemoveMembersResult {
  /** Principals that were removed, in request order. */
  removed: string[];
  /** Principals that were not members, in request order. */
  notMembers: string[];
}

/** @internal What `Groups` needs from the client. */
export interface GroupsContext {
  client: Client<typeof PermissionsService>;
  resolveProject(project: string | undefined): string;
  callOptions(o: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined; headers?: HeadersInit | undefined }): CallOptions;
}

/**
 * Groups of principals, available as `permio.groups`. A group is referenced as
 * the principal `group:<slug>` (see `group()`): grant to it and every member
 * holds the grant. Groups cannot contain groups.
 *
 * Every method that takes a group accepts its slug (`"editors"`) or its
 * principal ID (`"group:editors"`).
 */
export class Groups {
  readonly #ctx: GroupsContext;

  /** @internal */
  constructor(ctx: GroupsContext) {
    this.#ctx = ctx;
  }

  /**
   * Creates a group.
   *
   * @throws PermioError with code `AlreadyExists` if the project already has a group with this name.
   */
  async create(name: string, options: CreateGroupOptions = {}): Promise<Group> {
    const slug = slugOf(name);
    return this.#ctx.client.createGroup(
      { projectName: this.#ctx.resolveProject(options.project), name: slug, description: options.description ?? "" },
      this.#ctx.callOptions(options),
    );
  }

  /**
   * Returns a group.
   *
   * @throws PermioNotFoundError if it does not exist.
   */
  async get(name: string, options: GroupRequestOptions = {}): Promise<Group> {
    const slug = slugOf(name);
    return this.#ctx.client.getGroup(
      { projectName: this.#ctx.resolveProject(options.project), name: slug },
      this.#ctx.callOptions(options),
    );
  }

  /**
   * Replaces a group's description.
   *
   * @throws PermioNotFoundError if it does not exist.
   */
  async update(name: string, options: UpdateGroupOptions): Promise<Group> {
    const slug = slugOf(name);
    if (typeof options?.description !== "string") {
      throw new PermioValidationError("permio: description is required");
    }
    return this.#ctx.client.updateGroup(
      { projectName: this.#ctx.resolveProject(options.project), name: slug, description: options.description },
      this.#ctx.callOptions(options),
    );
  }

  /**
   * Deletes a group, its memberships and every grant made to it. Resolves
   * whether or not the group existed.
   */
  async delete(name: string, options: GroupRequestOptions = {}): Promise<void> {
    const slug = slugOf(name);
    await this.#ctx.client.deleteGroup(
      { projectName: this.#ctx.resolveProject(options.project), name: slug },
      this.#ctx.callOptions(options),
    );
  }

  /** Iterates every group in a project, ordered by name. */
  list(params: ListGroupsParams = {}): AsyncGenerator<Group, void, undefined> {
    const projectName = this.#ctx.resolveProject(params.project);
    return paginate(
      (pagination, signal) =>
        this.#ctx.client.listGroups(
          { projectName, pagination, ...(params.search ? { search: params.search } : {}) },
          this.#ctx.callOptions({ ...params, signal }),
        ),
      (res) => res.groups,
      params,
    );
  }

  /**
   * Adds up to 100 principals to a group. Principals that are already members
   * are reported in `existing`. Group principals (`group:…`) are rejected,
   * because groups cannot be nested.
   */
  async addMembers(name: string, principals: string[], options: GroupRequestOptions = {}): Promise<AddMembersResult> {
    const slug = slugOf(name);
    const principalIds = principalList(principals, "call");
    if (principalIds.some((p) => p.startsWith(GROUP_PRINCIPAL_PREFIX))) {
      throw new PermioValidationError("permio: groups cannot contain groups");
    }
    const res = await this.#ctx.client.addGroupMembers(
      { projectName: this.#ctx.resolveProject(options.project), name: slug, principalIds },
      this.#ctx.callOptions(options),
    );
    return { added: res.addedPrincipalIds, existing: res.existingPrincipalIds };
  }

  /** Removes up to 100 principals from a group. Principals that were not members are reported in `notMembers`. */
  async removeMembers(
    name: string,
    principals: string[],
    options: GroupRequestOptions = {},
  ): Promise<RemoveMembersResult> {
    const slug = slugOf(name);
    const principalIds = principalList(principals, "call");
    const res = await this.#ctx.client.removeGroupMembers(
      { projectName: this.#ctx.resolveProject(options.project), name: slug, principalIds },
      this.#ctx.callOptions(options),
    );
    return { removed: res.removedPrincipalIds, notMembers: res.notMemberPrincipalIds };
  }

  /** Iterates a group's members, ordered by principal ID. */
  listMembers(name: string, params: GroupListOptions = {}): AsyncGenerator<GroupMember, void, undefined> {
    const slug = slugOf(name);
    const projectName = this.#ctx.resolveProject(params.project);
    return paginate(
      (pagination, signal) =>
        this.#ctx.client.listGroupMembers(
          { projectName, name: slug, pagination },
          this.#ctx.callOptions({ ...params, signal }),
        ),
      (res) => res.members,
      params,
    );
  }

  /** Iterates the groups `principal` is a member of, ordered by name. */
  listForPrincipal(principal: string, params: GroupListOptions = {}): AsyncGenerator<Group, void, undefined> {
    if (typeof principal !== "string" || principal === "") {
      throw new PermioValidationError("permio: principal is required");
    }
    const projectName = this.#ctx.resolveProject(params.project);
    return paginate(
      (pagination, signal) =>
        this.#ctx.client.listGroupsForPrincipal(
          { projectName, principalId: principal, pagination },
          this.#ctx.callOptions({ ...params, signal }),
        ),
      (res) => res.groups,
      params,
    );
  }
}
