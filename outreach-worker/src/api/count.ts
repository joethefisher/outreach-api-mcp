// Pre-flight count classification.
//
// Outreach `?count=true` returns `meta.count` and `meta.count_truncated`.
// Two truncation cases both mean "narrow the scope":
//   1. Outreach stops counting at ~2_000_000 → count: 2_000_000, count_truncated: true
//   2. Under load, count gets throttled       → count: 0,         count_truncated: true
//
// Tools mint the `tooLarge` envelope themselves; this helper just classifies.

import type { JsonApiMeta } from "./jsonapi.js";

export interface CountResult {
  readonly count: number;
  readonly truncated: boolean;
  /** True when the count is over the caller's threshold OR was truncated. */
  readonly exceeds: boolean;
}

export function classifyCount(meta: JsonApiMeta | undefined, threshold: number): CountResult {
  const count = meta?.count ?? 0;
  const truncated = meta?.count_truncated === true;
  return {
    count,
    truncated,
    exceeds: truncated || count > threshold,
  };
}
