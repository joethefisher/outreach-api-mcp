// getAccountProfile — full account view with prospects, opportunities, recent activity.

import { daysAgoISO, profileUrl, runTool } from "./_helpers.js";
import type { OutreachClient } from "../api/client.js";
import { range, relId, type FilterMap } from "../api/filters.js";

export interface GetAccountProfileInput {
  readonly accountId: number;
  readonly includeProspects?: boolean | null;
  readonly includeOpportunities?: boolean | null;
  readonly includeRecentActivity?: boolean | null;
}

export async function getAccountProfile(input: GetAccountProfileInput): Promise<string> {
  return runTool("getAccountProfile", input, async ({ client, schema }) => {
    const id = input.accountId;
    const includeProspects = input.includeProspects !== false;
    const includeOpportunities = input.includeOpportunities !== false;
    const includeRecentActivity = input.includeRecentActivity !== false;
    const since = daysAgoISO(30);

    const account = await client.get("account", id, {
      includes: ["owner"],
      fields: {
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
          "description",
          "updatedAt",
          "custom1",
          "custom2",
          "custom3",
          "custom4",
        ],
        user: ["firstName", "lastName", "email"],
      },
      flatten: { owner: ["firstName", "lastName", "email"] },
    });

    const labelled = schema.applyLabelsTo("account", { ...account });

    // Phase 1: prospects + opportunities scoped to this account.
    //
    // The activity counts in phase 2 need this account's prospect IDs to
    // scope correctly (COR-02); none of mailing/task/call/sequenceState has
    // a direct account relationship — they all go via prospect. Even when
    // includeProspects=false we still fetch the IDs so the counts are scoped.
    const [prospects, opportunities, prospectsForScope] = await Promise.all([
      includeProspects
        ? client.list("prospect", {
            filters: { account: relId(id) },
            fields: {
              prospect: [
                "firstName",
                "lastName",
                "title",
                "engagedScore",
                "engagedAt",
                "stageName",
              ],
            },
            pageSize: 50,
            sort: "-engagedScore",
          })
        : Promise.resolve({ data: [] as readonly Record<string, unknown>[], nextCursor: null }),
      includeOpportunities
        ? client.list("opportunity", {
            filters: { account: relId(id) },
            fields: {
              opportunity: [
                "name",
                "amount",
                "closeDate",
                "state",
                "forecastCategory",
                "probability",
              ],
            },
            pageSize: 50,
          })
        : Promise.resolve({ data: [] as readonly Record<string, unknown>[], nextCursor: null }),
      // ID-only scope fetch. Skipped when we already have full prospects, or
      // when activity counts are off.
      !includeProspects && includeRecentActivity
        ? client.list<{ id: number }>("prospect", {
            filters: { account: relId(id) },
            fields: { prospect: [] },
            pageSize: 500,
          })
        : Promise.resolve({ data: [] as readonly { id: number }[], nextCursor: null }),
    ]);

    const prospectIds = (includeProspects ? prospects.data : prospectsForScope.data)
      .map((p) => p.id)
      .filter((pid): pid is number => typeof pid === "number");

    // Phase 2: activity counts, scoped via prospect → account.
    const sinceRange = range(`${since}T00:00:00Z`, new Date().toISOString());
    const noProspects = prospectIds.length === 0;
    const [mailingsCount, callsCount, tasksCount, sequenceStatesCount] = await Promise.all([
      includeRecentActivity && !noProspects
        ? safeCountRecent(client, "mailing", {
            prospect: relId(prospectIds),
            createdAt: sinceRange,
          })
        : Promise.resolve({
            count: noProspects && includeRecentActivity ? 0 : 0,
            truncated: false,
          }),
      includeRecentActivity && !noProspects
        ? // Outreach v2 doesn't accept date filters on `call`; scope by
          // prospect only — the value is lifetime calls for this account's
          // current prospects, surfaced via `callsLoggedNote` below.
          safeCountRecent(client, "call", { prospect: relId(prospectIds) })
        : Promise.resolve({ count: 0, truncated: false }),
      includeRecentActivity && !noProspects
        ? safeCountRecent(client, "task", {
            prospect: relId(prospectIds),
            createdAt: sinceRange,
          })
        : Promise.resolve({ count: 0, truncated: false }),
      includeRecentActivity && !noProspects
        ? safeCountRecent(client, "sequenceState", {
            prospect: relId(prospectIds),
            createdAt: sinceRange,
          })
        : Promise.resolve({ count: 0, truncated: false }),
    ]);

    const activeCounts = new Map<number, number>();
    if (prospectIds.length > 0) {
      const activeStates = await client.list<{ prospectId: number }>("sequenceState", {
        filters: { prospect: relId(prospectIds), state: ["active", "paused", "pending"] },
        fields: { sequenceState: ["state"] },
        pageSize: 500,
      });
      for (const s of activeStates.data) {
        activeCounts.set(s.prospectId, (activeCounts.get(s.prospectId) ?? 0) + 1);
      }
    }

    return {
      account: {
        id: account["id"],
        name: account["name"],
        naturalName: account["naturalName"],
        domain: account["domain"],
        industry: account["industry"],
        numberOfEmployees: account["numberOfEmployees"],
        locality: account["locality"],
        namedAccount: account["named"],
        buyerIntentScore: account["buyerIntentScore"],
        tags: account["tags"] ?? [],
        description: account["description"],
        ...(labelled.customFields !== undefined && { customFields: labelled.customFields }),
        profileUrl: profileUrl("account", id),
        updatedAt: account["updatedAt"],
      },
      owner:
        account["ownerId"] !== undefined
          ? {
              id: account["ownerId"],
              name: nameFromParts(account["ownerFirstName"], account["ownerLastName"]),
              email: account["ownerEmail"],
            }
          : null,
      prospects: prospects.data.map((p) => ({
        id: p["id"],
        firstName: p["firstName"],
        lastName: p["lastName"],
        title: p["title"],
        stageName: p["stageName"],
        activeSequenceCount: activeCounts.get(p["id"] as number) ?? 0,
        engagedScore: p["engagedScore"],
        profileUrl: profileUrl("prospect", p["id"] as number),
      })),
      opportunities: opportunities.data.map((o) => ({
        id: o["id"],
        name: o["name"],
        forecastCategory: o["forecastCategory"],
        amount: o["amount"],
        closeDate: o["closeDate"],
        state: o["state"],
        probability: o["probability"],
        profileUrl: profileUrl("opportunity", o["id"] as number),
      })),
      recentActivity: {
        mailingsSent: mailingsCount.count >= 0 ? mailingsCount.count : null,
        callsLogged: callsCount.count >= 0 ? callsCount.count : null,
        tasksCreated: tasksCount.count >= 0 ? tasksCount.count : null,
        sequencesStarted: sequenceStatesCount.count >= 0 ? sequenceStatesCount.count : null,
        callsLoggedNote:
          "Scoped to this account's current prospects. Outreach v2 does not accept date filters on `call`, so this is a lifetime count for those prospects, not a 30-day count.",
        unavailableNote: [mailingsCount, callsCount, tasksCount, sequenceStatesCount].some(
          (c) => c.count === -1,
        )
          ? "Some counts unavailable — Outreach API rejected the filter at this scope. Narrow the window or check the rep's permissions and retry."
          : undefined,
      },
    };
  });
}

async function safeCountRecent(
  client: OutreachClient,
  resource: string,
  filters: Record<string, unknown>,
): Promise<{ count: number; truncated: boolean }> {
  try {
    return await client.count(resource, filters as FilterMap);
  } catch {
    return { count: -1, truncated: true };
  }
}

function nameFromParts(first: unknown, last: unknown): string | undefined {
  if (typeof first !== "string" && typeof last !== "string") return undefined;
  const combined =
    `${typeof first === "string" ? first : ""} ${typeof last === "string" ? last : ""}`.trim();
  return combined === "" ? undefined : combined;
}
