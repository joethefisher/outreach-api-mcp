// getOpenTasks — incomplete tasks, optionally filtered.

import { range, relId, type FilterMap } from "../api/filters.js";
import { ambiguousMatch, noResults } from "../errors/envelopes.js";

import { profileUrl, runTool } from "./_helpers.js";
import { resolveUserByName } from "./_resolvers.js";

export interface GetOpenTasksInput {
  readonly ownerId?: number | null;
  readonly ownerName?: string | null;
  readonly prospectId?: number | null;
  readonly action?: string | null;
  readonly dueBefore?: string | null;
  readonly limit?: number | null;
}

export async function getOpenTasks(input: GetOpenTasksInput): Promise<string> {
  return runTool("getOpenTasks", input, async ({ client }) => {
    const limit = clamp(input.limit ?? 50, 1, 200);

    let ownerIds: readonly number[] | undefined;
    if (input.ownerId !== null && input.ownerId !== undefined) ownerIds = [input.ownerId];
    else if (input.ownerName !== null && input.ownerName !== undefined && input.ownerName !== "") {
      const matches = await resolveUserByName(client, input.ownerName);
      if (matches.length === 0)
        return noResults({ ownerName: input.ownerName }, ["check spelling"]);
      if (matches.length > 5) return ambiguousMatch(matches.slice(0, 10), "owner");
      ownerIds = matches.map((m) => m.id);
    }

    const filters: Record<string, unknown> = { state: "incomplete" };
    if (ownerIds !== undefined) filters["owner"] = relId([...ownerIds]);
    if (input.prospectId !== null && input.prospectId !== undefined) {
      filters["prospect"] = relId(input.prospectId);
    }
    if (input.action !== null && input.action !== undefined && input.action !== "") {
      filters["action"] = input.action;
    }
    if (input.dueBefore !== null && input.dueBefore !== undefined && input.dueBefore !== "") {
      filters["dueAt"] = range("0001-01-01T00:00:00Z", `${input.dueBefore}T23:59:59Z`);
    }

    const [tasks, totalCount] = await Promise.all([
      client.list("task", {
        filters: filters as FilterMap,
        includes: ["prospect.account", "owner", "template"],
        fields: {
          task: ["action", "state", "note", "dueAt", "createdAt"],
          prospect: ["firstName", "lastName"],
          account: ["name"],
          user: ["firstName", "lastName"],
          template: ["name"],
        },
        flatten: {
          prospect: ["firstName", "lastName"],
          owner: ["firstName", "lastName"],
          template: ["name"],
        },
        pageSize: limit,
        sort: "dueAt",
      }),
      client.count("task", filters as FilterMap),
    ]);

    return {
      tasks: tasks.data.map((t) => {
        const prospectId = t["prospectId"];
        return {
          id: t["id"],
          action: t["action"],
          state: t["state"],
          note: t["note"],
          dueAt: t["dueAt"],
          prospectId,
          prospectName: nameFromParts(t["prospectFirstName"], t["prospectLastName"]),
          accountName: undefined,
          ownerName: nameFromParts(t["ownerFirstName"], t["ownerLastName"]),
          templateName: t["templateName"],
          createdAt: t["createdAt"],
          profileUrl:
            typeof prospectId === "number" ? profileUrl("prospect", prospectId) : undefined,
        };
      }),
      totalCount: totalCount.count,
      truncated: tasks.nextCursor !== null,
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
