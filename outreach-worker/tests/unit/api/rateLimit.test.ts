import { describe, expect, it } from "vitest";

import { parseRetryAfter, RateLimitTracker } from "../../../src/api/rateLimit.js";

function headers(entries: Readonly<Record<string, string>>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(entries)) h.set(k, v);
  return h;
}

describe("RateLimitTracker.observe", () => {
  it("captures state from Headers", () => {
    const t = new RateLimitTracker();
    t.observe(
      headers({
        "X-RateLimit-Limit": "100",
        "X-RateLimit-Remaining": "90",
        "X-RateLimit-Reset": "1700000000",
      }),
    );
    expect(t.current()).toEqual({ limit: 100, remaining: 90, resetAt: 1700000000 });
  });

  it("captures state from a plain object headers shape", () => {
    const t = new RateLimitTracker();
    t.observe({
      "x-ratelimit-limit": "100",
      "x-ratelimit-remaining": "20",
      "x-ratelimit-reset": "1700000060",
    });
    expect(t.current()).toEqual({ limit: 100, remaining: 20, resetAt: 1700000060 });
  });

  it("ignores incomplete header sets", () => {
    const t = new RateLimitTracker();
    t.observe(headers({ "X-RateLimit-Limit": "100" }));
    expect(t.current()).toBeNull();
  });

  it("ignores null headers", () => {
    const t = new RateLimitTracker();
    t.observe(null);
    expect(t.current()).toBeNull();
  });
});

describe("RateLimitTracker.recommendDelaySeconds", () => {
  it("returns 0 when above the warn threshold", () => {
    const t = new RateLimitTracker();
    t.observe(
      headers({
        "X-RateLimit-Limit": "100",
        "X-RateLimit-Remaining": "50",
        "X-RateLimit-Reset": "1700000060",
      }),
    );
    expect(t.recommendDelaySeconds(1700000000)).toBe(0);
  });

  it("paces evenly when in the warn band (remaining ≤ 10%)", () => {
    const t = new RateLimitTracker();
    t.observe(
      headers({
        "X-RateLimit-Limit": "100",
        "X-RateLimit-Remaining": "5",
        "X-RateLimit-Reset": "1700000060",
      }),
    );
    // 60s until reset, 5 calls remaining → ~12s between calls.
    expect(t.recommendDelaySeconds(1700000000)).toBe(12);
  });

  it("waits the full reset window when remaining is 0", () => {
    const t = new RateLimitTracker();
    t.observe(
      headers({
        "X-RateLimit-Limit": "100",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "1700000060",
      }),
    );
    expect(t.recommendDelaySeconds(1700000000)).toBe(60);
  });

  it("returns 0 when no state has been observed", () => {
    expect(new RateLimitTracker().recommendDelaySeconds(0)).toBe(0);
  });

  it("never returns a negative delay even if reset is in the past", () => {
    const t = new RateLimitTracker();
    t.observe(
      headers({
        "X-RateLimit-Limit": "100",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "1700000000",
      }),
    );
    expect(t.recommendDelaySeconds(1700000100)).toBe(0);
  });
});

describe("parseRetryAfter", () => {
  it("returns the integer value from the header", () => {
    expect(parseRetryAfter(headers({ "Retry-After": "45" }))).toBe(45);
  });

  it("is case-insensitive on the header name", () => {
    expect(parseRetryAfter(headers({ "retry-after": "20" }))).toBe(20);
  });

  it("falls back to 30 on missing header", () => {
    expect(parseRetryAfter(new Headers())).toBe(30);
  });

  it("falls back to 30 on null headers", () => {
    expect(parseRetryAfter(null)).toBe(30);
  });

  it("falls back to 30 on a non-numeric value (HTTP-date is rare for Outreach)", () => {
    expect(parseRetryAfter(headers({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }))).toBe(30);
  });

  it("falls back to 30 on a non-positive value", () => {
    expect(parseRetryAfter(headers({ "Retry-After": "-5" }))).toBe(30);
    expect(parseRetryAfter(headers({ "Retry-After": "0" }))).toBe(30);
  });
});
