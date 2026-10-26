export {
  Permio,
  DEFAULT_BASE_URL,
  DEV_BASE_URL,
  type PermioOptions,
  type RequestOptions,
  type CheckParams,
  type CheckResult,
  type ListParams,
  type ListAssignmentsParams,
  type BatchCheckParams,
  type BatchCheckEntry,
  type ListAccessParams,
  type WhoHasAccessParams,
  type GrantParams,
  type RevokeParams,
  type WhoAmI,
  type PrincipalKind,
  type ApiKeyAccessLevel,
} from "./client.js";
export {
  AccessScopes,
  WILDCARD_SEGMENT,
  type AccessScopeInfo,
  type AccessScopeKindName,
  type AccessEntry,
  type AccessGrantInfo,
  type AccessGrantMatchName,
} from "./access.js";
export {
  Groups,
  group,
  GROUP_PRINCIPAL_PREFIX,
  type GroupRequestOptions,
  type CreateGroupOptions,
  type UpdateGroupOptions,
  type ListGroupsParams,
  type GroupListOptions,
  type AddMembersResult,
  type RemoveMembersResult,
} from "./groups.js";
export {
  PermioError,
  PermioConfigError,
  PermioAuthError,
  PermioPermissionError,
  PermioValidationError,
  PermioNotFoundError,
  PermioUnavailableError,
  PermioTimeoutError,
  PermioDeniedError,
  parseMissingPermissions,
  toPermioError,
  type MissingPermission,
  type PermioErrorOptions,
} from "./errors.js";
export { validateApiKey, isValidApiKey, API_KEY_LENGTH, type ApiKeyKind } from "./apikey.js";
export { resource, encodeSegment, assertResourceUri, MAX_RESOURCE_URI_LENGTH } from "./resource.js";
export { paginate, MAX_PAGE_SIZE, type PageOptions } from "./pagination.js";
export { isIdempotentMethod, type RetryOptions } from "./transport.js";
export { Code } from "@connectrpc/connect";

// Generated messages and service descriptors, for use with the raw clients.
export * as permissionsv1 from "./gen/proto/permissions/v1/permissions_pb.js";
export * as organisationv1 from "./gen/proto/organisation/v1/organisation_pb.js";
export * as paginationv1 from "./gen/proto/pagination/v1/pagination_pb.js";
export { PermissionsService } from "./gen/proto/permissions/v1/permissions_pb.js";
export { OrganisationService } from "./gen/proto/organisation/v1/organisation_pb.js";
