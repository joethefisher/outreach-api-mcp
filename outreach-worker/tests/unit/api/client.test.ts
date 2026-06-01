import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveOutreachClient, OutreachApiException } from "../../../src/api/client.js";
import { configureLogger } from "../../../src/logger.js";

const API_BASE = "https://api.outreach.io/api/v2";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/vnd.api+json", ...headers },
  });
}

function makeClient(opts: {
  responses: readonly Response[];
  accessTokens?: readonly string[];
  invalidateAccessToken?: () => void;
}): { client: LiveOutreachClient; calls: FetchCall[]; tokensRequested: number } {
  const calls: FetchCall[] = [];
  let responseIdx = 0;
  let tokensRequested = 0;
  const accessTokens = opts.accessTokens ?? ["initial-token", "refreshed-token"];
  const fetchImpl: typeof fetch = (url, init) => {
    const urlStr = url instanceof URL ? url.toString() : typeof url === "string" ? url : url.url;
    calls.push({ url: urlStr, init: init ?? {} });
    const response = opts.responses[responseIdx];
    if (response === undefined) {
      throw new Error(`No response queued for call ${String(responseIdx + 1)}`);
    }
    responseIdx++;
    return Promise.resolve(response);
  };
  const getAccessToken = (): Promise<string> => {
    const token = accessTokens[tokensRequested] ?? accessTokens[accessTokens.length - 1]!;
    tokensRequested++;
    return Promise.resolve(token);
  };
  const client = new LiveOutreachClient({
    apiBase: API_BASE,
    getAccessToken,
    invalidateAccessToken: opts.invalidateAccessToken ?? ((): void => undefined),
    fetch: fetchImpl,
  });
  return {
    client,
    calls,
    get tokensRequested(): number {
      return tokensRequested;
    },
  };
}

beforeEach(() => {
  configureLogger("error");
});
afterEach(() => {
  vi.restoreAllMocks();
  configureLogger("info");
});

describe("LiveOutreachClient.list", () => {
  it("issues a GET with the bearer token", async () => {
    const { client, calls } = makeClient({
      responses: [jsonResponse(200, { data: [], meta: { count: 0 } })],
    });
    await client.list("prospect", { pageSize: 25 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(`${API_BASE}/prospects`);
    expect(calls[0]!.url).toContain("page%5Bsize%5D=25");
    expect(calls[0]!.init.method).toBe("GET");
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer initial-token",
    );
  });

  it("returns normalized data with cursor and count from meta", async () => {
    const { client } = makeClient({
      responses: [
        jsonResponse(200, {
          data: [{ type: "prospect", id: 1, attributes: { firstName: "Joe" } }],
          meta: { count: 100, count_truncated: false },
          links: {
            next: "https://api.outreach.io/api/v2/prospects?page%5Bafter%5D=xyz",
          },
        }),
      ],
    });
    const result = await client.list("prospect");
    expect(result.data).toHaveLength(1);
    expect(result.nextCursor).toBe("xyz");
    expect(result.count).toBe(100);
    expect(result.countTruncated).toBe(false);
  });

  it("pluralizes irregular resource names correctly", async () => {
    const { client, calls } = makeClient({
      responses: [
        jsonResponse(200, { data: [] }),
        jsonResponse(200, { data: [] }),
        jsonResponse(200, { data: [] }),
      ],
    });
    await client.list("opportunity");
    await client.list("mailbox");
    await client.list("opportunityProspectRole");
    expect(calls[0]!.url).toContain("/opportunities");
    expect(calls[1]!.url).toContain("/mailboxes");
    expect(calls[2]!.url).toContain("/opportunityProspectRoles");
  });
});

describe("LiveOutreachClient.get", () => {
  it("issues GET with the resource id and includes", async () => {
    const { client, calls } = makeClient({
      responses: [
        jsonResponse(200, {
          data: { type: "prospect", id: 42, attributes: { firstName: "Joe" } },
        }),
      ],
    });
    const out = await client.get("prospect", 42, { includes: ["account", "owner"] });
    expect(calls[0]!.url).toContain(`${API_BASE}/prospects/42`);
    expect(calls[0]!.url).toContain("include=account%2Cowner");
    expect(out["id"]).toBe(42);
    expect(out["firstName"]).toBe("Joe");
  });

  it("throws notFound on 404", async () => {
    const { client } = makeClient({ responses: [jsonResponse(404, {})] });
    await expect(client.get("prospect", 99)).rejects.toMatchObject({
      envelope: { error: "notFound", resourceType: "prospect", id: 99 },
    });
  });
});

describe("LiveOutreachClient — 401 force-refresh retry", () => {
  it("invalidates the token cache and retries once on 401", async () => {
    let invalidateCalls = 0;
    const env = makeClient({
      responses: [
        jsonResponse(401, { errors: [{ id: "unauthorized" }] }),
        jsonResponse(200, { data: [] }),
      ],
      accessTokens: ["stale-token", "fresh-token"],
      invalidateAccessToken: () => {
        invalidateCalls++;
      },
    });
    await env.client.list("prospect");
    expect(invalidateCalls).toBe(1);
    expect(env.calls).toHaveLength(2);
    expect((env.calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer stale-token",
    );
    expect((env.calls[1]!.init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer fresh-token",
    );
    expect(env.tokensRequested).toBe(2);
  });

  it("throws tokenInvalid envelope when 401 persists after the refresh retry", async () => {
    const { client } = makeClient({
      responses: [
        jsonResponse(401, { errors: [{ id: "unauthorized" }] }),
        jsonResponse(401, { errors: [{ id: "unauthorized" }] }),
      ],
      invalidateAccessToken: () => undefined,
    });
    await expect(client.list("prospect")).rejects.toMatchObject({
      envelope: { error: "tokenInvalid" },
    });
  });
});

describe("LiveOutreachClient — 429 retry-after", () => {
  it("retries once after Retry-After on 429", async () => {
    const { client, calls } = makeClient({
      responses: [
        jsonResponse(429, { errors: [{ id: "rateLimited" }] }, { "Retry-After": "0" }),
        jsonResponse(200, { data: [] }),
      ],
    });
    await client.list("prospect");
    expect(calls).toHaveLength(2);
  });

  it("throws rateLimited envelope when 429 persists", async () => {
    const { client } = makeClient({
      responses: [
        jsonResponse(429, { errors: [] }, { "Retry-After": "0" }),
        jsonResponse(429, { errors: [] }, { "Retry-After": "30" }),
      ],
    });
    await expect(client.list("prospect")).rejects.toMatchObject({
      envelope: { error: "rateLimited", retryAfterSeconds: 30 },
    });
  });

  it("surfaces rateLimited immediately when Retry-After exceeds the auto-retry cap (AVL-01)", async () => {
    // Retry-After of 3600 (1 hour) would otherwise block the server. The
    // client surfaces rateLimited with the real wait so the agent can decide.
    const env = makeClient({
      responses: [jsonResponse(429, { errors: [] }, { "Retry-After": "3600" })],
    });
    await expect(env.client.list("prospect")).rejects.toMatchObject({
      envelope: { error: "rateLimited", retryAfterSeconds: 3600 },
    });
    // No retry should be made — only one fetch call.
    expect(env.calls).toHaveLength(1);
  });
});

describe("LiveOutreachClient — fetch timeout (AVL-02)", () => {
  it("translates fetch AbortError into a timeout envelope", async () => {
    const fetchImpl: typeof fetch = () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    };
    const client = new LiveOutreachClient({
      apiBase: API_BASE,
      getAccessToken: () => Promise.resolve("tok"),
      invalidateAccessToken: () => undefined,
      fetch: fetchImpl,
    });
    await expect(client.list("prospect")).rejects.toMatchObject({
      envelope: { error: "timeout" },
    });
  });
});

describe("LiveOutreachClient — 403 scope translation", () => {
  it("emits scopeMissing when the body names a missing scope", async () => {
    const { client } = makeClient({
      responses: [
        jsonResponse(403, {
          errors: [{ id: "forbidden", detail: 'missing scope "prospects.read"' }],
        }),
      ],
    });
    await expect(client.list("prospect")).rejects.toMatchObject({
      envelope: { error: "scopeMissing", scope: "prospects.read" },
    });
  });

  it("emits outreachApiError on a 403 with no scope hint", async () => {
    const { client } = makeClient({
      responses: [jsonResponse(403, { errors: [{ id: "forbidden", detail: "denied" }] })],
    });
    await expect(client.list("prospect")).rejects.toMatchObject({
      envelope: { error: "outreachApiError", status: 403 },
    });
  });
});

describe("LiveOutreachClient — 5xx + read-only invariant", () => {
  it("emits outreachApiError on a 500", async () => {
    const { client } = makeClient({
      responses: [jsonResponse(500, { errors: [{ id: "server" }] })],
    });
    await expect(client.list("prospect")).rejects.toBeInstanceOf(OutreachApiException);
  });

  it("only issues GET requests (read-only invariant)", async () => {
    const { client, calls } = makeClient({
      responses: [
        jsonResponse(200, { data: [] }),
        jsonResponse(200, { data: { type: "prospect", id: 1, attributes: {} } }),
        jsonResponse(200, { data: [] }),
      ],
    });
    await client.list("prospect");
    await client.get("prospect", 1);
    await client.count("prospect");
    for (const call of calls) {
      expect(call.init.method).toBe("GET");
    }
  });
});

describe("LiveOutreachClient.count", () => {
  it("requests pageSize=1 with count=true", async () => {
    const { client, calls } = makeClient({
      responses: [jsonResponse(200, { data: [], meta: { count: 1234 } })],
    });
    const result = await client.count("prospect");
    expect(result.count).toBe(1234);
    expect(result.truncated).toBe(false);
    expect(calls[0]!.url).toContain("page%5Bsize%5D=1");
    expect(calls[0]!.url).toContain("count=true");
  });

  it("surfaces count_truncated=true", async () => {
    const { client } = makeClient({
      responses: [jsonResponse(200, { data: [], meta: { count: 0, count_truncated: true } })],
    });
    const result = await client.count("prospect");
    expect(result.truncated).toBe(true);
  });
});

describe("LiveOutreachClient.listUsers", () => {
  it("maps Outreach user resources to the OutreachUser shape", async () => {
    const { client } = makeClient({
      responses: [
        jsonResponse(200, {
          data: [
            {
              type: "user",
              id: 5,
              attributes: {
                firstName: "Sally",
                lastName: "Smith",
                email: "sally@example.com",
                title: "AE",
                locked: false,
                createdAt: "2026-01-01T00:00:00Z",
              },
            },
          ],
        }),
      ],
    });
    const users = await client.listUsers();
    expect(users).toHaveLength(1);
    expect(users[0]).toEqual({
      id: 5,
      name: "Sally Smith",
      email: "sally@example.com",
      title: "AE",
      locked: false,
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  it("omits optional fields cleanly when missing", async () => {
    const { client } = makeClient({
      responses: [
        jsonResponse(200, {
          data: [{ type: "user", id: 6, attributes: { email: "x@y.z" } }],
        }),
      ],
    });
    const users = await client.listUsers();
    expect(users[0]).toEqual({ id: 6, name: "", email: "x@y.z" });
  });
});

describe("LiveOutreachClient.fetchTypes", () => {
  it("returns the raw JSON document on success", async () => {
    const { client, calls } = makeClient({
      responses: [jsonResponse(200, { data: [{ type: "Prospect", meta: {} }] })],
    });
    const doc = await client.fetchTypes();
    expect(calls[0]!.url).toBe(`${API_BASE}/types`);
    expect(doc).toEqual({ data: [{ type: "Prospect", meta: {} }] });
  });

  it("throws on non-OK status", async () => {
    const { client } = makeClient({
      responses: [jsonResponse(503, { error: "down" })],
    });
    await expect(client.fetchTypes()).rejects.toBeInstanceOf(OutreachApiException);
  });
});
