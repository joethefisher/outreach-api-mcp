import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureLogger } from "../../src/logger.js";
import { analyzeSequencePerformance } from "../../src/tools/analyzeSequencePerformance.js";
import { cleanupToolContext, installToolContext, parseSuccess } from "../fixtures/toolHarness.js";

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
