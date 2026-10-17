import { PermioError } from "./errors.js";
import {
  AccessGrantMatch,
  AccessScopeKind,
  type PrincipalAccess,
} from "./gen/proto/permissions/v1/permissions_pb.js";

/** The `_` segment: in a PATTERN scope it matches exactly one segment. */
export const WILDCARD_SEGMENT = "_";

/**
 * Which resources a scope's `uri` stands for.
 *
 * - `"subtree"`: the URI itself and everything below it.
 * - `"pattern"`: every URI whose leading segments match `uri`, where each `_`
 *   segment matches exactly one segment, and everything below those.
 * - `"exact"`: exactly the URI. Reserved by the API; not returned today.
 * - `"unknown"`: a kind this SDK version does not know. It never matches.
 */
export type AccessScopeKindName = "subtree" | "pattern" | "exact" | "unknown";

/** One place where a principal holds a permission. */
export interface AccessScopeInfo {
  /** Resource URI (subtree, exact) or URI pattern with `_` segments (pattern). */
  uri: string;
  kind: AccessScopeKindName;
}

export function scopeKindName(kind: AccessScopeKind): AccessScopeKindName {
  switch (kind) {
    case AccessScopeKind.SUBTREE:
      return "subtree";
    case AccessScopeKind.PATTERN:
      return "pattern";
    case AccessScopeKind.EXACT:
      return "exact";
    default:
      return "unknown";
  }
}

// Splits "/a/b" into ["a", "b"]. Returns undefined for anything that is not a
// well-formed URI (no leading slash, empty segments), so it can never match.
function segments(uri: string): string[] | undefined {
  if (typeof uri !== "string" || !uri.startsWith("/") || uri.length < 2) return undefined;
  const parts = uri.slice(1).split("/");
  return parts.includes("") ? undefined : parts;
}

function scopeMatches(scope: AccessScopeInfo, target: string[]): boolean {
  const own = segments(scope.uri);
  if (!own) return false;
  switch (scope.kind) {
    case "exact":
      return own.length === target.length && own.every((s, i) => s === target[i]);
    case "subtree":
      // Segment by segment, so /a/b covers /a/b/c but not /a/bc. A "_" here is literal.
      return own.length <= target.length && own.every((s, i) => s === target[i]);
    case "pattern":
      return own.length <= target.length && own.every((s, i) => s === WILDCARD_SEGMENT || s === target[i]);
    default:
      return false;
  }
}

const REGEX_META = /[.*+?^${}()|[\]\\/]/g;

function escapeRegExp(text: string): string {
  return text.replace(REGEX_META, "\\$&");
}

function scopeRegExpSource(scope: AccessScopeInfo): string | undefined {
  const own = segments(scope.uri);
  if (!own) return undefined;
  const body = own
    .map((s) => "\\/" + (scope.kind === "pattern" && s === WILDCARD_SEGMENT ? "[^/]+" : escapeRegExp(s)))
    .join("");
  switch (scope.kind) {
    case "exact":
      return body;
    case "subtree":
    case "pattern":
      return `${body}(?:\\/.*)?`;
    default:
      return undefined;
  }
}

/**
 * The answer to "where may this principal use this permission under `under`?",
 * returned by `Permio.listAccess`. Every page has already been fetched.
 *
 * ```ts
 * const access = await permio.listAccess({ principal: userId, permission: "docs.read", under: "/docs" });
 * docs.filter((d) => access.allows(resource("docs", d.id)));
 * ```
 *
 * The scopes describe resources at or below `under`. A URI outside `under` was
 * not asked about, so `allows()` returning `false` for it means "unknown", not
 * "denied". A PATTERN scope may also match some URIs outside `under` (its `_`
 * segments can sit in the part that matches `under`); those really are allowed.
 */
export class AccessScopes {
  /** The `under` URI that was asked about. */
  readonly under: string;
  /**
   * True when the principal holds the permission on `under` itself, and so on
   * everything below it. `scopes` is then a single subtree scope for `under`.
   * Check this first: when it is true, a list needs no filter at all.
   */
  readonly coversAll: boolean;
  /** Every scope, ordered by URI as the API returned them. */
  readonly scopes: readonly AccessScopeInfo[];

  constructor(under: string, coversAll: boolean, scopes: AccessScopeInfo[]) {
    this.under = under;
    this.coversAll = coversAll;
    this.scopes = Object.freeze(scopes.map((s) => Object.freeze({ ...s })));
  }

  /** True when the principal has no access anywhere under `under`. */
  get isEmpty(): boolean {
    return !this.coversAll && !this.scopes.some((s) => s.kind !== "unknown");
  }

  /**
   * Whether the principal holds the permission on `uri`, according to these
   * scopes. Matching is per segment: a subtree scope `/a/b` allows `/a/b` and
   * `/a/b/c` but not `/a/bc`; a pattern scope `/a/_/c` allows `/a/x/c` and
   * `/a/x/c/d` but not `/a/x` or `/a/x/y`. Malformed URIs are never allowed.
   */
  allows(uri: string): boolean {
    const target = segments(uri);
    if (!target) return false;
    return this.scopes.some((s) => scopeMatches(s, target));
  }

  /**
   * The subtree scopes' URIs, for filtering a database by path prefix. A URI
   * `p` here stands for `p` itself and everything below it, so match
   * `path = p OR path starts with p + "/"`; a bare `startsWith(p)` would also
   * match `/docs/12` for `/docs/1`. Prefixes already covered by a shorter one
   * are dropped.
   *
   * Pattern scopes cannot be expressed as a prefix and are not included: see
   * `patterns()` and `toRegExp()`, or `hasPatterns`.
   */
  toPrefixes(): string[] {
    const subtrees = [...new Set(this.scopes.filter((s) => s.kind === "subtree").map((s) => s.uri))];
    return subtrees.filter((p) => !subtrees.some((q) => p.startsWith(q + "/")));
  }

  /** The pattern scopes' URIs (with `_` segments). Empty when every scope is a prefix. */
  patterns(): string[] {
    return this.scopes.filter((s) => s.kind === "pattern").map((s) => s.uri);
  }

  /** The exact scopes' URIs. The API does not return exact scopes today. */
  exact(): string[] {
    return this.scopes.filter((s) => s.kind === "exact").map((s) => s.uri);
  }

  /** True when some scope is a pattern, so `toPrefixes()` alone does not cover everything. */
  get hasPatterns(): boolean {
    return this.scopes.some((s) => s.kind === "pattern");
  }

  /**
   * One anchored regular expression that matches exactly the URIs `allows()`
   * accepts, for stores that filter by regex (MongoDB `$regex`, PostgreSQL `~`
   * with `.source`). With no scopes it matches nothing.
   */
  toRegExp(): RegExp {
    const parts = this.scopes.map(scopeRegExpSource).filter((p): p is string => p !== undefined);
    // "$.^" can never match, and is valid in JavaScript, PCRE (MongoDB) and PostgreSQL regexes.
    return parts.length === 0 ? /$.^/ : new RegExp(`^(?:${parts.join("|")})$`);
  }
}

/** How a grant reaches the resource asked about. */
export type AccessGrantMatchName = "exact" | "ancestor" | "wildcard" | "unknown";

/** One grant (or one role within a grant) that gives a principal access. */
export interface AccessGrantInfo {
  /** The URI the grant was made on: the resource, an ancestor, or a URI with `_` segments matching it. */
  resource: string;
  /** True unless the grant was made on exactly the resource. */
  inherited: boolean;
  match: AccessGrantMatchName;
  /** Through a role, or as directly granted permissions. */
  source: { type: "role"; id: string; name: string } | { type: "direct" } | { type: "unknown" };
}

/** One principal with access to a resource, returned by `Permio.whoHasAccess`. */
export interface AccessEntry {
  /** The principal ID; `group:<slug>` for a group. */
  principal: string;
  /** True when `principal` is a group. */
  isGroup: boolean;
  /**
   * The slug of the group through which `principal` has the grants in `via`,
   * for entries added by `expandGroups`. Undefined for grants made to `principal` itself.
   */
  viaGroup: string | undefined;
  /** The grants that give the access, most specific first. */
  via: AccessGrantInfo[];
}

function matchName(match: AccessGrantMatch): AccessGrantMatchName {
  switch (match) {
    case AccessGrantMatch.EXACT:
      return "exact";
    case AccessGrantMatch.ANCESTOR:
      return "ancestor";
    case AccessGrantMatch.WILDCARD:
      return "wildcard";
    default:
      return "unknown";
  }
}

export function toAccessEntry(p: PrincipalAccess): AccessEntry {
  return {
    principal: p.principalId,
    isGroup: p.isGroup,
    viaGroup: p.viaGroup === "" ? undefined : p.viaGroup,
    via: p.via.map((g) => ({
      resource: g.resourceUri,
      inherited: g.inherited,
      match: matchName(g.match),
      source:
        g.source.case === "role"
          ? { type: "role", id: g.source.value.id, name: g.source.value.name }
          : g.source.case === "direct"
            ? { type: "direct" }
            : { type: "unknown" },
    })),
  };
}

/** Thrown when the API answers in a way the SDK cannot trust, e.g. a batch result for an unrequested resource. */
export function inconsistentResponse(what: string): PermioError {
  return new PermioError(`permio: inconsistent response from the API: ${what}`);
}
