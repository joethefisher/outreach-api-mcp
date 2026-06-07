// Tier-2 escape hatch — generic by-ID lookup for any read-only resource.

import { invalidResource, validationError } from "../errors/envelopes.js";

import { profileUrl, runTool } from "./_helpers.js";
import {
  ESSENTIAL_FIELDS,
  isAllowedResource,
  READ_ONLY_RESOURCES,
  type AllowedResource,
} from "./allowlist.js";

export interface OutreachGetByIdInput {
  readonly resource: string;
  readonly id: number;
  readonly includes?: readonly string[] | null;
  /** JSON-stringified Record<string, string[]> for sparse fieldsets. */
  readonly fields?: string | null;
}

export async function outreachGetById(input: OutreachGetByIdInput): Promise<string> {
  return runTool("outreachGetById", input, async ({ client, schema }) => {
    if (!isAllowedResource(input.resource)) {
      return invalidResource(input.resource, [...READ_ONLY_RESOURCES]);
    }
    const resource: AllowedResource = input.resource;

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

    const record = await client.get(resource, input.id, {
      ...(input.includes !== null && input.includes !== undefined && { includes: input.includes }),
      ...(fields !== undefined && { fields }),
    });
    const labelled = schema.applyLabelsTo(resource, record);
    (labelled as Record<string, unknown>)["profileUrl"] = profileUrl(resource, input.id);
    return labelled;
  });
}
