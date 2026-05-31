import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAuthorizeUrl,
  CallbackError,
  exchangeAuthorizationCode,
  generatePkcePair,
  generateState,
  parseCallback,
  TokenExchangeError,
} from "../../../src/auth/bootstrap.js";
import { configureLogger } from "../../../src/logger.js";

beforeEach(() => {
  configureLogger("error");
});
afterEach(() => {
  vi.restoreAllMocks();
  configureLogger("info");
});

describe("generatePkcePair", () => {
  it("produces a base64url verifier of expected length", () => {
    const { verifier, method } = generatePkcePair();
    expect(method).toBe("S256");
    // 64 random bytes → 86 chars base64url (no padding).
    expect(verifier.length).toBeGreaterThanOrEqual(86);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("computes the S256 challenge as SHA-256 of the verifier in base64url", () => {
    const { verifier, challenge } = generatePkcePair();
    const expected = createHash("sha256").update(verifier).digest().toString("base64url");
    expect(challenge).toBe(expected);
  });

  it("produces a different pair each call", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("generateState", () => {
  it("produces a base64url string of expected length", () => {
    const s = generateState();
    // 32 random bytes → 43 chars base64url (no padding).
    expect(s.length).toBeGreaterThanOrEqual(43);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces a different value each call", () => {
    expect(generateState()).not.toBe(generateState());
  });
});

describe("buildAuthorizeUrl", () => {
  const baseOpts = {
    authorizeEndpoint: "https://api.outreach.io/oauth/authorize",
    clientId: "cid",
    redirectUri: "http://127.0.0.1:8765/callback",
    scope: "users.read accounts.read",
    state: "state-abc",
    codeChallenge: "challenge-xyz",
  };

  it("sets every required OAuth parameter", () => {
    const url = buildAuthorizeUrl(baseOpts);
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8765/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("users.read accounts.read");
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("targets the supplied authorize endpoint", () => {
    const url = buildAuthorizeUrl(baseOpts);
    expect(url.origin).toBe("https://api.outreach.io");
    expect(url.pathname).toBe("/oauth/authorize");
  });
});

describe("parseCallback", () => {
  it("returns the code on a clean callback with matching state", () => {
    const params = new URLSearchParams({ code: "auth-code", state: "expected" });
    expect(parseCallback(params, "expected").code).toBe("auth-code");
  });

  it("rejects state mismatch as a CSRF candidate", () => {
    const params = new URLSearchParams({ code: "auth-code", state: "other" });
    expect(() => parseCallback(params, "expected")).toThrow(CallbackError);
    expect(() => parseCallback(params, "expected")).toThrow(/CSRF/);
  });

  it("rejects callbacks carrying an OAuth error parameter", () => {
    const params = new URLSearchParams({
      error: "access_denied",
      error_description: "user said no",
      state: "expected",
    });
    expect(() => parseCallback(params, "expected")).toThrow(CallbackError);
    expect(() => parseCallback(params, "expected")).toThrow(/access_denied/);
  });

  it("rejects callbacks missing the code parameter", () => {
    const params = new URLSearchParams({ state: "expected" });
    expect(() => parseCallback(params, "expected")).toThrow(/missing authorization code/);
  });

  it("rejects callbacks missing the state parameter", () => {
    const params = new URLSearchParams({ code: "auth-code" });
    expect(() => parseCallback(params, "expected")).toThrow(/state mismatch/);
  });
});

describe("exchangeAuthorizationCode", () => {
  const baseArgs = {
    tokenEndpoint: "https://api.outreach.io/oauth/token",
    code: "code-1",
    redirectUri: "http://127.0.0.1:8765/callback",
    clientId: "cid",
    clientSecret: "csecret",
    codeVerifier: "v-1",
  };

  function jsonResponse(status: number, body: unknown, statusText = "OK"): Response {
    return new Response(JSON.stringify(body), {
      status,
      statusText,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("posts the authorization_code grant with the verifier", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );
    await exchangeAuthorizationCode({ ...baseArgs, fetch: fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(baseArgs.tokenEndpoint);
    expect(init?.method).toBe("POST");
    // exchangeAuthorizationCode sends the body as a URL-encoded string,
    // not an object — assert the string contents directly.
    expect(typeof init?.body).toBe("string");
    const body = init?.body as string;
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=code-1");
    expect(body).toContain("code_verifier=v-1");
    expect(body).toContain("client_id=cid");
    expect(body).toContain("client_secret=csecret");
  });

  it("returns parsed tokens on a 200 response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );
    const result = await exchangeAuthorizationCode({ ...baseArgs, fetch: fetchImpl });
    expect(result).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresIn: 3600,
      tokenType: "Bearer",
    });
  });

  it("throws TokenExchangeError on a non-2xx response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }, "Bad Request"));
    await expect(
      exchangeAuthorizationCode({ ...baseArgs, fetch: fetchImpl }),
    ).rejects.toBeInstanceOf(TokenExchangeError);
  });

  it("throws TokenExchangeError on an unexpected response shape", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { not_a: "token_response" }));
    await expect(
      exchangeAuthorizationCode({ ...baseArgs, fetch: fetchImpl }),
    ).rejects.toBeInstanceOf(TokenExchangeError);
  });
});
