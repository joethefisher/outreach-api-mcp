import { describe, expect, it } from "vitest";

import {
  extractNextCursor,
  indexIncluded,
  normalizeDocument,
  normalizeResource,
  type JsonApiDocument,
  type JsonApiResource,
} from "../../../src/api/jsonapi.js";

const sampleAccount: JsonApiResource = {
  type: "account",
  id: 7,
  attributes: { name: "Acme", domain: "acme.com" },
};

const sampleOwner: JsonApiResource = {
  type: "user",
  id: 12,
  attributes: { firstName: "Sally", lastName: "Smith" },
};

const sampleProspect: JsonApiResource = {
  type: "prospect",
  id: 42,
  attributes: { firstName: "Joe", lastName: "Fisher", title: "PM" },
  relationships: {
    account: { data: { type: "account", id: 7 } },
    owner: { data: { type: "user", id: 12 } },
    tags: {
      data: [
        { type: "tag", id: 1 },
        { type: "tag", id: 2 },
      ],
    },
    nothing: { data: null },
  },
};

describe("indexIncluded", () => {
  it("keys included resources by type:id", () => {
    const map = indexIncluded([sampleAccount, sampleOwner]);
    expect(map.get("account:7")).toBe(sampleAccount);
    expect(map.get("user:12")).toBe(sampleOwner);
    expect(map.size).toBe(2);
  });

  it("defaults to empty when no included resources are given", () => {
    expect(indexIncluded().size).toBe(0);
  });
});

describe("normalizeResource", () => {
  it("flattens attributes onto the output", () => {
    const out = normalizeResource(sampleProspect, indexIncluded([]));
    expect(out["id"]).toBe(42);
    expect(out["firstName"]).toBe("Joe");
    expect(out["lastName"]).toBe("Fisher");
    expect(out["title"]).toBe("PM");
  });

  it("lifts to-one relationships as <rel>Id", () => {
    const out = normalizeResource(sampleProspect, indexIncluded([]));
    expect(out["accountId"]).toBe(7);
    expect(out["ownerId"]).toBe(12);
  });

  it("lifts to-many relationships as <rel>Ids", () => {
    const out = normalizeResource(sampleProspect, indexIncluded([]));
    expect(out["tagsIds"]).toEqual([1, 2]);
  });

  it("omits null relationships entirely", () => {
    const out = normalizeResource(sampleProspect, indexIncluded([]));
    expect(out["nothing"]).toBeUndefined();
    expect(out["nothingId"]).toBeUndefined();
  });

  it("flattens included to-one attributes per the flatten map", () => {
    const out = normalizeResource(sampleProspect, indexIncluded([sampleAccount]), {
      account: ["name", "domain"],
    });
    expect(out["accountName"]).toBe("Acme");
    expect(out["accountDomain"]).toBe("acme.com");
  });

  it("flattens to-many relationships as arrays of objects", () => {
    const tagA: JsonApiResource = { type: "tag", id: 1, attributes: { label: "vip" } };
    const tagB: JsonApiResource = { type: "tag", id: 2, attributes: { label: "warm" } };
    const out = normalizeResource(sampleProspect, indexIncluded([tagA, tagB]), {
      tags: ["label"],
    });
    expect(out["tags"]).toEqual([{ label: "vip" }, { label: "warm" }]);
  });

  it("supports the * wildcard projection", () => {
    const out = normalizeResource(sampleProspect, indexIncluded([sampleAccount]), {
      account: ["*"],
    });
    expect(out["accountName"]).toBe("Acme");
    expect(out["accountDomain"]).toBe("acme.com");
  });

  it("coerces numeric-string IDs to numbers, preserves non-numeric IDs", () => {
    const numeric = normalizeResource({ type: "x", id: "42", attributes: {} }, indexIncluded([]));
    expect(numeric["id"]).toBe(42);
    const opaque = normalizeResource(
      { type: "x", id: "abc-123", attributes: {} },
      indexIncluded([]),
    );
    expect(opaque["id"]).toBe("abc-123");
  });
});

describe("normalizeDocument", () => {
  it("handles array data", () => {
    const doc: JsonApiDocument = {
      data: [sampleProspect, { type: "prospect", id: 43, attributes: { firstName: "Jane" } }],
      included: [sampleAccount, sampleOwner],
      meta: { count: 2 },
    };
    const out = normalizeDocument(doc);
    expect(Array.isArray(out.data)).toBe(true);
    if (Array.isArray(out.data)) {
      expect(out.data).toHaveLength(2);
      expect(out.data[0]!["firstName"]).toBe("Joe");
    }
    expect(out.meta?.count).toBe(2);
  });

  it("handles single-resource data", () => {
    const doc: JsonApiDocument = { data: sampleProspect, included: [sampleAccount] };
    const out = normalizeDocument(doc, { account: ["name"] });
    expect(Array.isArray(out.data)).toBe(false);
    if (!Array.isArray(out.data) && out.data !== undefined) {
      expect(out.data["accountName"]).toBe("Acme");
    }
  });

  it("returns undefined data when the document has none", () => {
    const out = normalizeDocument({});
    expect(out.data).toBeUndefined();
  });
});

describe("extractNextCursor", () => {
  it("returns the page[after] cursor from links.next", () => {
    const cursor = extractNextCursor({
      next: "https://api.outreach.io/api/v2/prospects?page%5Bafter%5D=abc",
    });
    expect(cursor).toBe("abc");
  });

  it("returns null when links is undefined", () => {
    expect(extractNextCursor(undefined)).toBeNull();
  });

  it("returns null when next is empty", () => {
    expect(extractNextCursor({ next: "" })).toBeNull();
  });

  it("returns null when the URL is malformed", () => {
    expect(extractNextCursor({ next: "not-a-url" })).toBeNull();
  });

  it("returns null when next has no page[after] param", () => {
    expect(extractNextCursor({ next: "https://api.outreach.io/api/v2/prospects" })).toBeNull();
  });
});
