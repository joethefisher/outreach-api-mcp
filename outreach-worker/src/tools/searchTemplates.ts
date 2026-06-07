// searchTemplates — by name, owner, or content keyword.

import { relId, type FilterMap } from "../api/filters.js";
import { ambiguousMatch, noResults } from "../errors/envelopes.js";

import { profileUrl, runTool } from "./_helpers.js";
import { resolveUserByName } from "./_resolvers.js";

export interface SearchTemplatesInput {
  readonly query?: string | null;
  readonly bodyContains?: string | null;
  readonly ownerId?: number | null;
  readonly ownerName?: string | null;
  readonly limit?: number | null;
}

export async function searchTemplates(input: SearchTemplatesInput): Promise<string> {
  return runTool("searchTemplates", input, async ({ client }) => {
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

    const fieldset = {
      template: ["name", "subject", "bodyText", "bodyHtml", "archived", "updatedAt"],
      user: ["firstName", "lastName"],
    };

    let result = await client.list("template", {
      filters: filters as FilterMap,
      includes: ["owner"],
      fields: fieldset,
      flatten: { owner: ["firstName", "lastName"] },
      pageSize: isNonEmpty(input.bodyContains) ? 200 : limit,
    });

    // COR-05: when the wide-fallback path or bodyContains client-side
    // filter drops matches, the server-side `nextCursor !== null`
    // signal can't capture that — track explicitly.
    let fallbackTruncated = false;

    if (result.data.length === 0 && isNonEmpty(input.query)) {
      const q = input.query.toLowerCase();
      const wide = await client.list("template", {
        filters: ownerIds !== undefined ? { owner: relId([...ownerIds]) } : {},
        includes: ["owner"],
        fields: fieldset,
        flatten: { owner: ["firstName", "lastName"] },
        pageSize: 200,
        sort: "-updatedAt",
      });
      const filtered = wide.data.filter((t) => {
        const name = ((t["name"] as string | undefined) ?? "").toLowerCase();
        const subject = ((t["subject"] as string | undefined) ?? "").toLowerCase();
        return name.includes(q) || subject.includes(q);
      });
      fallbackTruncated = filtered.length > limit;
      result = { data: filtered, nextCursor: null };
    }

    let rows = [...result.data];
    if (isNonEmpty(input.bodyContains)) {
      const needle = input.bodyContains.toLowerCase();
      rows = rows.filter((t) => {
        const combined = `${(t["bodyText"] as string | undefined) ?? ""} ${(t["bodyHtml"] as string | undefined) ?? ""}`;
        return stripHtml(combined).toLowerCase().includes(needle);
      });
    }
    if (rows.length > limit) fallbackTruncated = true;
    rows = rows.slice(0, limit);

    if (rows.length === 0) {
      return noResults({ filters: input }, [
        "drop bodyContains and search by name",
        "try a different keyword",
      ]);
    }

    // Sequence-usage counts — requires sequenceTemplates.read; degrade silently.
    const tplIds = rows.map((t) => t["id"]).filter((id): id is number => typeof id === "number");
    const usageCounts = new Map<number, number>();
    if (tplIds.length > 0) {
      try {
        const sequenceTemplates = await client.list<{ templateId: number }>("sequenceTemplate", {
          filters: { template: relId(tplIds) },
          fields: { sequenceTemplate: [] },
          pageSize: 1000,
        });
        for (const st of sequenceTemplates.data) {
          usageCounts.set(st.templateId, (usageCounts.get(st.templateId) ?? 0) + 1);
        }
      } catch {
        // sequenceTemplates.read scope missing or transient; leave counts empty.
      }
    }

    return {
      templates: rows.map((t) => ({
        id: t["id"],
        name: t["name"],
        subject: t["subject"],
        bodyPreview: stripHtml(
          (t["bodyText"] as string | undefined) ?? (t["bodyHtml"] as string | undefined) ?? "",
        ).slice(0, 200),
        archived: t["archived"],
        ownerId: t["ownerId"],
        ownerName: nameFromParts(t["ownerFirstName"], t["ownerLastName"]),
        sequenceCount: usageCounts.get(t["id"] as number) ?? 0,
        profileUrl: profileUrl("template", t["id"] as number),
        updatedAt: t["updatedAt"],
      })),
      truncated: fallbackTruncated || result.nextCursor !== null,
    };
  });
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
