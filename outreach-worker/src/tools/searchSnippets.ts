// searchSnippets — by name or content keyword.

import { relId, type FilterMap } from "../api/filters.js";
import { ambiguousMatch, noResults } from "../errors/envelopes.js";

import { profileUrl, runTool } from "./_helpers.js";
import { resolveUserByName } from "./_resolvers.js";

export interface SearchSnippetsInput {
  readonly query?: string | null;
  readonly bodyContains?: string | null;
  readonly ownerId?: number | null;
  readonly ownerName?: string | null;
  readonly limit?: number | null;
}

export async function searchSnippets(input: SearchSnippetsInput): Promise<string> {
  return runTool("searchSnippets", input, async ({ client }) => {
    const limit = clamp(input.limit ?? 25, 1, 100);

    let ownerIds: readonly number[] | undefined;
    if (input.ownerId !== null && input.ownerId !== undefined) ownerIds = [input.ownerId];
    else if (input.ownerName !== null && input.ownerName !== undefined && input.ownerName !== "") {
      const matches = await resolveUserByName(client, input.ownerName);
      if (matches.length === 0)
        return noResults({ ownerName: input.ownerName }, ["check spelling"]);
      if (matches.length > 5) return ambiguousMatch(matches.slice(0, 10), "owner");
      ownerIds = matches.map((m) => m.id);
    }

    const filters: Record<string, unknown> = {};
    if (input.query !== null && input.query !== undefined && input.query !== "")
      filters["name"] = input.query;
    if (ownerIds !== undefined) filters["owner"] = relId([...ownerIds]);

    const fieldset = {
      snippet: ["name", "bodyHtml", "updatedAt"],
      user: ["firstName", "lastName"],
    };

    let result = await client.list("snippet", {
      filters: filters as FilterMap,
      includes: ["owner"],
      fields: fieldset,
      flatten: { owner: ["firstName", "lastName"] },
      pageSize:
        input.bodyContains !== null && input.bodyContains !== undefined && input.bodyContains !== ""
          ? 200
          : limit,
    });

    // COR-05: the wide-fallback + bodyContains client-side filter paths
    // rebuild the result with nextCursor=null, masking truncation. Track
    // explicitly so we can flag it to the agent.
    let fallbackTruncated = false;

    if (
      result.data.length === 0 &&
      input.query !== null &&
      input.query !== undefined &&
      input.query !== ""
    ) {
      const q = input.query.toLowerCase();
      const wide = await client.list("snippet", {
        filters: ownerIds !== undefined ? { owner: relId([...ownerIds]) } : {},
        includes: ["owner"],
        fields: fieldset,
        flatten: { owner: ["firstName", "lastName"] },
        pageSize: 200,
        sort: "-updatedAt",
      });
      const filtered = wide.data.filter((s) =>
        ((s["name"] as string | undefined) ?? "").toLowerCase().includes(q),
      );
      fallbackTruncated = filtered.length > limit;
      result = { data: filtered, nextCursor: null };
    }

    let rows = [...result.data];
    if (
      input.bodyContains !== null &&
      input.bodyContains !== undefined &&
      input.bodyContains !== ""
    ) {
      const needle = input.bodyContains.toLowerCase();
      rows = rows.filter((s) =>
        ((s["bodyHtml"] as string | undefined) ?? "")
          .replace(/<[^>]+>/g, " ")
          .toLowerCase()
          .includes(needle),
      );
    }
    if (rows.length > limit) fallbackTruncated = true;
    rows = rows.slice(0, limit);

    if (rows.length === 0) {
      return noResults({ filters: input }, ["search by name", "try a shorter keyword"]);
    }

    return {
      snippets: rows.map((s) => ({
        id: s["id"],
        name: s["name"],
        bodyPreview: ((s["bodyHtml"] as string | undefined) ?? "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200),
        ownerId: s["ownerId"],
        ownerName: nameFromParts(s["ownerFirstName"], s["ownerLastName"]),
        profileUrl: profileUrl("snippet", s["id"] as number),
        updatedAt: s["updatedAt"],
      })),
      truncated: fallbackTruncated || result.nextCursor !== null,
    };
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function nameFromParts(first: unknown, last: unknown): string | undefined {
  if (typeof first !== "string" && typeof last !== "string") return undefined;
  const combined =
    `${typeof first === "string" ? first : ""} ${typeof last === "string" ? last : ""}`.trim();
  return combined === "" ? undefined : combined;
}
