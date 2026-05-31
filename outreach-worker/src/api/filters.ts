// Filter / sort / fieldset / pagination URL helpers for the Outreach JSON:API.
//
// Outreach 03-api-conventions:
//   - filter[attribute]=value, comma-lists for multiple values, .. for ranges,
//     __null__ / __notnull__ for presence
//   - filter[relationship][id]=N for relationship-by-ID lookups
//   - sort=field, sort=-field, sort=lastName,-firstName
//   - fields[type]=name,domain (sparse fieldsets)
//   - page[size]=N, page[after]=<cursor>, count=false|true

export type FilterValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number)[];

export type FilterMapValue =
  | FilterValue
  | RangeFilter
  | RelationshipIdFilter
  | Readonly<Record<string, FilterValue>>;

export type FilterMap = Readonly<Record<string, FilterMapValue>>;

export interface RangeFilter {
  /** Inclusive range bounds. Use the literal strings "neginf"/"inf" for open ends. */
  readonly __range: readonly [string | number, string | number];
}

export interface RelationshipIdFilter {
  readonly __relId: number | readonly number[];
}

/** Range filter helper. Pass the literal strings "neginf"/"inf" for open ends. */
export function range(from: string | number, to: string | number): RangeFilter {
  return { __range: [from, to] };
}

/** Relationship-by-ID filter helper. Accepts a single ID or an array. */
export function relId(id: number | readonly number[]): RelationshipIdFilter {
  return { __relId: id };
}

/** Append `filter[...]` params for every non-null/non-undefined key. */
export function appendFilters(params: URLSearchParams, filters: FilterMap | undefined): void {
  if (filters === undefined) return;
  for (const [key, raw] of Object.entries(filters)) {
    if (raw === null || raw === undefined) continue;
    if (isRangeFilter(raw)) {
      params.append(`filter[${key}]`, `${String(raw.__range[0])}..${String(raw.__range[1])}`);
      continue;
    }
    if (isRelIdFilter(raw)) {
      const ids = Array.isArray(raw.__relId) ? raw.__relId : [raw.__relId as number];
      params.append(`filter[${key}][id]`, ids.join(","));
      continue;
    }
    if (typeof raw === "object" && !Array.isArray(raw)) {
      // Nested filter[key][subkey]=value form.
      for (const [subkey, subv] of Object.entries(raw)) {
        if (subv === null || subv === undefined) continue;
        params.append(`filter[${key}][${subkey}]`, formatValue(subv));
      }
      continue;
    }
    // Branches above eliminated null/undefined/RangeFilter/RelationshipIdFilter
    // and nested object. Whatever remains is a FilterValue (primitive or array).
    params.append(`filter[${key}]`, formatValue(raw as FilterValue));
  }
}

function formatValue(value: FilterValue): string {
  if (value === null) return "__null__";
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => String(v)).join(",");
  return String(value);
}

function isRangeFilter(value: unknown): value is RangeFilter {
  return typeof value === "object" && value !== null && "__range" in value;
}

function isRelIdFilter(value: unknown): value is RelationshipIdFilter {
  return typeof value === "object" && value !== null && "__relId" in value;
}

/** Append sparse fieldset params: `fields[type]=a,b,c`. */
export function appendFields(
  params: URLSearchParams,
  fields: Readonly<Record<string, readonly string[]>> | undefined,
): void {
  if (fields === undefined) return;
  for (const [type, list] of Object.entries(fields)) {
    if (list.length === 0) continue;
    params.append(`fields[${type}]`, list.join(","));
  }
}

/** Append the `include=` parameter as a single comma-separated value. */
export function appendIncludes(
  params: URLSearchParams,
  includes: readonly string[] | undefined,
): void {
  if (includes === undefined || includes.length === 0) return;
  params.append("include", includes.join(","));
}

/** Append the `sort=` directive (already formatted with leading `-` for desc). */
export function appendSort(params: URLSearchParams, sort: string | undefined): void {
  if (sort === undefined || sort === "") return;
  params.append("sort", sort);
}

export interface PaginationOptions {
  readonly pageSize?: number;
  readonly cursor?: string | null;
  readonly count?: boolean;
}

export function appendPagination(params: URLSearchParams, opts: PaginationOptions = {}): void {
  if (opts.pageSize !== undefined) params.append("page[size]", String(opts.pageSize));
  if (opts.cursor !== undefined && opts.cursor !== null && opts.cursor !== "") {
    params.append("page[after]", opts.cursor);
  }
  if (opts.count !== undefined) params.append("count", opts.count ? "true" : "false");
}

export interface ListQuery {
  readonly filters?: FilterMap;
  readonly fields?: Readonly<Record<string, readonly string[]>>;
  readonly includes?: readonly string[];
  readonly sort?: string;
  readonly pageSize?: number;
  readonly cursor?: string | null;
  readonly count?: boolean;
}

/** Compose the full query string for a list endpoint. */
export function buildQueryString(q: ListQuery): string {
  const params = new URLSearchParams();
  appendFilters(params, q.filters);
  appendFields(params, q.fields);
  appendIncludes(params, q.includes);
  appendSort(params, q.sort);
  // Construct the pagination options object conditionally so we never pass
  // `undefined` explicitly under `exactOptionalPropertyTypes`.
  const pagination: PaginationOptions = {
    ...(q.pageSize !== undefined && { pageSize: q.pageSize }),
    ...(q.cursor !== undefined && q.cursor !== null && { cursor: q.cursor }),
    ...(q.count !== undefined && { count: q.count }),
  };
  appendPagination(params, pagination);
  return params.toString();
}
