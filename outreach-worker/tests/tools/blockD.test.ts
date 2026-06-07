import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureLogger } from "../../src/logger.js";
import { getAuditLog } from "../../src/tools/getAuditLog.js";
import { getOpenTasks } from "../../src/tools/getOpenTasks.js";
import { getTeamRoster } from "../../src/tools/getTeamRoster.js";
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

describe("Block D — activity, tasks, audit", () => {
  it("getOpenTasks returns flattened task rows + total count", async () => {
    await installToolContext({
      list: {
        task: [
          {
            id: 1,
            action: "call",
            state: "incomplete",
            note: "Follow up",
            dueAt: "2026-06-01T00:00:00Z",
            prospectId: 42,
            prospectFirstName: "Joe",
            prospectLastName: "Fisher",
            ownerFirstName: "Sally",
            ownerLastName: "Smith",
          },
        ],
      },
      count: { task: 1 },
    });
    const raw = await getOpenTasks({});
    const result = parseSuccess(raw) as unknown as {
      tasks: { id: number; action: string; prospectName?: string; profileUrl?: string }[];
      totalCount: number;
    };
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.prospectName).toBe("Joe Fisher");
    expect(result.tasks[0]?.profileUrl).toBe("https://web.outreach.io/prospects/42");
    expect(result.totalCount).toBe(1);
  });

  it("getOpenTasks surfaces totalCount=null + totalCountUnknown=true on throttled count (COR-12)", async () => {
    // Outreach signals an un-countable result as { count: -1, truncated: true }
    // (after the COR-12 client.count fix translates the throttled response).
    // The tool must NOT report this as a real "0" — it should be null with a
    // clear unknown signal.
    await installToolContext({
      list: {
        task: [
          {
            id: 1,
            action: "call",
            state: "incomplete",
            dueAt: "2026-06-01T00:00:00Z",
            prospectId: 42,
          },
        ],
      },
      count: { task: { count: -1, truncated: true } },
    });
    const raw = await getOpenTasks({});
    const result = parseSuccess(raw) as unknown as {
      tasks: { id: number }[];
      totalCount: number | null;
      totalCountUnknown: boolean;
    };
    expect(result.tasks).toHaveLength(1); // the page itself is fine
    expect(result.totalCount).toBeNull();
    expect(result.totalCountUnknown).toBe(true);
  });

  it("getTeamRoster paginates past the 500-user single-page cap (COR-07)", async () => {
    // Seed 1200 users; pre-fix a single 500-pageSize read silently dropped
    // 700 of them. Post-fix paginateList walks pages and returns all of
    // them with truncated=false (well under the 5000 cap).
    const users = Array.from({ length: 1200 }, (_, i) => ({
      id: i + 1,
      firstName: `User${String(i)}`,
      lastName: "X",
      email: `u${String(i)}@x.com`,
    }));
    await installToolContext({ list: { user: users } });
    const raw = await getTeamRoster({});
    const result = parseSuccess(raw) as unknown as {
      users: { id: number }[];
      truncated: boolean;
    };
    expect(result.users).toHaveLength(1200);
    expect(result.truncated).toBe(false);
  });

  it("getTeamRoster signals truncated=true when the page cap is hit (COR-07)", async () => {
    // Seed more users than the 10-page cap × 500-pageSize = 5000 ceiling.
    const users = Array.from({ length: 6000 }, (_, i) => ({
      id: i + 1,
      firstName: `User${String(i)}`,
      lastName: "X",
      email: `u${String(i)}@x.com`,
    }));
    await installToolContext({ list: { user: users } });
    const raw = await getTeamRoster({});
    const result = parseSuccess(raw) as unknown as {
      users: { id: number }[];
      truncated: boolean;
      note?: string;
    };
    expect(result.users.length).toBe(5000); // capped at 10 pages × 500
    expect(result.truncated).toBe(true);
    expect(result.note).toContain("larger than 5000");
  });

  it("getTeamRoster sorts alphabetically and filters out locked users by default", async () => {
    await installToolContext({
      list: {
        user: [
          { id: 1, firstName: "Charlie", lastName: "Brown", email: "c@x.com" },
          { id: 2, firstName: "Alice", lastName: "Adams", email: "a@x.com", locked: true },
          { id: 3, firstName: "Bob", lastName: "Brady", email: "b@x.com" },
        ],
      },
    });
    const raw = await getTeamRoster({});
    const result = parseSuccess(raw) as unknown as { users: { id: number; name: string }[] };
    expect(result.users.map((u) => u.name)).toEqual(["Bob Brady", "Charlie Brown"]);
  });

  it("getAuditLog rejects unfiltered queries with validationError", async () => {
    await installToolContext();
    const raw = await getAuditLog({});
    expect(parseEnvelope(raw).error).toBe("validationError");
  });

  it("getAuditLog rejects a malformed dateRangeFrom with validationError (COR-08)", async () => {
    await installToolContext();
    const raw = await getAuditLog({ dateRangeFrom: "last week", dateRangeTo: "2026-01-01" });
    const env = parseEnvelope(raw);
    expect(env.error).toBe("validationError");
    expect(env["pointer"]).toBe("dateRangeFrom");
  });

  it("getAuditLog rejects from > to with validationError (COR-08)", async () => {
    await installToolContext();
    const raw = await getAuditLog({ dateRangeFrom: "2026-03-01", dateRangeTo: "2026-02-15" });
    const env = parseEnvelope(raw);
    expect(env.error).toBe("validationError");
    expect(env.message).toContain("on or before");
  });

  it("getAuditLog filters to the date range, excluding entries outside it (COR-01)", async () => {
    await installToolContext({
      list: {
        auditLog: [
          {
            id: 1,
            action: "create",
            agent: { userId: 5 },
            additionalInfo: [],
            occurredAt: "2026-05-05T10:00:00Z",
          },
          {
            id: 2,
            action: "update",
            agent: { userId: 5 },
            additionalInfo: [],
            occurredAt: "2026-05-10T10:00:00Z",
          },
          {
            // Outside the requested 2026-05-01..2026-05-15 window — must be excluded.
            id: 3,
            action: "delete",
            agent: { userId: 5 },
            additionalInfo: [],
            occurredAt: "2026-06-01T10:00:00Z",
          },
        ],
      },
    });
    const raw = await getAuditLog({ dateRangeFrom: "2026-05-01", dateRangeTo: "2026-05-15" });
    const result = parseSuccess(raw) as unknown as { entries: { id: number }[] };
    expect(result.entries.map((e) => e.id)).toEqual([1, 2]);
  });
});
