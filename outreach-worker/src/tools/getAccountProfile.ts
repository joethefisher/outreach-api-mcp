// getAccountProfile — full account view with prospects, opportunities, recent activity.

import type { ListResult, OutreachClient } from "../api/client.js";
import { range, relId, type FilterMap } from "../api/filters.js";

import { daysAgoISO, nameFromParts, optionalFetch, profileUrl, runTool } from "./_helpers.js";

export interface GetAccountProfileInput {
  readonly accountId: number;
  readonly includeProspects?: boolean | null;
  readonly includeOpportunities?: boolean | null;
  readonly includeRecentActivity?: boolean | null;
}

/**
 * Cap on the prospect-ID scope set used to filter activity counts. Sized
 * generously for the typical "named account" (a few hundred prospects at
 * most). When the cap is hit, `recentActivity.truncated` is set so the
 * agent can tell the user the counts are a lower bound, not a total.
 */
const MAX_SCOPE_PROSPECTS = 500;
const SCOPE_PAGE_SIZE = 200;

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

    // NEW-2: every optional section is wrapped via optionalFetch so a single
    // sub-fetch failure (scopeMissing on prospects, a timeout on
    // opportunities, a 5xx on the scope walk) does not collapse the whole
    // tool. The core account.get above stays hard.
    const unavailableSections: string[] = [];
    const emptyPage = {
      data: [] as readonly Record<string, unknown>[],
      nextCursor: null,
    };
    const emptyScope = { ids: [] as readonly number[], truncated: false };

    // NEW-1: scope source is ALWAYS the dedicated paginated ID-only fetch,
    // independent of `includeProspects`. This guarantees the same counts
    // regardless of whether the caller asked for the rich prospect list, and
    // gives us a real truncation signal when the cap is hit.
    //
    // The rich prospect list (top-50-by-engagement) is a separate concern,
    // fetched in parallel only when the caller asked for it.
    const [prospects, opportunities, scope] = await Promise.all([
      includeProspects
        ? optionalFetch(
            client.list("prospect", {
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
            }),
            "prospects",
            emptyPage,
            unavailableSections,
          )
        : Promise.resolve(emptyPage),
      includeOpportunities
        ? optionalFetch(
            client.list("opportunity", {
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
            }),
            "opportunities",
            emptyPage,
            unavailableSections,
          )
        : Promise.resolve(emptyPage),
      includeRecentActivity
        ? optionalFetch(
            fetchAccountProspectIds(client, id),
            "scope (prospect IDs)",
            emptyScope,
            unavailableSections,
          )
        : Promise.resolve(emptyScope),
    ]);

    const prospectIds = scope.ids;
    const scopeTruncated = scope.truncated;

    // Phase 2: activity counts, scoped via prospect → account.
    const sinceRange = range(`${since}T00:00:00Z`, new Date().toISOString());
    const noProspects = prospectIds.length === 0;
    const skipCounts = !includeRecentActivity || noProspects;
    const skipped = Promise.resolve({ count: 0, truncated: false });
    const [mailingsCount, callsCount, tasksCount, sequenceStatesCount] = await Promise.all([
      skipCounts
        ? skipped
        : safeCountRecent(client, "mailing", {
            prospect: relId([...prospectIds]),
            createdAt: sinceRange,
          }),
      skipCounts
        ? skipped
        : // Outreach v2 doesn't accept date filters on `call`; scope by
          // prospect only — the value is lifetime calls for this account's
          // current prospects, surfaced via `callsLoggedNote` below.
          safeCountRecent(client, "call", { prospect: relId([...prospectIds]) }),
      skipCounts
        ? skipped
        : safeCountRecent(client, "task", {
            prospect: relId([...prospectIds]),
            createdAt: sinceRange,
          }),
      skipCounts
        ? skipped
        : safeCountRecent(client, "sequenceState", {
            prospect: relId([...prospectIds]),
            createdAt: sinceRange,
          }),
    ]);

    const activeCounts = new Map<number, number>();
    if (prospectIds.length > 0) {
      const activeStates = await optionalFetch(
        client.list<{ prospectId: number }>("sequenceState", {
          filters: {
            prospect: relId([...prospectIds]),
            state: ["active", "paused", "pending"],
          },
          fields: { sequenceState: ["state"] },
          pageSize: 500,
        }),
        "activeSequenceCounts",
        { data: [] as readonly { prospectId: number }[], nextCursor: null },
        unavailableSections,
      );
      for (const s of activeStates.data) {
        activeCounts.set(s.prospectId, (activeCounts.get(s.prospectId) ?? 0) + 1);
      }
    }

    const someCountUnavailable = [mailingsCount, callsCount, tasksCount, sequenceStatesCount].some(
      (c) => c.count === -1,
    );

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
        scopeProspectCount: prospectIds.length,
        truncated: scopeTruncated,
        mailingsSent: mailingsCount.count >= 0 ? mailingsCount.count : null,
        callsLogged: callsCount.count >= 0 ? callsCount.count : null,
        tasksCreated: tasksCount.count >= 0 ? tasksCount.count : null,
        sequencesStarted: sequenceStatesCount.count >= 0 ? sequenceStatesCount.count : null,
        callsLoggedNote:
          "Scoped to this account's current prospects. Outreach v2 does not accept date filters on `call`, so this is a lifetime count for those prospects, not a 30-day count.",
        ...(scopeTruncated && {
          scopeTruncatedNote: `Activity counts cover the first ${String(prospectIds.length)} of this account's prospects (cap MAX_SCOPE_PROSPECTS=${String(MAX_SCOPE_PROSPECTS)}). Numbers are a lower bound; narrow by sub-segment for exact figures.`,
        }),
        ...(someCountUnavailable && {
          unavailableNote:
            "Some counts unavailable — Outreach API rejected the filter at this scope. Narrow the window or check the rep's permissions and retry.",
        }),
      },
      ...(unavailableSections.length > 0 && { unavailableSections }),
    };
  });
}

/**
 * Paginate `prospect` by account up to MAX_SCOPE_PROSPECTS IDs. Returns
 * `truncated: true` when the cap was hit AND the upstream still had a
 * nextCursor — the caller's counts will be a lower bound in that case.
 */
async function fetchAccountProspectIds(
  client: OutreachClient,
  accountId: number,
): Promise<{ readonly ids: readonly number[]; readonly truncated: boolean }> {
  const ids: number[] = [];
  let cursor: string | null = null;
  for (;;) {
    const remaining = MAX_SCOPE_PROSPECTS - ids.length;
    if (remaining <= 0) {
      // We already filled the cap on a previous iteration; the next-cursor
      // check below ran but we haven't actually fetched again. Defensive: if
      // we got here we have not seen a null cursor, so the upstream still
      // had more — signal truncated.
      return { ids, truncated: true };
    }
    const pageSize = Math.min(remaining, SCOPE_PAGE_SIZE);
    const page: ListResult<{ id: number }> = await client.list<{ id: number }>("prospect", {
      filters: { account: relId(accountId) },
      fields: { prospect: [] },
      pageSize,
      ...(cursor !== null && cursor !== "" && { cursor }),
    });
    for (const p of page.data) {
      if (typeof p.id === "number") ids.push(p.id);
    }
    if (page.nextCursor === null || page.nextCursor === "") {
      // Upstream exhausted; not truncated regardless of cap.
      return { ids, truncated: false };
    }
    if (ids.length >= MAX_SCOPE_PROSPECTS) {
      // Hit the cap with more pages still available upstream.
      return { ids, truncated: true };
    }
    cursor = page.nextCursor;
  }
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
