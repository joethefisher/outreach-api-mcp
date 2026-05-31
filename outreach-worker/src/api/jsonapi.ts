// JSON:API 1.0 → flat-object normalization.
//
// The MCP agent never sees raw JSON:API. Tools return flat objects where:
//   - { id, attributes.foo } collapses to { id, foo }
//   - relationships are exposed as `<rel>Id` (to-one) or `<rel>Ids` (to-many)
//   - included[] resources are indexed by `${type}:${id}` and looked up by ID
//   - tools opt-in to attribute flattening per relationship via the FlattenMap

export interface JsonApiResourceIdentifier {
  readonly type: string;
  readonly id: number | string;
}

export interface JsonApiRelationship {
  readonly data?: JsonApiResourceIdentifier | readonly JsonApiResourceIdentifier[] | null;
  readonly links?: Readonly<Record<string, unknown>>;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface JsonApiResource {
  readonly type: string;
  readonly id: number | string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly relationships?: Readonly<Record<string, JsonApiRelationship>>;
  readonly links?: Readonly<Record<string, unknown>>;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface JsonApiMeta {
  readonly count?: number;
  readonly count_truncated?: boolean;
  readonly [key: string]: unknown;
}

export interface JsonApiLinks {
  readonly first?: string;
  readonly next?: string;
  readonly prev?: string;
  readonly last?: string;
}

export interface JsonApiError {
  readonly id?: string;
  readonly title?: string;
  readonly detail?: string;
  readonly source?: { readonly pointer?: string };
}

export interface JsonApiDocument<
  T extends JsonApiResource | readonly JsonApiResource[] =
    | JsonApiResource
    | readonly JsonApiResource[],
> {
  readonly data?: T;
  readonly included?: readonly JsonApiResource[];
  readonly meta?: JsonApiMeta;
  readonly links?: JsonApiLinks;
  readonly errors?: readonly JsonApiError[];
}

/**
 * Map: relationship name → list of attribute names to project from the related
 * resource onto the flat output, prefixed with the relationship name.
 *
 * Example: `{ account: ["name", "domain"] }` projects `accountName` and
 * `accountDomain` from each prospect's account relationship.
 *
 * Special: `["*"]` projects every attribute verbatim (still prefixed).
 */
export type FlattenMap = Readonly<Record<string, readonly string[]>>;

/** Build an O(1) lookup over `included[]` keyed by `${type}:${id}`. */
export function indexIncluded(
  included: readonly JsonApiResource[] = [],
): Map<string, JsonApiResource> {
  const map = new Map<string, JsonApiResource>();
  for (const resource of included) map.set(`${resource.type}:${String(resource.id)}`, resource);
  return map;
}

/**
 * Normalize one resource. Emits `id` and all attributes flat. To-one
 * relationships become `<rel>Id`; to-many become `<rel>Ids`. Any relationship
 * named in `flatten` also gets per-attribute projections like `accountName`.
 */
export function normalizeResource(
  resource: JsonApiResource,
  index: ReadonlyMap<string, JsonApiResource>,
  flatten: FlattenMap = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { id: coerceId(resource.id) };
  for (const [key, value] of Object.entries(resource.attributes ?? {})) {
    out[key] = value;
  }
  for (const [rel, def] of Object.entries(resource.relationships ?? {})) {
    const data = def.data;
    if (data === null || data === undefined) continue;
    if (isIdentifierArray(data)) {
      out[`${rel}Ids`] = data.map((d) => coerceId(d.id));
      const projection = flatten[rel];
      if (projection !== undefined && projection.length > 0) {
        out[rel] = data.map((d) => {
          const related = index.get(`${d.type}:${String(d.id)}`);
          return projectAttrs(related, projection);
        });
      }
      continue;
    }
    out[`${rel}Id`] = coerceId(data.id);
    const projection = flatten[rel];
    if (projection !== undefined && projection.length > 0) {
      const related = index.get(`${data.type}:${String(data.id)}`);
      const projected = projectAttrs(related, projection);
      for (const [attrName, attrValue] of Object.entries(projected)) {
        out[`${rel}${capitalize(attrName)}`] = attrValue;
      }
    }
  }
  return out;
}

export interface NormalizedDocument {
  readonly data: Record<string, unknown> | Record<string, unknown>[] | undefined;
  readonly meta: JsonApiMeta | undefined;
  readonly links: JsonApiLinks | undefined;
}

/** Normalize the top-level document, leaving meta and links unchanged. */
export function normalizeDocument(
  doc: JsonApiDocument,
  flatten: FlattenMap = {},
): NormalizedDocument {
  const index = indexIncluded(doc.included);
  let data: Record<string, unknown> | Record<string, unknown>[] | undefined;
  const docData = doc.data;
  if (isResourceArray(docData)) {
    data = docData.map((r) => normalizeResource(r, index, flatten));
  } else if (docData !== undefined) {
    data = normalizeResource(docData, index, flatten);
  }
  return { data, meta: doc.meta, links: doc.links };
}

function isIdentifierArray(
  value: JsonApiResourceIdentifier | readonly JsonApiResourceIdentifier[],
): value is readonly JsonApiResourceIdentifier[] {
  return Array.isArray(value);
}

function isResourceArray(
  value: JsonApiResource | readonly JsonApiResource[] | undefined,
): value is readonly JsonApiResource[] {
  return Array.isArray(value);
}

function projectAttrs(
  resource: JsonApiResource | undefined,
  projection: readonly string[],
): Record<string, unknown> {
  if (resource === undefined) return {};
  const attrs = resource.attributes ?? {};
  if (projection.length === 1 && projection[0] === "*") return { ...attrs };
  const out: Record<string, unknown> = {};
  for (const attr of projection) {
    if (attr in attrs) out[attr] = attrs[attr];
  }
  return out;
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function coerceId(id: number | string): number | string {
  if (typeof id === "number") return id;
  // Outreach IDs are integers wire-side. Preserve string form only if the value
  // is not a valid integer (defensive — should not happen against live Outreach).
  if (!/^[-+]?\d+$/.test(id)) return id;
  const n = Number(id);
  return Number.isFinite(n) ? n : id;
}

/** Extract the `page[after]` cursor from `links.next`. Returns null if absent. */
export function extractNextCursor(links: JsonApiLinks | undefined): string | null {
  const next = links?.next;
  if (next === undefined || next === "") return null;
  try {
    const url = new URL(next);
    return url.searchParams.get("page[after]");
  } catch {
    return null;
  }
}
