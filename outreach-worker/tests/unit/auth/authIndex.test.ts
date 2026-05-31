import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthError,
  getAccessToken,
  getOAuthClient,
  resetOAuthClient,
  setOAuthClient,
} from "../../../src/auth/index.js";
import {
  OAuthClient,
  OAuthError,
  OAuthInvalidGrantError,
  OAuthNotInitializedError,
} from "../../../src/auth/oauth.js";
import { configureLogger } from "../../../src/logger.js";
import { InMemoryTokenCache } from "../../fixtures/inMemoryTokenCache.js";

beforeEach(() => { configureLogger("error"); });
afterEach(() => {
  vi.restoreAllMocks();
  resetOAuthClient();
  configureLogger("info");
});

function fakeClient(throwing: Error | string): OAuthClient {
  return {
    getAccessToken: () =>
      throwing instanceof Error ? Promise.reject(throwing) : Promise.resolve(throwing),
  } as unknown as OAuthClient;
}

describe("getAccessToken envelope wrapping", () => {
  it("wraps OAuthNotInitializedError into AuthError(oauthNotConnected)", async () => {
    setOAuthClient(fakeClient(new OAuthNotInitializedError()));
    try {
      await getAccessToken();
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).envelope.error).toBe("oauthNotConnected");
    }
  });

  it("wraps OAuthInvalidGrantError into AuthError(tokenInvalid)", async () => {
    setOAuthClient(fakeClient(new OAuthInvalidGrantError("bad")));
    try {
      await getAccessToken();
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect((e as AuthError).envelope.error).toBe("tokenInvalid");
    }
  });

  it("passes through other errors unchanged", async () => {
    const original = new OAuthError("network down");
    setOAuthClient(fakeClient(original));
    await expect(getAccessToken()).rejects.toBe(original);
  });

  it("returns the access token on success", async () => {
    setOAuthClient(fakeClient("at-success"));
    expect(await getAccessToken()).toBe("at-success");
  });
});

describe("getOAuthClient singleton", () => {
  it("constructs a client from env config when none is set", () => {
    const prev = { ...process.env };
    process.env["OUTREACH_CLIENT_ID"] = "cid";
    process.env["OUTREACH_CLIENT_SECRET"] = "csecret";
    process.env["OUTREACH_TOKEN_CACHE_PATH"] = "/tmp/outreach-auth-index-test.json";
    try {
      const c1 = getOAuthClient();
      const c2 = getOAuthClient();
      expect(c1).toBe(c2);
    } finally {
      process.env = prev;
    }
  });

  it("returns the injected client when one has been set", () => {
    const injected = new OAuthClient({
      clientId: "x",
      clientSecret: "y",
      tokenEndpoint: "https://example/token",
      cache: new InMemoryTokenCache(),
    });
    setOAuthClient(injected);
    expect(getOAuthClient()).toBe(injected);
  });
});
