import { describe, expect, it } from "vitest";

import {
  appendFields,
  appendFilters,
  appendIncludes,
  appendPagination,
  appendSort,
  buildQueryString,
  range,
  relId,
} from "../../../src/api/filters.js";

describe("appendFilters", () => {
  it("encodes a simple equality filter", () => {
    const params = new URLSearchParams();
    appendFilters(params, { firstName: "Sally" });
    expect(decodeURIComponent(params.toString())).toBe("filter[firstName]=Sally");
  });

  it("skips null filter values (callers pass the literal '__null__' for presence checks)", () => {
    const params = new URLSearchParams();
    appendFilters(params, { ownerId: null });
    expect(params.toString()).toBe("");
  });

  it("passes through the literal '__null__' for an explicit presence filter", () => {
    const params = new URLSearchParams();
    appendFilters(params, { ownerId: "__null__" });
    expect(decodeURIComponent(params.toString())).toBe("filter[ownerId]=__null__");
  });

  it("skips undefined keys entirely", () => {
    const params = new URLSearchParams();
    appendFilters(params, { foo: undefined, bar: "x" });
    expect(decodeURIComponent(params.toString())).toBe("filter[bar]=x");
  });

  it("comma-joins array values", () => {
    const params = new URLSearchParams();
    appendFilters(params, { stage: ["new", "open", "won"] });
    expect(decodeURIComponent(params.toString())).toBe("filter[stage]=new,open,won");
  });

  it("encodes range() with .. between bounds", () => {
    const params = new URLSearchParams();
    appendFilters(params, { updatedAt: range("2026-01-01", "2026-12-31") });
    expect(decodeURIComponent(params.toString())).toBe("filter[updatedAt]=2026-01-01..2026-12-31");
  });

  it("encodes range() with neginf/inf sentinels", () => {
    const params = new URLSearchParams();
    appendFilters(params, { updatedAt: range("neginf", "2026-01-01") });
    expect(decodeURIComponent(params.toString())).toBe("filter[updatedAt]=neginf..2026-01-01");
  });

  it("encodes relId() as filter[<rel>][id]=N", () => {
    const params = new URLSearchParams();
    appendFilters(params, { account: relId(42) });
    expect(decodeURIComponent(params.toString())).toBe("filter[account][id]=42");
  });

  it("encodes relId() with an array of IDs", () => {
    const params = new URLSearchParams();
    appendFilters(params, { account: relId([1, 2, 3]) });
    expect(decodeURIComponent(params.toString())).toBe("filter[account][id]=1,2,3");
  });

  it("encodes nested sub-object filters as filter[key][subkey]=value", () => {
    const params = new URLSearchParams();
    appendFilters(params, { engagement: { score: 7, active: true } });
    const decoded = decodeURIComponent(params.toString());
    expect(decoded).toContain("filter[engagement][score]=7");
    expect(decoded).toContain("filter[engagement][active]=true");
  });

  it("is a no-op when filters is undefined", () => {
    const params = new URLSearchParams();
    appendFilters(params, undefined);
    expect(params.toString()).toBe("");
  });
});

describe("appendFields / appendIncludes / appendSort / appendPagination", () => {
  it("appendFields emits fields[type]=a,b", () => {
    const params = new URLSearchParams();
    appendFields(params, { prospect: ["firstName", "lastName"] });
    expect(decodeURIComponent(params.toString())).toBe("fields[prospect]=firstName,lastName");
  });

  it("appendFields skips empty arrays", () => {
    const params = new URLSearchParams();
    appendFields(params, { prospect: [], account: ["name"] });
    expect(decodeURIComponent(params.toString())).toBe("fields[account]=name");
  });

  it("appendIncludes joins with comma into a single include= param", () => {
    const params = new URLSearchParams();
    appendIncludes(params, ["account", "owner"]);
    expect(params.toString()).toBe("include=account%2Cowner");
  });

  it("appendIncludes is a no-op on empty arrays", () => {
    const params = new URLSearchParams();
    appendIncludes(params, []);
    expect(params.toString()).toBe("");
  });

  it("appendSort threads the value through verbatim", () => {
    const params = new URLSearchParams();
    appendSort(params, "-updatedAt");
    expect(params.toString()).toBe("sort=-updatedAt");
  });

  it("appendPagination emits page[size], page[after], count", () => {
    const params = new URLSearchParams();
    appendPagination(params, { pageSize: 50, cursor: "abc", count: true });
    const decoded = decodeURIComponent(params.toString());
    expect(decoded).toContain("page[size]=50");
    expect(decoded).toContain("page[after]=abc");
    expect(decoded).toContain("count=true");
  });

  it("appendPagination omits empty/null cursors", () => {
    const params = new URLSearchParams();
    appendPagination(params, { pageSize: 10, cursor: null });
    expect(decodeURIComponent(params.toString())).toBe("page[size]=10");
  });
});

describe("buildQueryString", () => {
  it("composes every section in order", () => {
    const query = buildQueryString({
      filters: { firstName: "Sally" },
      fields: { prospect: ["firstName"] },
      includes: ["account"],
      sort: "-updatedAt",
      pageSize: 25,
      cursor: "abc",
      count: true,
    });
    const decoded = decodeURIComponent(query);
    expect(decoded).toContain("filter[firstName]=Sally");
    expect(decoded).toContain("fields[prospect]=firstName");
    expect(decoded).toContain("include=account");
    expect(decoded).toContain("sort=-updatedAt");
    expect(decoded).toContain("page[size]=25");
    expect(decoded).toContain("page[after]=abc");
    expect(decoded).toContain("count=true");
  });

  it("returns empty string for an empty query", () => {
    expect(buildQueryString({})).toBe("");
  });
});
