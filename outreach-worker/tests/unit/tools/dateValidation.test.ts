import { describe, expect, it } from "vitest";

import { validateDateRange } from "../../../src/tools/_helpers.js";

describe("validateDateRange (COR-08)", () => {
  it("accepts two valid ISO dates in order", () => {
    const r = validateDateRange("2026-01-01", "2026-01-15");
    if (!r.ok) throw new Error("expected ok");
    expect(r.range.from).toBe("2026-01-01");
    expect(r.range.to).toBe("2026-01-15");
  });

  it("treats missing / empty inputs as null", () => {
    const r = validateDateRange(null, undefined);
    if (!r.ok) throw new Error("expected ok");
    expect(r.range.from).toBeNull();
    expect(r.range.to).toBeNull();
  });

  it("rejects a non-date dateRangeFrom with validationError pointing at the field", () => {
    const r = validateDateRange("last week", "2026-01-15");
    if (r.ok) throw new Error("expected error");
    expect(r.envelope.error).toBe("validationError");
    expect(r.envelope.pointer).toBe("dateRangeFrom");
    expect(r.envelope.message).toContain("YYYY-MM-DD");
  });

  it("rejects a non-date dateRangeTo with validationError pointing at the field", () => {
    const r = validateDateRange("2026-01-01", "tomorrow");
    if (r.ok) throw new Error("expected error");
    expect(r.envelope.error).toBe("validationError");
    expect(r.envelope.pointer).toBe("dateRangeTo");
  });

  it("rejects from > to with a clear ordering message", () => {
    const r = validateDateRange("2026-03-01", "2026-02-15");
    if (r.ok) throw new Error("expected error");
    expect(r.envelope.error).toBe("validationError");
    expect(r.envelope.detail).toContain("on or before");
  });

  it("rejects malformed calendar dates that look ISO but aren't (2026-13-01)", () => {
    const r = validateDateRange("2026-13-01", null);
    if (r.ok) throw new Error("expected error");
    expect(r.envelope.error).toBe("validationError");
    expect(r.envelope.pointer).toBe("dateRangeFrom");
    expect(r.envelope.detail).toContain("real calendar date");
  });

  it("rejects Feb 30 (calendar round-trip catches what the regex doesn't)", () => {
    const r = validateDateRange("2026-02-30", null);
    if (r.ok) throw new Error("expected error");
    expect(r.envelope.pointer).toBe("dateRangeFrom");
  });
});
