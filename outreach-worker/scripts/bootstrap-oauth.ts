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
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  buildAuthorizeUrl,
  CallbackError,
  exchangeAuthorizationCode,
  generatePkcePair,
  generateState,
  parseCallback,
} from "../src/auth/bootstrap.js";
import { OUTREACH_READ_SCOPES, scopeString } from "../src/auth/scopes.js";
import { FileTokenCache } from "../src/auth/tokenCache.js";
import { loadBootstrapConfig } from "../src/config/index.js";

const AUTHORIZE_ENDPOINT = "https://api.outreach.io/oauth/authorize";
const TOKEN_ENDPOINT = "https://api.outreach.io/oauth/token";
const CALLBACK_PATH = "/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface CallbackPayload {
  readonly code: string;
}

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

  const callbackPromise = awaitCallback(cfg.redirectPort, state);
  openBrowser(authorizeUrl.toString());

  const callback = await callbackPromise;
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

function awaitCallback(port: number, expectedState: string): Promise<CallbackPayload> {
  return new Promise<CallbackPayload>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${String(port)}`);
      if (url.pathname !== CALLBACK_PATH) {
        respond(res, 404, "Not Found");
        return;
      }
      try {
        const parsed = parseCallback(url.searchParams, expectedState);
        respond(res, 200, "Outreach authorization complete. You can close this tab.");
        cleanup();
        resolve({ code: parsed.code });
      } catch (e) {
        const message = e instanceof CallbackError ? e.message : "Unexpected callback error.";
        respond(res, 400, escapeHtml(message));
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });

    const timeoutHandle = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for OAuth callback after ${String(CALLBACK_TIMEOUT_MS / 1000)}s.`,
        ),
      );
    }, CALLBACK_TIMEOUT_MS);

    function cleanup(): void {
      clearTimeout(timeoutHandle);
      server.close();
    }

    server.on("error", (e) => {
      cleanup();
      reject(e);
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
