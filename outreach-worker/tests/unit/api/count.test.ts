import { describe, expect, it } from "vitest";

import { classifyCount } from "../../../src/api/count.js";

describe("classifyCount", () => {
  it("returns count + truncated=false + exceeds=false for a small count", () => {
    expect(classifyCount({ count: 50, count_truncated: false }, 1000)).toEqual({
      count: 50,
      truncated: false,
      exceeds: false,
    });
  });

  it("flags exceeds=true when count is over the threshold", () => {
    expect(classifyCount({ count: 5000, count_truncated: false }, 1000).exceeds).toBe(true);
  });

  it("flags exceeds=true when the upstream truncated the count", () => {
    expect(classifyCount({ count: 0, count_truncated: true }, 1000).exceeds).toBe(true);
  });

  it("treats Outreach's 'count throttled' (count=0, truncated=true) as exceeds", () => {
    // Production-observed shape: Outreach returns this under load.
    expect(classifyCount({ count: 0, count_truncated: true }, 1000)).toEqual({
      count: 0,
      truncated: true,
      exceeds: true,
    });
  });

  it("treats Outreach's hard cap (count=2_000_000, truncated=true) as exceeds", () => {
    expect(classifyCount({ count: 2_000_000, count_truncated: true }, 1000).exceeds).toBe(true);
  });

  it("defaults to 0/false/false when meta is undefined", () => {
    expect(classifyCount(undefined, 1000)).toEqual({
      count: 0,
      truncated: false,
      exceeds: false,
    });
  });
});
