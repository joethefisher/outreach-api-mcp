import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OAuthClient,
  OAuthError,
  OAuthInvalidGrantError,
  OAuthNotInitializedError,
} from "../../../src/auth/oauth.js";
import { configureLogger } from "../../../src/logger.js";
import { InMemoryTokenCache } from "../../fixtures/inMemoryTokenCache.js";

const TOKEN_ENDPOINT = "https://example.outreach.io/oauth/token";
const FIXED_NOW = 1_700_000_000_000;

interface MockTokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
  readonly token_type: "Bearer";
}

function jsonResponse(status: number, body: unknown, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

function freshClient(opts: {
  initialRefreshToken?: string;
  fetchImpl: typeof fetch;
  cache?: InMemoryTokenCache;
}): { client: OAuthClient; cache: InMemoryTokenCache } {
  const cache = opts.cache ?? new InMemoryTokenCache();
  const baseOpts = {
    clientId: "cid",
    clientSecret: "csecret",
    tokenEndpoint: TOKEN_ENDPOINT,
    cache,
    fetch: opts.fetchImpl,
    now: () => FIXED_NOW,
  };
  const client = new OAuthClient(
    opts.initialRefreshToken === undefined
      ? baseOpts
      : { ...baseOpts, initialRefreshToken: opts.initialRefreshToken },
  );
  return { client, cache };
}

beforeEach(() => {
  configureLogger("error");
});
afterEach(() => {
  vi.restoreAllMocks();
  configureLogger("info");
});

describe("OAuthClient.getAccessToken — initialization", () => {
  it("throws OAuthNotInitializedError when cache and seed are both empty", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { client } = freshClient({ fetchImpl });
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(OAuthNotInitializedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the seed refresh token and persists it to the cache on first use", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        access_token: "at-1",
        refresh_token: "rt-rotated",
        expires_in: 3600,
        token_type: "Bearer",
      } satisfies MockTokenResponse),
    );
    const { client, cache } = freshClient({ initialRefreshToken: "rt-seed", fetchImpl });

    const token = await client.getAccessToken();
    expect(token).toBe("at-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Cache holds the rotated refresh token AND the access token, with expiry.
    const stored = await cache.read();
    expect(stored?.refreshToken).toBe("rt-rotated");
    expect(stored?.accessToken).toBe("at-1");
    expect(stored?.accessTokenExpiresAt).toBe(FIXED_NOW + 3600_000);
  });
});

describe("OAuthClient.getAccessToken — refresh", () => {
  it("sends grant_type=refresh_token with credentials in the body", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        access_token: "at-1",
        expires_in: 3600,
        token_type: "Bearer",
      } satisfies MockTokenResponse),
    );
    const { client } = freshClient({ initialRefreshToken: "rt-seed", fetchImpl });
    await client.getAccessToken();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(TOKEN_ENDPOINT);
    const initObj = init!;
    expect(initObj.method).toBe("POST");
    expect(initObj.body).toContain("grant_type=refresh_token");
    expect(initObj.body).toContain("refresh_token=rt-seed");
    expect(initObj.body).toContain("client_id=cid");
    expect(initObj.body).toContain("client_secret=csecret");
  });

  it("does not rotate the refresh token when the server omits it", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        access_token: "at-1",
        expires_in: 3600,
        token_type: "Bearer",
      } satisfies MockTokenResponse),
    );
    const { client, cache } = freshClient({ initialRefreshToken: "rt-seed", fetchImpl });
    await client.getAccessToken();
    const stored = await cache.read();
    expect(stored?.refreshToken).toBe("rt-seed");
  });

  it("returns the cached access token when called again before expiry", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        access_token: "at-1",
        expires_in: 3600,
        token_type: "Bearer",
      } satisfies MockTokenResponse),
    );
    const { client } = freshClient({ initialRefreshToken: "rt-seed", fetchImpl });
    await client.getAccessToken();
    await client.getAccessToken();
    await client.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent refresh calls into a single network exchange", async () => {
    let resolveFetch: ((res: Response) => void) | null = null;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { client } = freshClient({ initialRefreshToken: "rt-seed", fetchImpl });
    const p1 = client.getAccessToken();
    const p2 = client.getAccessToken();
    const p3 = client.getAccessToken();
    // performRefresh awaits cache.read() before reaching fetch; drain the
    // microtask queue so the fetch mock has been invoked.
    await new Promise<void>((r) => {
      setImmediate(r);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch!(
      jsonResponse(200, {
        access_token: "at-1",
        expires_in: 3600,
        token_type: "Bearer",
      } satisfies MockTokenResponse),
    );
    const [t1, t2, t3] = await Promise.all([p1, p2, p3]);
    expect(t1).toBe("at-1");
    expect(t2).toBe("at-1");
    expect(t3).toBe("at-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("OAuthClient.getAccessToken — failure paths", () => {
  it("translates a 400 invalid_grant into OAuthInvalidGrantError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }, "Bad Request"));
    const { client } = freshClient({ initialRefreshToken: "rt-seed", fetchImpl });
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(OAuthInvalidGrantError);
  });

  it("translates a 401 into OAuthInvalidGrantError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(401, { error: "invalid_client" }, "Unauthorized"));
    const { client } = freshClient({ initialRefreshToken: "rt-seed", fetchImpl });
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(OAuthInvalidGrantError);
  });

  it("translates a 500 into OAuthError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(500, { error: "server_error" }, "Internal Server Error"));
    const { client } = freshClient({ initialRefreshToken: "rt-seed", fetchImpl });
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(OAuthError);
  });

  it("rejects an unexpected response shape", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { not_a: "token_response" }));
    const { client } = freshClient({ initialRefreshToken: "rt-seed", fetchImpl });
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(OAuthError);
  });

  it("releases the in-flight slot on failure so the next call can retry", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(500, { error: "x" }, "ISE"))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "at-2",
          expires_in: 3600,
          token_type: "Bearer",
        } satisfies MockTokenResponse),
      );
    const { client } = freshClient({ initialRefreshToken: "rt-seed", fetchImpl });
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(OAuthError);
    const token = await client.getAccessToken();
    expect(token).toBe("at-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
