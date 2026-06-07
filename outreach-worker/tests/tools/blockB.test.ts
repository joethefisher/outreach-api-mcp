import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OutreachApiException } from "../../src/api/client.js";
import { outreachApiError } from "../../src/errors/envelopes.js";
import { configureLogger } from "../../src/logger.js";
import { analyzeSequencePerformance } from "../../src/tools/analyzeSequencePerformance.js";
import { compareSequences } from "../../src/tools/compareSequences.js";
import { getProspectSequenceHistory } from "../../src/tools/getProspectSequenceHistory.js";
import { getSequenceProfile } from "../../src/tools/getSequenceProfile.js";
import { searchSequences } from "../../src/tools/searchSequences.js";
import {
  cleanupToolContext,
  installToolContext,
  parseEnvelope,
  parseSuccess,
} from "../fixtures/toolHarness.js";

beforeEach(() => {
  configureLogger("error");
});
afterEach(() => {
  configureLogger("info");
  cleanupToolContext();
});

describe("Block B — analyzeSequencePerformance", () => {
  it("never reports an engagement rate above 1.0 (COR-04)", async () => {
    // The scenario the reviewer flagged: a bounced mailing that nonetheless
    // recorded an `openedAt` timestamp (some providers do this). Pre-fix the
    // open numerator counted it while the denominator excluded it, giving
    // openRate > 1.0.
    await installToolContext({
      get: {
        sequence: { 1: { id: 1, name: "Onboarding" } },
      },
      list: {
        mailing: [
          {
            id: 100,
            sequenceId: 1,
            state: "delivered",
            createdAt: "2026-05-10T10:00:00Z",
            deliveredAt: "2026-05-10T10:01:00Z",
            openedAt: "2026-05-10T11:00:00Z",
          },
          {
            id: 101,
            sequenceId: 1,
            state: "bounced",
            createdAt: "2026-05-10T10:00:00Z",
            bouncedAt: "2026-05-10T10:01:00Z",
            // Provider quirk: bounced but the timestamp landed on the row.
            openedAt: "2026-05-10T11:00:00Z",
          },
        ],
        sequenceState: [
          { id: 1, sequenceId: 1, state: "active", createdAt: "2026-05-09T00:00:00Z" },
        ],
      },
      count: { mailing: 2 },
    });
    const raw = await analyzeSequencePerformance({
      sequenceId: 1,
      dateRangeFrom: "2026-05-01",
      dateRangeTo: "2026-05-31",
    });
    const result = parseSuccess(raw) as unknown as {
      totals: { delivered: number; bounced: number; opened: number };
      rates: Record<string, number>;
    };
    expect(result.totals.delivered).toBe(1);
    expect(result.totals.bounced).toBe(1);
    // The bounced-but-opened mailing must NOT count toward `opened` now.
    expect(result.totals.opened).toBe(1);
    expect(result.rates["openRate"]).toBe(1);
    expect(result.rates["openRate"]).toBeLessThanOrEqual(1);
    expect(result.rates["replyRate"]).toBeLessThanOrEqual(1);
    expect(result.rates["clickRate"]).toBeLessThanOrEqual(1);
  });

  it("emits the documented totals and rates on a clean dataset", async () => {
    await installToolContext({
      get: { sequence: { 1: { id: 1, name: "Onboarding" } } },
      list: {
        mailing: [
          {
            id: 100,
            sequenceId: 1,
            state: "delivered",
            createdAt: "2026-05-10T10:00:00Z",
            deliveredAt: "2026-05-10T10:01:00Z",
            openedAt: "2026-05-10T11:00:00Z",
            repliedAt: "2026-05-10T12:00:00Z",
          },
          {
            id: 101,
            sequenceId: 1,
            state: "delivered",
            createdAt: "2026-05-10T10:00:00Z",
            deliveredAt: "2026-05-10T10:01:00Z",
          },
        ],
        sequenceState: [],
      },
      count: { mailing: 2 },
    });
    const raw = await analyzeSequencePerformance({
      sequenceId: 1,
      dateRangeFrom: "2026-05-01",
      dateRangeTo: "2026-05-31",
    });
    const result = parseSuccess(raw) as unknown as {
      totals: { delivered: number; opened: number; replied: number };
      rates: Record<string, number>;
    };
    expect(result.totals.delivered).toBe(2);
    expect(result.totals.opened).toBe(1);
    expect(result.totals.replied).toBe(1);
    expect(result.rates["openRate"]).toBe(0.5);
    expect(result.rates["replyRate"]).toBe(0.5);
  });
});

describe("Block B — searchSequences", () => {
  it("routes name + shareType filters server-side and computes activeProspectCount client-side", async () => {
    const client = await installToolContext({
      list: {
        sequence: [
          {
            id: 7,
            name: "Cold outbound",
            description: "Top of funnel",
            enabled: true,
            shareType: "shared",
            sequenceType: "manual",
            sequenceStepCount: 5,
            ownerId: 1,
            ownerFirstName: "Sally",
            ownerLastName: "Smith",
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-05-10T00:00:00Z",
          },
        ],
        sequenceState: [
          { id: 1, sequenceId: 7, state: "active" },
          { id: 2, sequenceId: 7, state: "paused" },
          { id: 3, sequenceId: 7, state: "finished" }, // not in ACTIVE_STATES
        ],
      },
    });

    const raw = await searchSequences({ query: "Cold outbound", shareType: "shared" });
    const result = parseSuccess(raw) as unknown as {
      sequences: { id: number; activeProspectCount: number; profileUrl: string }[];
      truncated: boolean;
    };
    expect(result.sequences).toHaveLength(1);
    // 2 of the 3 sequenceStates are in ACTIVE_STATES (active/paused/pending).
    expect(result.sequences[0]?.activeProspectCount).toBe(2);
    expect(result.sequences[0]?.profileUrl).toBe("https://web.outreach.io/sequences/7");

    const seqCall = client.listCalls.find((c) => c.resource === "sequence");
    expect(seqCall?.options?.filters).toMatchObject({
      name: "Cold outbound",
      shareType: "shared",
    });
  });

  it("applies enabled filter client-side (Outreach does not accept filter[enabled])", async () => {
    await installToolContext({
      list: {
        sequence: [
          {
            id: 1,
            name: "A",
            enabled: true,
            ownerId: 1,
            ownerFirstName: "X",
            ownerLastName: "Y",
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-04-01T00:00:00Z",
          },
          {
            id: 2,
            name: "B",
            enabled: false,
            ownerId: 1,
            ownerFirstName: "X",
            ownerLastName: "Y",
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-04-01T00:00:00Z",
          },
        ],
        sequenceState: [],
      },
    });
    const raw = await searchSequences({ enabled: true });
    const result = parseSuccess(raw) as unknown as {
      sequences: { id: number; enabled: boolean }[];
    };
    expect(result.sequences.map((s) => s.id)).toEqual([1]);
    expect(result.sequences.every((s) => s.enabled)).toBe(true);
  });

  it("returns noResults envelope on empty match", async () => {
    await installToolContext({ list: { sequence: [] } });
    const raw = await searchSequences({ query: "no-such-sequence" });
    expect(parseEnvelope(raw).error).toBe("noResults");
  });
});

describe("Block B — getProspectSequenceHistory", () => {
  it("returns sequenceStates as history rows with durationDays for terminal states", async () => {
    await installToolContext({
      get: {
        prospect: { 42: { id: 42, firstName: "Sally", lastName: "Smith" } },
      },
      list: {
        sequenceState: [
          {
            id: 1,
            prospectId: 42,
            sequenceId: 7,
            sequenceName: "Cold outbound",
            state: "finished",
            createdAt: "2026-05-01T00:00:00Z",
            stateChangedAt: "2026-05-08T00:00:00Z",
            activeAt: "2026-05-01T00:00:00Z",
          },
          {
            id: 2,
            prospectId: 42,
            sequenceId: 8,
            sequenceName: "Win-back",
            state: "active",
            createdAt: "2026-05-20T00:00:00Z",
            stateChangedAt: "2026-05-20T00:00:00Z",
            activeAt: "2026-05-20T00:00:00Z",
          },
        ],
      },
    });

    const raw = await getProspectSequenceHistory({ prospectId: 42 });
    const result = parseSuccess(raw) as unknown as {
      prospectName: string;
      prospectProfileUrl: string;
      history: {
        sequenceStateId: number;
        sequenceId: number;
        sequenceName: string;
        sequenceProfileUrl: string;
        state: string;
        durationDays: number | null;
        finishedAt: string | null;
      }[];
    };

    expect(result.prospectName).toBe("Sally Smith");
    expect(result.prospectProfileUrl).toBe("https://web.outreach.io/prospects/42");
    expect(result.history).toHaveLength(2);

    const finished = result.history.find((h) => h.sequenceId === 7);
    expect(finished?.durationDays).toBe(7); // 2026-05-08 minus 2026-05-01.
    expect(finished?.finishedAt).toBe("2026-05-08T00:00:00Z");
    expect(finished?.sequenceProfileUrl).toBe("https://web.outreach.io/sequences/7");

    // Non-terminal state: no duration, no finishedAt.
    const active = result.history.find((h) => h.sequenceId === 8);
    expect(active?.durationDays).toBeNull();
    expect(active?.finishedAt).toBeNull();
  });
});

describe("Block B — getProspectSequenceHistory (COR-10)", () => {
  it("returns durationDays=null when stateChangedAt precedes createdAt (clock-skew safety)", async () => {
    // Imported / clock-skewed data can yield stateChangedAt < createdAt.
    // Pre-fix the tool reported a negative durationDays; post-fix it
    // reports null so the agent doesn't surface a nonsense window.
    await installToolContext({
      get: {
        prospect: { 42: { id: 42, firstName: "Sally", lastName: "Smith" } },
      },
      list: {
        sequenceState: [
          {
            id: 99,
            prospectId: 42,
            sequenceId: 7,
            sequenceName: "Cold outbound",
            state: "finished",
            createdAt: "2026-05-10T00:00:00Z",
            stateChangedAt: "2026-05-05T00:00:00Z", // 5 days BEFORE createdAt
          },
        ],
      },
    });
    const raw = await getProspectSequenceHistory({ prospectId: 42 });
    const result = parseSuccess(raw) as unknown as {
      history: { sequenceId: number; durationDays: number | null }[];
    };
    expect(result.history[0]?.durationDays).toBeNull();
  });
});

describe("Block B — compareSequences", () => {
  function installCompareFixture(): Promise<void> {
    return installToolContext({
      get: {
        sequence: {
          1: { id: 1, name: "Cold A" },
          2: { id: 2, name: "Cold B" },
        },
      },
      list: {
        mailing: [
          {
            id: 100,
            sequenceId: 1,
            state: "delivered",
            createdAt: "2026-05-10T10:00:00Z",
            deliveredAt: "2026-05-10T10:01:00Z",
            openedAt: "2026-05-10T11:00:00Z",
          },
          {
            id: 200,
            sequenceId: 2,
            state: "delivered",
            createdAt: "2026-05-10T10:00:00Z",
            deliveredAt: "2026-05-10T10:01:00Z",
            openedAt: "2026-05-10T11:00:00Z",
            repliedAt: "2026-05-10T12:00:00Z",
          },
        ],
        sequenceState: [],
      },
      count: { mailing: 2 },
    }).then(() => undefined);
  }

  it("rejects fewer than 2 sequence IDs with validationError", async () => {
    await installToolContext();
    const raw = await compareSequences({ sequenceIds: [1] });
    const env = parseEnvelope(raw);
    expect(env.error).toBe("validationError");
    expect(env["pointer"]).toBe("sequenceIds");
  });

  it("rejects more than 5 sequence IDs with tooManyInputs", async () => {
    await installToolContext();
    const raw = await compareSequences({ sequenceIds: [1, 2, 3, 4, 5, 6] });
    expect(parseEnvelope(raw).error).toBe("tooManyInputs");
  });

  it("returns per-sequence totals + rates and picks bestReplyRate", async () => {
    await installCompareFixture();
    const raw = await compareSequences({
      sequenceIds: [1, 2],
      dateRangeFrom: "2026-05-01",
      dateRangeTo: "2026-05-31",
    });
    const result = parseSuccess(raw) as unknown as {
      sequences: {
        sequenceId: number;
        totals: Record<string, number>;
        rates: Record<string, number>;
      }[];
      winners: { bestReplyRate: { sequenceId: number; rate: number } | null };
    };

    expect(result.sequences.map((s) => s.sequenceId)).toEqual([1, 2]);
    // Sequence 2 has the reply, so it wins reply-rate.
    expect(result.winners.bestReplyRate?.sequenceId).toBe(2);
    expect(result.winners.bestReplyRate?.rate).toBeGreaterThan(0);
  });
});

describe("Block B — getSequenceProfile", () => {
  it("returns sequence + steps + enrollmentSummary on a clean fetch", async () => {
    await installToolContext({
      get: {
        sequence: {
          1: {
            id: 1,
            name: "Onboarding",
            description: "First touch",
            enabled: true,
            shareType: "shared",
            sequenceType: "manual",
            sequenceStepCount: 2,
            ownerId: 5,
            ownerFirstName: "Sally",
            ownerLastName: "Smith",
            ownerEmail: "sally@x.com",
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-05-01T00:00:00Z",
          },
        },
      },
      list: {
        sequenceStep: [
          { id: 10, sequenceId: 1, order: 1, stepType: "auto_email", interval: 0 },
          { id: 11, sequenceId: 1, order: 2, stepType: "auto_email", interval: 86400 },
        ],
        sequenceTemplate: [],
        sequenceState: [
          { id: 1, sequenceId: 1, state: "active" },
          { id: 2, sequenceId: 1, state: "finished" },
          { id: 3, sequenceId: 1, state: "active" },
        ],
      },
    });

    const raw = await getSequenceProfile({ sequenceId: 1 });
    const result = parseSuccess(raw) as unknown as {
      sequence: { id: number; profileUrl: string };
      owner: { id: number; name?: string; email?: string } | null;
      steps: { order: number }[];
      enrollmentSummary: Record<string, number>;
      unavailableSections?: string[];
    };

    expect(result.sequence.id).toBe(1);
    expect(result.sequence.profileUrl).toBe("https://web.outreach.io/sequences/1");
    expect(result.owner?.email).toBe("sally@x.com");
    expect(result.steps.map((s) => s.order)).toEqual([1, 2]);
    expect(result.enrollmentSummary["totalEnrolled"]).toBe(3);
    expect(result.enrollmentSummary["active"]).toBe(2);
    expect(result.enrollmentSummary["finished"]).toBe(1);
    expect(result.unavailableSections).toBeUndefined();
  });

  it("degrades the enrollment summary on a non-scope failure (5xx) instead of throwing (NEW-2)", async () => {
    // Pre-NEW-2 the tail allStates try/catch only degraded on scopeMissing —
    // a transient 5xx made the whole tool throw, despite all the other
    // sections returning normally. After NEW-2 it degrades via optionalFetch
    // and the response surfaces enrollment summary as unavailable.
    await installToolContext({
      get: {
        sequence: { 1: { id: 1, name: "Onboarding" } },
      },
      list: {
        sequenceStep: [],
      },
      failOn: {
        list: { sequenceState: new OutreachApiException(outreachApiError(503, "upstream down")) },
      },
    });
    const raw = await getSequenceProfile({ sequenceId: 1 });
    const result = parseSuccess(raw) as unknown as {
      sequence: { id: number };
      enrollmentSummary: { totalEnrolled: number };
      unavailableSections?: string[];
    };
    expect(result.sequence.id).toBe(1);
    expect(result.enrollmentSummary.totalEnrolled).toBe(0);
    expect(result.unavailableSections).toBeDefined();
    expect(result.unavailableSections?.some((s) => s.includes("enrollment summary"))).toBe(true);
  });
});
