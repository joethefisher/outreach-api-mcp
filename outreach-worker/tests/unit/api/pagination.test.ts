import { describe, expect, it, vi } from "vitest";

import type { JsonApiDocument, JsonApiResource } from "../../../src/api/jsonapi.js";
import { paginate, type PaginatedFetch } from "../../../src/api/pagination.js";

function page(
  records: readonly JsonApiResource[],
  next: string | null = null,
  included: readonly JsonApiResource[] = [],
): JsonApiDocument<readonly JsonApiResource[]> {
  return {
    data: records,
    included,
    ...(next === null
      ? {}
      : {
          links: {
            next: `https://api.outreach.io/api/v2/prospects?page%5Bafter%5D=${next}`,
          },
        }),
  };
}

function resource(id: number, type = "prospect"): JsonApiResource {
  return { type, id, attributes: { id_marker: id } };
}

describe("paginate", () => {
  it("walks every page until next is null", async () => {
    const calls: (string | null)[] = [];
    const fetchPage: PaginatedFetch = (cursor) => {
      calls.push(cursor);
      if (cursor === null) return Promise.resolve(page([resource(1), resource(2)], "c1"));
      if (cursor === "c1") return Promise.resolve(page([resource(3)], "c2"));
      return Promise.resolve(page([resource(4)], null));
    };
    const result = await paginate(fetchPage);
    expect(calls).toEqual([null, "c1", "c2"]);
    expect(result.data.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(result.pagesWalked).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("stops at maxPages and flags truncated=true", async () => {
    const fetchPage: PaginatedFetch = vi
      .fn<PaginatedFetch>()
      .mockResolvedValue(page([resource(1)], "infinite-cursor"));
    const result = await paginate(fetchPage, { maxPages: 3 });
    expect(result.pagesWalked).toBe(3);
    expect(result.truncated).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("stops at maxRecords and flags truncated only when more pages remain", async () => {
    const fetchPage: PaginatedFetch = (cursor) => {
      if (cursor === null)
        return Promise.resolve(page([resource(1), resource(2), resource(3)], "c1"));
      return Promise.resolve(page([resource(4)], null));
    };
    const result = await paginate(fetchPage, { maxRecords: 3 });
    expect(result.data).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("does NOT flag truncated when the record cap is met on the last page exactly", async () => {
    const fetchPage: PaginatedFetch = () => Promise.resolve(page([resource(1), resource(2)], null));
    const result = await paginate(fetchPage, { maxRecords: 2 });
    expect(result.data).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it("dedupes included[] across pages by type:id", async () => {
    const accountA: JsonApiResource = { type: "account", id: 7, attributes: { name: "Acme" } };
    const fetchPage: PaginatedFetch = (cursor) => {
      if (cursor === null) return Promise.resolve(page([resource(1)], "c1", [accountA]));
      return Promise.resolve(page([resource(2)], null, [accountA]));
    };
    const result = await paginate(fetchPage);
    expect(result.included).toHaveLength(1);
    expect(result.included[0]).toBe(accountA);
  });

  it("invokes onPage for each page and skips accumulation when provided", async () => {
    const seen: number[] = [];
    const fetchPage: PaginatedFetch = (cursor) => {
      if (cursor === null) return Promise.resolve(page([resource(1)], "c1"));
      return Promise.resolve(page([resource(2)], null));
    };
    const result = await paginate(fetchPage, {
      onPage: (doc) => {
        for (const r of doc.data ?? []) seen.push(r.id as number);
      },
    });
    expect(seen).toEqual([1, 2]);
    expect(result.data).toEqual([]);
    expect(result.pagesWalked).toBe(2);
  });

  it("handles empty pages without errors", async () => {
    const fetchPage: PaginatedFetch = vi.fn<PaginatedFetch>().mockResolvedValue(page([], null));
    const result = await paginate(fetchPage);
    expect(result.data).toEqual([]);
    expect(result.pagesWalked).toBe(1);
  });
});
