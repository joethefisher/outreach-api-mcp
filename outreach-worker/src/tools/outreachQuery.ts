// Tier-2 escape hatch — generic JSON:API query for any read-only resource.
//
// Validates against the resource allowlist, applies sensible defaults
// (essential fieldset, page size 50), and returns the normalized page plus
// the next cursor. The agent prompt advises calling capability tools first.

import { profileUrl, runTool } from "./_helpers.js";
import {
  ESSENTIAL_FIELDS,
  isAllowedResource,
  READ_ONLY_RESOURCES,
  type AllowedResource,
} from "./allowlist.js";
import type { FilterMap } from "../api/filters.js";
import { invalidResource, validationError } from "../errors/envelopes.js";

export interface OutreachQueryInput {
  readonly resource: string;
  readonly filters?: string | null;
  readonly includes?: readonly string[] | null;
  readonly fields?: string | null;
  readonly sort?: string | null;
  readonly pageSize?: number | null;
  readonly cursor?: string | null;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export async function outreachQuery(input: OutreachQueryInput): Promise<string> {
  return runTool("outreachQuery", input, async ({ client, schema }) => {
    if (!isAllowedResource(input.resource)) {
      return invalidResource(input.resource, [...READ_ONLY_RESOURCES]);
    }
    const resource: AllowedResource = input.resource;

    let filters: FilterMap | undefined;
    if (input.filters !== null && input.filters !== undefined && input.filters !== "") {
      try {
        filters = JSON.parse(input.filters) as FilterMap;
      } catch {
        return validationError("filters must be valid JSON.", "filters");
      }
    }

    let fields: Record<string, readonly string[]> | undefined;
    if (input.fields !== null && input.fields !== undefined && input.fields !== "") {
      try {
        fields = JSON.parse(input.fields) as Record<string, readonly string[]>;
      } catch {
        return validationError("fields must be valid JSON.", "fields");
      }
    }
    if (fields === undefined) {
      const essential = ESSENTIAL_FIELDS[resource];
      if (essential !== undefined && essential.length > 0) fields = { [resource]: essential };
    }

    const pageSize = clampPageSize(input.pageSize ?? DEFAULT_PAGE_SIZE);

    const result = await client.list(resource, {
      ...(filters !== undefined && { filters }),
      ...(input.includes !== null && input.includes !== undefined && { includes: input.includes }),
      ...(fields !== undefined && { fields }),
      ...(input.sort !== null &&
        input.sort !== undefined &&
        input.sort !== "" && {
          sort: input.sort,
        }),
      pageSize,
      ...(input.cursor !== null &&
        input.cursor !== undefined &&
        input.cursor !== "" && {
          cursor: input.cursor,
        }),
    });

    const data = result.data.map((row) => {
      const labelled = schema.applyLabelsTo(resource, row);
      const id = (row as { id?: number | string }).id;
      if (id !== undefined) {
        (labelled as Record<string, unknown>)["profileUrl"] = profileUrl(resource, id);
      }
      return labelled;
    });

    const warnings: string[] = [];
    if (input.sort?.includes(".") === true) {
      warnings.push(
        "Sort by relationship attribute is deprecated by Outreach. Consider sorting client-side.",
      );
    }

    return {
      resourceType: resource,
      results: data,
      nextCursor: result.nextCursor,
      truncated: result.nextCursor !== null,
      warnings,
    };
  });
}

function clampPageSize(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  if (n > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return Math.floor(n);
}
