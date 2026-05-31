// Cursor-based pagination iterator with hard cap and truncation flag.
//
// Used by tools that aggregate across many pages
// (e.g. analyzeSequencePerformance). Single-page tools call the client directly.
//
// Rules:
//   - The cursor is opaque to the iterator: it never inspects, only round-trips.
//   - Pages are capped at MAX_PAGES per call; on hit, truncated = true.
//   - If maxRecords is set, the iterator stops once that many records have been
//     collected — flagging truncated = true only when more were actually
//     available upstream.

import { extractNextCursor, type JsonApiDocument, type JsonApiResource } from "./jsonapi.js";

/** Maximum pages walked per call. 50 pages × 1000 records = 50_000 record ceiling. */
const MAX_PAGES = 50;

export type PaginatedFetch = (
  cursor: string | null,
) => Promise<JsonApiDocument<readonly JsonApiResource[]>>;

export interface PaginateOptions {
  /** Override the default page-walking cap. Defaults to MAX_PAGES (50). */
  readonly maxPages?: number;
  /** Stop early once this many records have been collected. */
  readonly maxRecords?: number;
  /**
   * Streaming aggregation callback. When provided, the iterator does NOT
   * accumulate `data` or `included` — the caller aggregates inside the callback.
   */
  readonly onPage?: (doc: JsonApiDocument<readonly JsonApiResource[]>) => void | Promise<void>;
}

export interface PaginateResult {
  readonly data: readonly JsonApiResource[];
  readonly pagesWalked: number;
  readonly truncated: boolean;
  /** Concatenated `included[]` across pages, deduped by `${type}:${id}`. */
  readonly included: readonly JsonApiResource[];
}

/**
 * Walk pages until: no `next` link, the page cap is reached, or the record cap
 * is reached. Returns concatenated `data` + deduped `included` with a
 * `truncated` flag.
 *
 * If `onPage` is set, `data` and `included` come back empty — the caller is
 * expected to aggregate inside the callback for memory-bounded workloads.
 */
export async function paginate(
  fetchPage: PaginatedFetch,
  opts: PaginateOptions = {},
): Promise<PaginateResult> {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const maxRecords = opts.maxRecords ?? Number.POSITIVE_INFINITY;

  const data: JsonApiResource[] = [];
  const includedIndex = new Map<string, JsonApiResource>();
  let cursor: string | null = null;
  let pagesWalked = 0;
  let truncated = false;

  for (;;) {
    if (pagesWalked >= maxPages) {
      truncated = true;
      break;
    }
    const doc = await fetchPage(cursor);
    pagesWalked++;

    if (opts.onPage !== undefined) {
      await opts.onPage(doc);
    } else {
      for (const resource of doc.data ?? []) {
        data.push(resource);
        if (data.length >= maxRecords) break;
      }
      for (const inc of doc.included ?? []) {
        includedIndex.set(`${inc.type}:${String(inc.id)}`, inc);
      }
      if (data.length >= maxRecords) {
        if (extractNextCursor(doc.links) !== null) truncated = true;
        break;
      }
    }

    const next = extractNextCursor(doc.links);
    if (next === null) break;
    cursor = next;
  }

  return {
    data,
    pagesWalked,
    truncated,
    included: Array.from(includedIndex.values()),
  };
}
