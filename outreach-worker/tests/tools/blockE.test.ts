import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OutreachApiException } from "../../src/api/client.js";
import { scopeMissing } from "../../src/errors/envelopes.js";
import { configureLogger } from "../../src/logger.js";
import { draftEmail } from "../../src/tools/draftEmail.js";
import { cleanupToolContext, installToolContext, parseSuccess } from "../fixtures/toolHarness.js";

beforeEach(() => {
  configureLogger("error");
});
afterEach(() => {
  configureLogger("info");
  cleanupToolContext();
});

// Allowed top-level keys in a successful draftEmail response. Any new key
// added in src/tools/draftEmail.ts is a deliberate change AND a docs change
// — this test makes the surface explicit so a "send" affordance can never
// sneak in via a fresh field.
const ALLOWED_KEYS = new Set<string>([
  "prospect",
  "recentInteractions",
  "template",
  "customFieldsRelevantToEmail",
  "draftingHints",
  "reminder",
  "unavailableSections",
]);

const FORBIDDEN_KEYS = [
  "send",
  "sendEmail",
  "deliver",
  "sentAt",
  "messageId",
  "scheduledFor",
  "outboundId",
  "draftId",
];

const prospectFixture = {
  id: 42,
  firstName: "Sally",
  lastName: "Smith",
  title: "VP Eng",
  emails: ["sally@acme.com"],
  stageName: "Discovery",
  engagedScore: 5,
  engagedAt: "2026-05-01T00:00:00Z",
  accountId: 7,
  accountName: "Acme",
  accountDomain: "acme.com",
  accountIndustry: "Software",
  ownerId: 12,
  ownerFirstName: "Joe",
  ownerLastName: "Fisher",
} as Record<string, unknown>;

describe("Block E — draftEmail (context-only contract)", () => {
  it("returns a context bundle, NEVER a send affordance", async () => {
    await installToolContext({
      get: { prospect: { 42: prospectFixture } },
      list: { mailing: [], call: [] },
    });

    const raw = await draftEmail({ prospectId: 42, intent: "follow up after demo" });
    const result = parseSuccess(raw);

    // 1. The contract reminder string is present.
    expect(result["reminder"]).toBeDefined();
    const reminder = result["reminder"];
    expect(typeof reminder === "string" ? reminder : "").toContain("context only");

    // 2. No send-shaped key exists, anywhere at the top level.
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(result, forbidden)).toBe(false);
    }

    // 3. Surface is closed: every returned key is in the allowlist.
    for (const key of Object.keys(result)) {
      expect(ALLOWED_KEYS.has(key)).toBe(true);
    }

    // 4. Prospect block returns navigation URL (rep clicks through to Outreach
    //    UI to actually send), not a programmatic send token.
    const prospect = result["prospect"] as Record<string, unknown>;
    expect(prospect["profileUrl"]).toBe("https://web.outreach.io/prospects/42");
  });

  it("returns recentInteractions sorted newest-first from mailings + calls", async () => {
    await installToolContext({
      get: { prospect: { 42: prospectFixture } },
      list: {
        mailing: [
          {
            id: 1,
            prospectId: 42,
            subject: "Initial outreach",
            state: "delivered",
            createdAt: "2026-05-01T00:00:00Z",
            deliveredAt: "2026-05-01T00:00:00Z",
            openedAt: "2026-05-02T00:00:00Z",
            templateName: "Cold A",
          },
          {
            id: 2,
            prospectId: 42,
            subject: "Demo follow-up",
            state: "delivered",
            createdAt: "2026-05-15T00:00:00Z",
            deliveredAt: "2026-05-15T00:00:00Z",
            repliedAt: "2026-05-16T00:00:00Z",
            templateName: "Demo follow",
          },
        ],
        call: [
          {
            id: 100,
            prospectId: 42,
            direction: "outbound",
            outcome: "connected",
            answeredAt: "2026-05-10T15:00:00Z",
            note: "Good call; sending pricing",
          },
        ],
      },
    });

    const raw = await draftEmail({ prospectId: 42, intent: "send pricing details" });
    const result = parseSuccess(raw) as unknown as {
      recentInteractions: { type: string; date: string }[];
      draftingHints: string[];
    };

    expect(result.recentInteractions.length).toBe(3);
    // Newest first: Demo follow-up (2026-05-15) → call (2026-05-10) → initial (2026-05-01).
    expect(result.recentInteractions.map((i) => i.type)).toEqual(["mailing", "call", "mailing"]);
    expect(result.recentInteractions[0]?.date).toBe("2026-05-15T00:00:00Z");

    // draftingHints surfaces the reply + call signals so the agent can use them.
    const hintsJoined = result.draftingHints.join(" | ");
    expect(hintsJoined).toContain("Intent: send pricing details");
    expect(hintsJoined).toContain("replied to");
    expect(hintsJoined).toContain("Last call");
  });

  it("attaches templateId content when one is provided", async () => {
    await installToolContext({
      get: {
        prospect: { 42: prospectFixture },
        template: {
          99: {
            id: 99,
            name: "Follow-up #2",
            subject: "Quick question",
            bodyHtml: "<p>Hi {{firstName}}</p>",
            bodyText: "Hi {{firstName}}",
          },
        },
      },
      list: { mailing: [], call: [] },
    });

    const raw = await draftEmail({ prospectId: 42, intent: "check in", templateId: 99 });
    const result = parseSuccess(raw) as unknown as {
      template: { id: number; name: string; subject: string; bodyText: string } | null;
    };
    expect(result.template?.id).toBe(99);
    expect(result.template?.subject).toBe("Quick question");
  });

  it("truncates oversized template bodies to 5000 chars + suffix (DES-04)", async () => {
    const long = "x".repeat(6000);
    await installToolContext({
      get: {
        prospect: { 42: prospectFixture },
        template: {
          77: {
            id: 77,
            name: "Wall of text",
            subject: "Big",
            bodyHtml: long,
            bodyText: long,
          },
        },
      },
      list: { mailing: [], call: [] },
    });
    const raw = await draftEmail({ prospectId: 42, intent: "x", templateId: 77 });
    const result = parseSuccess(raw) as unknown as {
      template: { bodyHtml: string; bodyText: string } | null;
    };
    expect(result.template?.bodyHtml).toContain("[...truncated]");
    expect(result.template?.bodyText).toContain("[...truncated]");
    expect((result.template?.bodyHtml ?? "").length).toBeLessThanOrEqual(
      5000 + "\n[...truncated]".length,
    );
  });

  it("degrades each optional context fetch into unavailableSections (NEW-2)", async () => {
    await installToolContext({
      get: { prospect: { 42: prospectFixture } },
      failOn: {
        list: {
          mailing: new OutreachApiException(scopeMissing("mailings.read")),
          call: new OutreachApiException(scopeMissing("calls.read")),
        },
      },
    });

    const raw = await draftEmail({ prospectId: 42, intent: "say hi" });
    const result = parseSuccess(raw) as unknown as {
      recentInteractions: unknown[];
      unavailableSections?: string[];
    };

    // Successful core response, optional sections degrade.
    expect(result.recentInteractions).toEqual([]);
    expect(result.unavailableSections).toBeDefined();
    const sections = result.unavailableSections ?? [];
    expect(sections.some((s) => s.startsWith("recentMailings:"))).toBe(true);
    expect(sections.some((s) => s.startsWith("recentCalls:"))).toBe(true);
  });

  it("skips context fetches entirely when includeRecentContext=false", async () => {
    const client = await installToolContext({
      get: { prospect: { 42: prospectFixture } },
    });

    const raw = await draftEmail({
      prospectId: 42,
      intent: "ping",
      includeRecentContext: false,
    });
    const result = parseSuccess(raw) as unknown as { recentInteractions: unknown[] };
    expect(result.recentInteractions).toEqual([]);

    // No mailing or call list calls were made.
    expect(client.listCalls.find((c) => c.resource === "mailing")).toBeUndefined();
    expect(client.listCalls.find((c) => c.resource === "call")).toBeUndefined();
  });
});
