// Bootstrap helpers for the one-time OAuth consent flow.
//
// Splits the security-sensitive pure logic (PKCE, state, code exchange,
// callback validation) out from the CLI orchestration in
// scripts/bootstrap-oauth.ts so it can be unit-tested in isolation.
//
// Security choices documented in /SECURITY.md §2.3:
//   - PKCE: 64-byte verifier from crypto.randomBytes, S256 challenge.
//   - State: 32-byte random, base64url. Mismatch on callback is rejected
//     with a CSRF-prevention error.
//   - Loopback redirect only — the caller binds 127.0.0.1, not 0.0.0.0.

import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

export function generatePkcePair(): PkcePair {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

export function generateState(): string {
  return base64url(randomBytes(32));
}

export interface BuildAuthorizeUrlOptions {
  readonly authorizeEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly state: string;
  readonly codeChallenge: string;
}

export function buildAuthorizeUrl(opts: BuildAuthorizeUrlOptions): URL {
  const url = new URL(opts.authorizeEndpoint);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", opts.scope);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

export interface CallbackParseResult {
  readonly code: string;
}

export class CallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallbackError";
  }
}

/**
 * Parse and validate the loopback callback URL. Throws CallbackError on:
 *   - state mismatch (CSRF protection)
 *   - presence of an `error` parameter from the provider
 *   - missing `code` parameter
 */
export function parseCallback(
  searchParams: URLSearchParams,
  expectedState: string,
): CallbackParseResult {
  const error = searchParams.get("error");
  if (error !== null && error !== "") {
    const desc = searchParams.get("error_description");
    throw new CallbackError(
      desc !== null && desc !== "" ? `OAuth error: ${error} (${desc})` : `OAuth error: ${error}`,
    );
  }
  const state = searchParams.get("state");
  if (state === null || state !== expectedState) {
    throw new CallbackError(
      "OAuth callback state mismatch — possible CSRF attempt. Restart the bootstrap.",
    );
  }
  const code = searchParams.get("code");
  if (code === null || code === "") {
    throw new CallbackError("OAuth callback missing authorization code.");
  }
  return { code };
}

export interface ExchangeCodeOptions {
  readonly tokenEndpoint: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly codeVerifier: string;
  /** Injectable for tests. Defaults to globalThis.fetch. */
  readonly fetch?: typeof fetch;
}

export interface TokenExchangeResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly tokenType: "Bearer";
}

export class TokenExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenExchangeError";
  }
}

export async function exchangeAuthorizationCode(
  opts: ExchangeCodeOptions,
): Promise<TokenExchangeResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code_verifier: opts.codeVerifier,
  });
  const response = await fetchImpl(opts.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new TokenExchangeError(
      `Token exchange failed (${String(response.status)} ${response.statusText})${text === "" ? "" : `: ${text.slice(0, 200)}`}`,
    );
  }
  const json: unknown = await response.json();
  if (!isTokenResponse(json)) {
    throw new TokenExchangeError("Token endpoint returned an unexpected response shape.");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    tokenType: json.token_type,
  };
}

interface RawTokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly token_type: "Bearer";
}

function isTokenResponse(value: unknown): value is RawTokenResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["access_token"] !== "string" || v["access_token"].length === 0) return false;
  if (typeof v["refresh_token"] !== "string" || v["refresh_token"].length === 0) return false;
  if (typeof v["expires_in"] !== "number" || v["expires_in"] <= 0) return false;
  if (v["token_type"] !== "Bearer") return false;
  return true;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}
