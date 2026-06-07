import { describe, expect, it } from "vitest";

import {
  ESSENTIAL_FIELDS,
  isAllowedResource,
  READ_ONLY_RESOURCES,
} from "../../../src/tools/allowlist.js";

describe("isAllowedResource", () => {
  it("accepts every documented read-only resource", () => {
    for (const r of READ_ONLY_RESOURCES) {
      expect(isAllowedResource(r)).toBe(true);
    }
  });

  it("rejects any write-class resource the OAuth scopes don't grant", () => {
    // Writes the Outreach API supports that we deliberately don't expose.
    // The guard's job is to fail closed on these even if upstream would 403.
    const forbidden = [
      "complianceRequest",
      "duty",
      "personalization",
      "phoneNumber",
      "profile",
      "role",
      "smtpServer",
      "webhook",
    ];
    for (const r of forbidden) {
      expect(isAllowedResource(r)).toBe(false);
    }
  });

  it("rejects empty / whitespace / injection-shaped strings", () => {
    expect(isAllowedResource("")).toBe(false);
    expect(isAllowedResource(" ")).toBe(false);
    expect(isAllowedResource("account ")).toBe(false); // trailing space
    expect(isAllowedResource("Account")).toBe(false); // case-sensitive
    expect(isAllowedResource("ACCOUNT")).toBe(false);
    expect(isAllowedResource("account/../user")).toBe(false);
    expect(isAllowedResource("../etc/passwd")).toBe(false);
  });

  it("is case-sensitive — only the documented camelCase form passes", () => {
    expect(isAllowedResource("user")).toBe(true);
    expect(isAllowedResource("User")).toBe(false);
    expect(isAllowedResource("USER")).toBe(false);
    expect(isAllowedResource("sequenceState")).toBe(true);
    expect(isAllowedResource("sequencestate")).toBe(false);
    expect(isAllowedResource("sequence_state")).toBe(false);
  });

  it("ESSENTIAL_FIELDS only references resources in the allowlist", () => {
    for (const key of Object.keys(ESSENTIAL_FIELDS)) {
      expect(isAllowedResource(key)).toBe(true);
    }
  });

  it("narrows the type when used as a type guard", () => {
    const input: string = "account";
    if (isAllowedResource(input)) {
      // After the guard, `input` narrows to AllowedResource — a value of this
      // type is assignable to keyof ESSENTIAL_FIELDS without a cast. If the
      // guard ever stopped narrowing, this would fail to compile.
      const fields = ESSENTIAL_FIELDS[input];
      expect(fields).toBeDefined();
    } else {
      throw new Error("expected guard to narrow");
    }
  });
});
