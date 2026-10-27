import { inconsistentResponse } from "./access.js";

/** Largest page the API accepts (`PaginationRequest.limit` is 1..100). */
export const MAX_PAGE_SIZE = 100;

export interface PageOptions {
  /** Items requested per page, 1..100. Default 100. */
  pageSize?: number;
  /** Stops iteration (and any in-flight request) when aborted. */
  signal?: AbortSignal;
}

/** Options of `paginate`. */
export interface PaginateOptions extends PageOptions {
  /**
   * Stops after this many items. The last page request asks only for the
   * items still wanted, so no more than `maxItems` are ever fetched.
   */
  maxItems?: number;
}

interface Paginated {
  pagination?: { nextCursor: string } | undefined;
}

/**
 * Iterates every item of a list RPC that uses `pagination.PaginationRequest` /
 * `PaginationResponse`, following `next_cursor` until the API returns an empty one.
 * A cursor the API already returned would loop forever, so it throws a
 * `PermioError` ("inconsistent response from the API") instead.
 *
 * ```ts
 * for await (const key of paginate(
 *   (pagination) => permio.organisations.listAPIKeys({ organisationId, projectName, pagination }),
 *   (res) => res.apiKeys,
 * )) { ... }
 * ```
 */
export async function* paginate<Res extends Paginated, Item>(
  fetchPage: (pagination: { limit: number; cursor?: string }, signal?: AbortSignal) => Promise<Res>,
  items: (res: Res) => Item[],
  options: PaginateOptions = {},
): AsyncGenerator<Item, void, undefined> {
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(options.pageSize ?? MAX_PAGE_SIZE)));
  const maxItems = options.maxItems === undefined ? Infinity : Math.max(0, Math.floor(options.maxItems));
  let yielded = 0;
  let cursor: string | undefined;
  const seen = new Set<string>();
  while (yielded < maxItems) {
    options.signal?.throwIfAborted();
    const limit = Math.min(pageSize, maxItems - yielded);
    const res = await fetchPage(cursor === undefined ? { limit } : { limit, cursor }, options.signal);
    for (const item of items(res)) {
      if (yielded >= maxItems) return;
      yielded++;
      yield item;
    }
    const next = res.pagination?.nextCursor ?? "";
    // An empty cursor ends the listing. A repeated one would loop forever, and
    // stopping quietly would return a truncated listing as if it were complete.
    if (next === "") return;
    if (seen.has(next)) throw inconsistentResponse(`pagination cursor ${JSON.stringify(next)} was returned twice`);
    seen.add(next);
    cursor = next;
  }
}
