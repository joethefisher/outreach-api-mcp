// searchSequences — by name, owner, enabled, share type, or recent updates.

import { profileUrl, runTool } from "./_helpers.js";
import { resolveUserByName } from "./_resolvers.js";
import { range, relId, type FilterMap } from "../api/filters.js";
import { ambiguousMatch, noResults } from "../errors/envelopes.js";

export interface SearchSequencesInput {
  readonly query?: string | null;
  readonly ownerId?: number | null;
  readonly ownerName?: string | null;
  readonly enabled?: boolean | null;
  readonly shareType?: string | null;
  readonly updatedSince?: string | null;
  readonly limit?: number | null;
}

const ACTIVE_STATES = ["active", "paused", "pending"];

export async function searchSequences(input: SearchSequencesInput): Promise<string> {
  return runTool("searchSequences", input, async ({ client }) => {
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
    if (isNonEmpty(input.query)) filters["name"] = input.query;
    if (ownerIds !== undefined) filters["owner"] = relId([...ownerIds]);
    if (isNonEmpty(input.shareType)) filters["shareType"] = input.shareType;
    if (isNonEmpty(input.updatedSince)) {
      filters["updatedAt"] = range(input.updatedSince, new Date().toISOString());
    }

    // Client-side enabled filter — Outreach doesn't accept filter[enabled].
    const fetchSize =
      input.enabled !== undefined && input.enabled !== null ? Math.min(limit * 4, 100) : limit;

    const sequenceFields = [
      "name",
      "description",
      "enabled",
      "shareType",
      "sequenceType",
      "sequenceStepCount",
      "createdAt",
      "updatedAt",
    ];

    const result = await client.list("sequence", {
      filters: filters as FilterMap,
      includes: ["owner"],
      fields: { sequence: sequenceFields, user: ["firstName", "lastName"] },
      flatten: { owner: ["firstName", "lastName"] },
      pageSize: fetchSize,
      sort: "-updatedAt",
    });

    let rows = [...result.data];
    if (input.enabled !== undefined && input.enabled !== null) {
      rows = rows.filter((s) => s["enabled"] === input.enabled);
    }

    if (rows.length === 0 && isNonEmpty(input.query)) {
      const q = input.query.toLowerCase();
      const wide = await client.list("sequence", {
        filters: ownerIds !== undefined ? { owner: relId([...ownerIds]) } : {},
        includes: ["owner"],
        fields: { sequence: sequenceFields, user: ["firstName", "lastName"] },
        flatten: { owner: ["firstName", "lastName"] },
        pageSize: 200,
        sort: "-updatedAt",
      });
      let filtered = wide.data.filter((s) => {
        const name = ((s["name"] as string | undefined) ?? "").toLowerCase();
        const desc = ((s["description"] as string | undefined) ?? "").toLowerCase();
        return name.includes(q) || desc.includes(q);
      });
      if (input.enabled !== undefined && input.enabled !== null) {
        filtered = filtered.filter((s) => s["enabled"] === input.enabled);
      }
      rows = filtered;
    }

    rows = rows.slice(0, limit);

    if (rows.length === 0) {
      return noResults({ filters: input }, ["widen the date range", "check spelling"]);
    }

    const seqIds = rows.map((s) => s["id"]).filter((id): id is number => typeof id === "number");
    const counts = new Map<number, number>();
    if (seqIds.length > 0) {
      const states = await client.list<{ sequenceId: number }>("sequenceState", {
        filters: { sequence: relId(seqIds), state: ACTIVE_STATES },
        fields: { sequenceState: ["state"] },
        pageSize: 1000,
      });
      for (const s of states.data) {
        counts.set(s.sequenceId, (counts.get(s.sequenceId) ?? 0) + 1);
      }
    }

    return {
      sequences: rows.map((s) => ({
        id: s["id"],
        name: s["name"],
        description: s["description"],
        enabled: s["enabled"],
        shareType: s["shareType"],
        sequenceType: s["sequenceType"],
        sequenceStepCount: s["sequenceStepCount"],
        activeProspectCount: counts.get(s["id"] as number) ?? 0,
        ownerId: s["ownerId"],
        ownerName: nameFromParts(s["ownerFirstName"], s["ownerLastName"]),
        createdAt: s["createdAt"],
        updatedAt: s["updatedAt"],
        profileUrl: profileUrl("sequence", s["id"] as number),
      })),
      truncated: result.nextCursor !== null,
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
