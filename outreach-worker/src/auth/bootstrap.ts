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

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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
  // SEC-07: timing-safe state comparison. Plain `!==` short-circuits at
  // the first differing byte, which leaks the matching prefix length to
  // an attacker who can observe response timing. The states are equal-
  // length by construction (32-byte base64url) but we length-guard
  // anyway since timingSafeEqual throws on length mismatch.
  if (state === null || !constantTimeEquals(state, expectedState)) {
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

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// ─── Loopback callback listener (extracted from the CLI for testability) ───

export interface CallbackPayload {
  readonly code: string;
}

export interface AwaitCallbackOptions {
  /** Path the listener accepts (default: "/callback"). */
  readonly callbackPath?: string;
  /** Reject the promise after this many ms (default: 5 minutes). */
  readonly timeoutMs?: number;
}

export interface AwaitCallbackHandle {
  /** Resolved with `{ code }` on a valid callback; rejected on error/timeout. */
  readonly result: Promise<CallbackPayload>;
  /**
   * Actual bound port — useful when `port === 0` (ephemeral). Valid only
   * after the listener is bound, which is guaranteed by the time the
   * `awaitCallback` promise resolves.
   */
  readonly port: number;
  /** Close the listener early without waiting for resolve/reject. */
  close(): void;
}

const DEFAULT_CALLBACK_PATH = "/callback";
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Stand up a 127.0.0.1-only HTTP listener that resolves with the OAuth
 * `code` parameter on a valid callback, or rejects on state mismatch /
 * provider error / missing code / timeout / non-callback request.
 *
 * Pass `port === 0` to bind an ephemeral port (returned in the handle).
 * The returned promise resolves only after `listen` succeeds, so callers
 * can read `handle.port` immediately. The listener closes itself on
 * resolve, reject, or `close()`.
 */
export function awaitCallback(
  port: number,
  expectedState: string,
  options: AwaitCallbackOptions = {},
): Promise<AwaitCallbackHandle> {
  const callbackPath = options.callbackPath ?? DEFAULT_CALLBACK_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;

  let resolveFn: (payload: CallbackPayload) => void = () => undefined;
  let rejectFn: (err: Error) => void = () => undefined;
  const result = new Promise<CallbackPayload>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
    const addr = server.address();
    const boundPort = addr !== null && typeof addr === "object" ? addr.port : port;
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${String(boundPort)}`);
    // SEC-07: OAuth authorization-code flow requires the provider to
    // redirect via 302→GET to the callback. Reject any other method
    // outright (405) so a stray POST/PUT/DELETE can never inject params
    // into `parseCallback` and so a tab "preflight" can't accidentally
    // trip the listener.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      respond(res, 405, "Method Not Allowed");
      return;
    }
    if (url.pathname !== callbackPath) {
      respond(res, 404, "Not Found");
      return;
    }
    try {
      const parsed = parseCallback(url.searchParams, expectedState);
      respond(res, 200, "Outreach authorization complete. You can close this tab.");
      cleanup();
      resolveFn({ code: parsed.code });
    } catch (e) {
      const message = e instanceof CallbackError ? e.message : "Unexpected callback error.";
      respond(res, 400, escapeHtml(message));
      cleanup();
      rejectFn(e instanceof Error ? e : new Error(String(e)));
    }
  });

  const timeoutHandle = setTimeout(() => {
    cleanup();
    rejectFn(new Error(`Timed out waiting for OAuth callback after ${String(timeoutMs / 1000)}s.`));
  }, timeoutMs);

  function cleanup(): void {
    clearTimeout(timeoutHandle);
    server.close();
  }

  return new Promise<AwaitCallbackHandle>((resolveHandle, rejectHandle) => {
    server.once("listening", () => {
      const addr = server.address();
      const boundPort = addr !== null && typeof addr === "object" ? addr.port : port;
      server.on("error", (e) => {
        cleanup();
        rejectFn(e);
      });
      resolveHandle({
        result,
        port: boundPort,
        close: cleanup,
      });
    });
    server.once("error", (e) => {
      cleanup();
      rejectHandle(e);
    });
    server.listen(port, "127.0.0.1");
  });
}

function respond(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>outreach-api-mcp</title></head><body style="font-family:system-ui,sans-serif;max-width:640px;margin:80px auto;padding:0 24px"><h1>${message}</h1></body></html>`,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
