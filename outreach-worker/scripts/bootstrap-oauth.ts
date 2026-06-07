#!/usr/bin/env node
// One-time OAuth consent flow.
//
// Walks the user through Outreach's authorize endpoint, captures the
// redirect on a local loopback HTTP server, exchanges the code for a
// refresh token, persists the result to the on-disk cache, and prints
// an .env block for the user to save.
//
// Security:
//   - Loopback only (binds 127.0.0.1; not reachable from network).
//   - PKCE S256 — client secret never appears in the browser URL.
//   - CSRF-resistant state parameter, rejected on mismatch.
//   - Refresh token written to a 0600 file in 0700 parent directory.
//
// Run via:  npm run bootstrap:oauth

import { spawn } from "node:child_process";

import {
  awaitCallback,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  generatePkcePair,
  generateState,
} from "../src/auth/bootstrap.js";
import { OUTREACH_READ_SCOPES, scopeString } from "../src/auth/scopes.js";
import { FileTokenCache } from "../src/auth/tokenCache.js";
import { loadBootstrapConfig } from "../src/config/index.js";

const AUTHORIZE_ENDPOINT = "https://api.outreach.io/oauth/authorize";
const TOKEN_ENDPOINT = "https://api.outreach.io/oauth/token";
const CALLBACK_PATH = "/callback";

async function main(): Promise<void> {
  const cfg = loadBootstrapConfig();
  const redirectUri = `http://127.0.0.1:${String(cfg.redirectPort)}${CALLBACK_PATH}`;
  const state = generateState();
  const pkce = generatePkcePair();

  const authorizeUrl = buildAuthorizeUrl({
    authorizeEndpoint: AUTHORIZE_ENDPOINT,
    clientId: cfg.oauth.clientId,
    redirectUri,
    scope: scopeString(),
    state,
    codeChallenge: pkce.challenge,
  });

  console.log("→ outreach-api-mcp OAuth bootstrap");
  console.log(`→ Redirect URI: ${redirectUri}`);
  console.log(`→ Token cache:  ${cfg.tokenCachePath}`);
  console.log(`→ Scopes (${String(OUTREACH_READ_SCOPES.length)}): ${scopeString()}`);
  console.log();
  console.log("Make sure your Outreach OAuth app has the redirect URI above registered.");
  console.log("Opening your browser. If it does not open, copy this URL manually:");
  console.log();
  console.log(`  ${authorizeUrl.toString()}`);
  console.log();

  const handle = await awaitCallback(cfg.redirectPort, state);
  openBrowser(authorizeUrl.toString());

  const callback = await handle.result;
  console.log("✓ Callback received. Exchanging authorization code for token...");

  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint: TOKEN_ENDPOINT,
    code: callback.code,
    redirectUri,
    clientId: cfg.oauth.clientId,
    clientSecret: cfg.oauth.clientSecret,
    codeVerifier: pkce.verifier,
  });

  await new FileTokenCache(cfg.tokenCachePath).write({
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
    updatedAt: new Date().toISOString(),
  });

  console.log(`✓ Refresh token captured and persisted to: ${cfg.tokenCachePath}`);
  console.log();
  console.log("Add this to your .env file (or the env your MCP client sources):");
  console.log("---");
  console.log(`OUTREACH_CLIENT_ID=${cfg.oauth.clientId}`);
  console.log(`OUTREACH_CLIENT_SECRET=${cfg.oauth.clientSecret}`);
  console.log(`OUTREACH_REFRESH_TOKEN=${tokens.refreshToken}`);
  console.log("---");
  console.log();
  console.log("You can now start the MCP server with: node dist/index.js");
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Best-effort. The URL is already printed for manual copy/paste.
  }
}

main().catch((e: unknown) => {
  console.error("Bootstrap failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
