// OAuth2 refresh-token grant runtime.
//
// Owns the access token lifecycle for the MCP server:
//   - Reads the refresh token from the on-disk cache (or env seed on first run).
//   - Exchanges it for an access token via the configured token endpoint.
//   - Coalesces concurrent callers via a single in-flight refresh promise.
//   - Caches the access token in memory until just before its expiry.
//   - Rotates the refresh token if the server returns a new one.
//
// Never logs tokens. The structured logger redacts the relevant fields, but
// this module also takes care not to include token material in any log call.

import { logger } from "../logger.js";
import type { TokenCache } from "./tokenCache.js";

const ACCESS_TOKEN_REFRESH_BUFFER_SECONDS = 60;
const REFRESH_REQUEST_TIMEOUT_MS = 30_000;

export interface OAuthClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenEndpoint: string;
  readonly cache: TokenCache;
  /** Seed refresh token used only if the cache is empty on first call. */
  readonly initialRefreshToken?: string;
  /** Injectable for tests. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
  readonly token_type: "Bearer";
  readonly scope?: string;
}

export class OAuthNotInitializedError extends Error {
  constructor() {
    super("No refresh token available. Run `npm run bootstrap:oauth` first.");
    this.name = "OAuthNotInitializedError";
  }
}

export class OAuthInvalidGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthInvalidGrantError";
  }
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

export class OAuthClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tokenEndpoint: string;
  private readonly cache: TokenCache;
  private readonly initialRefreshToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private inflight: Promise<string> | null = null;
  private cachedAccessToken: string | null = null;
  private cachedAccessTokenExpiresAt = 0;

  constructor(opts: OAuthClientOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.tokenEndpoint = opts.tokenEndpoint;
    this.cache = opts.cache;
    this.initialRefreshToken = opts.initialRefreshToken;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Return a valid access token, refreshing if necessary. Coalesces
   * concurrent callers — only one network exchange is in flight at a time.
   */
  async getAccessToken(): Promise<string> {
    if (
      this.cachedAccessToken !== null &&
      this.now() + ACCESS_TOKEN_REFRESH_BUFFER_SECONDS * 1000 < this.cachedAccessTokenExpiresAt
    ) {
      return this.cachedAccessToken;
    }
    if (this.inflight === null) {
      const promise = this.performRefresh();
      this.inflight = promise.finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /**
   * Invalidate the in-memory access token cache. The next getAccessToken()
   * call will trigger a fresh refresh-grant exchange. Used by the API client
   * when Outreach returns 401 mid-stream (token revoked before its TTL).
   * Refresh token state is unaffected.
   */
  invalidateAccessToken(): void {
    this.cachedAccessToken = null;
    this.cachedAccessTokenExpiresAt = 0;
  }

  private async performRefresh(): Promise<string> {
    const refreshToken = await this.resolveRefreshToken();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, REFRESH_REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetchImpl(this.tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (response.status === 400 || response.status === 401) {
      throw new OAuthInvalidGrantError(
        `Refresh failed (${String(response.status)}). The refresh token may be invalid or revoked. Re-run \`npm run bootstrap:oauth\`.`,
      );
    }
    if (!response.ok) {
      throw new OAuthError(
        `Token endpoint returned ${String(response.status)} ${response.statusText}.`,
      );
    }

    const json: unknown = await response.json();
    if (!isOAuthTokenResponse(json)) {
      throw new OAuthError("Token endpoint returned an unexpected response shape.");
    }

    const expiresAt = this.now() + json.expires_in * 1000;
    const newRefreshToken = json.refresh_token ?? refreshToken;
    const rotated = json.refresh_token !== undefined && json.refresh_token !== refreshToken;

    await this.cache.write({
      refreshToken: newRefreshToken,
      accessToken: json.access_token,
      accessTokenExpiresAt: expiresAt,
      updatedAt: new Date(this.now()).toISOString(),
    });

    this.cachedAccessToken = json.access_token;
    this.cachedAccessTokenExpiresAt = expiresAt;

    logger.info("oauth.refresh.success", {
      rotated,
      expiresInSeconds: json.expires_in,
    });

    return json.access_token;
  }

  private async resolveRefreshToken(): Promise<string> {
    const cached = await this.cache.read();
    if (cached !== null) return cached.refreshToken;
    if (this.initialRefreshToken !== undefined) {
      await this.cache.write({
        refreshToken: this.initialRefreshToken,
        updatedAt: new Date(this.now()).toISOString(),
      });
      return this.initialRefreshToken;
    }
    throw new OAuthNotInitializedError();
  }
}

function isOAuthTokenResponse(value: unknown): value is OAuthTokenResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["access_token"] !== "string" || v["access_token"].length === 0) return false;
  if (typeof v["expires_in"] !== "number" || v["expires_in"] <= 0) return false;
  if (v["refresh_token"] !== undefined && typeof v["refresh_token"] !== "string") return false;
  return true;
}
