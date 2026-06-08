// searchProspects — find prospects by name, email, company, owner, stage,
// active sequence, or recent activity.

import type { OutreachClient } from "../api/client.js";
import { range, relId, type FilterMap } from "../api/filters.js";
import { ambiguousMatch, noResults } from "../errors/envelopes.js";

import { clamp, nameFromParts, profileUrl, runTool } from "./_helpers.js";
import { resolveAccountByName, resolveStageByName, resolveUserByName } from "./_resolvers.js";

export interface SearchProspectsInput {
  readonly query?: string | null;
  readonly companyName?: string | null;
  readonly accountId?: number | null;
  readonly ownerName?: string | null;
  readonly ownerId?: number | null;
  readonly stage?: string | null;
  readonly hasActiveSequence?: boolean | null;
  readonly updatedSince?: string | null;
  readonly limit?: number | null;
}

const ACTIVE_SEQ_STATES = ["active", "paused", "pending"];

const PROSPECT_FIELDS = {
  prospect: [
    "firstName",
    "lastName",
    "title",
    "emails",
    "engagedScore",
    "engagedAt",
    "openCount",
    "clickCount",
    "replyCount",
    "stageName",
    "updatedAt",
    "custom1",
    "custom2",
    "custom3",
    "custom4",
    "custom5",
  ],
  account: ["name", "domain"],
  user: ["firstName", "lastName"],
};

const PROSPECT_FLATTEN = {
  account: ["name", "domain"],
  owner: ["firstName", "lastName"],
};

export async function searchProspects(input: SearchProspectsInput): Promise<string> {
  return runTool("searchProspects", input, async ({ client, schema }) => {
    const limit = clamp(input.limit ?? 25, 1, 100);

    let accountIds: readonly number[] | undefined;
    if (input.accountId !== null && input.accountId !== undefined) accountIds = [input.accountId];
    else if (
      input.companyName !== null &&
      input.companyName !== undefined &&
      input.companyName !== ""
    ) {
      const matches = await resolveAccountByName(client, input.companyName);
      if (matches.length === 0) {
        return noResults({ companyName: input.companyName }, [
          "widen the company name",
          "try the domain",
        ]);
      }
      if (matches.length > 5) return ambiguousMatch(matches.slice(0, 10), "company");
      accountIds = matches.map((m) => m.id);
    }

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

    let stageIds: readonly number[] | undefined;
    if (input.stage !== null && input.stage !== undefined && input.stage !== "") {
      const matches = await resolveStageByName(client, input.stage);
      if (matches.length === 0) {
        return noResults({ stage: input.stage }, ["check the stage name"]);
      }
      stageIds = matches.map((m) => m.id);
    }

    const filters: Record<string, unknown> = {};
    if (accountIds !== undefined) filters["account"] = relId([...accountIds]);
    if (ownerIds !== undefined) filters["owner"] = relId([...ownerIds]);
    if (stageIds !== undefined) filters["stage"] = relId([...stageIds]);
    if (
      input.updatedSince !== null &&
      input.updatedSince !== undefined &&
      input.updatedSince !== ""
    ) {
      filters["updatedAt"] = range(input.updatedSince, new Date().toISOString());
    }

    let candidatePages: { data: readonly Record<string, unknown>[]; nextCursor: string | null };
    let userTokens: readonly string[] = [];
    // COR-05: client-side fallback paths sets nextCursor=null, so the
    // server-side `nextCursor !== null` truncated signal is structurally
    // unreachable on that branch. Track fallback truncation separately.
    let fallbackTruncated = false;

    if (input.query !== null && input.query !== undefined && input.query !== "") {
      const q = input.query.trim();
      const passes: Record<string, string>[] = [];
      if (q.includes("@")) {
        passes.push({ emails: q });
      } else {
        userTokens = q.includes(" ") ? q.split(/\s+/).filter((t) => t !== "") : [q];
        const projects = ["firstName", "lastName", "title"];
        const tokenVariants = userTokens.map((t) => {
          const stripped = stripAccents(t);
          return stripped !== t ? [t, stripped] : [t];
        });
        for (const variants of tokenVariants) {
          for (const v of variants) {
            for (const field of projects) passes.push({ [field]: v });
          }
        }
        if (userTokens.length === 2) {
          const variantsA = tokenVariants[0];
          const variantsB = tokenVariants[1];
          if (variantsA !== undefined && variantsB !== undefined) {
            for (const a of variantsA) {
              for (const b of variantsB) {
                passes.push({ firstName: a, lastName: b });
                passes.push({ firstName: b, lastName: a });
              }
            }
          }
        }
      }
      const noNarrowingFilters =
        accountIds === undefined &&
        ownerIds === undefined &&
        stageIds === undefined &&
        (input.updatedSince === null ||
          input.updatedSince === undefined ||
          input.updatedSince === "");
      const passPageSize = userTokens.length === 1 && noNarrowingFilters ? 100 : limit;
      const queries = await Promise.all(
        passes.map((passFilters) =>
          client.list("prospect", {
            filters: { ...filters, ...passFilters } as FilterMap,
            includes: ["account", "owner"],
            fields: PROSPECT_FIELDS,
            flatten: PROSPECT_FLATTEN,
            pageSize: passPageSize,
          }),
        ),
      );
      const merged = new Map<number, { row: Record<string, unknown>; tokenHits: number }>();
      for (const page of queries) {
        for (const p of page.data) {
          const pid = p["id"] as number;
          if (merged.has(pid)) continue;
          const hits =
            userTokens.length > 0 ? userTokens.filter((t) => prospectMatchesToken(p, t)).length : 1;
          merged.set(pid, { row: p, tokenHits: hits });
        }
      }
      const ranked = Array.from(merged.values())
        .sort((a, b) => b.tokenHits - a.tokenHits)
        .map((e) => e.row);
      // COR-05: record fallback truncation BEFORE slicing. nextCursor is
      // null on this path by construction, so the original
      // `nextCursor !== null` truncated check would never fire.
      fallbackTruncated = ranked.length > limit;
      candidatePages = { data: ranked.slice(0, limit), nextCursor: null };
    } else {
      candidatePages = await client.list("prospect", {
        filters: filters as FilterMap,
        includes: ["account", "owner"],
        fields: PROSPECT_FIELDS,
        flatten: PROSPECT_FLATTEN,
        pageSize: limit,
      });
    }

    if (candidatePages.data.length === 0) {
      return noResults({ filters: input }, [
        "widen the date range",
        "drop a filter",
        "try a different spelling",
      ]);
    }

    const prospectIds = candidatePages.data
      .map((p) => p["id"])
      .filter((pid): pid is number => typeof pid === "number");
    const activeSeqCounts = await activeSequenceCounts(client, prospectIds);

    let prospects = candidatePages.data.map((p) => {
      const labelled = schema.applyLabelsTo("prospect", p);
      const id = p["id"] as number;
      return {
        id,
        firstName: p["firstName"],
        lastName: p["lastName"],
        title: p["title"],
        emails: p["emails"],
        accountId: p["accountId"],
        accountName: p["accountName"],
        accountDomain: p["accountDomain"],
        stageId: undefined,
        stageName: p["stageName"],
        ownerId: p["ownerId"],
        ownerName: nameFromParts(p["ownerFirstName"], p["ownerLastName"]),
        activeSequenceCount: activeSeqCounts.get(id) ?? 0,
        updatedAt: p["updatedAt"],
        profileUrl: profileUrl("prospect", id),
        ...(labelled.customFields !== undefined && { customFields: labelled.customFields }),
      };
    });

    if (input.hasActiveSequence === true) {
      prospects = prospects.filter((p) => p.activeSequenceCount > 0);
    } else if (input.hasActiveSequence === false) {
      prospects = prospects.filter((p) => p.activeSequenceCount === 0);
    }

    return {
      prospects,
      totalReturned: prospects.length,
      truncated:
        fallbackTruncated || (prospects.length >= limit && candidatePages.nextCursor !== null),
      nextCursor: candidatePages.nextCursor,
    };
  });
}

async function activeSequenceCounts(
  client: OutreachClient,
  prospectIds: readonly number[],
): Promise<Map<number, number>> {
  if (prospectIds.length === 0) return new Map();
  const states = await client.list<{ prospectId: number; state: string }>("sequenceState", {
    filters: { prospect: relId([...prospectIds]), state: ACTIVE_SEQ_STATES },
    fields: { sequenceState: ["state"] },
    pageSize: 1000,
  });
  const counts = new Map<number, number>();
  for (const s of states.data) {
    counts.set(s.prospectId, (counts.get(s.prospectId) ?? 0) + 1);
  }
  return counts;
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

function prospectMatchesToken(prospect: Record<string, unknown>, token: string): boolean {
  const needle = stripAccents(token).toLowerCase();
  if (needle === "") return false;
  const fields = ["firstName", "lastName", "title"] as const;
  for (const field of fields) {
    const v = prospect[field];
    if (typeof v !== "string" || v === "") continue;
    if (stripAccents(v).toLowerCase().includes(needle)) return true;
  }
  return false;
}
