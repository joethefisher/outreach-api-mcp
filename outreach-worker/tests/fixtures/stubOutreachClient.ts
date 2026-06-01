// Stub OutreachClient for tool-layer integration tests.
//
// Seeded per-resource fixtures the tool dispatches against. The stub now
// applies a small subset of filter semantics (field-equality on literals,
// relationship-id match via relId(), date ranges) so tests can assert that
// tools actually scope their queries — see TST-04 in code-review/REVIEW.md.

import type {
  GetOptions,
  ListOptions,
  ListResult,
  OutreachClient,
  OutreachUser,
} from "../../src/api/client.js";
import type { FilterMap, RangeFilter, RelationshipIdFilter } from "../../src/api/filters.js";

export interface StubData {
  readonly list?: Record<string, readonly Record<string, unknown>[]>;
  readonly get?: Record<string, Record<number, Record<string, unknown>>>;
  readonly count?: Record<string, number>;
  readonly listUsers?: readonly OutreachUser[];
  readonly fetchTypes?: unknown;
}

export class StubOutreachClient implements OutreachClient {
  public listCalls: { resource: string; options?: ListOptions }[] = [];
  public getCalls: { resource: string; id: number | string; options?: GetOptions }[] = [];
  public countCalls: { resource: string; filters?: FilterMap }[] = [];

  constructor(private readonly data: StubData = {}) {}

  list<T = Record<string, unknown>>(
    resource: string,
    options: ListOptions = {},
  ): Promise<ListResult<T>> {
    this.listCalls.push({ resource, options });
    const rows = this.data.list?.[resource] ?? [];
    const filtered =
      options.filters === undefined ? rows : rows.filter((row) => matches(row, options.filters));
    return Promise.resolve({ data: filtered as readonly T[], nextCursor: null });
  }

  get<T = Record<string, unknown>>(
    resource: string,
    id: number | string,
    options: GetOptions = {},
  ): Promise<T> {
    this.getCalls.push({ resource, id, options });
    const record = this.data.get?.[resource]?.[Number(id)];
    if (record === undefined) {
      return Promise.reject(
        new Error(`StubOutreachClient: no fixture for ${resource}/${String(id)}`),
      );
    }
    return Promise.resolve(record as T);
  }

  count(
    resource: string,
    filters?: FilterMap,
  ): Promise<{ readonly count: number; readonly truncated: boolean }> {
    this.countCalls.push({ resource, ...(filters !== undefined && { filters }) });
    // Prefer a seeded count override; fall back to filtered-list length so a
    // test seeded only with `list` data gets a consistent count.
    const seeded = this.data.count?.[resource];
    if (seeded !== undefined) return Promise.resolve({ count: seeded, truncated: false });
    const rows = this.data.list?.[resource] ?? [];
    const filtered = filters === undefined ? rows : rows.filter((row) => matches(row, filters));
    return Promise.resolve({ count: filtered.length, truncated: false });
  }

  listUsers(): Promise<readonly OutreachUser[]> {
    return Promise.resolve(this.data.listUsers ?? []);
  }

  fetchTypes(): Promise<unknown> {
    return Promise.resolve(this.data.fetchTypes ?? { data: [] });
  }
}

// ─── Filter matching ──────────────────────────────────────────────────────

function matches(row: Record<string, unknown>, filters: FilterMap | undefined): boolean {
  if (filters === undefined) return true;
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue;
    if (isRangeFilter(value)) {
      // Match against `<key>` interpreted as an ISO date string. The tools
      // currently use ranges only on date fields (createdAt, updatedAt,
      // deliveredAt, ...). String comparison of ISO8601 is order-preserving.
      const rowVal = row[key];
      if (typeof rowVal !== "string") return false;
      const [from, to] = value.__range;
      if (typeof from === "string" && rowVal < from) return false;
      if (typeof to === "string" && rowVal > to) return false;
      continue;
    }
    if (isRelIdFilter(value)) {
      // Relationships normalize as `<key>Id` (to-one) or `<key>Ids` (to-many).
      const rel = value.__relId;
      const wantedIds: readonly number[] = Array.isArray(rel) ? rel : [rel as number];
      const single = row[`${key}Id`];
      const many = row[`${key}Ids`];
      if (typeof single === "number" && wantedIds.includes(single)) continue;
      if (
        Array.isArray(many) &&
        many.some((id: unknown) => typeof id === "number" && wantedIds.includes(id))
      ) {
        continue;
      }
      return false;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      // Nested filter[key][subkey]=value. Not used by any current tool; skip.
      continue;
    }
    // Literal equality (handles array values via `includes`).
    const rowVal = row[key];
    if (Array.isArray(value)) {
      if (!value.includes(rowVal)) return false;
      continue;
    }
    if (rowVal !== value) return false;
  }
  return true;
}

function isRangeFilter(value: unknown): value is RangeFilter {
  return typeof value === "object" && value !== null && "__range" in value;
}

function isRelIdFilter(value: unknown): value is RelationshipIdFilter {
  return typeof value === "object" && value !== null && "__relId" in value;
}
