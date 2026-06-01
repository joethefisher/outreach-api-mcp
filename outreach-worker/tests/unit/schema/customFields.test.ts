import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutreachClient } from "../../../src/api/client.js";
import { configureLogger } from "../../../src/logger.js";
import { CustomFieldSchemaCache } from "../../../src/schema/customFields.js";

interface StubClient extends OutreachClient {
  fetchTypesCalls: number;
}

function stubClient(typesResponse: unknown): StubClient {
  let calls = 0;
  return {
    list: () => Promise.reject(new Error("list not used in schema tests")),
    get: () => Promise.reject(new Error("get not used in schema tests")),
    count: () => Promise.reject(new Error("count not used in schema tests")),
    listUsers: () => Promise.reject(new Error("listUsers not used in schema tests")),
    fetchTypes: () => {
      calls++;
      return typesResponse instanceof Error
        ? Promise.reject(typesResponse)
        : Promise.resolve(typesResponse);
    },
    get fetchTypesCalls(): number {
      return calls;
    },
  };
}

const liveTypesResponse = {
  data: [
    {
      type: "Prospect",
      meta: {
        validations: {
          custom1: { label: "Industry", type: "string" },
          custom2: { label: "Tier", type: "string" },
          custom3: { label: null }, // unconfigured slot — must be skipped
          custom4: {}, // missing label — must be skipped
        },
      },
    },
    {
      type: "Account",
      meta: {
        validations: {
          custom1: { label: "Region", type: "string" },
        },
      },
    },
  ],
};

beforeEach(() => {
  configureLogger("error");
});
afterEach(() => {
  vi.restoreAllMocks();
  configureLogger("info");
});

describe("CustomFieldSchemaCache — population", () => {
  it("loads the live /types shape and indexes by resource", async () => {
    const cache = new CustomFieldSchemaCache(stubClient(liveTypesResponse));
    await cache.ensureLoaded();
    expect(cache.isLoaded()).toBe(true);
    expect(cache.labelForField("prospect", "custom1")).toBe("Industry");
    expect(cache.labelForField("prospect", "custom2")).toBe("Tier");
    expect(cache.labelForField("account", "custom1")).toBe("Region");
  });

  it("skips entries whose label is null or missing", async () => {
    const cache = new CustomFieldSchemaCache(stubClient(liveTypesResponse));
    await cache.ensureLoaded();
    expect(cache.labelForField("prospect", "custom3")).toBeNull();
    expect(cache.labelForField("prospect", "custom4")).toBeNull();
  });

  it("loads the legacy fixture shape (data as object map)", async () => {
    const legacy = {
      data: {
        prospect: { attributes: { custom1: { label: "Region", type: "string" } } },
      },
    };
    const cache = new CustomFieldSchemaCache(stubClient(legacy));
    await cache.ensureLoaded();
    expect(cache.labelForField("prospect", "custom1")).toBe("Region");
  });

  it("enters failed state on fetch error and stops retrying", async () => {
    const client = stubClient(new Error("network down"));
    const cache = new CustomFieldSchemaCache(client);
    await cache.ensureLoaded();
    expect(cache.isLoaded()).toBe(false);
    expect(client.fetchTypesCalls).toBe(1);
    // Second call is a no-op — failed state is sticky.
    await cache.ensureLoaded();
    expect(client.fetchTypesCalls).toBe(1);
  });

  it("scrubs token-shaped strings inside the fetch-failure warn log (NEW-3)", async () => {
    // Reproduces the residual SEC-01 leak the second-pass review flagged.
    // The fetch failure logs `{ message: e.message }`; if the upstream error
    // message embedded a Bearer header / form-encoded token / JWT — as it
    // would when client.ts pushes the first 200 chars of an upstream 4xx/5xx
    // body into outreachApiError.detail — that token must never reach stderr.
    configureLogger("warn");
    const captured: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
    try {
      const evilMessage =
        "Outreach API returned 500: Authorization: Bearer abc.def.ghi-secret; " +
        "refresh_token=very-secret-rt; jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SIGNATURE-x";
      const client = stubClient(new Error(evilMessage));
      const cache = new CustomFieldSchemaCache(client);
      await cache.ensureLoaded();

      expect(captured.length).toBeGreaterThan(0);
      const line = captured.join("");
      expect(line).toContain("schema.cache.load.failed");
      expect(line).toContain("[REDACTED]");
      // No fragment of any of the token-shaped values is allowed through.
      expect(line).not.toContain("abc.def.ghi-secret");
      expect(line).not.toContain("very-secret-rt");
      expect(line).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("dedupes concurrent ensureLoaded() into one fetch", async () => {
    const client = stubClient(liveTypesResponse);
    const cache = new CustomFieldSchemaCache(client);
    await Promise.all([cache.ensureLoaded(), cache.ensureLoaded(), cache.ensureLoaded()]);
    expect(client.fetchTypesCalls).toBe(1);
  });

  it("ignores malformed root shapes without throwing", async () => {
    const cache1 = new CustomFieldSchemaCache(stubClient(null));
    await cache1.ensureLoaded();
    expect(cache1.isLoaded()).toBe(false);

    const cache2 = new CustomFieldSchemaCache(stubClient({}));
    await cache2.ensureLoaded();
    expect(cache2.isLoaded()).toBe(false);
  });
});

describe("CustomFieldSchemaCache — reverse lookup", () => {
  it("returns customN for a known label (case-insensitive)", async () => {
    const cache = new CustomFieldSchemaCache(stubClient(liveTypesResponse));
    await cache.ensureLoaded();
    expect(cache.fieldForLabel("prospect", "Industry")).toBe("custom1");
    expect(cache.fieldForLabel("prospect", "industry")).toBe("custom1");
    expect(cache.fieldForLabel("prospect", "INDUSTRY")).toBe("custom1");
  });

  it("returns null for an unknown label", async () => {
    const cache = new CustomFieldSchemaCache(stubClient(liveTypesResponse));
    await cache.ensureLoaded();
    expect(cache.fieldForLabel("prospect", "Unknown")).toBeNull();
  });
});

describe("CustomFieldSchemaCache.applyLabelsTo", () => {
  it("groups labelled custom fields under customFields", async () => {
    const cache = new CustomFieldSchemaCache(stubClient(liveTypesResponse));
    await cache.ensureLoaded();
    const record: Record<string, unknown> = {
      id: 1,
      firstName: "Joe",
      custom1: "Tech",
      custom2: "Tier 1",
    };
    const out = cache.applyLabelsTo("prospect", record);
    expect(out["custom1"]).toBeUndefined();
    expect(out["custom2"]).toBeUndefined();
    expect(out.customFields).toEqual({ Industry: "Tech", Tier: "Tier 1" });
    expect(out["firstName"]).toBe("Joe");
  });

  it("drops null/undefined/empty by default", async () => {
    const cache = new CustomFieldSchemaCache(stubClient(liveTypesResponse));
    await cache.ensureLoaded();
    const record: Record<string, unknown> = {
      id: 1,
      custom1: null,
      custom2: "",
    };
    const out = cache.applyLabelsTo("prospect", record);
    expect(out.customFields).toBeUndefined();
  });

  it("keeps null/empty when keepNulls is true", async () => {
    const cache = new CustomFieldSchemaCache(stubClient(liveTypesResponse));
    await cache.ensureLoaded();
    const out = cache.applyLabelsTo(
      "prospect",
      { id: 1, custom1: null, custom2: "" },
      { keepNulls: true },
    );
    expect(out.customFields).toEqual({ Industry: null, Tier: "" });
  });

  it("drops unmapped customN keys (noise reduction)", async () => {
    const cache = new CustomFieldSchemaCache(stubClient(liveTypesResponse));
    await cache.ensureLoaded();
    const record: Record<string, unknown> = {
      id: 1,
      custom1: "Tech",
      custom99: "garbage",
    };
    const out = cache.applyLabelsTo("prospect", record);
    expect(out["custom99"]).toBeUndefined();
    expect(out.customFields).toEqual({ Industry: "Tech" });
  });
});
