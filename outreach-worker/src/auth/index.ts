// Public auth API.
//
// Wraps the singleton OAuthClient. Tools call `getAccessToken()` and receive
// either a current bearer token or a thrown `AuthError` carrying an
// agent-facing envelope. Reset helpers are exposed for tests.

import {
  OAuthClient,
  OAuthInvalidGrantError,
  OAuthNotInitializedError,
  type OAuthClientOptions,
} from "./oauth.js";
import { FileTokenCache } from "./tokenCache.js";
import { loadRuntimeConfig } from "../config/index.js";
import {
  oauthNotConnected,
  tokenInvalid,
  type OAuthNotConnectedError,
  type TokenInvalidError,
} from "../errors/envelopes.js";


const OUTREACH_TOKEN_ENDPOINT = "https://api.outreach.io/oauth/token";

export class AuthError extends Error {
  constructor(readonly envelope: OAuthNotConnectedError | TokenInvalidError) {
    super(envelope.message);
    this.name = "AuthError";
  }
}

let cached: OAuthClient | null = null;

export function getOAuthClient(): OAuthClient {
  if (cached !== null) return cached;
  const cfg = loadRuntimeConfig();
  const baseOptions = {
    clientId: cfg.oauth.clientId,
    clientSecret: cfg.oauth.clientSecret,
    tokenEndpoint: OUTREACH_TOKEN_ENDPOINT,
    cache: new FileTokenCache(cfg.tokenCachePath),
  };
  const options: OAuthClientOptions =
    cfg.initialRefreshToken === undefined
      ? baseOptions
      : { ...baseOptions, initialRefreshToken: cfg.initialRefreshToken };
  cached = new OAuthClient(options);
  return cached;
}

export async function getAccessToken(): Promise<string> {
  try {
    return await getOAuthClient().getAccessToken();
  } catch (e) {
    if (e instanceof OAuthNotInitializedError) throw new AuthError(oauthNotConnected());
    if (e instanceof OAuthInvalidGrantError) throw new AuthError(tokenInvalid());
    throw e;
  }
}

/** Test seam — inject a pre-built client. */
export function setOAuthClient(client: OAuthClient): void {
  cached = client;
}

/** Test seam — clear the cached singleton. */
export function resetOAuthClient(): void {
  cached = null;
}
