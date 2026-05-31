import { describe, expect, it } from "vitest";

import { OUTREACH_READ_SCOPES, scopeString } from "../../../src/auth/scopes.js";

describe("OUTREACH_READ_SCOPES", () => {
  it("requests only read scopes — never write or admin", () => {
    for (const scope of OUTREACH_READ_SCOPES) {
      expect(scope.endsWith(".read"), `${scope} is not a read scope`).toBe(true);
    }
  });

  it("includes the scopes needed by every Block A/B/C/D tool", () => {
    // Spot-check: if these go missing the tool layer will get 403s.
    const required = [
      "prospects.read",
      "accounts.read",
      "sequences.read",
      "sequenceStates.read",
      "templates.read",
      "snippets.read",
      "mailings.read",
      "tasks.read",
      "users.read",
      "auditLogs.read",
      "opportunities.read",
    ];
    for (const scope of required) {
      expect(OUTREACH_READ_SCOPES).toContain(scope);
    }
  });

  it("has no duplicates", () => {
    const unique = new Set(OUTREACH_READ_SCOPES);
    expect(unique.size).toBe(OUTREACH_READ_SCOPES.length);
  });
});

describe("scopeString", () => {
  it("joins scopes with a single space (OAuth standard)", () => {
    const s = scopeString();
    expect(s).toBe(OUTREACH_READ_SCOPES.join(" "));
    expect(s.split(" ").length).toBe(OUTREACH_READ_SCOPES.length);
  });
});
