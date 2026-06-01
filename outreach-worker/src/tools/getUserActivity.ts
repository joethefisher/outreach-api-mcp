// getUserActivity — per-user metrics over a date range.

import { daysAgoISO, runTool, todayISO } from "./_helpers.js";
import { resolveUserByName } from "./_resolvers.js";
import { range, relId, type FilterMap } from "../api/filters.js";
import { ambiguousMatch, noResults } from "../errors/envelopes.js";

export interface GetUserActivityInput {
  readonly userId?: number | null;
  readonly userName?: string | null;
  readonly dateRangeFrom?: string | null;
  readonly dateRangeTo?: string | null;
}

export async function getUserActivity(input: GetUserActivityInput): Promise<string> {
  return runTool("getUserActivity", input, async ({ client }) => {
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

    const from = input.dateRangeFrom ?? daysAgoISO(30);
    const to = input.dateRangeTo ?? todayISO();
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
      safeCount("mailing", { createdAt: range(fromIso, toIso) }),
      safeCount("mailing", { createdAt: range(fromIso, toIso), openedAt: "__notnull__" }),
      safeCount("mailing", { createdAt: range(fromIso, toIso), repliedAt: "__notnull__" }),
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
    try {
      const mailboxes = await client.list<{ id: number }>("mailbox", {
        filters: { user: relId(userId) },
        fields: { mailbox: ["email"] },
        pageSize: 100,
      });
      if (mailboxes.data.length > 0) {
        const mailboxIds = mailboxes.data.map((mb) => mb.id);
        const states = await client.list<{ prospectId: number }>("sequenceState", {
          filters: {
            mailbox: relId(mailboxIds),
            state: ["active", "paused", "pending"],
          },
          fields: { sequenceState: ["state"] },
          pageSize: 1000,
        });
        activeSequencesScoped = states.data.length;
        activeSequencesMethod = "mailbox";
      } else {
        activeSequencesScoped = 0;
        activeSequencesMethod = "mailbox";
      }
    } catch {
      if (ownedProspects.data.length > 0) {
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
      } else {
        activeSequencesScoped = 0;
        activeSequencesMethod = "ownedProspects";
      }
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

    return {
      user: {
        id: user["id"],
        name: nameFromParts(user["firstName"], user["lastName"]),
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
        unavailableMetrics: [mailingsSentByOwner, mailingsOpened, mailingsReplied].some(
          (c) => c.count === -1,
        )
          ? "Some mailing counts unavailable — Outreach API rejected the date-range filter at this scope. Narrow the date range to retry."
          : undefined,
      },
      topAccounts,
    };
  });
}

function nameFromParts(first: unknown, last: unknown): string {
  return `${typeof first === "string" ? first : ""} ${typeof last === "string" ? last : ""}`.trim();
}
