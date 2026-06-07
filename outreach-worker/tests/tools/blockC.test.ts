import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OutreachApiException } from "../../src/api/client.js";
import { scopeMissing } from "../../src/errors/envelopes.js";
import { configureLogger } from "../../src/logger.js";
import { getSnippet } from "../../src/tools/getSnippet.js";
import { getTemplate } from "../../src/tools/getTemplate.js";
import { searchSnippets } from "../../src/tools/searchSnippets.js";
import { searchTemplates } from "../../src/tools/searchTemplates.js";
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

describe("Block C — templates & snippets", () => {
  it("searchTemplates issues a server-side name filter when the API matches it", async () => {
    const client = await installToolContext({
      list: {
        template: [
          {
            id: 11,
            name: "Welcome",
            subject: "Welcome aboard",
            bodyText: "Hi {{firstName}}",
            bodyHtml: "<p>Hi {{firstName}}</p>",
            archived: false,
            ownerId: 5,
            ownerFirstName: "Alice",
            ownerLastName: "Adams",
            updatedAt: "2026-05-10T00:00:00Z",
          },
        ],
        sequenceTemplate: [{ id: 100, templateId: 11 }],
      },
    });

    const raw = await searchTemplates({ query: "Welcome" });
    const result = parseSuccess(raw) as unknown as {
      templates: {
        id: number;
        name: string;
        bodyPreview: string;
        sequenceCount: number;
        profileUrl: string;
        ownerName?: string;
      }[];
      truncated: boolean;
    };

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]?.id).toBe(11);
    expect(result.templates[0]?.profileUrl).toBe("https://web.outreach.io/templates/11");
    expect(result.templates[0]?.sequenceCount).toBe(1);
    expect(result.templates[0]?.ownerName).toBe("Alice Adams");

    // Outgoing filter audit: first call to `template` carried `name: "Welcome"`
    // server-side, NOT just the client-side fallback.
    const tplCall = client.listCalls.find((c) => c.resource === "template");
    expect(tplCall?.options?.filters).toMatchObject({ name: "Welcome" });
  });

  it("searchTemplates flags truncated=true on the client-side fallback when matches were dropped (COR-05)", async () => {
    // Wide-fallback path: 7 templates whose names contain "Outbound", limit=3.
    // Pre-fix `truncated` was always false on this path because nextCursor=null.
    // Post-fix it reflects that 4 matches were dropped client-side.
    const wide = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1,
      name: `Outbound ${String(i)}`,
      subject: "X",
      bodyText: "x",
      bodyHtml: "",
      archived: false,
      ownerId: 5,
      ownerFirstName: "A",
      ownerLastName: "B",
      updatedAt: "2026-05-10T00:00:00Z",
    }));
    await installToolContext({ list: { template: wide } });
    // Query "Outbound" exact-matches nothing seeded under name="Outbound" — the
    // exact-name filter returns 0, triggers the wide fallback which substring-
    // matches all 7. Limit=3, so 4 should be reported as dropped.
    const raw = await searchTemplates({ query: "Outbound", limit: 3 });
    const result = parseSuccess(raw) as unknown as {
      templates: { id: number }[];
      truncated: boolean;
    };
    expect(result.templates).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("searchTemplates falls back to client-side bodyContains filter (COR-05 territory)", async () => {
    await installToolContext({
      list: {
        template: [
          {
            id: 1,
            name: "Outbound A",
            subject: "Hello",
            bodyText: "Mentioning revenue growth",
            bodyHtml: "",
            archived: false,
            ownerId: 5,
            ownerFirstName: "A",
            ownerLastName: "B",
            updatedAt: "2026-05-10T00:00:00Z",
          },
          {
            id: 2,
            name: "Outbound B",
            subject: "Follow up",
            bodyText: "About a podcast",
            bodyHtml: "",
            archived: false,
            ownerId: 5,
            ownerFirstName: "A",
            ownerLastName: "B",
            updatedAt: "2026-05-11T00:00:00Z",
          },
        ],
      },
    });

    const raw = await searchTemplates({ bodyContains: "revenue" });
    const result = parseSuccess(raw) as unknown as { templates: { id: number }[] };
    // bodyContains is client-side: only the matching row survives.
    expect(result.templates.map((t) => t.id)).toEqual([1]);
  });

  it("searchTemplates resolves ownerName via two-step lookup before filtering", async () => {
    const client = await installToolContext({
      list: {
        user: [
          { id: 9, firstName: "Sally", lastName: "Smith", email: "sally@x.com" },
          { id: 10, firstName: "Sam", lastName: "Jones", email: "sam@x.com" },
        ],
        template: [
          {
            id: 21,
            name: "Sally's outbound",
            subject: "Hi",
            bodyText: "x",
            bodyHtml: "",
            archived: false,
            ownerId: 9,
            ownerFirstName: "Sally",
            ownerLastName: "Smith",
            updatedAt: "2026-05-10T00:00:00Z",
          },
          {
            id: 22,
            name: "Sam's outbound",
            subject: "Hi",
            bodyText: "x",
            bodyHtml: "",
            archived: false,
            ownerId: 10,
            ownerFirstName: "Sam",
            ownerLastName: "Jones",
            updatedAt: "2026-05-10T00:00:00Z",
          },
        ],
      },
    });

    const raw = await searchTemplates({ ownerName: "Sally" });
    const result = parseSuccess(raw) as unknown as { templates: { id: number; ownerId: number }[] };

    // Only Sally's template after the owner filter is applied.
    expect(result.templates.map((t) => t.id)).toEqual([21]);
    expect(result.templates[0]?.ownerId).toBe(9);

    // The outgoing template list call must carry an owner relId filter, proving
    // the resolved id is actually being sent — not just relied on for client-side filtering.
    const tplCall = client.listCalls.find((c) => c.resource === "template");
    expect(tplCall?.options?.filters).toMatchObject({ owner: { __relId: [9] } });
  });

  it("searchTemplates returns noResults envelope when no rows match", async () => {
    await installToolContext({ list: { template: [] } });
    const raw = await searchTemplates({ query: "ghost-template-xyz" });
    expect(parseEnvelope(raw).error).toBe("noResults");
  });

  it("searchTemplates degrades sequenceCount silently when sequenceTemplates.read missing", async () => {
    await installToolContext({
      list: {
        template: [
          {
            id: 31,
            name: "X",
            subject: "X",
            bodyText: "",
            bodyHtml: "",
            archived: false,
            ownerId: 5,
            ownerFirstName: "A",
            ownerLastName: "B",
            updatedAt: "2026-05-10T00:00:00Z",
          },
        ],
      },
      failOn: {
        list: {
          sequenceTemplate: new OutreachApiException(scopeMissing("sequenceTemplates.read")),
        },
      },
    });

    // Tool must still return success — degrades by reporting 0 / leaves the
    // rest of the row intact rather than failing the whole call.
    const raw = await searchTemplates({});
    const result = parseSuccess(raw) as unknown as { templates: { sequenceCount: number }[] };
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]?.sequenceCount).toBe(0);
  });

  it("getTemplate returns full body + sequence usage list", async () => {
    await installToolContext({
      get: {
        template: {
          42: {
            id: 42,
            name: "Demo follow-up",
            subject: "Following up",
            bodyHtml: "<p>Hi</p>",
            bodyText: "Hi",
            ccRecipients: ["cc@x.com"],
            bccRecipients: [],
            archived: false,
            ownerId: 5,
            ownerFirstName: "Owen",
            ownerLastName: "R",
          },
        },
      },
      list: {
        sequenceTemplate: [
          {
            id: 1001,
            templateId: 42,
            sequenceStepId: 500,
            sequenceStepSequenceId: 77,
            sequenceStepSequenceName: "Cold outbound",
          },
        ],
      },
    });

    const raw = await getTemplate({ templateId: 42 });
    const result = parseSuccess(raw) as unknown as {
      template: { id: number; name: string; profileUrl: string; ownerName?: string };
      usedInSequences:
        | null
        | {
            sequenceStepId: number;
            sequenceId: number | null;
            sequenceName: string | null;
          }[];
    };

    expect(result.template.id).toBe(42);
    expect(result.template.profileUrl).toBe("https://web.outreach.io/templates/42");
    expect(result.template.ownerName).toBe("Owen R");
    expect(result.usedInSequences).toEqual([
      { sequenceStepId: 500, sequenceId: 77, sequenceName: "Cold outbound" },
    ]);
  });

  it("getTemplate sets usedInSequences=null with a note on scopeMissing", async () => {
    await installToolContext({
      get: {
        template: {
          7: {
            id: 7,
            name: "X",
            subject: "Y",
            bodyHtml: "<p>x</p>",
            bodyText: "x",
            ccRecipients: [],
            bccRecipients: [],
            archived: false,
            ownerId: 1,
            ownerFirstName: "A",
            ownerLastName: "B",
          },
        },
      },
      failOn: {
        list: {
          sequenceTemplate: new OutreachApiException(scopeMissing("sequenceTemplates.read")),
        },
      },
    });

    const raw = await getTemplate({ templateId: 7 });
    const result = parseSuccess(raw) as unknown as {
      usedInSequences: unknown;
      usedInSequencesNote?: string;
    };
    expect(result.usedInSequences).toBeNull();
    expect(result.usedInSequencesNote).toContain("sequenceTemplates.read scope not granted");
  });

  it("getTemplate truncates bodyHtml + bodyText past 5000 chars", async () => {
    const long = "x".repeat(6000);
    await installToolContext({
      get: {
        template: {
          1: {
            id: 1,
            name: "Big",
            subject: "Big",
            bodyHtml: long,
            bodyText: long,
            ccRecipients: [],
            bccRecipients: [],
            archived: false,
            ownerId: 1,
            ownerFirstName: "A",
            ownerLastName: "B",
          },
        },
      },
      list: { sequenceTemplate: [] },
    });

    const raw = await getTemplate({ templateId: 1 });
    const result = parseSuccess(raw) as unknown as {
      template: { bodyHtml: string; bodyText: string };
    };
    expect(result.template.bodyHtml.length).toBeLessThanOrEqual(5000 + "\n[...truncated]".length);
    expect(result.template.bodyHtml).toContain("[...truncated]");
    expect(result.template.bodyText).toContain("[...truncated]");
  });

  it("searchSnippets returns flattened snippet rows with stripped body preview", async () => {
    const client = await installToolContext({
      list: {
        snippet: [
          {
            id: 100,
            name: "Calendly link",
            bodyHtml: "<p>Book a time: <a href='http://x'>here</a></p>",
            ownerId: 5,
            ownerFirstName: "Sam",
            ownerLastName: "Jones",
            updatedAt: "2026-05-10T00:00:00Z",
          },
        ],
      },
    });

    const raw = await searchSnippets({ query: "Calendly" });
    const result = parseSuccess(raw) as unknown as {
      snippets: { id: number; bodyPreview: string; profileUrl: string; ownerName?: string }[];
      truncated: boolean;
    };

    expect(result.snippets).toHaveLength(1);
    expect(result.snippets[0]?.profileUrl).toBe("https://web.outreach.io/snippets/100");
    expect(result.snippets[0]?.bodyPreview).not.toContain("<a");
    expect(result.snippets[0]?.bodyPreview).toContain("Book a time");
    expect(result.snippets[0]?.ownerName).toBe("Sam Jones");

    const snippetCall = client.listCalls.find((c) => c.resource === "snippet");
    expect(snippetCall?.options?.filters).toMatchObject({ name: "Calendly" });
  });

  it("searchSnippets bodyContains filters client-side after the API hit", async () => {
    await installToolContext({
      list: {
        snippet: [
          {
            id: 1,
            name: "A",
            bodyHtml: "<p>book a demo</p>",
            ownerId: 5,
            ownerFirstName: "A",
            ownerLastName: "B",
            updatedAt: "2026-05-10T00:00:00Z",
          },
          {
            id: 2,
            name: "B",
            bodyHtml: "<p>share a podcast</p>",
            ownerId: 5,
            ownerFirstName: "A",
            ownerLastName: "B",
            updatedAt: "2026-05-10T00:00:00Z",
          },
        ],
      },
    });

    const raw = await searchSnippets({ bodyContains: "demo" });
    const result = parseSuccess(raw) as unknown as { snippets: { id: number }[] };
    expect(result.snippets.map((s) => s.id)).toEqual([1]);
  });

  it("searchSnippets returns noResults envelope on empty match", async () => {
    await installToolContext({ list: { snippet: [] } });
    const raw = await searchSnippets({ query: "no-such-snippet" });
    expect(parseEnvelope(raw).error).toBe("noResults");
  });

  it("getSnippet returns full body + flattened owner", async () => {
    await installToolContext({
      get: {
        snippet: {
          7: {
            id: 7,
            name: "Signature block",
            bodyHtml: "<p>Best,<br/>Joe</p>",
            shareType: "shared",
            ownerId: 12,
            ownerFirstName: "Joe",
            ownerLastName: "Fisher",
          },
        },
      },
    });

    const raw = await getSnippet({ snippetId: 7 });
    const result = parseSuccess(raw) as unknown as {
      snippet: {
        id: number;
        bodyHtml: string;
        shareType: string;
        ownerName?: string;
        profileUrl: string;
      };
    };
    expect(result.snippet.id).toBe(7);
    expect(result.snippet.shareType).toBe("shared");
    expect(result.snippet.ownerName).toBe("Joe Fisher");
    expect(result.snippet.profileUrl).toBe("https://web.outreach.io/snippets/7");
  });

  it("getSnippet truncates bodyHtml past 5000 chars", async () => {
    const long = "x".repeat(7000);
    await installToolContext({
      get: { snippet: { 1: { id: 1, name: "X", bodyHtml: long, ownerId: 1 } } },
    });
    const raw = await getSnippet({ snippetId: 1 });
    const result = parseSuccess(raw) as unknown as { snippet: { bodyHtml: string } };
    expect(result.snippet.bodyHtml).toContain("[...truncated]");
  });
});
