import { describe, expect, it } from "vitest";

import {
  ambiguousMatch,
  invalidResource,
  isErrorEnvelope,
  noResults,
  notFound,
  notImplemented,
  oauthNotConnected,
  outreachApiError,
  rateLimited,
  scopeMissing,
  timeout,
  tokenInvalid,
  tooLarge,
  tooManyInputs,
  validationError,
} from "../../src/errors/envelopes.js";

describe("error envelope factories", () => {
  it("notFound carries the resource type and id", () => {
    const e = notFound("prospect", 42);
    expect(e).toMatchObject({ error: "notFound", resourceType: "prospect", id: 42 });
    expect(e.message).toContain("prospect");
    expect(e.message).toContain("42");
  });

  it("ambiguousMatch defaults the noun and reports the count", () => {
    const e = ambiguousMatch([
      { id: 1, label: "Acme" },
      { id: 2, label: "Acme Co" },
    ]);
    expect(e.matches).toHaveLength(2);
    expect(e.message).toContain("2");
  });

  it("noResults preserves the query and suggestions", () => {
    const e = noResults({ name: "Joe" }, ["try email"]);
    expect(e.query).toEqual({ name: "Joe" });
    expect(e.suggestions).toEqual(["try email"]);
  });

  it("tooLarge differentiates negative count from positive count", () => {
    const e1 = tooLarge(-1);
    expect(e1.message).toContain("too large for Outreach to count");
    const e2 = tooLarge(120_000, true);
    expect(e2.message).toContain("More than");
    expect(e2.countTruncated).toBe(true);
  });

  it("tooManyInputs surfaces the limit and the given count", () => {
    const e = tooManyInputs(5, 8);
    expect(e.limit).toBe(5);
    expect(e.given).toBe(8);
  });

  it("rateLimited carries the retry-after seconds", () => {
    expect(rateLimited(30).retryAfterSeconds).toBe(30);
  });

  it("tokenInvalid points users at the bootstrap script", () => {
    expect(tokenInvalid().message).toContain("bootstrap:oauth");
  });

  it("oauthNotConnected points users at the bootstrap script", () => {
    expect(oauthNotConnected().message).toContain("bootstrap:oauth");
  });

  it("scopeMissing names the missing scope", () => {
    const e = scopeMissing("prospects.read");
    expect(e.scope).toBe("prospects.read");
    expect(e.message).toContain("prospects.read");
  });

  it("outreachApiError preserves status and detail", () => {
    const e1 = outreachApiError(500);
    expect(e1.status).toBe(500);
    expect(e1.detail).toBeUndefined();
    const e2 = outreachApiError(422, "bad filter");
    expect(e2.detail).toBe("bad filter");
    expect(e2.message).toContain("bad filter");
  });

  it("validationError preserves pointer when given", () => {
    const e1 = validationError("missing field");
    expect(e1.pointer).toBeUndefined();
    const e2 = validationError("missing field", "/data/attributes/x");
    expect(e2.pointer).toBe("/data/attributes/x");
    expect(e2.message).toContain("/data/attributes/x");
  });

  it("invalidResource lists the allowed set", () => {
    const e = invalidResource("widget", ["prospect", "account"]);
    expect(e.allowed).toEqual(["prospect", "account"]);
    expect(e.message).toContain("prospect");
    expect(e.message).toContain("account");
  });

  it("timeout returns a timeout envelope", () => {
    expect(timeout().error).toBe("timeout");
  });

  it("notImplemented names the tool", () => {
    expect(notImplemented("doThing").tool).toBe("doThing");
  });
});

describe("isErrorEnvelope", () => {
  it("recognizes valid envelopes", () => {
    expect(isErrorEnvelope(notFound("x", 1))).toBe(true);
    expect(isErrorEnvelope(noResults({}))).toBe(true);
  });

  it("rejects non-envelopes", () => {
    expect(isErrorEnvelope(null)).toBe(false);
    expect(isErrorEnvelope(undefined)).toBe(false);
    expect(isErrorEnvelope({})).toBe(false);
    expect(isErrorEnvelope({ error: 42 })).toBe(false);
    expect(isErrorEnvelope("error")).toBe(false);
  });
});
