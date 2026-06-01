import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureLogger } from "../../src/logger.js";
import { getAccountProfile } from "../../src/tools/getAccountProfile.js";
import { getProspectProfile } from "../../src/tools/getProspectProfile.js";
import { searchAccounts } from "../../src/tools/searchAccounts.js";
import { searchProspects } from "../../src/tools/searchProspects.js";
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

describe("Block A — prospects & accounts", () => {
  it("searchProspects returns flattened prospect rows on a basic query", async () => {
    await installToolContext({
      list: {
        prospect: [
          {
            id: 1,
            firstName: "Sally",
            lastName: "Smith",
            title: "VP Eng",
            emails: ["sally@acme.com"],
            accountId: 7,
            accountName: "Acme",
            accountDomain: "acme.com",
            ownerId: 12,
            ownerFirstName: "Joe",
            ownerLastName: "Fisher",
            stageName: "Discovery",
            updatedAt: "2026-05-01T00:00:00Z",
          },
        ],
        sequenceState: [],
      },
    });
    const raw = await searchProspects({ query: "Sally" });
    const result = parseSuccess(raw) as unknown as {
      prospects: {
        id: number;
        firstName: string;
        profileUrl: string;
        activeSequenceCount: number;
      }[];
    };
    expect(result.prospects).toHaveLength(1);
    expect(result.prospects[0]?.firstName).toBe("Sally");
    expect(result.prospects[0]?.profileUrl).toBe("https://web.outreach.io/prospects/1");
    expect(result.prospects[0]?.activeSequenceCount).toBe(0);
  });

  it("searchProspects returns noResults envelope when nothing matches", async () => {
    await installToolContext({ list: { prospect: [], sequenceState: [] } });
    const raw = await searchProspects({ query: "ghost" });
    const env = parseEnvelope(raw);
    expect(env.error).toBe("noResults");
  });

  it("getProspectProfile composes a 360 view from parallel fetches", async () => {
    await installToolContext({
      get: {
        prospect: {
          42: {
            id: 42,
            firstName: "Joe",
            lastName: "Fisher",
            title: "PM",
            emails: ["joe@example.com"],
            stageName: "Demo",
            accountId: 7,
            accountName: "Acme",
            accountDomain: "acme.com",
            accountIndustry: "Tech",
            accountEmployeeCount: 100,
            ownerId: 12,
            ownerFirstName: "Sally",
            ownerLastName: "Smith",
          },
        },
      },
      list: {
        sequenceState: [
          {
            id: 99,
            state: "active",
            prospectId: 42,
            sequenceId: 5,
            sequenceName: "Onboarding",
            createdAt: "2026-05-01T00:00:00Z",
          },
        ],
        mailing: [],
        call: [],
        task: [],
        opportunity: [],
      },
    });
    const raw = await getProspectProfile({ prospectId: 42 });
    const result = parseSuccess(raw) as unknown as {
      prospect: { id: number; profileUrl: string };
      account: { id: number; name: string } | null;
      stage: { name: string } | null;
      activeSequences: { state: string }[];
    };
    expect(result.prospect.id).toBe(42);
    expect(result.prospect.profileUrl).toBe("https://web.outreach.io/prospects/42");
    expect(result.account?.name).toBe("Acme");
    expect(result.stage?.name).toBe("Demo");
    expect(result.activeSequences).toHaveLength(1);
  });

  it("searchAccounts returns flattened account rows", async () => {
    await installToolContext({
      list: {
        account: [
          {
            id: 7,
            name: "Acme",
            domain: "acme.com",
            industry: "Tech",
            named: true,
            ownerId: 12,
            ownerFirstName: "Sally",
            ownerLastName: "Smith",
          },
        ],
      },
    });
    const raw = await searchAccounts({ query: "Acme" });
    const result = parseSuccess(raw) as unknown as {
      accounts: { id: number; name: string; profileUrl: string }[];
    };
    expect(result.accounts[0]?.name).toBe("Acme");
    expect(result.accounts[0]?.profileUrl).toBe("https://web.outreach.io/accounts/7");
  });

  it("getAccountProfile aggregates account + prospects + scopes activity to the account (COR-02)", async () => {
    const env = await installToolContext({
      get: {
        account: {
          7: {
            id: 7,
            name: "Acme",
            domain: "acme.com",
            industry: "Tech",
            ownerId: 12,
            ownerFirstName: "Sally",
            ownerLastName: "Smith",
            ownerEmail: "sally@acme.com",
          },
        },
      },
      list: {
        prospect: [
          {
            id: 1,
            accountId: 7,
            firstName: "P1",
            lastName: "L1",
            title: "T",
            engagedScore: 80,
            stageName: "Demo",
          },
          {
            id: 2,
            accountId: 7,
            firstName: "P2",
            lastName: "L2",
            title: "T",
            engagedScore: 70,
            stageName: "Demo",
          },
        ],
        opportunity: [],
        sequenceState: [],
      },
      count: { mailing: 5, call: 3, task: 2, sequenceState: 1 },
    });
    const raw = await getAccountProfile({ accountId: 7 });
    const result = parseSuccess(raw) as unknown as {
      account: { id: number; name: string };
      prospects: { id: number }[];
      recentActivity: { mailingsSent: number | null };
    };
    expect(result.account.id).toBe(7);
    expect(result.prospects).toHaveLength(2);
    expect(result.recentActivity.mailingsSent).toBe(5);

    // COR-02: every activity count must include a `prospect` filter scoped
    // to this account's prospects. Pre-fix, the counts went out with only a
    // date filter (or empty for `call`) and returned workspace-wide numbers.
    const scoped = ["mailing", "task", "call", "sequenceState"] as const;
    for (const resource of scoped) {
      const call = env.countCalls.find((c) => c.resource === resource);
      expect(call, `expected a count call for ${resource}`).toBeDefined();
      const prospectFilter = call?.filters?.["prospect"];
      expect(prospectFilter, `${resource} count must be scoped by prospect`).toEqual({
        __relId: [1, 2],
      });
    }
  });
});
