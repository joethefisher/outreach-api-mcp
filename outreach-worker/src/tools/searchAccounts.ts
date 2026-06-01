// searchAccounts — by name, domain, owner, industry, named flag, intent score, or recent updates.

import { profileUrl, runTool } from "./_helpers.js";
import { resolveUserByName } from "./_resolvers.js";
import { range, relId, type FilterMap } from "../api/filters.js";
import { ambiguousMatch, noResults } from "../errors/envelopes.js";

export interface SearchAccountsInput {
  readonly query?: string | null;
  readonly domain?: string | null;
  readonly ownerId?: number | null;
  readonly ownerName?: string | null;
  readonly industry?: string | null;
  readonly named?: boolean | null;
  readonly buyerIntentScoreMin?: number | null;
  readonly updatedSince?: string | null;
  readonly limit?: number | null;
}

export async function searchAccounts(input: SearchAccountsInput): Promise<string> {
  return runTool("searchAccounts", input, async ({ client, schema }) => {
    const limit = clamp(input.limit ?? 25, 1, 100);

    let ownerIds: readonly number[] | undefined;
    if (input.ownerId !== null && input.ownerId !== undefined) ownerIds = [input.ownerId];
    else if (input.ownerName !== null && input.ownerName !== undefined && input.ownerName !== "") {
      const matches = await resolveUserByName(client, input.ownerName);
      if (matches.length === 0) {
        return noResults({ ownerName: input.ownerName }, ["check spelling", "use the rep's email"]);
      }
      if (matches.length > 5) return ambiguousMatch(matches.slice(0, 10), "owner");
      ownerIds = matches.map((m) => m.id);
    }

    const filters: Record<string, unknown> = {};
    if (isNonEmpty(input.query)) filters["name"] = input.query;
    if (isNonEmpty(input.domain)) filters["domain"] = input.domain;
    if (ownerIds !== undefined) filters["owner"] = relId([...ownerIds]);
    if (isNonEmpty(input.industry)) filters["industry"] = input.industry;
    if (input.named !== undefined && input.named !== null) filters["named"] = input.named;
    if (input.buyerIntentScoreMin !== undefined && input.buyerIntentScoreMin !== null) {
      filters["buyerIntentScore"] = range(input.buyerIntentScoreMin, Number.MAX_SAFE_INTEGER);
    }
    if (isNonEmpty(input.updatedSince)) {
      filters["updatedAt"] = range(input.updatedSince, new Date().toISOString());
    }

    const fieldset = {
      account: [
        "name",
        "naturalName",
        "domain",
        "industry",
        "numberOfEmployees",
        "locality",
        "named",
        "buyerIntentScore",
        "tags",
        "updatedAt",
        "custom1",
        "custom2",
        "custom3",
        "custom4",
      ],
      user: ["firstName", "lastName"],
    };

    let result = await client.list("account", {
      filters: filters as FilterMap,
      includes: ["owner"],
      fields: fieldset,
      flatten: { owner: ["firstName", "lastName"] },
      pageSize: limit,
    });

    if (result.data.length === 0 && isNonEmpty(input.query)) {
      const q = input.query.toLowerCase();
      const wideFilters: Record<string, unknown> = {};
      if (ownerIds !== undefined) wideFilters["owner"] = relId([...ownerIds]);
      if (isNonEmpty(input.domain)) wideFilters["domain"] = input.domain;
      if (isNonEmpty(input.industry)) wideFilters["industry"] = input.industry;
      if (input.named !== undefined && input.named !== null) wideFilters["named"] = input.named;

      const wide = await client.list("account", {
        filters: wideFilters as FilterMap,
        includes: ["owner"],
        fields: fieldset,
        flatten: { owner: ["firstName", "lastName"] },
        pageSize: 200,
        sort: "-updatedAt",
      });
      const filtered = wide.data.filter((a) => {
        const name = ((a["name"] as string | undefined) ?? "").toLowerCase();
        const nat = ((a["naturalName"] as string | undefined) ?? "").toLowerCase();
        const domain = ((a["domain"] as string | undefined) ?? "").toLowerCase();
        return name.includes(q) || nat.includes(q) || domain.includes(q);
      });
      result = { data: filtered.slice(0, limit), nextCursor: null };
    }

    if (result.data.length === 0) {
      return noResults({ filters: input }, [
        "try the domain instead of the name",
        "drop the named filter",
        "try a different industry name",
      ]);
    }

    const accounts = result.data.map((a) => {
      const labelled = schema.applyLabelsTo("account", { ...a });
      const ownerName = nameFromParts(a["ownerFirstName"], a["ownerLastName"]);
      return {
        id: a["id"],
        name: a["name"],
        naturalName: a["naturalName"],
        domain: a["domain"],
        industry: a["industry"],
        numberOfEmployees: a["numberOfEmployees"],
        locality: a["locality"],
        ownerId: a["ownerId"],
        ownerName,
        namedAccount: a["named"],
        buyerIntentScore: a["buyerIntentScore"],
        tags: a["tags"] ?? [],
        ...(labelled.customFields !== undefined && { customFields: labelled.customFields }),
        profileUrl: profileUrl("account", a["id"] as number),
        updatedAt: a["updatedAt"],
      };
    });

    return {
      accounts,
      truncated: result.nextCursor !== null,
      nextCursor: result.nextCursor,
    };
  });
}

function isNonEmpty(s: string | null | undefined): s is string {
  return s !== null && s !== undefined && s !== "";
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
