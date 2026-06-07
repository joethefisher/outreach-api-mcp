// getUserActivity — per-user metrics over a date range.
//
// COR-03 (fixed): mailing counts are scoped via mailbox→user (when
// mailboxes.read is granted) so each rep's numbers are theirs. When that
// scope is missing, mailing counts return null and the response surfaces a
// clear note rather than silently reporting workspace-wide numbers.

import { range, relId, type FilterMap } from "../api/filters.js";
import { ambiguousMatch, noResults } from "../errors/envelopes.js";

import { daysAgoISO, nameFromParts, runTool, todayISO, validateDateRange } from "./_helpers.js";
import { resolveUserByName } from "./_resolvers.js";

export interface GetUserActivityInput {
  readonly userId?: number | null;
  readonly userName?: string | null;
  readonly dateRangeFrom?: string | null;
  readonly dateRangeTo?: string | null;
}

export async function getUserActivity(input: GetUserActivityInput): Promise<string> {
  return runTool("getUserActivity", input, async ({ client }) => {
    const dateValidation = validateDateRange(input.dateRangeFrom, input.dateRangeTo);
    if (!dateValidation.ok) return dateValidation.envelope;

    let userId: number | undefined = input.userId ?? undefined;
    if (
      userId === undefined &&
      input.userName !== null &&
      input.userName !== undefined &&
      input.userName !== ""
    ) {
      const matches = await resolveUserByName(client, input.userName);
      if (matches.length === 0) return noResults({ userName: input.userName }, ["check spelling"]);
      if (matches.length > 5) return ambiguousMatch(matches.slice(0, 10), "user");
      const first = matches[0];
      if (first === undefined) return noResults({ userName: input.userName }, ["check spelling"]);
      userId = first.id;
    }
    if (userId === undefined) {
      return noResults({}, ["provide userId or userName"]);
    }

    const from = dateValidation.range.from ?? daysAgoISO(30);
    const to = dateValidation.range.to ?? todayISO();
    const fromIso = `${from}T00:00:00Z`;
    const toIso = `${to}T23:59:59Z`;

    const user = await client.get("user", userId, {
      fields: { user: ["firstName", "lastName", "email", "title"] },
    });

    const safeCount = async (
      resource: string,
      filters: Record<string, unknown>,
    ): Promise<{ count: number; truncated: boolean }> => {
      try {
        return await client.count(resource, filters as FilterMap);
      } catch {
        return { count: -1, truncated: true };
      }
    };

    // Fetch the user's mailboxes first so mailing counts can scope to them
    // (COR-03). If mailboxes.read isn't granted, mailing counts return null.
    let mailboxIds: readonly number[] | null = null;
    let mailboxScopeError: string | null = null;
    try {
      const mailboxes = await client.list<{ id: number }>("mailbox", {
        filters: { user: relId(userId) },
        fields: { mailbox: ["email"] },
        pageSize: 100,
      });
      mailboxIds = mailboxes.data.map((mb) => mb.id);
    } catch {
      mailboxScopeError = "mailboxes.read scope not granted";
    }

    const unavailableMailing = Promise.resolve({ count: -1, truncated: true });
    const mailingFilter = (extra: Record<string, unknown>): FilterMap | null => {
      if (mailboxIds === null) return null;
      if (mailboxIds.length === 0) return null;
      return {
        mailbox: relId([...mailboxIds]),
        createdAt: range(fromIso, toIso),
        ...extra,
      };
    };

    const noMailingCount = mailboxIds !== null && mailboxIds.length === 0;

    const mailingCount = (
      extra: Record<string, unknown>,
    ): Promise<{
      count: number;
      truncated: boolean;
    }> => {
      if (noMailingCount) return Promise.resolve({ count: 0, truncated: false });
      const filter = mailingFilter(extra);
      if (filter === null) return unavailableMailing;
      return safeCount("mailing", filter);
    };

    const [
      prospectsOwned,
      mailingsSentByOwner,
      mailingsOpened,
      mailingsReplied,
      callsLogged,
      callsCompleted,
      tasksCreated,
      tasksCompleted,
    ] = await Promise.all([
      safeCount("prospect", { owner: relId(userId) }),
      mailingCount({}),
      mailingCount({ openedAt: "__notnull__" }),
      mailingCount({ repliedAt: "__notnull__" }),
      safeCount("call", { user: relId(userId) }),
      safeCount("call", { user: relId(userId), outcome: "connected" }),
      safeCount("task", { owner: relId(userId), createdAt: range(fromIso, toIso) }),
      safeCount("task", {
        owner: relId(userId),
        state: "complete",
        createdAt: range(fromIso, toIso),
      }),
    ]);

    const ownedProspects = await client.list<{
      accountId?: number;
      accountName?: string;
      engagedScore?: number;
      id: number;
    }>("prospect", {
      filters: { owner: relId(userId) },
      includes: ["account"],
      fields: { prospect: ["engagedScore"], account: ["name"] },
      flatten: { account: ["name"] },
      pageSize: 500,
    });

    let activeSequencesScoped: number | null = null;
    let activeSequencesMethod: "mailbox" | "ownedProspects" | "unknown" = "unknown";
    if (mailboxIds !== null && mailboxIds.length > 0) {
      try {
        const states = await client.list<{ prospectId: number }>("sequenceState", {
          filters: {
            mailbox: relId([...mailboxIds]),
            state: ["active", "paused", "pending"],
          },
          fields: { sequenceState: ["state"] },
          pageSize: 1000,
        });
        activeSequencesScoped = states.data.length;
        activeSequencesMethod = "mailbox";
      } catch {
        // Fall through to ownedProspects fallback below.
      }
    } else if (mailboxIds !== null && mailboxIds.length === 0) {
      activeSequencesScoped = 0;
      activeSequencesMethod = "mailbox";
    }
    if (activeSequencesMethod === "unknown" && ownedProspects.data.length > 0) {
      try {
        const ownedIds = ownedProspects.data.map((p) => p.id);
        const states = await client.list<{ prospectId: number }>("sequenceState", {
          filters: { prospect: relId(ownedIds), state: ["active", "paused", "pending"] },
          fields: { sequenceState: ["state"] },
          pageSize: 1000,
        });
        activeSequencesScoped = states.data.length;
        activeSequencesMethod = "ownedProspects";
      } catch {
        activeSequencesScoped = null;
      }
    } else if (activeSequencesMethod === "unknown") {
      activeSequencesScoped = 0;
      activeSequencesMethod = "ownedProspects";
    }

    const accountAgg = new Map<
      number,
      {
        accountId: number;
        accountName: string;
        prospectCount: number;
        recentActivityCount: number;
      }
    >();
    for (const p of ownedProspects.data) {
      if (p.accountId === undefined) continue;
      const entry = accountAgg.get(p.accountId) ?? {
        accountId: p.accountId,
        accountName: p.accountName ?? `Account ${String(p.accountId)}`,
        prospectCount: 0,
        recentActivityCount: 0,
      };
      entry.prospectCount++;
      accountAgg.set(p.accountId, entry);
    }
    const topAccounts = Array.from(accountAgg.values())
      .sort((a, b) => b.prospectCount - a.prospectCount)
      .slice(0, 10);

    const m = (c: { count: number }): number | null => (c.count >= 0 ? c.count : null);
    const mailingNote =
      mailboxScopeError !== null
        ? "Mailing counts unavailable — mailboxes.read scope not granted, so mailings cannot be scoped to this user."
        : mailboxIds !== null && mailboxIds.length === 0
          ? "This user has no mailboxes configured; mailing counts are 0 by definition."
          : undefined;

    return {
      user: {
        id: user["id"],
        name: nameFromParts(user["firstName"], user["lastName"]) ?? "",
        email: user["email"],
        title: user["title"],
      },
      dateRange: { from, to },
      metrics: {
        prospectsOwned: m(prospectsOwned),
        activeSequences: activeSequencesScoped,
        activeSequencesNote:
          activeSequencesMethod === "mailbox"
            ? "Counts active sequenceStates whose mailbox belongs to this user (via mailboxes.read)."
            : activeSequencesMethod === "ownedProspects"
              ? "Counts active sequenceStates on prospects owned by this user (mailboxes.read unavailable; falling back to approximation)."
              : "activeSequences calculation failed.",
        mailingsSent: m(mailingsSentByOwner),
        mailingsOpened: m(mailingsOpened),
        mailingsReplied: m(mailingsReplied),
        callsLogged: m(callsLogged),
        callsCompleted: m(callsCompleted),
        tasksCreated: m(tasksCreated),
        tasksCompleted: m(tasksCompleted),
        callsLoggedNote: "lifetime total — Outreach v2 doesn't support filter[answeredAt] on calls",
        ...(mailingNote !== undefined && { mailingNote }),
        unavailableMetrics: [mailingsSentByOwner, mailingsOpened, mailingsReplied].some(
          (c) => c.count === -1,
        )
          ? (mailingNote ??
            "Some mailing counts unavailable — Outreach API rejected the filter at this scope. Narrow the date range to retry.")
          : undefined,
      },
      topAccounts,
    };
  });
}
