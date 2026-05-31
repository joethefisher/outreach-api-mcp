import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OAuthClient } from "../../../src/auth/oauth.js";
import { configureLogger } from "../../../src/logger.js";
import { InMemoryTokenCache } from "../../fixtures/inMemoryTokenCache.js";

const TOKEN_ENDPOINT = "https://example.outreach.io/oauth/token";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  configureLogger("error");
});
afterEach(() => {
  vi.restoreAllMocks();
  configureLogger("info");
});

describe("OAuthClient.invalidateAccessToken", () => {
  it("forces the next getAccessToken to perform a fresh refresh exchange", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "at-1",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "at-2",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      );
    const client = new OAuthClient({
      clientId: "cid",
      clientSecret: "csec",
      tokenEndpoint: TOKEN_ENDPOINT,
      cache: new InMemoryTokenCache(),
      initialRefreshToken: "rt-seed",
      fetch: fetchImpl,
      now: () => 1_700_000_000_000,
    });
    expect(await client.getAccessToken()).toBe("at-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Without invalidation, the in-memory cache would serve at-1.
    expect(await client.getAccessToken()).toBe("at-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // After invalidation, the next call goes back to the token endpoint.
    client.invalidateAccessToken();
    expect(await client.getAccessToken()).toBe("at-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not invalidate the refresh token state", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        access_token: "at-1",
        refresh_token: "rt-from-server",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );
    const cache = new InMemoryTokenCache();
    const client = new OAuthClient({
      clientId: "cid",
      clientSecret: "csec",
      tokenEndpoint: TOKEN_ENDPOINT,
      cache,
      initialRefreshToken: "rt-seed",
      fetch: fetchImpl,
      now: () => 1_700_000_000_000,
    });
    await client.getAccessToken();
    client.invalidateAccessToken();
    // Cache still holds the rotated refresh token.
    const stored = await cache.read();
    expect(stored?.refreshToken).toBe("rt-from-server");
  });
});
